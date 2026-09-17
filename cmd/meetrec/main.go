package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/riffado/riffado/audio/discovery"
	"github.com/riffado/riffado/audio/recorder"
)

const pollInterval = 2 * time.Second

type options struct {
	output  string
	verbose bool
	debug   bool
	list    bool
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}

func run(arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("meetrec", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var opts options
	flags.StringVar(&opts.output, "output", "", "write to FILE instead of a timestamped file in the current directory")
	flags.BoolVar(&opts.verbose, "verbose", false, "print route-selection and recorder details")
	flags.BoolVar(&opts.debug, "debug", false, "print PipeWire/Pulse object identifiers and properties useful for troubleshooting")
	flags.BoolVar(&opts.list, "list", false, "list browser streams, audio devices, monitors, and detected routing without recording")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	if opts.debug {
		opts.verbose = true
	}

	pactlPath, err := exec.LookPath("pactl")
	if err != nil {
		return errors.New("pactl is required but was not found in PATH; install PipeWire's PulseAudio compatibility tools (usually the pulseaudio-utils package)")
	}
	discoverer := discovery.NewDiscoverer(pactlPath)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if opts.list {
		snapshot, err := discoverer.Snapshot(ctx)
		if err != nil {
			return fmt.Errorf("inspect audio routes: %w", err)
		}
		discovery.WriteDiagnostics(stdout, snapshot, opts.debug)
		return nil
	}

	ffmpegPath, _ := exec.LookPath("ffmpeg")
	checkContext, checkCancel := context.WithTimeout(ctx, 10*time.Second)
	err = recorder.CheckFFmpeg(checkContext, ffmpegPath)
	checkCancel()
	if err != nil {
		return err
	}

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	fmt.Fprintln(stdout, "Detecting meeting audio...")
	route, err := waitForRoute(ctx, discoverer, signals, stdout, opts)
	if err != nil {
		return err
	}
	if route == nil {
		return nil
	}

	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Detected meeting audio:")
	fmt.Fprintf(stdout, "  browser: %s\n", route.Application.DisplayName)
	fmt.Fprintf(stdout, "  mic:     %s\n", route.CaptureSource.Description)
	fmt.Fprintf(stdout, "  output:  %s\n", route.PlaybackSink.Description)
	if opts.verbose {
		fmt.Fprintf(stdout, "  monitor: %s\n", route.PlaybackMonitor.Description)
		fmt.Fprintf(stdout, "  method:  %s\n", route.DetectionMethod)
	}

	outputPath, displayPath, err := recordingPath(opts.output, time.Now())
	if err != nil {
		return err
	}
	var ffmpegLog io.Writer
	if opts.debug {
		ffmpegLog = stderr
	}
	session, err := (recorder.Recorder{FFmpeg: ffmpegPath, Log: ffmpegLog}).Start(*route, outputPath)
	if err != nil {
		return err
	}
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Recording...")
	fmt.Fprintln(stdout, "Press Ctrl+C to stop.")

	watchContext, stopWatching := context.WithCancel(ctx)
	routeChanges := make(chan error, 1)
	go watchRoute(watchContext, discoverer, *route, routeChanges, stderr, opts.verbose)

	meter := newLevelMeter(stdout, isInteractive(stdout))
	meterTicker := time.NewTicker(100 * time.Millisecond)
	levels := session.Levels()
	var stopReason error
	routeChanged := false
recording:
	for {
		select {
		case sample, ok := <-levels:
			if !ok {
				levels = nil
				continue
			}
			meter.Update(sample, time.Now())
		case now := <-meterTicker.C:
			meter.Render(now)
		case <-signals:
			break recording
		case stopReason = <-routeChanges:
			routeChanged = true
			break recording
		case <-session.Done():
			if err := session.Err(); err != nil {
				stopReason = fmt.Errorf("FFmpeg stopped unexpectedly: %w", err)
			} else {
				stopReason = errors.New("FFmpeg stopped unexpectedly")
			}
			break recording
		}
	}
	meterTicker.Stop()
	meter.Clear()
	if routeChanged {
		fmt.Fprintln(stderr, "Audio route changed; stopping the recording to avoid capturing the wrong device.")
	}
	stopWatching()
	if err := session.Stop(); err != nil && stopReason == nil {
		stopReason = err
	}
	if err := recorder.ValidateOutput(outputPath); err != nil {
		detail := session.Diagnostic()
		if detail != "" {
			return fmt.Errorf("%w\nFFmpeg: %s", err, detail)
		}
		return err
	}
	if stopReason != nil {
		fmt.Fprintf(stderr, "Partial recording saved as %s\n", displayPath)
		if detail := session.Diagnostic(); opts.verbose && detail != "" {
			fmt.Fprintf(stderr, "FFmpeg: %s\n", detail)
		}
		return stopReason
	}
	fmt.Fprintf(stdout, "Saved %s\n", displayPath)
	return nil
}

func waitForRoute(ctx context.Context, discoverer *discovery.Discoverer, signals <-chan os.Signal, output io.Writer, opts options) (*discovery.MeetingAudioRoute, error) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	waitingPrinted := false
	for {
		snapshot, err := discoverer.Snapshot(ctx)
		if err != nil {
			return nil, fmt.Errorf("inspect audio routes: %w", err)
		}
		route, err := discovery.SelectMeetingRoute(snapshot)
		if err == nil {
			return &route, nil
		}
		var ambiguous *discovery.AmbiguousError
		var routeError *discovery.RouteError
		switch {
		case errors.Is(err, discovery.ErrNoMeeting):
			if !waitingPrinted {
				fmt.Fprintln(output, "Waiting for an active communication stream...")
				waitingPrinted = true
			}
		case errors.As(err, &ambiguous), errors.As(err, &routeError):
			discovery.WriteDiagnostics(output, snapshot, opts.debug)
			return nil, fmt.Errorf("%w\nTry: meetrec --list", err)
		default:
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-signals:
			return nil, nil
		case <-ticker.C:
		}
	}
}

func watchRoute(ctx context.Context, discoverer *discovery.Discoverer, route discovery.MeetingAudioRoute, changes chan<- error, stderr io.Writer, verbose bool) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	consecutiveFailures := 0
	consecutiveSnapshotFailures := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		snapshot, err := discoverer.Snapshot(ctx)
		if err != nil {
			consecutiveSnapshotFailures++
			if verbose {
				fmt.Fprintf(stderr, "Audio graph check %d/3 failed: %v\n", consecutiveSnapshotFailures, err)
			}
			if consecutiveSnapshotFailures >= 3 {
				select {
				case changes <- fmt.Errorf("audio graph became unavailable: %w", err):
				case <-ctx.Done():
				}
				return
			}
			continue
		}
		consecutiveSnapshotFailures = 0
		err = discovery.ValidateRoute(snapshot, route)
		if err == nil {
			consecutiveFailures = 0
			continue
		}
		consecutiveFailures++
		if verbose {
			fmt.Fprintf(stderr, "Route check %d/2: %v\n", consecutiveFailures, err)
		}
		if consecutiveFailures < 2 {
			continue
		}
		select {
		case changes <- err:
		case <-ctx.Done():
		}
		return
	}
}

func recordingPath(requested string, now time.Time) (string, string, error) {
	if requested == "" {
		filename := "meeting-" + now.Format("2006-01-02_15-04-05") + ".ogg"
		cwd, err := os.Getwd()
		if err != nil {
			return "", "", fmt.Errorf("determine current directory: %w", err)
		}
		return filepath.Join(cwd, filename), "./" + filename, nil
	}
	absolute, err := filepath.Abs(requested)
	if err != nil {
		return "", "", fmt.Errorf("resolve output path: %w", err)
	}
	return absolute, requested, nil
}

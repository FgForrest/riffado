package recorder

import (
	"errors"
	"math"
	"os"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/riffado/riffado/audio/discovery"
)

func TestBuildArgsUsesIndependentClockCorrectionAndSafeMixing(t *testing.T) {
	route := discovery.MeetingAudioRoute{
		CaptureSource:   discovery.Source{Name: "source.device"},
		PlaybackMonitor: discovery.Source{Name: "sink.device.monitor"},
	}
	args := BuildArgs(route, "/work/meeting.ogg")
	joined := strings.Join(args, " ")
	for _, expected := range []string{
		"source.device", "sink.device.monitor",
		"aresample=48000:async=100:first_pts=0",
		"amix=inputs=2", "weights=1 1", "normalize=1",
		"alimiter=limit=0.95:level=false", "libopus", "voip", "80k",
		"astats=metadata=1:reset=1", "measure_overall=Peak_level",
		"file='pipe\\:3':direct=1", "file='pipe\\:4':direct=1",
	} {
		if !strings.Contains(joined, expected) {
			t.Errorf("arguments do not contain %q: %s", expected, joined)
		}
	}
	if !slices.Contains(args, "/work/meeting.ogg") {
		t.Error("arguments do not contain output path")
	}
}

func TestParseLevelLine(t *testing.T) {
	decibels, ok := parseLevelLine("lavfi.astats.Overall.Peak_level=-18.750000")
	if !ok || decibels != -18.75 {
		t.Fatalf("parseLevelLine() = %v, %v", decibels, ok)
	}
	decibels, ok = parseLevelLine("lavfi.astats.Overall.Peak_level=-inf")
	if !ok || !math.IsInf(decibels, -1) {
		t.Fatalf("parseLevelLine(-inf) = %v, %v", decibels, ok)
	}
	if _, ok := parseLevelLine("frame:0 pts:0"); ok {
		t.Fatal("parseLevelLine() accepted a non-level line")
	}
}

func TestSessionPublishesBothInputLevels(t *testing.T) {
	directory := t.TempDir()
	helper := directory + "/fake-ffmpeg"
	script := "#!/bin/sh\nprintf 'lavfi.astats.Overall.Peak_level=-24.5\\n' >&3\nprintf 'lavfi.astats.Overall.Peak_level=-9.25\\n' >&4\nsleep 1\n"
	if err := os.WriteFile(helper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	route := discovery.MeetingAudioRoute{
		CaptureSource:   discovery.Source{Name: "source.device"},
		PlaybackMonitor: discovery.Source{Name: "sink.device.monitor"},
	}
	session, err := (Recorder{FFmpeg: helper}).Start(route, directory+"/unused.ogg")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := session.Stop(); err != nil {
			t.Errorf("Stop() error = %v", err)
		}
	}()

	levels := make(map[Input]float64)
	timeout := time.NewTimer(time.Second)
	defer timeout.Stop()
	for len(levels) < 2 {
		select {
		case level := <-session.Levels():
			levels[level.Input] = level.Decibels
		case <-timeout.C:
			t.Fatalf("received levels = %v", levels)
		}
	}
	if levels[Microphone] != -24.5 {
		t.Errorf("microphone level = %v", levels[Microphone])
	}
	if levels[RemotePlayback] != -9.25 {
		t.Errorf("remote playback level = %v", levels[RemotePlayback])
	}
}

func TestValidateOutputRejectsEmptyRecording(t *testing.T) {
	path := t.TempDir() + "/empty.ogg"
	if err := os.WriteFile(path, []byte("OggS"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateOutput(path); err == nil {
		t.Fatal("ValidateOutput() accepted a four-byte file")
	}
}

func TestSessionStopSignalsAndReapsProcessGroup(t *testing.T) {
	directory := t.TempDir()
	helper := directory + "/fake-ffmpeg"
	script := "#!/bin/sh\ntrap 'exit 0' INT TERM\nwhile true; do sleep 1; done\n"
	if err := os.WriteFile(helper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	route := discovery.MeetingAudioRoute{
		CaptureSource:   discovery.Source{Name: "source.device"},
		PlaybackMonitor: discovery.Source{Name: "sink.device.monitor"},
	}
	session, err := (Recorder{FFmpeg: helper}).Start(route, directory+"/unused.ogg")
	if err != nil {
		t.Fatal(err)
	}
	pid := session.command.Process.Pid
	if err := session.Stop(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-session.Done():
	case <-time.After(time.Second):
		t.Fatal("process was not reaped")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("process %d still exists: %v", pid, err)
	}
}

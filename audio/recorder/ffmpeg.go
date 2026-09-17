package recorder

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/riffado/riffado/audio/discovery"
)

const minimumRecordingSize = 512

const levelMetadataKey = "lavfi.astats.Overall.Peak_level"

type Input int

const (
	Microphone Input = iota
	RemotePlayback
)

type LevelSample struct {
	Input    Input
	Decibels float64
}

type Recorder struct {
	FFmpeg string
	Log    io.Writer
}

func CheckFFmpeg(ctx context.Context, path string) error {
	if path == "" {
		return errors.New("FFmpeg is required but was not found in PATH; install the ffmpeg package and try again")
	}
	encoders, err := exec.CommandContext(ctx, path, "-hide_banner", "-encoders").CombinedOutput()
	if err != nil {
		return fmt.Errorf("could not inspect FFmpeg encoders: %w", err)
	}
	if !bytes.Contains(encoders, []byte("libopus")) {
		return errors.New("FFmpeg is installed without the libopus encoder; install a full FFmpeg build with libopus support")
	}
	devices, err := exec.CommandContext(ctx, path, "-hide_banner", "-devices").CombinedOutput()
	if err != nil {
		return fmt.Errorf("could not inspect FFmpeg input devices: %w", err)
	}
	if !hasPulseInput(devices) {
		return errors.New("FFmpeg is installed without PulseAudio input support; install a full FFmpeg build with the pulse input device")
	}
	filters, err := exec.CommandContext(ctx, path, "-hide_banner", "-filters").CombinedOutput()
	if err != nil {
		return fmt.Errorf("could not inspect FFmpeg filters: %w", err)
	}
	if !bytes.Contains(filters, []byte("astats")) || !bytes.Contains(filters, []byte("ametadata")) {
		return errors.New("FFmpeg is installed without the astats/ametadata filters required for live input meters")
	}
	return nil
}

func BuildArgs(route discovery.MeetingAudioRoute, outputPath string) []string {
	microphoneMeter := "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level," +
		"ametadata=mode=print:key=" + levelMetadataKey + ":file='pipe\\:3':direct=1"
	remoteMeter := "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level," +
		"ametadata=mode=print:key=" + levelMetadataKey + ":file='pipe\\:4':direct=1"
	filter := "[0:a]aresample=48000:async=100:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono," + microphoneMeter + "[mic];" +
		"[1:a]aresample=48000:async=100:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono," + remoteMeter + "[remote];" +
		"[mic][remote]amix=inputs=2:duration=longest:dropout_transition=0:weights=1 1:normalize=1," +
		"alimiter=limit=0.95:level=false[out]"
	return []string{
		"-hide_banner", "-nostdin", "-loglevel", "warning",
		"-thread_queue_size", "4096", "-f", "pulse", "-sample_rate", "48000", "-wallclock", "1", "-i", route.CaptureSource.Name,
		"-thread_queue_size", "4096", "-f", "pulse", "-sample_rate", "48000", "-wallclock", "1", "-i", route.PlaybackMonitor.Name,
		"-filter_complex", filter,
		"-map", "[out]", "-ar", "48000", "-ac", "1",
		"-c:a", "libopus", "-application", "voip", "-b:a", "80k", "-vbr", "on",
		"-f", "ogg", "-n", outputPath,
	}
}

func (recorder Recorder) Start(route discovery.MeetingAudioRoute, outputPath string) (*Session, error) {
	if err := ensureOutputAvailable(outputPath); err != nil {
		return nil, err
	}
	logBuffer := &tailBuffer{limit: 64 * 1024}
	logWriter := io.Writer(logBuffer)
	if recorder.Log != nil {
		logWriter = io.MultiWriter(recorder.Log, logBuffer)
	}
	microphoneReader, microphoneWriter, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("create microphone meter pipe: %w", err)
	}
	remoteReader, remoteWriter, err := os.Pipe()
	if err != nil {
		_ = microphoneReader.Close()
		_ = microphoneWriter.Close()
		return nil, fmt.Errorf("create remote meter pipe: %w", err)
	}
	command := exec.Command(recorder.FFmpeg, BuildArgs(route, outputPath)...)
	command.Stdout = io.Discard
	command.Stderr = logWriter
	command.ExtraFiles = []*os.File{microphoneWriter, remoteWriter}
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		_ = microphoneReader.Close()
		_ = microphoneWriter.Close()
		_ = remoteReader.Close()
		_ = remoteWriter.Close()
		return nil, fmt.Errorf("start FFmpeg: %w", err)
	}
	_ = microphoneWriter.Close()
	_ = remoteWriter.Close()
	session := &Session{
		command: command,
		done:    make(chan struct{}),
		log:     logBuffer,
		levels:  make(chan LevelSample, 32),
	}
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		readLevelStream(microphoneReader, Microphone, session.levels)
	}()
	go func() {
		defer readers.Done()
		readLevelStream(remoteReader, RemotePlayback, session.levels)
	}()
	go func() {
		session.waitErr = command.Wait()
		_ = microphoneReader.Close()
		_ = remoteReader.Close()
		readers.Wait()
		close(session.levels)
		close(session.done)
	}()
	return session, nil
}

type Session struct {
	command *exec.Cmd
	done    chan struct{}
	log     *tailBuffer
	levels  chan LevelSample
	stop    sync.Once
	waitErr error
}

func (session *Session) Done() <-chan struct{} {
	return session.done
}

func (session *Session) Levels() <-chan LevelSample {
	return session.levels
}

func (session *Session) Err() error {
	select {
	case <-session.done:
		return session.waitErr
	default:
		return nil
	}
}

func (session *Session) Diagnostic() string {
	return strings.TrimSpace(session.log.String())
}

func (session *Session) Stop() error {
	session.stop.Do(func() {
		select {
		case <-session.done:
			return
		default:
		}
		_ = syscall.Kill(-session.command.Process.Pid, syscall.SIGINT)
	})
	select {
	case <-session.done:
		return nil
	case <-time.After(10 * time.Second):
	}
	_ = syscall.Kill(-session.command.Process.Pid, syscall.SIGTERM)
	select {
	case <-session.done:
		return nil
	case <-time.After(3 * time.Second):
	}
	_ = syscall.Kill(-session.command.Process.Pid, syscall.SIGKILL)
	select {
	case <-session.done:
		return errors.New("FFmpeg did not stop cleanly and was killed")
	case <-time.After(2 * time.Second):
		return errors.New("FFmpeg process could not be reaped after SIGKILL")
	}
}

func ValidateOutput(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("recording output was not created: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("recording output %q is not a regular file", path)
	}
	if info.Size() < minimumRecordingSize {
		return fmt.Errorf("recording output is only %d bytes and does not contain meaningful encoded audio", info.Size())
	}
	return nil
}

func ensureOutputAvailable(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve output path: %w", err)
	}
	if info, err := os.Stat(absolute); err == nil {
		return fmt.Errorf("output file already exists: %s (%d bytes)", absolute, info.Size())
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect output path: %w", err)
	}
	directory := filepath.Dir(absolute)
	info, err := os.Stat(directory)
	if err != nil {
		return fmt.Errorf("output directory is unavailable: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("output parent %q is not a directory", directory)
	}
	return nil
}

func hasPulseInput(devices []byte) bool {
	for _, line := range strings.Split(string(devices), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.Contains(fields[0], "D") && fields[1] == "pulse" {
			return true
		}
	}
	return false
}

func readLevelStream(reader io.Reader, input Input, updates chan<- LevelSample) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		decibels, ok := parseLevelLine(scanner.Text())
		if !ok {
			continue
		}
		select {
		case updates <- LevelSample{Input: input, Decibels: decibels}:
		default:
		}
	}
}

func parseLevelLine(line string) (float64, bool) {
	prefix := levelMetadataKey + "="
	position := strings.Index(line, prefix)
	if position < 0 {
		return 0, false
	}
	value := strings.TrimSpace(line[position+len(prefix):])
	decibels, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(decibels) {
		return 0, false
	}
	return decibels, true
}

type tailBuffer struct {
	mutex sync.Mutex
	data  []byte
	limit int
}

func (buffer *tailBuffer) Write(data []byte) (int, error) {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	buffer.data = append(buffer.data, data...)
	if len(buffer.data) > buffer.limit {
		buffer.data = append([]byte(nil), buffer.data[len(buffer.data)-buffer.limit:]...)
	}
	return len(data), nil
}

func (buffer *tailBuffer) String() string {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return string(buffer.data)
}

package main

import (
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"time"

	"github.com/riffado/riffado/audio/recorder"
)

const (
	meterWidth   = 16
	meterFloorDB = -60.0
)

type levelMeter struct {
	writer       io.Writer
	enabled      bool
	microphone   float64
	remote       float64
	microphoneAt time.Time
	remoteAt     time.Time
	lineWidth    int
}

func newLevelMeter(writer io.Writer, enabled bool) *levelMeter {
	return &levelMeter{
		writer:     writer,
		enabled:    enabled,
		microphone: meterFloorDB,
		remote:     meterFloorDB,
	}
}

func (meter *levelMeter) Update(sample recorder.LevelSample, now time.Time) {
	if sample.Input == recorder.Microphone {
		meter.microphone = sample.Decibels
		meter.microphoneAt = now
		return
	}
	meter.remote = sample.Decibels
	meter.remoteAt = now
}

func (meter *levelMeter) Render(now time.Time) {
	if !meter.enabled {
		return
	}
	microphone := levelBar(decayedLevel(meter.microphone, meter.microphoneAt, now), meterWidth)
	remote := levelBar(decayedLevel(meter.remote, meter.remoteAt, now), meterWidth)
	line := fmt.Sprintf("Mic [%s] Remote [%s]", microphone, remote)
	fmt.Fprintf(meter.writer, "\r%s", line)
	meter.lineWidth = len(line)
}

func (meter *levelMeter) Clear() {
	if !meter.enabled || meter.lineWidth == 0 {
		return
	}
	fmt.Fprintf(meter.writer, "\r%s\r", strings.Repeat(" ", meter.lineWidth))
	meter.lineWidth = 0
}

func decayedLevel(decibels float64, sampledAt, now time.Time) float64 {
	if sampledAt.IsZero() || math.IsInf(decibels, -1) {
		return meterFloorDB
	}
	staleFor := now.Sub(sampledAt) - 200*time.Millisecond
	if staleFor > 0 {
		decibels -= staleFor.Seconds() * 30
	}
	return decibels
}

func levelBar(decibels float64, width int) string {
	decibels = max(meterFloorDB, min(0, decibels))
	filled := int(math.Round((decibels - meterFloorDB) / -meterFloorDB * float64(width)))
	return strings.Repeat("#", filled) + strings.Repeat(".", width-filled)
}

func isInteractive(writer io.Writer) bool {
	file, ok := writer.(*os.File)
	if !ok {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

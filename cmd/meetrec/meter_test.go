package main

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/riffado/riffado/audio/recorder"
)

func TestLevelBarMapsDecibelsToWidth(t *testing.T) {
	for _, test := range []struct {
		decibels float64
		want     string
	}{
		{decibels: -60, want: ".........."},
		{decibels: -30, want: "#####....."},
		{decibels: 0, want: "##########"},
	} {
		if got := levelBar(test.decibels, 10); got != test.want {
			t.Errorf("levelBar(%v) = %q, want %q", test.decibels, got, test.want)
		}
	}
}

func TestLevelMeterRendersBothInputsOnOneRow(t *testing.T) {
	var output bytes.Buffer
	now := time.Unix(0, 0)
	meter := newLevelMeter(&output, true)
	meter.Update(recorder.LevelSample{Input: recorder.Microphone, Decibels: -30}, now)
	meter.Update(recorder.LevelSample{Input: recorder.RemotePlayback, Decibels: -12}, now)
	meter.Render(now)
	meter.Clear()

	text := output.String()
	if !strings.Contains(text, "\rMic [") || !strings.Contains(text, "] Remote [") {
		t.Fatalf("meter output = %q", text)
	}
	if strings.Contains(text, "\n") {
		t.Fatalf("meter used more than one row: %q", text)
	}
}

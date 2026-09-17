package main

import (
	"path/filepath"
	"testing"
	"time"
)

func TestDefaultRecordingPathUsesCurrentDirectory(t *testing.T) {
	path, display, err := recordingPath("", time.Date(2026, 9, 17, 10, 32, 41, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "meeting-2026-09-17_10-32-41.ogg" {
		t.Errorf("path = %q", path)
	}
	if display != "./meeting-2026-09-17_10-32-41.ogg" {
		t.Errorf("display = %q", display)
	}
}

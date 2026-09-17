package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

type commandRunner interface {
	Output(context.Context, string, ...string) ([]byte, error)
}

type execRunner struct{}

func (execRunner) Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	output, err := command.Output()
	if err == nil {
		return output, nil
	}
	var detail string
	if exitError, ok := err.(*exec.ExitError); ok {
		detail = strings.TrimSpace(string(exitError.Stderr))
	}
	if detail != "" {
		return nil, fmt.Errorf("%s %s failed: %s", name, strings.Join(args, " "), detail)
	}
	return nil, fmt.Errorf("%s %s failed: %w", name, strings.Join(args, " "), err)
}

type Discoverer struct {
	Pactl  string
	runner commandRunner
}

func NewDiscoverer(pactlPath string) *Discoverer {
	return &Discoverer{Pactl: pactlPath, runner: execRunner{}}
}

func (discoverer *Discoverer) Snapshot(ctx context.Context) (Snapshot, error) {
	listJSON, err := discoverer.runner.Output(ctx, discoverer.Pactl, "--format=json", "list")
	if err != nil {
		return Snapshot{}, err
	}
	infoJSON, err := discoverer.runner.Output(ctx, discoverer.Pactl, "--format=json", "info")
	if err != nil {
		return Snapshot{}, err
	}
	return ParseSnapshot(listJSON, infoJSON)
}

func ParseSnapshot(listJSON, infoJSON []byte) (Snapshot, error) {
	var snapshot Snapshot
	if err := json.Unmarshal(listJSON, &snapshot); err != nil {
		return Snapshot{}, fmt.Errorf("parse pactl object list: %w", err)
	}
	if err := json.Unmarshal(infoJSON, &snapshot.Info); err != nil {
		return Snapshot{}, fmt.Errorf("parse pactl server info: %w", err)
	}
	return snapshot, nil
}

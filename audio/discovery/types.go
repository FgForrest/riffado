package discovery

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
)

// ID is a PulseAudio object index. pactl emits some indexes as JSON numbers and
// others as quoted numbers, depending on the object type.
type ID int

func (id *ID) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) || bytes.Equal(data, []byte(`""`)) {
		*id = -1
		return nil
	}

	var number json.Number
	if len(data) > 0 && data[0] == '"' {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return err
		}
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return fmt.Errorf("invalid object index %q: %w", value, err)
		}
		*id = ID(parsed)
		return nil
	}

	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	parsed, err := strconv.Atoi(number.String())
	if err != nil {
		return fmt.Errorf("invalid object index %q: %w", number, err)
	}
	*id = ID(parsed)
	return nil
}

type Properties map[string]any

func (properties Properties) Value(key string) string {
	value, ok := properties[key]
	if !ok || value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

type ServerInfo struct {
	ServerName        string `json:"server_name"`
	ServerVersion     string `json:"server_version"`
	DefaultSourceName string `json:"default_source_name"`
	DefaultSinkName   string `json:"default_sink_name"`
}

type Client struct {
	Index      ID         `json:"index"`
	Properties Properties `json:"properties"`
}

type SourceOutput struct {
	Index      ID         `json:"index"`
	Client     ID         `json:"client"`
	Source     ID         `json:"source"`
	Corked     bool       `json:"corked"`
	Properties Properties `json:"properties"`
}

type SinkInput struct {
	Index      ID         `json:"index"`
	Client     ID         `json:"client"`
	Sink       ID         `json:"sink"`
	Corked     bool       `json:"corked"`
	Properties Properties `json:"properties"`
}

type Source struct {
	Index         ID         `json:"index"`
	State         string     `json:"state"`
	Name          string     `json:"name"`
	Description   string     `json:"description"`
	MonitorSource string     `json:"monitor_source"`
	Properties    Properties `json:"properties"`
}

func (source Source) IsMonitor() bool {
	return source.MonitorSource != "" || source.Properties.Value("device.class") == "monitor"
}

type Sink struct {
	Index         ID         `json:"index"`
	State         string     `json:"state"`
	Name          string     `json:"name"`
	Description   string     `json:"description"`
	MonitorSource string     `json:"monitor_source"`
	Properties    Properties `json:"properties"`
}

type Snapshot struct {
	Info          ServerInfo     `json:"-"`
	Clients       []Client       `json:"clients"`
	SourceOutputs []SourceOutput `json:"source_outputs"`
	SinkInputs    []SinkInput    `json:"sink_inputs"`
	Sources       []Source       `json:"sources"`
	Sinks         []Sink         `json:"sinks"`
}

type Browser struct {
	Key         string
	DisplayName string
}

type MeetingAudioRoute struct {
	Application            Browser
	CaptureSource          Source
	PlaybackSink           Sink
	PlaybackMonitor        Source
	ObservedCaptureTarget  ID
	ObservedPlaybackTarget ID
	CaptureStreamIndexes   []ID
	PlaybackStreamIndexes  []ID
	DetectionMethod        string
	UsedDefaultSource      bool
	UsedDefaultSink        bool
}

type DiagnosticStream struct {
	Index         ID
	Application   Browser
	Direction     string
	TargetIndex   ID
	TargetName    string
	TargetDisplay string
	Communication bool
	Active        bool
	MediaName     string
}

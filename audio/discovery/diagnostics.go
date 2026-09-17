package discovery

import (
	"fmt"
	"io"
)

func WriteDiagnostics(writer io.Writer, snapshot Snapshot, debug bool) {
	fmt.Fprintf(writer, "Audio server: %s %s\n", snapshot.Info.ServerName, snapshot.Info.ServerVersion)
	fmt.Fprintln(writer)
	fmt.Fprintln(writer, "Browser audio streams:")
	streams := BrowserStreams(snapshot)
	if len(streams) == 0 {
		fmt.Fprintln(writer, "  none")
	}
	for _, stream := range streams {
		state := "idle"
		if stream.Active {
			state = "active"
		}
		role := "audio"
		if stream.Communication {
			role = "communication"
		}
		target := stream.TargetDisplay
		if target == "" {
			target = "unresolved"
		}
		fmt.Fprintf(writer, "  %s %s (%s, %s) -> %s\n", stream.Application.DisplayName, stream.Direction, role, state, target)
		if debug {
			fmt.Fprintf(writer, "    stream=%d target=%d media=%q target_name=%q\n", stream.Index, stream.TargetIndex, stream.MediaName, stream.TargetName)
		}
	}

	fmt.Fprintln(writer)
	fmt.Fprintln(writer, "Microphones/sources:")
	for _, source := range snapshot.Sources {
		kind := "source"
		if source.IsMonitor() {
			kind = "monitor"
		}
		defaultMarker := ""
		if source.Name == snapshot.Info.DefaultSourceName {
			defaultMarker = " [default]"
		}
		fmt.Fprintf(writer, "  %s (%s, %s)%s\n", source.Description, kind, source.State, defaultMarker)
		if debug {
			fmt.Fprintf(writer, "    id=%d name=%q monitor_of=%q\n", source.Index, source.Name, source.MonitorSource)
		}
	}

	fmt.Fprintln(writer)
	fmt.Fprintln(writer, "Playback sinks:")
	for _, sink := range snapshot.Sinks {
		defaultMarker := ""
		if sink.Name == snapshot.Info.DefaultSinkName {
			defaultMarker = " [default]"
		}
		fmt.Fprintf(writer, "  %s (%s)%s\n", sink.Description, sink.State, defaultMarker)
		fmt.Fprintf(writer, "    monitor: %s\n", descriptionForSource(snapshot.Sources, sink.MonitorSource))
		if debug {
			fmt.Fprintf(writer, "    id=%d name=%q monitor_name=%q\n", sink.Index, sink.Name, sink.MonitorSource)
		}
	}

	fmt.Fprintln(writer)
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		fmt.Fprintf(writer, "Detected route: none (%v)\n", err)
		return
	}
	fmt.Fprintln(writer, "Detected route:")
	fmt.Fprintf(writer, "  application: %s\n", route.Application.DisplayName)
	fmt.Fprintf(writer, "  microphone:  %s\n", route.CaptureSource.Description)
	fmt.Fprintf(writer, "  playback:    %s\n", route.PlaybackSink.Description)
	fmt.Fprintf(writer, "  monitor:     %s\n", route.PlaybackMonitor.Description)
	fmt.Fprintf(writer, "  method:      %s\n", route.DetectionMethod)
}

func descriptionForSource(sources []Source, name string) string {
	if source, ok := sourceByName(sources, name); ok {
		return source.Description
	}
	if name == "" {
		return "unavailable"
	}
	return name + " (unresolved)"
}

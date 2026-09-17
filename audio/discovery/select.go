package discovery

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

var ErrNoMeeting = errors.New("no active meeting audio streams")

type AmbiguousError struct {
	Details string
}

func (err *AmbiguousError) Error() string {
	return "meeting audio routing is ambiguous: " + err.Details
}

type RouteError struct {
	Details string
}

func (err *RouteError) Error() string {
	return "could not resolve meeting audio routing: " + err.Details
}

var browsers = []struct {
	Browser
	PortalIDs []string
	Binaries  []string
	Names     []string
}{
	{Browser: Browser{Key: "chrome", DisplayName: "Google Chrome"}, PortalIDs: []string{"com.google.chrome"}, Binaries: []string{"chrome", "google-chrome", "google-chrome-stable"}, Names: []string{"google chrome", "chrome"}},
	{Browser: Browser{Key: "chromium", DisplayName: "Chromium"}, PortalIDs: []string{"org.chromium.chromium"}, Binaries: []string{"chromium", "chromium-browser"}, Names: []string{"chromium"}},
	{Browser: Browser{Key: "firefox", DisplayName: "Firefox"}, PortalIDs: []string{"org.mozilla.firefox"}, Binaries: []string{"firefox", "firefox-bin"}, Names: []string{"firefox", "mozilla firefox"}},
	{Browser: Browser{Key: "brave", DisplayName: "Brave"}, PortalIDs: []string{"com.brave.browser"}, Binaries: []string{"brave", "brave-browser", "brave-browser-stable"}, Names: []string{"brave", "brave browser"}},
	{Browser: Browser{Key: "vivaldi", DisplayName: "Vivaldi"}, PortalIDs: []string{"com.vivaldi.vivaldi"}, Binaries: []string{"vivaldi", "vivaldi-bin", "vivaldi-stable"}, Names: []string{"vivaldi"}},
	{Browser: Browser{Key: "edge", DisplayName: "Microsoft Edge"}, PortalIDs: []string{"com.microsoft.edge"}, Binaries: []string{"microsoft-edge", "microsoft-edge-stable"}, Names: []string{"microsoft edge"}},
}

type streamCandidate struct {
	index         ID
	target        ID
	application   Browser
	direction     string
	communication bool
	active        bool
	mediaName     string
}

func SelectMeetingRoute(snapshot Snapshot) (MeetingAudioRoute, error) {
	captures, playbacks := browserCandidates(snapshot)
	type applicationStreams struct {
		application Browser
		captures    []streamCandidate
		playbacks   []streamCandidate
	}
	groups := make(map[string]*applicationStreams)
	for _, candidate := range captures {
		group := groups[candidate.application.Key]
		if group == nil {
			group = &applicationStreams{application: candidate.application}
			groups[candidate.application.Key] = group
		}
		group.captures = append(group.captures, candidate)
	}
	for _, candidate := range playbacks {
		group := groups[candidate.application.Key]
		if group == nil {
			group = &applicationStreams{application: candidate.application}
			groups[candidate.application.Key] = group
		}
		group.playbacks = append(group.playbacks, candidate)
	}

	type rankedRoute struct {
		application     Browser
		captureTarget   ID
		playbackTarget  ID
		captureStreams  []ID
		playbackStreams []ID
		score           int
		communication   bool
	}
	var ranked []rankedRoute
	for _, group := range groups {
		if len(group.captures) == 0 || len(group.playbacks) == 0 || !hasLiveCapture(group.captures) {
			continue
		}
		captureTarget, captureStreams, captureScore, captureCommunication, err := chooseTarget(group.captures)
		if err != nil {
			return MeetingAudioRoute{}, err
		}
		playbackTarget, playbackStreams, playbackScore, playbackCommunication, err := chooseTarget(group.playbacks)
		if err != nil {
			return MeetingAudioRoute{}, err
		}
		ranked = append(ranked, rankedRoute{
			application:     group.application,
			captureTarget:   captureTarget,
			playbackTarget:  playbackTarget,
			captureStreams:  captureStreams,
			playbackStreams: playbackStreams,
			score:           captureScore + playbackScore,
			communication:   captureCommunication || playbackCommunication,
		})
	}
	if len(ranked) == 0 {
		return MeetingAudioRoute{}, ErrNoMeeting
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })
	if len(ranked) > 1 && ranked[0].score == ranked[1].score {
		return MeetingAudioRoute{}, &AmbiguousError{Details: fmt.Sprintf("both %s and %s have equally likely active audio streams", ranked[0].application.DisplayName, ranked[1].application.DisplayName)}
	}

	selected := ranked[0]
	source, usedDefaultSource, err := resolveSource(snapshot, selected.captureTarget)
	if err != nil {
		return MeetingAudioRoute{}, err
	}
	sink, usedDefaultSink, err := resolveSink(snapshot, selected.playbackTarget)
	if err != nil {
		return MeetingAudioRoute{}, err
	}
	monitor, ok := sourceByName(snapshot.Sources, sink.MonitorSource)
	if !ok || !monitor.IsMonitor() {
		return MeetingAudioRoute{}, &RouteError{Details: fmt.Sprintf("output sink %q has no usable monitor source", sink.Description)}
	}

	method := "browser streams"
	if selected.communication {
		method = "communication streams"
	}
	if usedDefaultSource || usedDefaultSink {
		method += " with default-device fallback"
	}
	return MeetingAudioRoute{
		Application:            selected.application,
		CaptureSource:          source,
		PlaybackSink:           sink,
		PlaybackMonitor:        monitor,
		ObservedCaptureTarget:  selected.captureTarget,
		ObservedPlaybackTarget: selected.playbackTarget,
		CaptureStreamIndexes:   selected.captureStreams,
		PlaybackStreamIndexes:  selected.playbackStreams,
		DetectionMethod:        method,
		UsedDefaultSource:      usedDefaultSource,
		UsedDefaultSink:        usedDefaultSink,
	}, nil
}

func BrowserStreams(snapshot Snapshot) []DiagnosticStream {
	captures, playbacks := browserCandidates(snapshot)
	all := append(captures, playbacks...)
	result := make([]DiagnosticStream, 0, len(all))
	for _, candidate := range all {
		stream := DiagnosticStream{
			Index:         candidate.index,
			Application:   candidate.application,
			Direction:     candidate.direction,
			TargetIndex:   candidate.target,
			Communication: candidate.communication,
			Active:        candidate.active,
			MediaName:     candidate.mediaName,
		}
		if candidate.direction == "capture" {
			if source, ok := sourceByIndex(snapshot.Sources, candidate.target); ok {
				stream.TargetName = source.Name
				stream.TargetDisplay = source.Description
			}
		} else if sink, ok := sinkByIndex(snapshot.Sinks, candidate.target); ok {
			stream.TargetName = sink.Name
			stream.TargetDisplay = sink.Description
		}
		result = append(result, stream)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Application.Key == result[j].Application.Key {
			if result[i].Direction == result[j].Direction {
				return result[i].Index < result[j].Index
			}
			return result[i].Direction < result[j].Direction
		}
		return result[i].Application.Key < result[j].Application.Key
	})
	return result
}

func ValidateRoute(snapshot Snapshot, route MeetingAudioRoute) error {
	if route.UsedDefaultSource && snapshot.Info.DefaultSourceName != route.CaptureSource.Name {
		return fmt.Errorf("default microphone changed from %q", route.CaptureSource.Description)
	}
	if route.UsedDefaultSink && snapshot.Info.DefaultSinkName != route.PlaybackSink.Name {
		return fmt.Errorf("default playback device changed from %q", route.PlaybackSink.Description)
	}
	currentSource, sourcePresent := sourceByName(snapshot.Sources, route.CaptureSource.Name)
	if !sourcePresent || currentSource.IsMonitor() {
		return fmt.Errorf("microphone %q disappeared", route.CaptureSource.Description)
	}
	currentSink, sinkPresent := sinkByName(snapshot.Sinks, route.PlaybackSink.Name)
	if !sinkPresent {
		return fmt.Errorf("playback device %q disappeared", route.PlaybackSink.Description)
	}
	if currentSink.MonitorSource != route.PlaybackMonitor.Name {
		return fmt.Errorf("monitor for playback device %q changed", route.PlaybackSink.Description)
	}
	if monitor, ok := sourceByName(snapshot.Sources, route.PlaybackMonitor.Name); !ok || !monitor.IsMonitor() {
		return fmt.Errorf("monitor for playback device %q disappeared", route.PlaybackSink.Description)
	}

	captures, playbacks := browserCandidates(snapshot)
	if err := validateStreamTargets(captures, route.Application.Key, route.CaptureStreamIndexes, route.ObservedCaptureTarget, "microphone"); err != nil {
		return err
	}
	if err := validateStreamTargets(playbacks, route.Application.Key, route.PlaybackStreamIndexes, route.ObservedPlaybackTarget, "playback device"); err != nil {
		return err
	}
	return nil
}

func browserCandidates(snapshot Snapshot) ([]streamCandidate, []streamCandidate) {
	clients := make(map[ID]Client, len(snapshot.Clients))
	for _, client := range snapshot.Clients {
		clients[client.Index] = client
	}
	var captures []streamCandidate
	for _, stream := range snapshot.SourceOutputs {
		browser, ok := browserForStream(stream.Properties, stream.Client, clients)
		if !ok {
			continue
		}
		captures = append(captures, streamCandidate{
			index: stream.Index, target: stream.Source, application: browser,
			direction: "capture", communication: isCommunication(stream.Properties),
			active: !stream.Corked, mediaName: stream.Properties.Value("media.name"),
		})
	}
	var playbacks []streamCandidate
	for _, stream := range snapshot.SinkInputs {
		browser, ok := browserForStream(stream.Properties, stream.Client, clients)
		if !ok {
			continue
		}
		playbacks = append(playbacks, streamCandidate{
			index: stream.Index, target: stream.Sink, application: browser,
			direction: "playback", communication: isCommunication(stream.Properties),
			active: !stream.Corked, mediaName: stream.Properties.Value("media.name"),
		})
	}
	return captures, playbacks
}

func browserForStream(properties Properties, clientID ID, clients map[ID]Client) (Browser, bool) {
	if client, ok := clients[clientID]; ok {
		if browser, matched := identifyBrowser(client.Properties); matched {
			return browser, true
		}
		if hasStrongApplicationIdentity(client.Properties) {
			return Browser{}, false
		}
	}
	return identifyBrowser(properties)
}

func identifyBrowser(properties Properties) (Browser, bool) {
	portalID := normalize(properties.Value("pipewire.access.portal.app_id"))
	if portalID != "" {
		for _, candidate := range browsers {
			if contains(candidate.PortalIDs, portalID) {
				return candidate.Browser, true
			}
		}
		return Browser{}, false
	}
	binary := normalizeBase(properties.Value("application.process.binary"))
	if binary != "" {
		for _, candidate := range browsers {
			if contains(candidate.Binaries, binary) {
				return candidate.Browser, true
			}
		}
		return Browser{}, false
	}
	name := normalize(properties.Value("application.name"))
	for _, candidate := range browsers {
		for _, accepted := range candidate.Names {
			if name == accepted || strings.HasPrefix(name, accepted+" ") {
				return candidate.Browser, true
			}
		}
	}
	return Browser{}, false
}

func hasStrongApplicationIdentity(properties Properties) bool {
	return properties.Value("pipewire.access.portal.app_id") != "" || properties.Value("application.process.binary") != ""
}

func isCommunication(properties Properties) bool {
	role := normalize(properties.Value("media.role"))
	if role == "communication" || role == "phone" {
		return true
	}
	text := normalize(strings.Join([]string{
		properties.Value("media.name"),
		properties.Value("node.name"),
		properties.Value("application.name"),
	}, " "))
	for _, marker := range []string{"webrtc", "voiceengine", "voice engine", "communication", "conference", "meeting", " call"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func chooseTarget(candidates []streamCandidate) (ID, []ID, int, bool, error) {
	bestScore := -1
	bestTargets := make(map[ID][]ID)
	communication := false
	for _, candidate := range candidates {
		score := 0
		if candidate.active {
			score++
		}
		if candidate.communication {
			score += 4
		}
		if score > bestScore {
			bestScore = score
			bestTargets = map[ID][]ID{candidate.target: {candidate.index}}
			communication = candidate.communication
		} else if score == bestScore {
			bestTargets[candidate.target] = append(bestTargets[candidate.target], candidate.index)
			communication = communication || candidate.communication
		}
	}
	if len(bestTargets) != 1 {
		return -1, nil, 0, false, &AmbiguousError{Details: "equally likely browser streams are routed to different devices"}
	}
	for target, indexes := range bestTargets {
		return target, indexes, bestScore, communication, nil
	}
	return -1, nil, 0, false, ErrNoMeeting
}

func hasLiveCapture(candidates []streamCandidate) bool {
	for _, candidate := range candidates {
		if candidate.active || candidate.communication {
			return true
		}
	}
	return false
}

func resolveSource(snapshot Snapshot, target ID) (Source, bool, error) {
	if source, ok := sourceByIndex(snapshot.Sources, target); ok && !source.IsMonitor() {
		return source, false, nil
	}
	if source, ok := sourceByName(snapshot.Sources, snapshot.Info.DefaultSourceName); ok && !source.IsMonitor() {
		return source, true, nil
	}
	return Source{}, false, &RouteError{Details: "the browser microphone route was unavailable and no physical default source could be resolved"}
}

func resolveSink(snapshot Snapshot, target ID) (Sink, bool, error) {
	if sink, ok := sinkByIndex(snapshot.Sinks, target); ok {
		return sink, false, nil
	}
	if sink, ok := sinkByName(snapshot.Sinks, snapshot.Info.DefaultSinkName); ok {
		return sink, true, nil
	}
	return Sink{}, false, &RouteError{Details: "the browser playback route was unavailable and no default sink could be resolved"}
}

func validateStreamTargets(candidates []streamCandidate, application string, originalIndexes []ID, expected ID, label string) error {
	original := make(map[ID]struct{}, len(originalIndexes))
	for _, index := range originalIndexes {
		original[index] = struct{}{}
	}
	originalPresent := false
	activeTargets := make(map[ID]struct{})
	for _, candidate := range candidates {
		if candidate.application.Key != application {
			continue
		}
		if _, ok := original[candidate.index]; ok {
			originalPresent = true
			if candidate.target != expected {
				return fmt.Errorf("meeting application changed its %s route", label)
			}
		}
		if candidate.active || candidate.communication {
			activeTargets[candidate.target] = struct{}{}
		}
	}
	if !originalPresent && len(activeTargets) == 1 {
		for target := range activeTargets {
			if target != expected {
				return fmt.Errorf("meeting application changed its %s route", label)
			}
		}
	}
	return nil
}

func sourceByIndex(sources []Source, index ID) (Source, bool) {
	for _, source := range sources {
		if source.Index == index {
			return source, true
		}
	}
	return Source{}, false
}

func sourceByName(sources []Source, name string) (Source, bool) {
	for _, source := range sources {
		if source.Name == name {
			return source, true
		}
	}
	return Source{}, false
}

func sinkByIndex(sinks []Sink, index ID) (Sink, bool) {
	for _, sink := range sinks {
		if sink.Index == index {
			return sink, true
		}
	}
	return Sink{}, false
}

func sinkByName(sinks []Sink, name string) (Sink, bool) {
	for _, sink := range sinks {
		if sink.Name == name {
			return sink, true
		}
	}
	return Sink{}, false
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if normalize(candidate) == value {
			return true
		}
	}
	return false
}

func normalize(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeBase(value string) string {
	value = normalize(value)
	if slash := strings.LastIndexByte(value, '/'); slash >= 0 {
		return value[slash+1:]
	}
	return value
}

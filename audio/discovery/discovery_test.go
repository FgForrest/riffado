package discovery

import (
	"errors"
	"os"
	"slices"
	"testing"
)

func TestParseAndSelectActualBrowserRoutes(t *testing.T) {
	snapshot := loadFixture(t)
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		t.Fatalf("SelectMeetingRoute() error = %v", err)
	}
	if route.Application.DisplayName != "Google Chrome" {
		t.Errorf("application = %q, want Google Chrome", route.Application.DisplayName)
	}
	if route.CaptureSource.Index != 10 {
		t.Errorf("capture source = %d, want 10", route.CaptureSource.Index)
	}
	if route.PlaybackSink.Index != 30 {
		t.Errorf("playback sink = %d, want 30", route.PlaybackSink.Index)
	}
	if route.PlaybackMonitor.Index != 20 {
		t.Errorf("playback monitor = %d, want 20", route.PlaybackMonitor.Index)
	}
	if route.UsedDefaultSource || route.UsedDefaultSink {
		t.Error("route unexpectedly used defaults")
	}
	if !slices.Equal(route.CaptureStreamIndexes, []ID{400}) || !slices.Equal(route.PlaybackStreamIndexes, []ID{500}) {
		t.Errorf("unexpected selected streams: capture=%v playback=%v", route.CaptureStreamIndexes, route.PlaybackStreamIndexes)
	}
}

func TestNonBrowserChromiumNamedClientIsIgnored(t *testing.T) {
	streams := BrowserStreams(loadFixture(t))
	for _, stream := range streams {
		if stream.Index == 401 {
			t.Fatal("non-browser client named 'Chromium input' was classified as a browser")
		}
	}
}

func TestCommunicationStreamWinsAmongMultipleBrowserStreams(t *testing.T) {
	snapshot := loadFixture(t)
	snapshot.SinkInputs = append(snapshot.SinkInputs, SinkInput{
		Index: 502, Client: 100, Sink: 31, Corked: false,
		Properties: Properties{"media.name": "Background tab audio"},
	})
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		t.Fatalf("SelectMeetingRoute() error = %v", err)
	}
	if route.PlaybackSink.Index != 30 {
		t.Errorf("playback sink = %d, want communication sink 30", route.PlaybackSink.Index)
	}
}

func TestMultipleCommunicationStreamsOnSameRouteAreAccepted(t *testing.T) {
	snapshot := loadFixture(t)
	snapshot.SinkInputs = append(snapshot.SinkInputs, SinkInput{
		Index: 502, Client: 100, Sink: 30, Corked: false,
		Properties: Properties{"media.name": "WebRTC second channel", "media.role": "phone"},
	})
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		t.Fatalf("SelectMeetingRoute() error = %v", err)
	}
	if !slices.Equal(route.PlaybackStreamIndexes, []ID{500, 502}) {
		t.Errorf("playback streams = %v, want [500 502]", route.PlaybackStreamIndexes)
	}
}

func TestAbsenceOfMeetingWaits(t *testing.T) {
	snapshot := loadFixture(t)
	snapshot.SourceOutputs = nil
	_, err := SelectMeetingRoute(snapshot)
	if !errors.Is(err, ErrNoMeeting) {
		t.Fatalf("error = %v, want ErrNoMeeting", err)
	}
}

func TestFallbackToDefaultsWhenStreamTargetsCannotBeResolved(t *testing.T) {
	snapshot := loadFixture(t)
	snapshot.SourceOutputs[0].Source = 999
	snapshot.SinkInputs[0].Sink = 998
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		t.Fatalf("SelectMeetingRoute() error = %v", err)
	}
	if route.CaptureSource.Index != 11 || route.PlaybackSink.Index != 31 || route.PlaybackMonitor.Index != 21 {
		t.Errorf("fallback route = source %d sink %d monitor %d, want 11/31/21", route.CaptureSource.Index, route.PlaybackSink.Index, route.PlaybackMonitor.Index)
	}
	if !route.UsedDefaultSource || !route.UsedDefaultSink {
		t.Error("route did not report default-device fallback")
	}
	if err := ValidateRoute(snapshot, route); err != nil {
		t.Fatalf("fallback route failed immediate validation: %v", err)
	}
}

func TestAmbiguousCaptureRoutingFails(t *testing.T) {
	snapshot := loadFixture(t)
	snapshot.SourceOutputs = append(snapshot.SourceOutputs, SourceOutput{
		Index: 402, Client: 100, Source: 11, Corked: false,
		Properties: Properties{"media.name": "WebRTC VoiceEngine", "media.role": "phone"},
	})
	_, err := SelectMeetingRoute(snapshot)
	var ambiguous *AmbiguousError
	if !errors.As(err, &ambiguous) {
		t.Fatalf("error = %v, want AmbiguousError", err)
	}
}

func TestValidateRouteDetectsDeviceDisappearance(t *testing.T) {
	snapshot := loadFixture(t)
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Sources = slices.DeleteFunc(snapshot.Sources, func(source Source) bool {
		return source.Index == route.CaptureSource.Index
	})
	if err := ValidateRoute(snapshot, route); err == nil {
		t.Fatal("ValidateRoute() succeeded after microphone disappeared")
	}
}

func TestValidateRouteDetectsBrowserRerouting(t *testing.T) {
	snapshot := loadFixture(t)
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SourceOutputs[0].Source = 11
	if err := ValidateRoute(snapshot, route); err == nil {
		t.Fatal("ValidateRoute() succeeded after capture stream was rerouted")
	}
}

func TestValidateFallbackRouteDetectsNewTarget(t *testing.T) {
	snapshot := loadFixture(t)
	snapshot.SourceOutputs[0].Source = 999
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SourceOutputs[0].Source = 10
	if err := ValidateRoute(snapshot, route); err == nil {
		t.Fatal("ValidateRoute() succeeded after fallback capture target changed")
	}
}

func TestValidateFallbackRouteDetectsDefaultDeviceChange(t *testing.T) {
	snapshot := loadFixture(t)
	snapshot.SourceOutputs[0].Source = 999
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Info.DefaultSourceName = "alsa_input.device-a.mono"
	if err := ValidateRoute(snapshot, route); err == nil {
		t.Fatal("ValidateRoute() succeeded after default microphone changed")
	}
}

func TestValidateRouteAllowsStreamsToDisappearDuringSilence(t *testing.T) {
	snapshot := loadFixture(t)
	route, err := SelectMeetingRoute(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SourceOutputs = nil
	snapshot.SinkInputs = nil
	if err := ValidateRoute(snapshot, route); err != nil {
		t.Fatalf("ValidateRoute() error = %v after streams disappeared", err)
	}
}

func loadFixture(t *testing.T) Snapshot {
	t.Helper()
	listJSON, err := os.ReadFile("testdata/pactl-list.json")
	if err != nil {
		t.Fatal(err)
	}
	infoJSON, err := os.ReadFile("testdata/pactl-info.json")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := ParseSnapshot(listJSON, infoJSON)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

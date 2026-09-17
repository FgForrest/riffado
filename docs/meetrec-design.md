# meetrec audio discovery design

## Decision

`meetrec` queries the PulseAudio compatibility server with:

```text
pactl --format=json list
pactl --format=json info
```

This is a structured API over `pipewire-pulse`, not parsing the human-readable
`pactl list` or `wpctl status` output. A snapshot directly exposes:

- source outputs (capture streams) and their current `source` indexes;
- sink inputs (playback streams) and their current `sink` indexes;
- client application metadata used to recognize browsers;
- each sink's authoritative `monitor_source` name;
- current default source and sink names for conservative fallback.

The resulting route is:

```text
browser source-output -> physical source
browser sink-input    -> sink -> sink monitor source
```

Hardware descriptions are display-only. Selection never searches for vendor,
USB, Bluetooth, headset, speakerphone, or laptop names, so changing hardware
does not require a code or configuration change.

## Alternatives considered

### Native PipeWire API

Walking nodes, ports, and links provides the richest graph and was validated on
a live PipeWire 1.6.8 system. In Go it also requires cgo, PipeWire headers, and
distro-specific shared-library packaging. The recorder still needs a stable
Pulse source name for FFmpeg. Native traversal therefore adds deployment cost
without improving the source/sink decision available through the compatibility
server.

### `pw-dump`

`pw-dump` produces structured JSON containing nodes, ports, and links. It can
map browser nodes to devices accurately, but reconstructing a routed stream
requires joining several object types and translating the chosen sink back to
its Pulse monitor name. It also adds another required executable. It remains a
useful future fallback if a distribution exposes incomplete Pulse metadata.

### Human-oriented `wpctl` or `pactl` output

These formats are localized and presentation-oriented. They were rejected as
too fragile for discovery. No such parsing exists in the implementation.

## Selection and fallback

1. Join each capture/playback stream to its client and recognize the browser by
   portal application ID or process binary. Application names are used only
   when stronger identity metadata is absent.
2. Prefer active streams marked as communication/phone or carrying common
   WebRTC media names.
3. If communication metadata is absent, use active streams from the same
   recognized browser.
4. Resolve the stream's actual source and sink indexes. Only if an index cannot
   be resolved, use the server's current default source or sink.
5. Resolve the sink's declared monitor source. The code never invents a monitor
   name by appending a suffix.
6. Fail on equally ranked routes to different devices. Multiple browser streams
   to the same device are safe and collapse to one route.

A browser capture stream must be active or communication-marked before a route
is eligible. With no eligible meeting, the CLI polls every two seconds and can
be started before joining. It does not immediately record defaults merely
because no meeting exists.

## Recording pipeline

FFmpeg opens the selected physical source and playback monitor independently.
Each input is converted to 48 kHz mono and passes through `aresample` with
timestamp correction (`async=100`, at most 100 samples of soft correction per
second). This compensates for long-term drift between independent hardware
clocks while preserving each Pulse input's wall-clock timestamps.

The two streams are mixed with equal weights and normalization, followed by a
0.95 limiter. The output is mono Opus in Ogg at 48 kHz, variable bitrate,
80 kbit/s, with the Opus VoIP application mode. Mono is intentional for speech
recognition and avoids spending bitrate on spatial information that does not
help transcription.

Before mixing, FFmpeg's `astats` filter measures each input's peak level and
`ametadata` sends the values through dedicated inherited pipes. The CLI renders
separate microphone and remote-playback bars on one terminal row. Metering is
read-only, happens before the mix, and is disabled when output is redirected.

FFmpeg receives SIGINT on normal shutdown so it can write the final Ogg pages.
It runs in its own process group; SIGTERM and SIGKILL are bounded fallbacks, so
no encoder process is left behind.

## Route monitoring

While recording, the graph is checked every two seconds. Device or monitor loss
and browser rerouting must be observed twice consecutively before the recorder
stops and finalizes a partial file. Stream disappearance alone is tolerated
because browsers may cork or remove streams during quiet periods.

## References

- [PipeWire PulseAudio compatibility](https://pipewire.pages.freedesktop.org/pipewire/page_pulseaudio.html)
- [`pw-dump` JSON state](https://docs.pipewire.org/page_man_pw-dump_1.html)
- [PipeWire links](https://docs.pipewire.org/group__pw__link.html)
- [FFmpeg resampler options](https://ffmpeg.org/ffmpeg-resampler.html)
- [FFmpeg `amix` filter](https://ffmpeg.org/ffmpeg-filters.html#amix)
- [FFmpeg `astats` filter](https://ffmpeg.org/ffmpeg-filters.html#astats-1)
- [FFmpeg `ametadata` filter](https://ffmpeg.org/ffmpeg-filters.html#metadata_002c-ametadata)

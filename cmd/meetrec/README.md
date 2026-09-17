# meetrec

`meetrec` records the microphone and remote playback used by a browser meeting
into one speech-optimized Ogg/Opus file. Device selection follows the active
audio routes; it does not match hardware vendor names or require a config file.

## Requirements

- Linux with PipeWire, WirePlumber, and `pipewire-pulse`
- `pactl` with JSON output support (commonly packaged as `pulseaudio-utils`)
- FFmpeg with PulseAudio input and the `libopus` encoder
- Go 1.22 or newer to build

On Ubuntu 24.04:

```bash
sudo apt install golang-go ffmpeg pulseaudio-utils pipewire pipewire-pulse wireplumber
```

## Happy path

From the repository root:

```bash
# build
go build -o meetrec ./cmd/meetrec

# start recording, before or after joining the meeting
./meetrec

# stop
Ctrl+C

# result
./meeting-YYYY-MM-DD_HH-MM-SS.ogg
```

Alternatively, the bundled build script produces a stripped, standalone binary
beside the CLI source:

```bash
./cmd/meetrec/build.sh
./cmd/meetrec/meetrec
```

The default output is always created in the current working directory. Use
`--output FILE` to choose another path. Existing files are never overwritten.

## Diagnostics

```bash
meetrec --list
meetrec --list --debug
meetrec --verbose
```

`--list` reports recognized browser streams, their current source/sink routes,
all sources, sink monitors, and the route that would be recorded. It does not
start FFmpeg.

During recording, an interactive terminal shows independent live meters for the
microphone and remote playback:

```text
Mic [######..........] Remote [########........]
```

The row updates in place and is omitted when standard output is redirected.

Supported browser identities currently include Google Chrome, Chromium,
Firefox, Brave, Vivaldi, and Microsoft Edge. The matching table is isolated in
`audio/discovery/select.go` so more applications can be added without changing
route selection.

## Route changes

Version 1 deliberately stops instead of trying to reconnect FFmpeg when the
selected microphone or output disappears, or when the meeting application is
rerouted. Two consecutive checks must agree before recording stops. The partial
Ogg file is finalized and its path is printed. Silence and temporary removal of
browser stream objects do not stop a recording while the selected devices and
monitor remain available.

Users are responsible for obtaining consent and complying with applicable laws
before recording a meeting.

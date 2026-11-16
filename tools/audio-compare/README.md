# Audio comparison

Run from the extension directory with Node 24 or newer after `npm ci`.

```sh
npm run compare -- '/absolute/path/to/track.mp3'
```

Open <http://127.0.0.1:4178/compare/>. The optional path supplies the initial track.
Without a path, use **Change file**. The server binds to localhost and serves the
specified audio file and the comparison's code dependencies. All decoding and DSP
run in the browser. The source recording stays outside the repository.

Choose the excerpt start, duration and speed, then render. Select a version during
playback to keep the same output position, with a 25 ms fade. The numbered keys
select versions and Space toggles playback. RMS matching uses gain reduction and
shared peak headroom. It is an approximate loudness match across the whole excerpt.

## Versions

| Version | Processing |
|---|---|
| Signalsmith current tab | Source resampling followed by the pre-fix pitch/formant settings |
| Signalsmith corrected tab | Same source resampling, with formant shift relative to the original track |
| Signalsmith audio file | Direct buffer time stretch using the extension's current settings |
| Rubber Band R3 tab | Resampled source, R3 real-time pitch correction, ChannelsTogether, PitchHighQuality |
| Rubber Band R3 audio file | Original buffer, R3 offline study/process passes, ChannelsTogether |

All versions preserve pitch, use stereo 48 kHz audio and omit reverb and dynamics.
Live input latency is cropped before comparison. Rendered excerpts isolate algorithm
quality. Reported render time includes setup and processing, and does not establish
AudioWorklet real-time CPU load or underrun performance.

Signalsmith uses our packaged 1.3.2 build. Rubber Band uses the development dependency
`rubberband-wasm@3.3.0`, whose build script pins Rubber Band 3.3.0 and exposes R3 Finer.
Its GPLv2 license and source/build instructions are in the installed package and the
[upstream repository](https://github.com/Daninet/rubberband-wasm).
The comparison loads that dependency from `node_modules`. The extension runtime uses
Signalsmith. Commercial distribution of Rubber Band in a proprietary application
requires the vendor's commercial licence.
[Rubber Band licensing](https://breakfastquay.com/rubberband/).

## Formant correction

A browser player with `preservesPitch=false` scales both pitch and formant frequencies
by its playback rate. Signalsmith's `formantCompensation=true` preserves its input
envelope. To recover the original envelope, the live path now also supplies
`formantSemitones = -12 * log2(speed)`. The direct file path supplies zero because its
input is the original recording. Disabled compensation and Original bypass supply zero.

The browser regression uses a harmonic source with an envelope centred at 1000 Hz.
At 0.75× the measured centre changed from 970.72 Hz to 1003.45 Hz. At 1.20× it changed
from 1007.91 Hz to 998.76 Hz. These measurements validate the correction on that signal.
Listening comparisons determine its benefit for a musical mix.

Run `npm run e2e` for extension and formant checks. With this server running and the
20-second initial track excerpt available, run `node tests/smoke.mjs --compare` for
the five rendered variants, switching, seek, pause and responsive layout checks.

## Live comparison

Open <http://127.0.0.1:4178/compare/realtime.html> to process the track through a real
AudioContext and AudioWorklet. The page runs one engine at a time. Engine and speed
changes rebuild the processor at the current source position. Volume affects playback.

Signalsmith uses the extension's corrected live settings and default quality profile.
Rubber Band uses R3 Finer, ChannelsTogether, PitchHighQuality and a 4096-frame output
prefill. A second R3 option enables WindowShort. A 65536-frame circular buffer absorbs
variable output sizes. Missing frames and overflow are counted explicitly. The Native
option measures the page and audio pipeline baseline with source resampling.

Metrics start after three seconds of warm-up. The worklet wrapper measures callback
wall time, counts over-budget callbacks and exact-zero output blocks with active input.
Chrome currently exposes `Date.now()` in this worklet with millisecond resolution.
Average callback duty and peak times are approximate. An over-budget callback indicates
deadline risk. Device underruns come separately from `AudioContext.playbackStats` when
available, with the value shown as unavailable in browsers lacking that API.

The repeatable measurement command opens a disposable, headed Chrome instance and
plays the local track. Keep the comparison server running.

```sh
HEADED=1 node tests/smoke.mjs --live
```

It measures 30 seconds per condition after warm-up, closes each AudioContext before
the next run, and saves `docs/data/realtime-benchmark.json`. `SystemInfo.getProcessInfo`
provides cumulative process CPU seconds for the isolated Chrome instance. The reported
CPU percentage sums the deltas and divides by elapsed wall time. 100% equals one core.
It includes browser UI, renderer and audio service costs. The native run supplies a
baseline. Reload the page to display the saved results.

The [recorded results](../../docs/REALTIME-COMPARISON.md) describe the tested hardware,
settings and limits. Run `HEADED=1 node tests/smoke.mjs --live-ui` to verify live engine
switching, context cleanup, the saved-results table and responsive layout.

Use `BENCH_QUICK=1 BENCH_SECONDS=5 HEADED=1 node tests/smoke.mjs --live` for a short
Signalsmith/Rubber Band smoke check saved under `/tmp`. The live measurements cover
local source resampling, worklet DSP and device playback. Website tab capture and DRM
integration need their own measurements.

References for the timing and buffering methods are the
[Web Audio playback statistics specification](https://www.w3.org/TR/webaudio-1.1/#audioplaybackstats)
and [Rubber Band integration notes](https://breakfastquay.com/rubberband/integration.html).

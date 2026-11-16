# Signalsmith Stretch 1.3.2

Upstream: https://github.com/Signalsmith-Audio/signalsmith-stretch
Official npm artifact: https://registry.npmjs.org/signalsmith-stretch/-/signalsmith-stretch-1.3.2.tgz
Artifact SHA-256: 345e774c8d5f680bc0156d788ff0f3f08d47bd307a8a262a7c0d5d887b230909

`SignalsmithStretch.js` contains the official Emscripten WASM build embedded as
base64 and the upstream Web Audio wrapper. No DSP code or WASM bytes were changed.
Local wrapper-only modifications:

1. Remove the generated Blob worklet fallback; require an explicit packaged moduleUrl.
2. Add `dispose` RPC and an early process() return false to release unused nodes.
3. Propagate WASM initialization errors to the main-thread Promise; reject on processorerror.

The original npm source can be downloaded from the pinned artifact above to diff
these changes. This is a vendored dependency; formatting rules for application
code should not rewrite its minified Emscripten section.

MIT notices: LICENSE.txt (Signalsmith Stretch) and LINEAR-LICENSE.txt (the Signalsmith
Linear dependency). The web API README is preserved as UPSTREAM-README.md.
License sources retrieved 2026-11-11:
https://raw.githubusercontent.com/Signalsmith-Audio/signalsmith-stretch/main/LICENSE.txt
https://raw.githubusercontent.com/Signalsmith-Audio/linear/main/LICENSE.txt

The runtime loads only these packaged files. No CDN, telemetry or remote code.

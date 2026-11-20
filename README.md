# slowed & reverb

Chrome extension for changing playback speed and adding reverb to browser tabs and local audio files. Rubber Band R3 is the default audio engine. Signalsmith is available for lower CPU use. Local recordings can be exported as WAV.

## Build version 0.9.1

Install Node.js 24 or newer, then run the following commands.

```sh
npm ci
npm run compile
npm test
npm run build
npm run zip
```

Load `.output/chrome-mv3` using Chrome’s Load unpacked command. The ZIP in `.output` is the store package.

The `v0.9.1` tag identifies the source for the Chrome Web Store release. Runtime code is in `entrypoints`, `utils` and `public`. The repository includes build configuration, unit tests, icon sources and third-party source archives.

## Licensing and corresponding source

Copyright (c) 2026 Anton Kopylov. The application is distributed under GNU GPL version 2. See LICENSE. Third-party notices and licenses are included beside their files in `public/vendor`, `public/fonts` and `public/assets`.

`vendor-src/rubberband-wasm-source.tar.gz` contains the binding source at commit `ecb2028a6af90804e79d91f72973f460c6d3c77b`, the npm 3.3.0 release commit. `vendor-src/rubberband-3.3.0.tar.bz2` contains the corresponding Rubber Band C++ source.

To rebuild Rubber Band WASM, unpack the binding archive, put the Rubber Band source under its `lib/rubberband` directory and retain the source archive as `lib/rubberband-3.3.0.tar.bz2`. Install Emscripten and the binding project’s npm dependencies, then run its `npm run build`. The compiler flags and build steps are in its `build.sh`. The extension’s `public/vendor/rubberband` contains the distributed WASM and bindings from npm `rubberband-wasm@3.3.0`.

Signalsmith is distributed under MIT. Its pinned source artifact and the local wrapper modifications are documented in `public/vendor/signalsmith/NOTICE.md`. The bundled music demo is CC BY 3.0, with attribution in `public/assets/CREDITS.md`. Onest is under the SIL Open Font License. Lucide icons are under ISC.

## Product and feedback

https://slowedandreverb.online/

https://github.com/tonic20/slowed-and-reverb/issues

# Slowed and Reverb · Chrome Web Store

Use the [English description](../FULL-DESCRIPTION.txt), [keyword table](../LISTING-KEYS.md) and [localized titles, summaries and descriptions](_locales/). The manifest uses only the title and summary from each translation. The popup labels stay in English. Version 0.9.0 targets desktop Chrome 116 and later.

## Store graphics

| Upload | File | Subject |
|---|---|---|
| Small promotional tile | [440 × 280](out/promo-small.png) | Product name and record icon |
| Screenshot 1 | [1280 × 800](out/01-studio.png) | Slowed preset on a local recording |
| Screenshot 2 | [1280 × 800](out/02-tempo.png) | Speed with pitch preserved |
| Screenshot 3 | [1280 × 800](out/03-space.png) | Dream preset and hall ambience |
| Screenshot 4 | [1280 × 800](out/04-export.png) | WAV download and tail controls |
| Screenshot 5 | [1280 × 800](out/05-engines.png) | Rubber Band R3 and processing quality settings |
| Store icon | [128 × 128](out/store-icon-128.png) | 96 px mark centered on transparency |

The controls in [ui/](ui/) come from the production popup document with the bundled vocal demo. From the extension directory, run `npm run capture:store`. From the repository root, run `node scripts/store/render-store-graphics.ts extensions/slowed-reverb/docs/store` to rebuild the upload PNGs. The capture also refreshes the homepage popup and welcome-page preset images. The homepage uses the same studio screenshot. The recording credits and license also appear next to the audio players on the homepage.

## Homepage audio

From the extension directory, run `node tests/smoke.mjs --site-audio` after building the extension. This requires Chrome and FFmpeg. The script processes the existing ten-second `site/assets/original.mp3` excerpt through the extension’s `renderAudio` and `encodeWav` functions, then encodes `site/assets/slowed.mp3` at 192 kbps. Rubber Band R3, High quality and the factory Slowed preset are used, with pitch preservation, 0.82× speed, 32% reverb and the reverb tail included. The processed file is 15.220125 seconds long. Source attribution remains visible beside the player.

## Listing and package

The English primary phrase is **slowed and reverb**. The keyword table records US estimates, the two short-description options and exclusions. For keyword comparisons the November 11 research contains the [15 competitor listings](../../../../docs/research/audio/2026-11-11/data/listings.json). Counting title, short and full descriptions, our listing uses 22 of 28 researched terms. The three leading comparison texts were 836, 626 and 2,468 characters and did not use the exact title phrase.

From the repository root:

```sh
ext=extensions/slowed-reverb
node scripts/store/translate-codex.ts "$ext/docs/store/_locales" "$ext/docs/store/_locales"
node scripts/store/check-translations.ts "$ext/docs/store/_locales"
(cd "$ext" && npm run locales && npm run compile && npm test && npm run zip)
```

The translator skips existing outputs. When changing the English source, generate into a fresh output directory, validate, then replace the translations. Use `docs/store/_locales/<language>/messages.json` for store upload. Use the ZIP produced in `.output/` for the extension package. The store requires a published item before visitors can install from a public listing.

## Web pages and feedback

- [Product homepage and audio comparison](https://slowedandreverb.online/)
- [Quick start for fresh installations](https://slowedandreverb.online/welcome/)
- [Optional uninstall feedback](https://slowedandreverb.online/uninstall/)
- [Privacy policy](https://slowedandreverb.online/privacy/)
- [Public feedback form](https://docs.google.com/forms/d/e/1FAIpQLSfWFJSJab-uvXUjRBXhiUB9QHrbAHAIpoPiGk5Nj-qy5sJhCQ/viewform)

The standalone website is hosted on private S3 behind CloudFront. See [deployment instructions](../../infra/README.md). After publication, link the assigned Chrome Web Store listing from the homepage.

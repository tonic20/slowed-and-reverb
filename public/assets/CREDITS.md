# Vocal demo

**A Foolish Game** — **Madam Snowflake**, featuring **Admiral Bob** (2014).

- Original recording and attribution: https://ccmixter.org/files/snowflake/46164
- Author: https://ccmixter.org/people/snowflake
- License: **Creative Commons Attribution 3.0 Unported (CC BY 3.0)**,
  https://creativecommons.org/licenses/by/3.0/
- Source audio: https://ccmixter.org/content/snowflake/snowflake_-_A_Foolish_Game.mp3
- Source metadata verified 2026-11-11 on the recording's ccMixter page.

`vocal-demo.mp3` is an adapted excerpt: original timestamps **00:15–00:55**,
80 ms fade-in, 500 ms fade-out, re-encoded to stereo MP3 at 160 kbps.
No pitch or speed changes were applied to the bundled file.
Attribution and a license link are also displayed beside the demo in the editor.
The artists do not endorse this prototype.

If you redistribute exported remixes of this demo, retain the artist/title,
source and CC BY 3.0 link, and identify your further changes.

Reproduce the excerpt from the original downloaded recording:

```sh
ffmpeg -ss 15 -i original.mp3 -t 40 \
  -af 'afade=t=in:st=0:d=0.08,afade=t=out:st=39.5:d=0.5' \
  -c:a libmp3lame -b:a 160k vocal-demo.mp3
```

import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Use the shipped WAV renderer and the existing licensed homepage excerpt.
export async function renderSiteAudio({ page, base, root }) {
  const tab = await page(`${base}/tests/audio.html`);
  await tab.evaluate(`window.siteRender = (async () => {
    const { renderAudio, encodeWav } = await import('/utils/audio/engine.js');
    const { defaults } = await import('/utils/settings.js');
    const context = new AudioContext({ sampleRate: 48000 });
    try {
      const source = await fetch('/site/assets/original.mp3');
      if (!source.ok) throw Error('Homepage source could not be loaded');
      const buffer = await context.decodeAudioData(await source.arrayBuffer());
      const settings = { ...defaults, engine: 'rubberband', quality: 'high' };
      const audio = await renderAudio(buffer, settings);
      const { blob } = encodeWav(audio, settings.safe);
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      window.siteAudio = { base64, duration: audio.duration, settings };
    } finally {
      await context.close();
    }
  })().catch(error => { window.siteAudioError = error.message; }); void 0`);
  let result;
  for (let attempt = 0; attempt < 120; attempt++) {
    const error = await tab.evaluate('window.siteAudioError');
    if (error) throw Error(error);
    result = await tab.evaluate('window.siteAudio');
    if (result) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!result) throw Error('Homepage audio render timed out');
  const temporary = await mkdtemp(resolve(tmpdir(), 'slowed-site-audio-'));
  try {
    const wav = resolve(temporary, 'slowed.wav');
    await writeFile(wav, Buffer.from(result.base64, 'base64'));
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      wav,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '192k',
      resolve(root, 'site/assets/slowed.mp3'),
    ]);
    console.log('Rendered homepage sample', { duration: result.duration, settings: result.settings });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

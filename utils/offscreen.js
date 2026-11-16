import { browser as chrome } from 'wxt/browser';
import { AudioEngine, renderAudio, encodeWav } from './audio/engine.js';
import { storedFile } from './file-store.js';
import { normalize } from './settings.js';
import { bounded } from './audio/lifecycle.js';
import { listeningRun } from './rating.js';

const engine = new AudioEngine(),
  urls = new Set();
const countListening = listeningRun();
let listeningAt = performance.now();
setInterval(() => {
  const now = performance.now(),
    elapsed = now - listeningAt;
  listeningAt = now;
  const source = engine.mode === 'browser' ? engine.stream : engine.mode === 'file' ? engine.buffer : null;
  if (countListening(source, engine.playing && !engine.failure && engine.level() > 0.001, elapsed)) {
    void chrome.runtime
      .sendMessage({ target: 'worker', command: 'RATING_RUN', id: crypto.randomUUID() })
      .catch(() => {});
  }
}, 1000);
let fileInfo = null,
  tabId = null,
  exporting = false;
function snapshot() {
  return {
    mode: engine.mode,
    playing: engine.playing,
    position: engine.currentTime(),
    duration: engine.mode === 'file' ? engine.buffer?.duration || 0 : 0,
    file: fileInfo,
    tabId,
    level: engine.level(),
    latency: engine.latency || 0,
    processor: engine.path?.node ? engine.path.node.engine || 'signalsmith' : 'native',
    dspStatistics: engine.path?.node?.statistics || null,
    deviceUnderrunSeconds: engine.context?.playbackStats?.underrunDuration ?? null,
    exporting,
    failure: engine.failure,
  };
}
async function recover(error, path) {
  const source = engine.mode,
    capturedTab = tabId;
  let recovered = false;
  try {
    recovered = await engine.recover(error, path);
  } catch (fallbackError) {
    await engine.clearSource();
    engine.failure = { source, message: fallbackError.message };
    recovered = true;
  }
  if (recovered && source === 'browser') {
    engine.failure.tabId = capturedTab;
    tabId = null;
    engine.mode = engine.buffer ? 'file' : null;
    // Do not await the worker while holding the audio lock: UPDATE may be waiting on us.
    void chrome.runtime
      .sendMessage({ target: 'worker', command: 'DSP_FAILED', tabId: capturedTab, error: error.message })
      .catch(() => {});
  }
}
engine.onFailure = (error, path) => {
  void navigator.locks.request('sr-audio-operation', () => recover(error, path)).catch(console.error);
};
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sr-meter' || port.sender?.id !== chrome.runtime.id) return;
  const send = () => {
    try {
      const level = engine.level();
      port.postMessage({ bands: level > 0.001 ? engine.spectrum() : [0, 0, 0, 0, 0] });
    } catch {
      clearInterval(timer);
    }
  };
  const timer = setInterval(send, 33);
  port.onDisconnect.addListener(() => clearInterval(timer));
  send();
});
async function loadFile(demo, pending = false) {
  let blob, name;
  if (demo) {
    const response = await fetch(chrome.runtime.getURL('assets/vocal-demo.mp3'));
    blob = await response.blob();
    name = 'A Foolish Game.mp3';
  } else {
    const stored = await storedFile('get', null, pending ? 'pending' : 'current');
    if (!stored) throw Error('Choose an audio file first.');
    blob = stored.blob;
    name = stored.name;
  }
  if (blob.size > 50 * 1024 * 1024) throw Error('Choose a file smaller than 50 MB.');
  const decoder = new AudioContext();
  let buffer;
  try {
    buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw Error('This audio file could not be decoded. Try MP3, WAV, M4A, OGG or FLAC.');
  } finally {
    await decoder.close();
  }
  if (buffer.duration > 600 || buffer.numberOfChannels > 2)
    throw Error('Use a mono or stereo file up to 10 minutes long.');
  if (buffer.duration <= 0) throw Error('This audio file is empty.');
  if (pending) await storedFile('put', { name, blob });
  await engine.setBuffer(buffer);
  tabId = null;
  fileInfo = { name, size: blob.size, duration: buffer.duration, sampleRate: buffer.sampleRate, demo: !!demo };
  return snapshot();
}
async function command(message) {
  if (message.command === 'STATUS') return snapshot();
  if (message.command === 'PREPARE') {
    await engine.prepareUpdate(message.settings);
    return snapshot();
  }
  if (message.command === 'RETRY') {
    await engine.retry();
    return snapshot();
  }
  if (message.command === 'UPDATE') {
    if (engine.failure && engine.failure.source !== message.settings.source) engine.failure = null;
    await engine.update(message.settings);
    return snapshot();
  }
  if (message.command === 'CONNECT') {
    await engine.clearSource();
    engine.failure = null;
    tabId = null;
    let stream;
    try {
      stream = await bounded(
        navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } },
          video: false,
        }),
        15000,
        (late) => late.getTracks().forEach((track) => track.stop()),
      );
      await engine.update(message.settings);
      await engine.setStream(stream);
      tabId = message.tabId;
      const capturedStream = stream,
        capturedTab = tabId;
      for (const track of stream.getTracks())
        track.addEventListener(
          'ended',
          () => {
            if (engine.stream !== capturedStream) return;
            void chrome.runtime
              .sendMessage({ target: 'worker', command: 'CAPTURE_ENDED', tabId: capturedTab })
              .catch(() => {});
          },
          { once: true },
        );
      return snapshot();
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      await engine.clearSource();
      throw error;
    }
  }
  if (message.command === 'DISCONNECT') {
    await engine.clearSource();
    tabId = null;
    engine.mode = engine.buffer ? 'file' : null;
    return snapshot();
  }
  if (message.command === 'LOAD') {
    try {
      return await loadFile(message.demo, message.pending);
    } finally {
      if (message.pending) await storedFile('delete', null, 'pending');
    }
  }
  if (message.command === 'REMOVE') {
    if (engine.mode !== 'browser') {
      await engine.clearSource();
      engine.mode = null;
    }
    engine.buffer = null;
    fileInfo = null;
    if (engine.failure?.source === 'file') engine.failure = null;
    await storedFile('delete');
    return snapshot();
  }
  if (message.command === 'PLAY') {
    if (engine.playing) await engine.pause();
    else await engine.play();
    return snapshot();
  }
  if (message.command === 'PAUSE') {
    await engine.pause();
    return snapshot();
  }
  if (message.command === 'SEEK') {
    await engine.seek(message.position);
    return snapshot();
  }
  if (message.command === 'EXPORT') {
    if (!engine.buffer) throw Error('Choose an audio file first.');
    if (exporting) throw Error('An export is already in progress.');
    exporting = true;
    try {
      await engine.pause();
      const buffer = await renderAudio(engine.buffer, message.settings);
      const { blob, gain } = encodeWav(buffer, message.settings.safe);
      const url = URL.createObjectURL(blob);
      urls.add(url);
      // Strip characters forbidden in download filenames, including ASCII control characters.
      return {
        url,
        gain,
        filename:
          (fileInfo.name
            .replace(/\.[^.]+$/, '')
            // oxlint-disable-next-line no-control-regex
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .slice(0, 100) || 'audio') + '-slowed-reverb.wav',
      };
    } finally {
      exporting = false;
    }
  }
  if (message.command === 'REVOKE') {
    if (urls.has(message.url)) {
      URL.revokeObjectURL(message.url);
      urls.delete(message.url);
    }
    return null;
  }
  throw Error('Unknown audio command.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'audio') return;
  (async () => {
    try {
      const value = await navigator.locks.request('sr-audio-operation', async () => {
        try {
          return await command(message);
        } catch (error) {
          if (
            ['PLAY', 'UPDATE', 'RETRY', 'SEEK'].includes(message.command) &&
            engine.mode === 'file' &&
            engine.buffer
          ) {
            if (message.command === 'PLAY' && !engine.playing) {
              engine.anchor = engine.context?.currentTime || 0;
              engine.playing = true;
            }
            await recover(error, engine.path);
            if (message.settings) engine.settings = normalize(message.settings);
            return snapshot();
          }
          throw error;
        }
      });
      respond({ ok: true, value });
    } catch (error) {
      respond({ ok: false, error: error.message });
    }
  })();
  return true;
});
setInterval(() => {
  if (engine.mode === 'file' && engine.playing && engine.currentTime() >= engine.buffer.duration) {
    void navigator.locks.request('sr-audio-operation', async () => {
      // A queued seek/play may have changed the source before this lock is acquired.
      if (engine.mode === 'file' && engine.playing && engine.currentTime() >= engine.buffer.duration)
        await engine.pause();
    });
  }
}, 200);

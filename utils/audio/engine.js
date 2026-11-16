import { effective, normalize, pitchFor } from '../settings.js';
import { effects } from './effects.js';
import { needsStretch } from './routing.js';
import { bounded, wait, FADE_SECONDS } from './lifecycle.js';
import { rubberbandNode, renderRubberBand, RUBBERBAND_FILE_LATENCY } from './rubberband.js';

const factory = globalThis.SignalsmithStretch;
factory.moduleUrl = new URL('/vendor/signalsmith/SignalsmithStretch.js', location.href).href;
export function release(node) {
  if (!node) return;
  if (node.dispose) return node.dispose();
  node.onprocessorerror = null;
  try {
    node.disconnect();
    node.port.postMessage([-1, 'dispose']);
    node.port.close();
  } catch {
    /* Failed or retired processor. */
  }
}
export async function stretchNode(context, quality) {
  const node = await bounded(
    factory(context, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }),
    undefined,
    release,
  );
  try {
    await bounded(node.configure({ preset: quality === 'light' ? 'cheaper' : 'default' }));
    return node;
  } catch (error) {
    release(node);
    throw error;
  }
}
export async function loadBuffer(node, buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
  await node.addBuffers(
    channels,
    channels.map((channel) => channel.buffer),
  );
}
export function scheduleOptions(settings, live = false) {
  const s = effective(settings);
  return {
    active: true,
    rate: s.speed,
    semitones: pitchFor(s, live),
    tonalityHz: 24000,
    formantCompensation: !s.bypass && s.formant,
    // Tab input has already been resampled by the page. Preserve the original
    // envelope, rather than the envelope after playbackRate shifted it.
    formantSemitones: live && !s.bypass && s.formant ? -12 * Math.log2(s.speed) : 0,
    formantBaseHz: 0,
  };
}
export async function renderAudio(buffer, value) {
  const s = effective(value),
    padding = needsStretch(s) && s.engine !== 'rubberband' ? 0.5 : 0;
  const tail = !s.bypass && s.wet && s.exportTail ? Number(s.tail) + Number(s.delay) / 1000 : 0;
  const frames = Math.ceil((buffer.duration / s.speed + tail) * buffer.sampleRate);
  if ((frames + padding * buffer.sampleRate) * 8 > 240 * 1024 * 1024)
    throw Error('This export is too large. Use a shorter file or a faster speed.');
  const context = new OfflineAudioContext(2, Math.ceil(padding * buffer.sampleRate) + frames, buffer.sampleRate);
  let node, graph, processorError, rejectFailure;
  const listeners = [];
  const failed = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  // Preparation can fail before rendering starts; keep this rejection handled throughout.
  void failed.catch(() => {});
  const watch = (processor) => {
    const handler = () => {
      processorError = Error('The audio processor stopped during export. Please retry.');
      rejectFailure(processorError);
    };
    processor.addEventListener('processorerror', handler);
    listeners.push([processor, handler]);
  };
  try {
    if (s.bypass) {
      const source = context.createBufferSource(),
        volume = context.createGain();
      source.buffer = buffer;
      volume.gain.value = s.volume / 100;
      source.connect(volume);
      volume.connect(context.destination);
      source.start();
      return await bounded(context.startRendering(), 60000);
    }
    graph = await bounded(effects(context, s), undefined, (late) => late.dispose());
    watch(graph.output);
    graph.output.connect(context.destination);
    if (needsStretch(s) && s.engine === 'rubberband') {
      const source = context.createBufferSource();
      source.buffer = await renderRubberBand(buffer, s);
      source.connect(graph.input);
      source.start();
    } else if (needsStretch(s)) {
      node = await stretchNode(context, s.quality);
      watch(node);
      await bounded(loadBuffer(node, buffer));
      node.connect(graph.input);
      await bounded(node.schedule({ ...scheduleOptions(s), output: padding, input: 0 }));
    } else {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = s.speed;
      source.connect(graph.input);
      source.start();
    }
    if (processorError) throw processorError;
    const full = await bounded(Promise.race([context.startRendering(), failed]), 60000);
    if (processorError) throw processorError;
    const result = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate: buffer.sampleRate });
    const start = Math.ceil(padding * buffer.sampleRate);
    for (let c = 0; c < 2; c++) result.copyToChannel(full.getChannelData(c).subarray(start, start + frames), c);
    return result;
  } finally {
    for (const [processor, handler] of listeners) processor.removeEventListener('processorerror', handler);
    release(node);
    graph?.dispose();
  }
}
export function encodeWav(buffer, safe = true) {
  const channels = Math.min(2, buffer.numberOfChannels),
    bytes = buffer.length * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes + 36, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let peak = 0;
  for (const channel of data) for (const value of channel) peak = Math.max(peak, Math.abs(value));
  const gain = safe && peak > 0.98 ? 0.98 / peak : 1;
  for (let i = 0; i < buffer.length; i++)
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i] * gain));
      view.setInt16(44 + (i * channels + c) * 2, Math.round(v * (v < 0 ? 32768 : 32767)), true);
    }
  return { blob: new Blob([view], { type: 'audio/wav' }), peak, gain };
}

export class AudioEngine {
  constructor() {
    this.settings = normalize();
    this.position = 0;
    this.playing = false;
    this.mode = null;
    this.path = null;
    this.prepared = null;
    this.failure = null;
    this.onFailure = () => {};
    this.paths = new Set();
    this.latency = 0;
  }
  async init() {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext({ latencyHint: 'playback' });
      this.meter = this.context.createAnalyser();
      this.meter.fftSize = 2048;
      this.meter.smoothingTimeConstant = 0;
      this.samples = new Float32Array(this.meter.fftSize);
      this.frequencies = new Float32Array(this.meter.frequencyBinCount);
      this.meter.connect(this.context.destination);
    }
    await bounded(this.context.resume());
  }
  currentTime() {
    if (!this.playing || this.mode !== 'file') return this.position;
    const speed = this.failure ? 1 : effective(this.settings).speed;
    return Math.min(this.buffer.duration, this.position + Math.max(0, this.context.currentTime - this.anchor) * speed);
  }
  watch(path, node) {
    const handler = () => {
      path.error = Error('The audio processor stopped.');
      if (this.path === path && !this.failure) this.onFailure(path.error, path);
    };
    node.addEventListener('processorerror', handler);
    (path.listeners ??= []).push([node, handler]);
  }
  disposePath(path) {
    if (!path || path.disposed) return;
    path.disposed = true;
    for (const [node, handler] of path.listeners || []) node.removeEventListener('processorerror', handler);
    this.paths.delete(path);
    if (path.source?.stop) {
      try {
        path.source.stop();
      } catch {
        /* Already stopped. */
      }
    }
    path.source?.disconnect();
    path.delay?.disconnect();
    release(path.node);
    path.graph?.dispose();
    path.gain?.disconnect();
  }
  async makePath(value) {
    const settings = normalize(value),
      s = effective(settings),
      live = this.mode === 'browser',
      rubberband = settings.engine === 'rubberband';
    const path = { settings, stretch: needsStretch(s, live), latency: 0 };
    this.paths.add(path);
    try {
      const context = this.context;
      path.gain = context.createGain();
      path.gain.gain.value = 0;
      path.gain.connect(this.meter);
      if (s.bypass) {
        const volume = context.createGain();
        volume.gain.value = s.volume / 100;
        path.graph = {
          input: volume,
          output: volume,
          update: (v) => {
            volume.gain.setTargetAtTime(v.volume / 100, context.currentTime, 0.015);
          },
          dispose: () => volume.disconnect(),
        };
      } else {
        path.graph = await bounded(effects(context, settings), undefined, (graph) => graph.dispose());
        this.watch(path, path.graph.output);
      }
      path.graph.output.connect(path.gain);
      if (path.stretch) {
        path.node = rubberband ? await rubberbandNode(context, settings) : await stretchNode(context, settings.quality);
        this.watch(path, path.node);
        if (!rubberband) path.latency = await bounded(path.node.latency());
        if (!live && !rubberband) await bounded(loadBuffer(path.node, this.buffer));
        if (!live && rubberband) {
          path.latency = RUBBERBAND_FILE_LATENCY;
          path.delay = context.createDelay(1);
          path.delay.delayTime.value = path.latency;
          path.node.connect(path.delay);
          path.delay.connect(path.graph.input);
        } else path.node.connect(path.graph.input);
      }
      if (live) {
        // A separate source node lets the retiring path disconnect without touching the new one.
        path.source = context.createMediaStreamSource(this.stream);
        path.source.connect(path.node || path.graph.input);
        if (path.node?.engine === 'rubberband') path.latency = await bounded(path.node.started);
        else if (path.node) await bounded(path.node.schedule(scheduleOptions(settings, true)));
        path.readyAt = context.currentTime + path.latency + 0.02;
      } else if (!path.node || rubberband) {
        path.source = context.createBufferSource();
        path.source.buffer = this.buffer;
        path.source.playbackRate.value = s.speed;
        path.source.connect(path.node || path.graph.input);
      }
      if (path.error) throw path.error;
      return path;
    } catch (error) {
      this.disposePath(path);
      throw error;
    }
  }
  needsReplacement(next) {
    if (!this.path) return true;
    const live = this.mode === 'browser',
      previous = this.path.settings;
    return (
      effective(previous).bypass !== effective(next).bypass ||
      needsStretch(previous, live) !== needsStretch(next, live) ||
      (needsStretch(next, live) && previous.quality !== next.quality) ||
      (needsStretch(next, live) && previous.engine !== next.engine) ||
      (next.engine === 'rubberband' &&
        needsStretch(next, live) &&
        ['speed', 'keep', 'pitch', 'formant'].some((key) => previous[key] !== next[key]))
    );
  }
  async prepareUpdate(value) {
    this.disposePath(this.prepared);
    this.prepared = null;
    if (this.failure || !this.playing || !this.needsReplacement(normalize(value))) return;
    this.prepared = await this.makePath(value);
  }
  async replacePath(next, candidate = null) {
    const old = this.path,
      path = candidate || (await this.makePath(next)),
      context = this.context;
    try {
      const now = context.currentTime;
      const start = this.mode === 'browser' ? Math.max(now + 0.01, path.readyAt) : now + path.latency + 0.02;
      const position =
        this.mode === 'file'
          ? Math.min(
              this.buffer.duration,
              this.currentTime() +
                (this.playing ? (start - now) * (this.failure ? 1 : effective(this.settings).speed) : 0),
            )
          : 0;
      if (this.mode === 'file') {
        if (path.node?.engine === 'rubberband') {
          path.source.start(start - path.latency, position);
          const processingLatency = await bounded(path.node.started);
          if (processingLatency > path.latency) throw Error('Rubber Band needs more file playback buffering.');
          path.delay.delayTime.setValueAtTime(path.latency - processingLatency, context.currentTime);
        } else if (path.node)
          await bounded(path.node.schedule({ ...scheduleOptions(next), output: start, input: position }));
        else path.source.start(start, position);
      }
      if (path.error) throw path.error;
      path.gain.gain.setValueAtTime(0, start);
      path.gain.gain.linearRampToValueAtTime(1, start + FADE_SECONDS);
      if (old) {
        old.gain.gain.cancelScheduledValues(start);
        old.gain.gain.setValueAtTime(1, start);
        old.gain.gain.linearRampToValueAtTime(0, start + FADE_SECONDS);
      }
      // Keep the old source alive throughout warm-up and crossfade, including file position tracking.
      await wait(Math.max(0, (start + FADE_SECONDS - context.currentTime) * 1000) + 10);
      if (path.error) throw path.error;
      this.path = path;
      this.latency = path.latency;
      this.settings = normalize(next);
      if (this.mode === 'file') {
        this.position = position;
        this.anchor = start;
      }
      this.disposePath(old);
      return path;
    } catch (error) {
      this.disposePath(path);
      if (old && !old.disposed) {
        old.gain.gain.cancelScheduledValues(context.currentTime);
        old.gain.gain.setTargetAtTime(1, context.currentTime, 0.005);
      }
      throw error;
    }
  }
  async clearSource() {
    if (this.mode === 'file') this.position = this.currentTime();
    this.playing = false;
    for (const path of this.paths) this.disposePath(path);
    this.path = null;
    this.prepared = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.latency = 0;
  }
  async setBuffer(buffer) {
    await this.clearSource();
    this.buffer = buffer;
    this.position = 0;
    this.mode = 'file';
    this.failure = null;
  }
  async play() {
    if (!this.buffer) throw Error('Choose an audio file first.');
    await this.init();
    this.mode = 'file';
    if (this.position >= this.buffer.duration) this.position = 0;
    const desired = this.settings;
    await this.replacePath(this.failure ? { ...desired, compare: 'original' } : desired);
    this.settings = desired;
    this.playing = true;
  }
  async pause() {
    if (this.mode === 'file') await this.clearSource();
  }
  async seek(position) {
    const playing = this.playing;
    await this.pause();
    this.position = Math.max(0, Math.min(this.buffer?.duration || 0, Number(position) || 0));
    if (playing) await this.play();
  }
  async setStream(stream) {
    await this.clearSource();
    await this.init();
    this.mode = 'browser';
    this.stream = stream;
    this.failure = null;
    await this.replacePath(this.settings);
    this.playing = true;
  }
  async update(value) {
    const next = normalize(value),
      position = this.currentTime();
    if (this.failure || !this.playing) {
      this.settings = next;
      return;
    }
    const candidate = this.prepared;
    this.prepared = null;
    if (this.needsReplacement(next)) await this.replacePath(next, candidate);
    else {
      this.disposePath(candidate);
      this.path.graph.update(next);
      if (this.path.node && this.path.node.engine !== 'rubberband')
        await bounded(
          this.path.node.schedule({
            ...scheduleOptions(next, this.mode === 'browser'),
            ...(this.mode === 'file' ? { input: position } : {}),
          }),
        );
      else if (this.mode === 'file')
        this.path.source.playbackRate.setValueAtTime(effective(next).speed, this.context.currentTime);
      if (this.mode === 'file') {
        this.position = position;
        this.anchor = this.context.currentTime;
      }
      this.path.settings = next;
      this.settings = next;
    }
  }
  async recover(error, failedPath = this.path) {
    if (failedPath && failedPath !== this.path) return false;
    const desired = this.settings,
      source = this.mode,
      playing = this.playing;
    this.position = this.currentTime();
    this.anchor = this.context?.currentTime || 0;
    this.failure = { source, message: error?.message || String(error) };
    this.disposePath(this.prepared);
    this.prepared = null;
    if (source === 'file' && this.buffer) {
      // Do not wait for, or reuse, any worklet in the emergency path.
      this.disposePath(this.path);
      this.path = null;
      this.playing = false;
      await this.init();
      await this.replacePath({ ...desired, compare: 'original' });
      this.settings = desired;
      this.playing = playing;
      if (!playing) await this.pause();
    } else if (source === 'browser') {
      await this.clearSource(); // Chrome restores native tab output; worker restores the source rate.
    }
    return true;
  }
  async retry() {
    const fault = this.failure,
      desired = this.settings;
    if (!fault) return;
    const position = this.currentTime();
    try {
      if (this.mode === 'file' && this.playing) {
        await this.replacePath(desired);
      } else if (this.mode === 'file') {
        await this.init();
        const candidate = await this.makePath(desired);
        this.disposePath(candidate);
      }
      this.failure = null;
      if (!this.playing) this.position = position;
    } catch (error) {
      this.settings = desired;
      throw error;
    }
  }
  level() {
    if (!this.meter || !this.playing) return 0;
    this.meter.getFloatTimeDomainData(this.samples);
    return Math.sqrt(this.samples.reduce((sum, x) => sum + x * x, 0) / this.samples.length);
  }
  spectrum() {
    if (!this.meter || !this.playing) return [0, 0, 0, 0, 0];
    this.meter.getFloatFrequencyData(this.frequencies);
    const edges = [60, 250, 700, 2000, 6000, 16000];
    const binHz = this.context.sampleRate / this.meter.fftSize;
    return edges.slice(0, -1).map((low, band) => {
      let peak = -Infinity;
      const end = Math.min(this.frequencies.length, Math.ceil(edges[band + 1] / binHz));
      for (let bin = Math.ceil(low / binHz); bin < end; bin++) peak = Math.max(peak, this.frequencies[bin]);
      return Math.max(0, Math.min(1, (peak + 72) / 54));
    });
  }
  async dispose() {
    await this.clearSource();
    this.meter?.disconnect();
    await this.context?.close();
    this.context = null;
  }
}

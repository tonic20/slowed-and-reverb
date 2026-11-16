import { stretchNode, scheduleOptions, release } from '../../utils/audio/engine.js';
import { bounded } from '../../utils/audio/lifecycle.js';

export class LiveEngine {
  constructor(buffer, onMetrics = () => {}, onError = () => {}) {
    this.buffer = buffer;
    this.onMetrics = onMetrics;
    this.onError = onError;
    this.metrics = null;
    this.error = null;
  }
  async start({ engine = 'signalsmith', speed = 0.82, offset = 30, volume = 0.5 }) {
    await this.stop();
    this.error = null;
    this.metrics = null;
    this.latencyMs = 0;
    this.engine = engine;
    this.speed = speed;
    this.offset = Math.min(offset, this.buffer.duration - 1);
    this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    const context = this.context;
    try {
      await context.resume();
      await context.audioWorklet.addModule('/compare/metrics-worklet.js');
      if (engine.startsWith('rubberband')) {
        const module = await WebAssembly.compileStreaming(fetch('/rubberband/rubberband.wasm'));
        await context.audioWorklet.addModule('/compare/rubberband-worklet.js');
        this.node = new AudioWorkletNode(context, 'comparison-rubberband', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { module, speed, shortWindow: engine === 'rubberband-short' },
        });
        await bounded(
          new Promise((resolve, reject) => {
            this.node.port.onmessage = ({ data }) => {
              if (data.type === 'ready') resolve();
              if (data.type === 'error') reject(Error(data.message));
            };
            this.node.onprocessorerror = () => reject(Error('Rubber Band processor failed to start'));
          }),
          10000,
        );
      } else if (engine === 'native') {
        this.node = new AudioWorkletNode(context, 'comparison-passthrough', { outputChannelCount: [2] });
      } else {
        this.node = await stretchNode(context, 'high');
        this.latencyMs = (await this.node.latency()) * 1000;
        await this.node.schedule({ ...scheduleOptions({ speed, keep: true, formant: true }, true), output: 0 });
      }
      this.node.onprocessorerror = () => this.fail('AudioWorklet processor failed');
      this.node.port.addEventListener('message', ({ data }) => {
        if (data?.type === 'error') this.fail(data.message);
        if (data?.type === 'dsp-metrics') {
          const stats = context.playbackStats;
          this.metrics = {
            ...data,
            engine,
            speed,
            sampleRate: context.sampleRate,
            quantumMs: (128 / context.sampleRate) * 1000,
            latencyMs:
              data.latencyFrames == null ? this.latencyMs || 0 : (data.latencyFrames / context.sampleRate) * 1000,
            outputLatencyMs: (context.outputLatency || 0) * 1000,
            deviceUnderrunSeconds:
              stats && this.playbackBaseline != null
                ? Math.max(0, stats.underrunDuration - this.playbackBaseline)
                : null,
            contextState: context.state,
          };
          this.onMetrics(this.metrics);
        }
      });
      this.node.port.start();
      this.gain = context.createGain();
      this.gain.gain.value = volume;
      this.node.connect(this.gain);
      this.gain.connect(context.destination);
      this.source = context.createBufferSource();
      this.source.buffer = this.buffer;
      this.source.playbackRate.value = speed;
      this.source.loop = true;
      this.source.loopStart = 0;
      this.source.loopEnd = this.buffer.duration;
      this.source.connect(this.node);
      this.startedAt = context.currentTime;
      this.source.start(0, this.offset);
      this.warmupTimer = setTimeout(() => this.resetMetrics(), 3000);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  resetMetrics() {
    if (!this.node || this.context.state !== 'running') return;
    this.playbackBaseline = this.context.playbackStats?.underrunDuration ?? null;
    this.node.port.postMessage({ type: 'measure-start' });
  }
  position() {
    return this.source
      ? (this.offset + (this.context.currentTime - this.startedAt) * this.speed) % this.buffer.duration
      : this.offset || 0;
  }
  setVolume(value) {
    this.gain?.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
  }
  fail(message) {
    this.error = message;
    this.onError(message);
    void this.stop();
  }
  async stop() {
    clearTimeout(this.warmupTimer);
    if (this.source) {
      this.offset = this.position();
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
    if (this.node) {
      if (this.engine === 'signalsmith') release(this.node);
      else {
        this.node.port.postMessage({ type: 'dispose' });
        this.node.disconnect();
        this.node.port.close();
      }
      this.node = null;
    }
    this.gain?.disconnect();
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}

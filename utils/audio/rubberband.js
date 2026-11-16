import { effective, pitchFor } from '../settings.js';
import { bounded } from './lifecycle.js';

let compiledModule;
export const RUBBERBAND_FILE_LATENCY = 0.5;

export async function renderRubberBand(buffer, value) {
  const settings = effective(value);
  const frames = Math.ceil(buffer.length / settings.speed);
  // Match the live/file player path, including Web Audio's native resampler.
  const resampler = new OfflineAudioContext(2, frames, buffer.sampleRate);
  const source = resampler.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = settings.speed;
  source.connect(resampler.destination);
  source.start();
  const resampled = await bounded(resampler.startRendering(), 60000);
  const channels = [resampled.getChannelData(0), resampled.getChannelData(1)];
  const worker = new Worker('/audio/rubberband-render.js', { type: 'module' });
  const pitchScale = 2 ** (pitchFor(settings, true) / 12);
  try {
    const output = await bounded(
      new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => (data.error ? reject(Error(data.error)) : resolve(data.channels));
        worker.onerror = () => reject(Error('Rubber Band WAV processing failed.'));
        worker.postMessage(
          {
            channels,
            sampleRate: buffer.sampleRate,
            pitchScale,
            formantScale: settings.formant ? 1 / (settings.speed * pitchScale) : 0,
            shortWindow: settings.quality === 'light',
          },
          channels.map((channel) => channel.buffer),
        );
      }),
      Math.max(60000, resampled.duration * 1000),
    );
    const result = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate: buffer.sampleRate });
    output.forEach((channel, index) => result.copyToChannel(channel, index));
    return result;
  } finally {
    worker.terminate();
  }
}

export async function rubberbandNode(context, value) {
  if (!compiledModule) {
    try {
      compiledModule = WebAssembly.compileStreaming(fetch('/vendor/rubberband/rubberband.wasm'));
      await compiledModule;
    } catch (error) {
      compiledModule = null;
      throw error;
    }
  }
  await context.audioWorklet.addModule('/audio/rubberband.js');
  const settings = effective(value);
  const pitchScale = 2 ** (pitchFor(settings, true) / 12);
  const node = new AudioWorkletNode(context, 'sr-rubberband', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      module: await compiledModule,
      pitchScale,
      // R3 applies this envelope correction in addition to its pitch shift.
      // Recover the original envelope from the resampled browser input.
      formantScale: settings.formant ? 1 / (settings.speed * pitchScale) : 0,
      shortWindow: settings.quality === 'light',
    },
  });
  node.engine = 'rubberband';
  let initialized, rejectInitialization, started, rejectStarted;
  const ready = new Promise((resolve, reject) => {
    initialized = resolve;
    rejectInitialization = reject;
  });
  node.started = new Promise((resolve, reject) => {
    started = resolve;
    rejectStarted = reject;
  });
  // The stream may fail before makePath starts awaiting its latency.
  void node.started.catch(() => {});
  const fail = (message) => {
    const error = Error(message);
    rejectInitialization(error);
    rejectStarted(error);
  };
  node.onprocessorerror = () => fail('Rubber Band audio processor failed.');
  node.port.onmessage = ({ data }) => {
    if (data.type === 'ready') initialized();
    if (data.type === 'started') started(data.latency);
    if (data.type === 'statistics') node.statistics = data;
    if (data.type === 'error') {
      fail(data.message);
      node.dispatchEvent(new Event('processorerror'));
    }
  };
  node.dispose = () => {
    node.onprocessorerror = null;
    node.disconnect();
    node.port.postMessage({ type: 'dispose' });
    node.port.close();
    fail('Rubber Band processor was released.');
  };
  try {
    await bounded(ready);
    return node;
  } catch (error) {
    node.dispose();
    throw error;
  }
}

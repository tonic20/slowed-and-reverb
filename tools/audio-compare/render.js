import { stretchNode, loadBuffer, release, scheduleOptions } from '../../utils/audio/engine.js';
import { normalize } from '../../utils/settings.js';
import { bounded } from '../../utils/audio/lifecycle.js';

export async function renderSignalsmith(buffer, speed, variant = 'fixed', quality = 'high') {
  const live = variant !== 'file';
  const sampleRate = buffer.sampleRate;
  const frames = Math.ceil(buffer.length / speed);
  // Leave room for the live processor's input and output latency, then crop it.
  const context = new OfflineAudioContext(2, frames + sampleRate * 2, sampleRate);
  const node = await stretchNode(context, quality);
  let source;
  let processorError;
  node.onprocessorerror = () => {
    processorError = Error('Signalsmith processor failed');
  };
  try {
    const settings = normalize({ speed, keep: true, formant: true, quality, wet: 0, volume: 100 });
    const options = scheduleOptions(settings, live);
    if (variant === 'legacy') options.formantSemitones = 0;
    const padding = 0.5;
    const latency = live ? await node.latency() : 0;
    node.connect(context.destination);
    if (live) {
      source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = speed;
      source.connect(node);
      await node.schedule({ ...options, output: 0 });
      source.start(padding);
    } else {
      await loadBuffer(node, buffer);
      await node.schedule({ ...options, output: padding, input: 0 });
    }
    const rendered = await bounded(context.startRendering(), 60000);
    if (processorError) throw processorError;
    const start = Math.round((padding + latency) * sampleRate);
    return Array.from({ length: 2 }, (_, channel) => rendered.getChannelData(channel).slice(start, start + frames));
  } finally {
    source?.disconnect();
    release(node);
  }
}

export async function resample(buffer, speed) {
  const context = new OfflineAudioContext(2, Math.ceil(buffer.length / speed), buffer.sampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = speed;
  source.connect(context.destination);
  source.start();
  const result = await context.startRendering();
  return [result.getChannelData(0), result.getChannelData(1)];
}

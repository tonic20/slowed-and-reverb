import { effective } from '../settings.js';

export function impulse(context, seconds, room) {
  const buffer = context.createBuffer(2, Math.ceil(seconds * context.sampleRate), context.sampleRate);
  const profiles = {
    dark: [
      0.22,
      0.014,
      [
        [0.023, 0.65],
        [0.047, 0.4],
        [0.079, 0.25],
      ],
    ],
    hall: [
      0.38,
      0.035,
      [
        [0.037, 0.55],
        [0.071, 0.4],
        [0.113, 0.3],
        [0.179, 0.18],
      ],
    ],
    plate: [
      0.68,
      0.004,
      [
        [0.009, 0.3],
        [0.017, 0.24],
        [0.031, 0.15],
      ],
    ],
  };
  const [filter, attack, reflections] = profiles[room] || profiles.dark;
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let seed = 7919 + c * 104729,
      low = 0;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      low += filter * ((seed / 4294967296) * 2 - 1 - low);
      const time = i / context.sampleRate;
      data[i] = low * Math.min(1, time / attack) * Math.exp((-7 * time) / seconds);
    }
    for (const [time, level] of reflections) data[Math.round((time + c * 0.002) * context.sampleRate)] += level;
  }
  return buffer;
}

export async function effects(context, initial) {
  await context.audioWorklet.addModule(new URL('/audio/dynamics.js', location.href));
  const input = context.createGain(),
    bass = context.createBiquadFilter();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  bass.type = 'lowshelf';
  bass.frequency.value = 150;
  const dry = context.createGain(),
    preDelay = context.createDelay(0.1);
  const tone = context.createBiquadFilter();
  tone.type = 'lowpass';
  const wet = context.createGain();
  const output = new AudioWorkletNode(context, 'sr-dynamics', {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  input.connect(bass);
  bass.connect(dry);
  dry.connect(output, 0, 0);
  bass.connect(preDelay);
  tone.connect(wet);
  wet.connect(output, 0, 1);
  const branches = new Set(),
    timers = new Set();
  let current, previous;
  function smooth(param, value) {
    param.cancelScheduledValues(context.currentTime);
    if (!previous) param.setValueAtTime(value, context.currentTime);
    else param.setTargetAtTime(value, context.currentTime, 0.015);
  }
  function update(value) {
    const s = effective(value);
    if (!previous || previous.room !== s.room || previous.tail !== s.tail) {
      const convolution = context.createConvolver(),
        gain = context.createGain();
      convolution.buffer = impulse(context, Number(s.tail), s.room);
      preDelay.connect(convolution);
      convolution.connect(gain);
      gain.connect(tone);
      gain.gain.setValueAtTime(previous ? 0 : 1, context.currentTime);
      if (previous) gain.gain.linearRampToValueAtTime(1, context.currentTime + 0.08);
      const branch = { convolution, gain };
      branches.add(branch);
      if (current) {
        const old = current;
        old.gain.gain.cancelScheduledValues(context.currentTime);
        old.gain.gain.setValueAtTime(old.gain.gain.value, context.currentTime);
        old.gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.08);
        const timer = setTimeout(() => {
          preDelay.disconnect(old.convolution);
          old.convolution.disconnect();
          old.gain.disconnect();
          branches.delete(old);
          timers.delete(timer);
        }, 180);
        timers.add(timer);
      }
      current = branch;
    }
    smooth(bass.gain, s.bass);
    smooth(preDelay.delayTime, Number(s.delay) / 1000);
    smooth(tone.frequency, { dark: 2800, warm: 6000, bright: 14000 }[s.tone]);
    smooth(dry.gain, 1 - s.wet / 100);
    smooth(wet.gain, s.wet / 100);
    smooth(output.parameters.get('volume'), s.volume / 100);
    output.parameters.get('duck').setValueAtTime(s.duck ? 1 : 0, context.currentTime);
    output.parameters.get('safe').setValueAtTime(s.safe && !s.bypass ? 1 : 0, context.currentTime);
    previous = s;
  }
  update(initial);
  return {
    input,
    output,
    update,
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      for (const { convolution, gain } of branches) {
        convolution.disconnect();
        gain.disconnect();
      }
      for (const n of [input, bass, dry, preDelay, tone, wet, output]) n.disconnect();
      output.port.close();
    },
  };
}

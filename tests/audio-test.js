import { renderAudio, encodeWav } from '../utils/audio/engine.js';
import { normalize } from '../utils/settings.js';
import { renderSignalsmith } from '../tools/audio-compare/render.js';

window.checkFormants = async () => {
  const sampleRate = 48000;
  const input = new AudioBuffer({ numberOfChannels: 2, length: sampleRate * 3, sampleRate });
  // A harmonic source with a known spectral envelope centred at 1 kHz.
  for (let harmonic = 1; harmonic <= 30; harmonic++) {
    const frequency = harmonic * 100;
    const amplitude = 0.025 * Math.exp(-0.5 * ((frequency - 1000) / 180) ** 2);
    for (let i = 0; i < input.length; i++)
      input.getChannelData(0)[i] += amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + harmonic * 1.7);
  }
  input.copyToChannel(input.getChannelData(0), 1);
  function envelopeCentre(data) {
    let weighted = 0,
      total = 0;
    const start = sampleRate,
      length = sampleRate / 2;
    for (let frequency = 400; frequency <= 1600; frequency += 100) {
      let real = 0,
        imaginary = 0;
      for (let i = 0; i < length; i++) {
        const value = data[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1)));
        real += value * Math.cos((2 * Math.PI * frequency * i) / sampleRate);
        imaginary += value * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
      }
      const magnitude = Math.hypot(real, imaginary);
      weighted += frequency * magnitude;
      total += magnitude;
    }
    return weighted / total;
  }
  const expected = envelopeCentre(input.getChannelData(0));
  const results = [];
  for (const speed of [0.75, 1.2]) {
    const legacy = envelopeCentre((await renderSignalsmith(input, speed, 'legacy'))[0]);
    const fixed = envelopeCentre((await renderSignalsmith(input, speed, 'fixed'))[0]);
    const result = { speed, expected, legacy, fixed };
    if (
      !Number.isFinite(fixed) ||
      Math.abs(fixed - expected) > 85 ||
      Math.abs(fixed - expected) >= Math.abs(legacy - expected) / 2
    )
      throw Error('Live formants must return to their original envelope: ' + JSON.stringify(result));
    results.push(result);
  }
  return results;
};
window.checkAudio = async () => {
  const input = new AudioBuffer({ numberOfChannels: 2, length: 96000, sampleRate: 48000 });
  for (let i = 0; i < input.length; i++) {
    input.getChannelData(0)[i] = 0.15 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    input.getChannelData(1)[i] = 0.1 * Math.sin((2 * Math.PI * 660 * i) / 48000);
  }
  const frequency = (data) => {
    const crossings = [];
    for (let i = 24001; i < 72000; i++)
      if (data[i - 1] <= 0 && data[i] > 0) crossings.push(i - 1 - data[i - 1] / (data[i] - data[i - 1]));
    return ((crossings.length - 1) * 48000) / (crossings.at(-1) - crossings[0]);
  };
  const modes = [];
  for (const engine of ['signalsmith', 'rubberband'])
    for (const quality of ['high', 'light'])
      for (const keep of [true, false]) {
        const output = await renderAudio(
          input,
          normalize({ speed: 0.8, wet: 0, keep, quality, engine, formant: false, volume: 100 }),
        );
        modes.push({
          engine,
          quality,
          keep,
          duration: output.duration,
          left: frequency(output.getChannelData(0)),
          right: frequency(output.getChannelData(1)),
          finite: output.getChannelData(0).every(Number.isFinite),
        });
      }
  const bypass = await renderAudio(input, normalize({ compare: 'original', volume: 100 }));
  const exact = input.getChannelData(0).every((v, i) => v === bypass.getChannelData(0)[i]);
  const impulse = new AudioBuffer({ numberOfChannels: 1, length: 4800, sampleRate: 48000 });
  impulse.getChannelData(0)[0] = 1;
  const reverbs = [];
  for (const room of ['dark', 'hall', 'plate']) {
    const out = await renderAudio(
      impulse,
      normalize({ speed: 1, wet: 60, tail: '1.5', room, delay: '50', volume: 100 }),
    );
    reverbs.push({
      room,
      duration: out.duration,
      energy: out
        .getChannelData(0)
        .slice(4800)
        .reduce((sum, v) => sum + v * v, 0),
    });
  }
  const truncated = await renderAudio(impulse, normalize({ speed: 1, wet: 60, exportTail: false }));
  const wav = encodeWav(bypass, true);
  const bytes = new DataView(await wav.blob.arrayBuffer());
  const mono = new AudioBuffer({ numberOfChannels: 1, length: 48000, sampleRate: 48000 });
  for (let i = 0; i < mono.length; i++) mono.getChannelData(0)[i] = 2 * Math.sin((2 * Math.PI * 220 * i) / 48000);
  const loud = await renderAudio(mono, normalize({ speed: 1, wet: 0, volume: 100, safe: true }));
  const unprotected = await renderAudio(mono, normalize({ speed: 1, wet: 0, volume: 100, safe: false }));
  const peak = (b) => b.getChannelData(0).reduce((p, v) => Math.max(p, Math.abs(v)), 0);
  const rightEnergy = loud.getChannelData(1).reduce((sum, v) => sum + v * v, 0);
  const originalConnect = AudioWorkletNode.prototype.connect;
  const exportFailures = [];
  try {
    for (const processor of ['pitch', 'dynamics']) {
      AudioWorkletNode.prototype.connect = function (...args) {
        const result = originalConnect.apply(this, args);
        if (this.parameters.has('volume') === (processor === 'dynamics'))
          queueMicrotask(() => this.dispatchEvent(new Event('processorerror')));
        return result;
      };
      let rejected = false;
      try {
        await renderAudio(input, normalize({ speed: 0.8, keep: true, engine: 'signalsmith' }));
      } catch (error) {
        rejected = /processor/i.test(error.message);
      }
      if (!rejected) throw Error(`${processor} export failure must reject instead of saving silent audio`);
      exportFailures.push(processor);
    }
  } finally {
    AudioWorkletNode.prototype.connect = originalConnect;
  }
  return {
    exportFailures,
    modes,
    exact,
    reverbs,
    monoRightEnergy: rightEnergy,
    protectedPeak: peak(loud),
    unprotectedPeak: peak(unprotected),
    truncated: truncated.duration,
    wav: {
      channels: bytes.getUint16(22, true),
      frames: bytes.getUint32(40, true) / 4,
      rate: bytes.getUint32(24, true),
    },
  };
};

window.checkRealtime = async () => {
  const { AudioEngine } = await import('../utils/audio/engine.js');
  const engine = new AudioEngine();
  const input = new AudioBuffer({ numberOfChannels: 2, length: 48000 * 12, sampleRate: 48000 });
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < input.length; i++) input.getChannelData(c)[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (value, message) => {
    if (!value) throw Error(message);
  };
  try {
    await engine.update({ speed: 1, pitch: 0, wet: 30, volume: 100, engine: 'signalsmith' });
    await engine.setBuffer(input);
    await engine.play();
    await pause(100);
    check(!engine.path?.node, 'neutral pitch must avoid a stretch worklet');
    const bands = engine.spectrum();
    check(bands.length === 5 && bands.every((v) => v >= 0 && v <= 1), 'five bounded spectrum bands');
    check(bands[1] > 0.2 && bands[1] > bands[4] + 0.2, '440 Hz moves its own band, not all bars together');
    const native = engine.path;
    await engine.update({ ...engine.settings, quality: 'light' });
    check(engine.path === native, 'native quality change must not rebuild playback');
    await engine.update({ ...engine.settings, speed: 0.8, keep: true });
    await pause(150);
    check(!!engine.path.node, 'pitch preservation needs DSP');
    const before = engine.currentTime();
    let minimum = 1,
      running = true;
    const sample = (async () => {
      while (running) {
        minimum = Math.min(minimum, engine.level());
        await pause(8);
      }
    })();
    await engine.update({ ...engine.settings, quality: 'high' });
    running = false;
    await sample;
    check(minimum > 0.015, 'quality replacement must not silence the output: ' + minimum);
    check(engine.currentTime() >= before, 'quality replacement must keep position moving forward');
    const beforeRubberBand = engine.currentTime();
    await engine.update({ ...engine.settings, engine: 'rubberband' });
    check(engine.path.node.engine === 'rubberband', 'file preview must use the selected engine');
    await pause(100);
    check(engine.level() > 0.03, 'Rubber Band file preview must be audible');
    check(engine.currentTime() > beforeRubberBand, 'file engine switch keeps source position');
    const filePosition = engine.currentTime();
    await engine.seek(3);
    check(engine.currentTime() >= 3 && engine.currentTime() < 3.5, 'Rubber Band file seek stays aligned');
    check(engine.currentTime() > filePosition, 'seek moves forward');
    const failed = engine.path;
    let recovered;
    engine.onFailure = (error, path) => {
      recovered = engine.recover(error, path);
    };
    failed.node.dispatchEvent(new Event('processorerror'));
    await pause(30);
    await recovered;
    check(
      !!engine.failure && !engine.path.node && engine.playing,
      'processor failure must continue native original: ' +
        JSON.stringify({
          failure: engine.failure,
          node: !!engine.path?.node,
          playing: engine.playing,
          callback: !!recovered,
        }),
    );
    check(engine.settings.keep && engine.settings.speed === 0.8, 'failure must preserve desired settings');
    await engine.retry();
    check(!engine.failure && !!engine.path.node, 'retry must restore the desired DSP');
    failed.node.dispatchEvent(new Event('processorerror'));
    await pause(30);
    check(!engine.failure, 'retired path cannot fail the new session');
    await engine.recover(Error('paused retry test'), engine.path);
    await engine.pause();
    check(
      engine.spectrum().every((v) => v === 0),
      'paused spectrum rests',
    );
    const makePath = engine.makePath;
    let attempts = 0;
    engine.makePath = async () => {
      attempts++;
      throw Error('processor still unavailable');
    };
    try {
      await engine.retry();
    } catch {
      /* Expected: failure must stay visible until preparation succeeds. */
    }
    check(attempts === 1 && !!engine.failure && !engine.playing, 'paused Retry must validate the processor');
    engine.makePath = makePath;
    await engine.retry();
    check(!engine.failure && !engine.playing && engine.paths.size === 0, 'paused Retry must release its test path');
    await engine.play();
    await engine.update({ ...engine.settings, compare: 'original' });
    check(!engine.path.node, 'Original must bypass DSP');
    const short = new AudioBuffer({ numberOfChannels: 1, length: 4410, sampleRate: 44100 });
    for (let i = 0; i < short.length; i++) short.getChannelData(0)[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    await engine.setBuffer(short);
    await engine.update({ engine: 'rubberband', speed: 0.8, keep: true, wet: 0, volume: 100 });
    await engine.play();
    check(
      engine.path.node.engine === 'rubberband' && engine.level() > 0.01,
      'short mono files must flush Rubber Band after the source ends',
    );
    return { minimumDuringSwitch: minimum, position: engine.currentTime(), failureRecovery: true };
  } finally {
    await engine.dispose();
  }
};

window.checkRubberBand = async () => {
  const { AudioEngine } = await import('../utils/audio/engine.js');
  const sourceContext = new AudioContext({ sampleRate: 48000 });
  const destination = sourceContext.createMediaStreamDestination();
  const source = sourceContext.createBufferSource();
  const input = sourceContext.createBuffer(2, 48000 * 2, 48000);
  for (let channel = 0; channel < 2; channel++)
    for (let i = 0; i < input.length; i++)
      input.getChannelData(channel)[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  source.buffer = input;
  source.loop = true;
  source.playbackRate.value = 0.82;
  source.connect(destination);
  source.start();
  await sourceContext.resume();
  const engine = new AudioEngine();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (value, message) => {
    if (!value) throw Error(message);
  };
  const results = [];
  try {
    await engine.update({ engine: 'rubberband', speed: 0.82, keep: true, wet: 0, volume: 100 });
    await engine.setStream(destination.stream);
    for (const speed of [0.82, 1.2, 0.5]) {
      const settings = { ...engine.settings, speed };
      await engine.prepareUpdate(settings);
      source.playbackRate.value = speed;
      await engine.update(settings);
      await pause(400);
      check(engine.path.node.engine === 'rubberband', 'tab must use Rubber Band');
      check(engine.level() > 0.03, 'Rubber Band output must be audible');
      const crossings = [];
      for (let i = 1; i < engine.samples.length; i++)
        if (engine.samples[i - 1] <= 0 && engine.samples[i] > 0)
          crossings.push(i - 1 - engine.samples[i - 1] / (engine.samples[i] - engine.samples[i - 1]));
      const hz = ((crossings.length - 1) * engine.context.sampleRate) / (crossings.at(-1) - crossings[0]);
      check(Math.abs(hz - 440) < 8, 'live pitch correction at ' + speed + ' returned ' + hz);
      results.push({ speed, hz, latency: engine.latency });
    }
    for (const settings of [
      { quality: 'light' },
      { engine: 'signalsmith' },
      { engine: 'rubberband', quality: 'high' },
    ]) {
      const old = engine.path;
      await engine.prepareUpdate({ ...engine.settings, ...settings });
      await engine.update({ ...engine.settings, ...settings });
      check(old.disposed && engine.paths.size === 1, 'engine switch must release the old processor');
      check(engine.stream === destination.stream, 'engine switch must keep the capture stream');
      await pause(200);
      check(engine.level() > 0.03, 'engine switch must restore audible output');
    }
    await pause(1100);
    check(engine.path.node.statistics.underrunFrames === 0, 'Rubber Band FIFO must remain supplied');
    await engine.update({ ...engine.settings, keep: false });
    check(!engine.path.node, 'classic resampling must bypass pitch correction');
    await engine.update({ ...engine.settings, keep: true });
    check(engine.path.node.engine === 'rubberband', 'Keep pitch must restore selected engine');
    return results;
  } finally {
    await engine.dispose();
    source.stop();
    await sourceContext.close();
  }
};

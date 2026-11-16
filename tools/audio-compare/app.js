import { renderSignalsmith, resample } from './render.js';

const $ = (id) => document.getElementById(id);
const variants = [
  { id: 'legacy', name: 'Signalsmith · current tab', detail: 'Original formant compensation · before the fix' },
  { id: 'fixed', name: 'Signalsmith · corrected tab', detail: 'Restores formants relative to the original track' },
  { id: 'file', name: 'Signalsmith · audio file', detail: 'Direct time stretch · existing file processing' },
  {
    id: 'rubber-live',
    name: 'Rubber Band R3 · tab',
    detail: 'Real-time algorithm · pitch correction after resampling',
  },
  { id: 'rubber-file', name: 'Rubber Band R3 · audio file', detail: 'Offline algorithm · two-pass time stretch' },
];
let audio, excerpt, context, master, activeSource, activeGain;
let selected = 1,
  position = 0,
  startedAt = 0,
  playing = false,
  busy = false,
  ready = false;
let results = [];
const buttons = variants.map((variant, index) => {
  const button = document.createElement('button');
  button.className = 'variant';
  button.disabled = true;
  button.setAttribute('aria-pressed', String(index === selected));
  button.innerHTML = `<span class="key">${index + 1}</span><span><strong>${variant.name}</strong><small>${variant.detail}</small></span><span class="result">Waiting</span>`;
  button.addEventListener('click', () => select(index));
  $('variants').append(button);
  return button;
});
function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function lock(value) {
  busy = value;
  for (const id of ['choose', 'file', 'start', 'duration', 'speed', 'render']) $(id).disabled = value;
  $('render').disabled = value || !audio;
  buttons.forEach((button) => {
    button.disabled = value || !ready;
  });
  $('play').disabled = $('seek').disabled = value || !ready;
}
async function audioContext() {
  context ||= new AudioContext();
  if (!master) {
    master = context.createGain();
    master.gain.value = Number($('volume').value);
    master.connect(context.destination);
  }
  return context;
}
async function load(bytes, name) {
  stop();
  ready = false;
  lock(true);
  status('Decoding audio…');
  try {
    const decoder = new OfflineAudioContext(2, 1, 48000);
    audio = await decoder.decodeAudioData(bytes);
    $('track-name').textContent = name.replace(/\s*\[[\w-]+\](?=\.)/, '').replace(/\.mp3$/i, '');
    $('start').max = Math.max(0, Math.floor(audio.duration - 1));
    $('start').value = Math.min(Number($('start').value), Number($('start').max));
    status('Track loaded. Preparing the comparison…');
  } catch (error) {
    audio = null;
    status(error.message, true);
  } finally {
    lock(false);
  }
  if (audio) await render();
}
function rubberband(channels, sampleRate, speed, live) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./rubberband-worker.js', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => finish(Error('Rubber Band rendering timed out')), 120000);
    function finish(error, value) {
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve(value);
    }
    worker.onerror = (event) => finish(Error(event.message || 'Rubber Band failed'));
    worker.onmessage = ({ data }) => finish(data.error ? Error(data.error) : null, data.channels);
    const copy = channels.map((channel) => channel.slice());
    worker.postMessage(
      { channels: copy, sampleRate, speed, live },
      copy.map((channel) => channel.buffer),
    );
  });
}
function measure(channels) {
  let energy = 0,
    peak = 0;
  for (const channel of channels)
    for (const sample of channel) {
      if (!Number.isFinite(sample)) throw Error('The engine returned invalid samples');
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
  const rms = Math.sqrt(energy / (channels.length * channels[0].length));
  if (rms < 1e-8) throw Error('This passage is silent. Choose a different start time.');
  return { rms, peak };
}
async function render() {
  if (busy || !audio) return;
  stop();
  ready = false;
  lock(true);
  results = [];
  const start = Math.min(Math.max(0, Number($('start').value) || 0), Math.max(0, audio.duration - 1));
  const duration = Math.min(Number($('duration').value), audio.duration - start);
  const speed = Number($('speed').value);
  $('start').value = start;
  try {
    excerpt = new AudioBuffer({
      numberOfChannels: 2,
      length: Math.floor(duration * audio.sampleRate),
      sampleRate: audio.sampleRate,
    });
    for (let channel = 0; channel < 2; channel++)
      excerpt.copyToChannel(
        audio
          .getChannelData(channel % audio.numberOfChannels)
          .subarray(Math.floor(start * audio.sampleRate), Math.floor(start * audio.sampleRate) + excerpt.length),
        channel,
      );
    buttons.forEach((button) => {
      button.querySelector('.result').textContent = 'Waiting';
    });
    for (let index = 0; index < variants.length; index++) {
      const variant = variants[index];
      status(`Rendering ${index + 1} of ${variants.length} — ${variant.name}…`);
      buttons[index].querySelector('.result').textContent = 'Rendering…';
      const began = performance.now();
      let channels;
      if (variant.id === 'rubber-live')
        channels = await rubberband(await resample(excerpt, speed), excerpt.sampleRate, speed, true);
      else if (variant.id === 'rubber-file')
        channels = await rubberband(
          [excerpt.getChannelData(0), excerpt.getChannelData(1)],
          excerpt.sampleRate,
          speed,
          false,
        );
      else channels = await renderSignalsmith(excerpt, speed, variant.id);
      const buffer = new AudioBuffer({
        numberOfChannels: 2,
        length: channels[0].length,
        sampleRate: excerpt.sampleRate,
      });
      channels.forEach((channel, i) => buffer.copyToChannel(channel, i));
      const measurements = measure(channels);
      results.push({ buffer, ...measurements, seconds: (performance.now() - began) / 1000 });
      buttons[index].querySelector('.result').textContent = 'Ready';
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const target = Math.min(...results.map((result) => result.rms));
    const headroom = Math.min(1, ...results.map((result) => 0.95 / ((result.peak * target) / result.rms)));
    results.forEach((result) => {
      result.matchedGain = (target / result.rms) * headroom;
    });
    ready = true;
    position = 0;
    updateLevels();
    lock(false);
    select(selected);
    status(`${format(start)}–${format(start + duration)} of the track · ${speed.toFixed(2)}× · ready to compare`);
  } catch (error) {
    status(error.message, true);
  } finally {
    lock(false);
  }
}
function updateLevels() {
  if (!ready) return;
  const rawGain = Math.min(1, ...results.map((result) => 0.95 / result.peak));
  results.forEach((result, index) => {
    result.gain = $('match').checked ? result.matchedGain : rawGain;
    buttons[index].querySelector('.result').textContent =
      `${(20 * Math.log10(result.gain)).toFixed(1)} dB · ${result.seconds.toFixed(1)} s render`;
  });
  activeGain?.gain.setTargetAtTime(results[selected].gain, context.currentTime, 0.02);
}
function currentPosition() {
  return playing ? Math.min(results[selected].buffer.duration, position + context.currentTime - startedAt) : position;
}
function retire() {
  if (!activeSource) return;
  const source = activeSource,
    gain = activeGain;
  source.onended = null;
  gain.gain.cancelScheduledValues(context.currentTime);
  gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
  gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.025);
  source.stop(context.currentTime + 0.03);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
  activeSource = activeGain = null;
}
function stop() {
  if (playing) position = currentPosition();
  playing = false;
  retire();
  $('play').textContent = 'Play';
}
function startPlayback() {
  const result = results[selected];
  if (position >= result.buffer.duration - 0.01) position = 0;
  const source = context.createBufferSource(),
    gain = context.createGain();
  source.buffer = result.buffer;
  source.connect(gain);
  gain.connect(master);
  gain.gain.setValueAtTime(0, context.currentTime);
  gain.gain.linearRampToValueAtTime(result.gain, context.currentTime + 0.025);
  activeSource = source;
  activeGain = gain;
  startedAt = context.currentTime;
  playing = true;
  source.onended = () => {
    if (activeSource !== source) return;
    playing = false;
    position = 0;
    activeSource = activeGain = null;
    source.disconnect();
    gain.disconnect();
    $('play').textContent = 'Play';
  };
  source.start(0, position);
  $('play').textContent = 'Pause';
}
function select(index) {
  if (!ready || busy) return;
  const wasPlaying = playing;
  stop();
  selected = index;
  buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === selected)));
  $('playing-name').textContent = variants[selected].name;
  $('seek').max = results[selected].buffer.duration;
  $('total').textContent = format(results[selected].buffer.duration);
  if (wasPlaying) startPlayback();
}
function format(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function draw() {
  const canvas = $('wave'),
    width = Math.round(canvas.clientWidth * devicePixelRatio),
    height = 82 * devicePixelRatio;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const paint = canvas.getContext('2d');
  paint.clearRect(0, 0, width, height);
  const now = ready ? currentPosition() : 0;
  if (ready) {
    const data = results[selected].buffer.getChannelData(0);
    const fraction = now / results[selected].buffer.duration;
    for (let x = 0; x < width; x += 4 * devicePixelRatio) {
      const from = Math.floor((x / width) * data.length),
        to = Math.floor(((x + 4 * devicePixelRatio) / width) * data.length);
      let peak = 0;
      for (let i = from; i < Math.min(to, data.length); i += 8) peak = Math.max(peak, Math.abs(data[i]));
      const size = Math.max(2, (peak / results[selected].peak) * height * 0.88);
      paint.fillStyle = x / width <= fraction ? '#dcbd88' : '#485245';
      paint.fillRect(x, (height - size) / 2, 2 * devicePixelRatio, size);
    }
    $('seek').value = now;
  }
  $('elapsed').textContent = format(now);
  requestAnimationFrame(draw);
}
$('choose').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0];
  if (file) await load(await file.arrayBuffer(), file.name);
};
$('render').onclick = render;
$('play').onclick = async () => {
  if (!ready || busy) return;
  if (playing) stop();
  else {
    await audioContext();
    await context.resume();
    startPlayback();
  }
};
$('seek').oninput = () => {
  const wasPlaying = playing;
  stop();
  position = Number($('seek').value);
  if (wasPlaying) startPlayback();
};
$('volume').oninput = () => master?.gain.setTargetAtTime(Number($('volume').value), context.currentTime, 0.02);
$('match').onchange = updateLevels;
for (const id of ['start', 'duration', 'speed'])
  $(id).onchange = () => {
    stop();
    ready = false;
    lock(false);
    status('Settings changed. Render the comparison to listen.');
  };
document.addEventListener('keydown', (event) => {
  if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
  if (event.code === 'Space') {
    event.preventDefault();
    $('play').click();
  }
  if (/^[1-5]$/.test(event.key)) select(Number(event.key) - 1);
});
requestAnimationFrame(draw);
lock(true);
try {
  const info = await (await fetch('/track-info')).json();
  if (info.name) {
    const response = await fetch('/track');
    if (!response.ok) throw Error('The local track could not be read');
    await load(await response.arrayBuffer(), info.name);
  } else {
    $('track-name').textContent = 'Choose an audio file';
    status('Choose a local track to begin.');
    lock(false);
  }
} catch (error) {
  status(error.message, true);
  lock(false);
}

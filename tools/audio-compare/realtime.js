import { LiveEngine } from './live-engine.js';

const $ = (id) => document.getElementById(id);
let player,
  busy = false;
const names = {
  signalsmith: 'Signalsmith',
  rubberband: 'Rubber Band R3',
  'rubberband-short': 'Rubber Band R3 short',
  native: 'Native baseline',
};
function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function showMetrics(metrics) {
  $('work').textContent = metrics.workPercent.toFixed(1) + '%';
  $('peak').textContent = metrics.maxMs.toFixed(1) + ' ms';
  $('budget').textContent = metrics.quantumMs.toFixed(2) + ' ms audio per callback';
  $('fifo').textContent = metrics.engine.startsWith('rubberband') ? metrics.underrunFrames : 'N/A';
  $('device').textContent =
    metrics.deviceUnderrunSeconds == null ? 'Unavailable' : (metrics.deviceUnderrunSeconds * 1000).toFixed(1) + ' ms';
  $('seconds').textContent = metrics.seconds.toFixed(1) + ' s';
  $('over').textContent = metrics.overBudget + ' / ' + metrics.blocks;
  $('zeros').textContent = metrics.zeroBlocks;
  $('latency').textContent = metrics.latencyMs.toFixed(1) + ' ms';
  $('timer').textContent = metrics.timer;
  status('Playing live · ' + names[metrics.engine] + ' · ' + metrics.speed.toFixed(2) + '×');
}
function controls(value) {
  busy = value;
  for (const id of ['play', 'engine', 'speed', 'start', 'reset']) $(id).disabled = value || !player;
}
function clearMetrics() {
  for (const id of ['work', 'peak', 'fifo', 'device', 'seconds', 'over', 'zeros', 'latency', 'timer'])
    $(id).textContent = '—';
}
async function start(offset) {
  if (!player || busy) return;
  controls(true);
  clearMetrics();
  status('Starting the live processor…');
  try {
    await player.start({
      engine: $('engine').value,
      speed: Number($('speed').value),
      offset,
      volume: Number($('volume').value),
    });
    $('play').textContent = 'Pause';
    status('Playing live · warming up for three seconds…');
  } catch (error) {
    status(error.message, true);
    $('play').textContent = 'Play live';
  } finally {
    controls(false);
  }
}
$('play').onclick = async () => {
  if (player.source) {
    controls(true);
    await player.stop();
    $('start').value = Math.floor(player.offset);
    $('play').textContent = 'Play live';
    status('Paused');
    controls(false);
  } else await start(Number($('start').value));
};
for (const id of ['engine', 'speed'])
  $(id).onchange = async () => {
    if (player?.source) await start(player.position());
  };
$('start').onchange = async () => {
  if (player?.source) await start(Number($('start').value));
};
$('volume').oninput = () => player?.setVolume(Number($('volume').value));
$('reset').onclick = () => {
  clearMetrics();
  player?.resetMetrics();
};
setInterval(() => {
  if (!player?.source) return;
  const seconds = player.position();
  $('position').textContent = Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}, 250);
window.addEventListener('pagehide', () => {
  void player?.stop();
});
controls(true);
try {
  const info = await (await fetch('/track-info')).json();
  if (!info.name) throw Error('Start the comparison server with a local audio file path.');
  $('track-name').textContent = info.name.replace(/\s*\[[\w-]+\](?=\.)/, '').replace(/\.mp3$/i, '');
  const response = await fetch('/track');
  if (!response.ok) throw Error('The local track could not be read');
  const decoder = new OfflineAudioContext(2, 1, 48000);
  const buffer = await decoder.decodeAudioData(await response.arrayBuffer());
  player = new LiveEngine(buffer, showMetrics, (message) => {
    status(message, true);
    $('play').textContent = 'Play live';
  });
  $('start').max = Math.floor(buffer.duration - 1);
  status('Ready · choose an engine and play');
} catch (error) {
  status(error.message, true);
}
controls(false);

try {
  const response = await fetch('/benchmark-results');
  if (response.ok) {
    const benchmark = await response.json();
    $('benchmark').hidden = false;
    $('benchmark-info').textContent =
      `${benchmark.machine} · ${benchmark.browser} · ${benchmark.secondsPerRun} s per run after warm-up · ${benchmark.sampleRate} Hz stereo`;
    for (const run of benchmark.runs) {
      const row = document.createElement('tr');
      for (const text of [
        names[run.engine],
        run.speed.toFixed(2) + '×',
        run.cpuPercent.toFixed(1) + '%',
        run.metrics.maxMs.toFixed(1) + ' ms',
        run.engine.startsWith('rubberband') ? run.metrics.underrunFrames : 'N/A',
        run.metrics.deviceUnderrunSeconds == null
          ? 'Unavailable'
          : (run.metrics.deviceUnderrunSeconds * 1000).toFixed(1) + ' ms',
      ]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      $('benchmark-rows').append(row);
    }
  }
} catch {
  /* Live measurements remain available without a saved benchmark. */
}

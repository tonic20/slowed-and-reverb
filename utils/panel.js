import { browser as chrome } from 'wxt/browser';
import { defaults, normalize, preset, reset, effective } from './settings.js';
import { storedFile } from './file-store.js';
import { normalizeRating, shouldAsk, ratingDestinations } from './rating.js';
import ratingConfig from './rating-links.json';

const ratingLinks = ratingDestinations(
  chrome.runtime.id,
  chrome.runtime.getManifest().update_url,
  ratingConfig.feedback,
);

const root = document.getElementById('ag-concept');
for (const p of root.querySelectorAll('.ag-product')) {
  p.querySelector('.ag-source-mount').replaceWith(root.querySelector('#ag-source-template').content.cloneNode(true));
  p.querySelector('.ag-feedback').before(root.querySelector('#ag-download-template').content.cloneNode(true));
}
let state = { ...defaults },
  session = {},
  initializing = true,
  popupTab = null,
  refreshing = false,
  busy = true,
  dirty = false,
  exportOpen = false,
  settingsOpen = false,
  notice = '',
  isError = false;
let showRating = false,
  ratingPreview = false;
const ratingWidget = root.querySelector('.ag-rating');
// Keep the stars last, below the download and demo attribution.
root.querySelector('.ag-content').append(ratingWidget);
function highlightRating(stars) {
  for (const button of ratingWidget.querySelectorAll('[data-rating]'))
    button.classList.toggle('is-highlighted', Number(button.dataset.rating) <= stars);
}
ratingWidget.addEventListener('pointerover', (event) =>
  highlightRating(Number(event.target.closest('[data-rating]')?.dataset.rating) || 0),
);
ratingWidget.addEventListener('pointerleave', () => highlightRating(0));
ratingWidget.addEventListener('focusin', (event) =>
  highlightRating(Number(event.target.closest('[data-rating]')?.dataset.rating) || 0),
);
ratingWidget.addEventListener('focusout', () => highlightRating(0));
const activityBars = [...root.querySelectorAll('.ag-bars > span')],
  bandLevels = new Float32Array(5),
  bandTargets = new Float32Array(5),
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let meterPort = null,
  meterFrame = 0,
  meterAt = 0;
function paintBands() {
  activityBars.forEach((bar, index) => bar.style.setProperty('--ag-band', bandLevels[index].toFixed(3)));
  root.dataset.outputLevel = Math.max(...bandLevels).toFixed(3);
}
function animateBands(now) {
  const elapsed = meterAt ? Math.min(now - meterAt, 64) : 16;
  meterAt = now;
  let moving = false;
  for (let i = 0; i < bandLevels.length; i++) {
    const difference = bandTargets[i] - bandLevels[i];
    bandLevels[i] += difference * (1 - Math.exp(-elapsed / (difference > 0 ? 30 : 180)));
    if (Math.abs(bandTargets[i] - bandLevels[i]) < 0.002) bandLevels[i] = bandTargets[i];
    else moving = true;
  }
  paintBands();
  meterFrame = moving ? requestAnimationFrame(animateBands) : 0;
  if (!moving) meterAt = 0;
}
function drawBands(bands) {
  for (let i = 0; i < bandTargets.length; i++)
    bandTargets[i] = Number.isFinite(bands?.[i]) ? Math.max(0, Math.min(1, bands[i])) : 0;
  if (reducedMotion.matches) {
    cancelAnimationFrame(meterFrame);
    meterFrame = meterAt = 0;
    bandLevels.set(bandTargets);
    paintBands();
  } else if (!meterFrame) meterFrame = requestAnimationFrame(animateBands);
}
function stopMeter() {
  const port = meterPort;
  meterPort = null;
  port?.disconnect();
  cancelAnimationFrame(meterFrame);
  meterFrame = meterAt = 0;
  bandLevels.fill(0);
  bandTargets.fill(0);
  paintBands();
}
function startMeter() {
  if (meterPort || document.hidden || !session.mode) return;
  const port = chrome.runtime.connect({ name: 'sr-meter' });
  meterPort = port;
  port.onMessage.addListener((value) => {
    if (meterPort === port) drawBands(value.bands);
  });
  port.onDisconnect.addListener(() => {
    if (meterPort === port) {
      meterPort = null;
      stopMeter();
    }
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMeter();
  else startMeter();
});
window.addEventListener('pagehide', stopMeter);
const time = (seconds) =>
  Number.isFinite(seconds) ? Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0') : '—';
async function send(command, args = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'worker', command, ...args });
  if (!response?.ok) throw Error(response?.error || 'The audio engine is unavailable. Reopen the extension.');
  return response.value;
}
function adopt(value) {
  session = value || {};
  if (session.mode) startMeter();
  else stopMeter();
  if (!dirty && value?.settings) state = normalize(value.settings);
}
async function perform(command, args = {}) {
  if (busy) return;
  busy = true;
  notice = command === 'EXPORT' ? 'Rendering WAV on your device…' : '';
  isError = false;
  render();
  try {
    adopt(await send(command, args));
    if (session.download) notice = 'WAV ready: ' + session.download;
  } catch (error) {
    notice = error.message;
    isError = true;
    try {
      adopt(await send('STATUS'));
    } catch {
      /* Keep the actionable original error. */
    }
  } finally {
    busy = false;
    render();
  }
}
async function save() {
  dirty = false;
  await perform('UPDATE', { settings: state });
}
function render() {
  const fileMode = state.source === 'file',
    connected = session.mode === 'browser' && session.tabId != null;
  const file = session.file,
    playing = fileMode ? session.mode === 'file' && session.playing : connected && session.playing;
  const empty =
    !fileMode &&
    (session.connection === 'unavailable' || (session.connection === 'waiting' && !connected && !session.failure));
  if (empty) settingsOpen = false;
  for (const p of root.querySelectorAll('.ag-product')) {
    for (const el of p.querySelectorAll('button,input,select')) el.disabled = busy;
    p.querySelector('.ag-header-actions').hidden = initializing || empty;
    p.querySelector('.ag-empty').hidden = initializing || !empty;
    p.querySelector('.ag-empty-error').textContent = isError ? notice : '';
    p.querySelector('.ag-content').hidden = initializing || empty || settingsOpen;
    p.querySelector('.ag-settings-panel').hidden = !settingsOpen;
    p.querySelector('.ag-settings').setAttribute('aria-expanded', String(settingsOpen));
    p.querySelector('.ag-settings').setAttribute('aria-label', settingsOpen ? 'Close settings' : 'Settings');
    p.querySelector('.ag-settings').dataset.tooltip = settingsOpen ? 'Close settings' : 'Settings';
    p.querySelector('[data-engine-help]').textContent =
      state.engine === 'rubberband'
        ? 'High-quality pitch and tempo processing.'
        : 'Uses less CPU. Useful on slower devices.';
    p.querySelector('[data-quality-help]').textContent =
      state.engine === 'rubberband'
        ? 'Lightweight uses a shorter processing window to reduce CPU usage.'
        : 'Lightweight reduces CPU usage. High quality uses a longer analysis window.';
    p.querySelector('.ag-settings-feedback').textContent = session.failure?.message || notice;
    p.classList.toggle('is-playing', !!playing);
    p.classList.toggle('is-file', fileMode);
    p.classList.toggle('is-off', !state.active || state.compare === 'original' || !!session.failure);
    for (const el of p.querySelectorAll('[data-source]'))
      el.setAttribute('aria-pressed', String(el.dataset.source === state.source));
    p.querySelector('.ag-drop').hidden = !fileMode || !!file;
    p.querySelector('.ag-file-player').hidden = fileMode && !file;
    const name = fileMode
      ? file?.name || ''
      : connected
        ? session.title || session.targetTitle
        : session.targetTitle || 'Connect a browser tab';
    p.querySelector('.ag-file-name').textContent = name;
    p.querySelector('.ag-file-name').title = name;
    const meta = p.querySelector('.ag-file-meta');
    meta.textContent = fileMode
      ? file?.demo
        ? 'Madam Snowflake feat. Admiral Bob'
        : file
          ? `${(file.sampleRate / 1000).toFixed(1)} kHz · ${(file.size / 1048576).toFixed(1)} MB`
          : ''
      : connected
        ? ''
        : 'Connect to the selected tab';
    meta.hidden = !meta.textContent;
    p.querySelector('.ag-file-row .ag-choose').hidden = !fileMode;
    p.querySelector('[data-disconnect]').hidden = fileMode || !connected;
    p.querySelector('[data-remove]').hidden = !fileMode || !file;
    p.querySelector('[data-source-status]').textContent =
      !fileMode && connected
        ? `DSP latency ≈ ${Math.round((session.latency || 0) * 1000)} ms`
        : fileMode && file
          ? 'Local audio file'
          : 'Click the extension icon on your music tab';
    const play = p.querySelector('.ag-file-play');
    play.disabled = busy || (fileMode && !file);
    play.setAttribute('aria-pressed', String(!!playing));
    play.setAttribute(
      'aria-label',
      !fileMode && !connected ? 'Connect tab audio' : playing ? 'Pause audio' : 'Play audio',
    );
    play.querySelector('.ag-play-symbol').innerHTML =
      `<i data-lucide="${playing ? 'pause' : 'play'}" aria-hidden="true"></i>`;
    const duration = fileMode ? file?.duration || 0 : connected ? session.duration || 0 : 0;
    const position = fileMode && session.mode !== 'file' ? 0 : session.position || 0;
    const speed = effective(state).speed;
    const seek = p.querySelector('.ag-file-seek');
    seek.max = duration || 1;
    seek.value = Math.min(position, duration);
    seek.disabled = busy || !duration || (fileMode && session.mode !== 'file');
    seek.style.setProperty('--ag-fill', duration ? `${(position / duration) * 100}%` : '0%');
    p.querySelector('[data-file-time]').textContent = duration ? time(position / speed) : '—';
    p.querySelector('[data-file-length]').textContent = duration ? time(duration / speed) : 'No audio connected';
    p.querySelector('.ag-file-error').textContent = '';
    p.querySelector('.ag-file-export').hidden = !fileMode || !file || !!session.failure;
    p.querySelector('.ag-compare').hidden = !!session.failure;
    p.querySelector('.ag-mini-status').hidden = !!session.failure || showRating || (fileMode && !!file);
    ratingWidget.hidden = !showRating || !!session.failure || isError || exportOpen;
    p.querySelector('.ag-export-options').setAttribute('aria-expanded', String(exportOpen));
    p.querySelector('.ag-export-options-panel').hidden = !exportOpen;
    p.querySelector('.ag-export-format').hidden = !exportOpen;
    p.querySelector('.ag-download').disabled = busy || !file;
    p.querySelector('.ag-demo-credit').hidden = !fileMode || !file?.demo;
    p.querySelector('.ag-power').setAttribute('aria-pressed', String(state.active));
    p.querySelector('.ag-power').setAttribute('aria-label', state.active ? 'Turn effect off' : 'Turn effect on');
    for (const el of p.querySelectorAll('[data-param]')) {
      const key = el.dataset.param;
      if (el.type === 'checkbox') el.checked = state[key];
      else el.value = state[key];
      if (el.type === 'range')
        el.style.setProperty(
          '--ag-fill',
          `${(100 * (Number(el.value) - Number(el.min))) / (Number(el.max) - Number(el.min))}%`,
        );
    }
    for (const el of p.querySelectorAll('[data-output]')) {
      const key = el.dataset.output;
      if (key === 'speed') el.innerHTML = state.speed.toFixed(2) + '<span>×</span>';
      else el.textContent = state[key] + '%';
    }
    for (const el of p.querySelectorAll('[data-pitch-help]'))
      el.textContent = state.keep
        ? 'Change the tempo, keep the original key.'
        : state.speed === 1
          ? 'Original speed and pitch.'
          : `The voice gets ${state.speed > 1 ? 'higher' : 'lower'} with the speed.`;
    for (const el of p.querySelectorAll('[data-preset]'))
      el.setAttribute('aria-pressed', String(el.dataset.preset === state.preset));
    for (const el of p.querySelectorAll('[data-compare]'))
      el.setAttribute('aria-pressed', String(el.dataset.compare === (state.active ? state.compare : 'original')));
    for (const el of p.querySelectorAll('[data-status]'))
      el.textContent = !state.active
        ? 'Effect off'
        : state.compare === 'original'
          ? 'Original sound'
          : (fileMode && !file) || (!fileMode && !connected)
            ? 'Ready to connect'
            : 'Effect on';
    for (const el of p.querySelectorAll('[data-mini-quality]'))
      el.textContent =
        state.engine === 'rubberband'
          ? `Rubber Band · ${state.quality === 'high' ? 'High' : 'Light'}`
          : state.quality === 'high'
            ? 'High quality'
            : 'Lightweight';
    const feedback = p.querySelector('.ag-feedback');
    feedback.textContent = session.failure
      ? session.failure.message || 'Audio processing stopped.'
      : notice;
    feedback.classList.toggle('is-error', isError || !!session.failure);
    p.querySelector('[data-retry]').hidden = !session.failure;
    if (session.failure) p.querySelector('[data-status]').textContent = 'Effect unavailable';
  }
  sizePopup();
}
function sizePopup() {
  if (!document.documentElement.classList.contains('is-toolbar-popup')) return;
  const product = root.querySelector('.ag-product');
  if (product)
    document.documentElement.style.height = Math.min(600, Math.ceil(product.getBoundingClientRect().height)) + 'px';
}
new ResizeObserver(sizePopup).observe(root);
root.addEventListener('input', (event) => {
  const el = event.target;
  if (!el.dataset.param || busy) return;
  state[el.dataset.param] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
  dirty = true;
  render();
});
root.addEventListener('change', (event) => {
  if (event.target.dataset.param) void save();
  if (event.target.classList.contains('ag-file-seek')) void perform('SEEK', { position: Number(event.target.value) });
});
root.addEventListener('click', (event) => {
  const b = event.target.closest('button');
  if (!b || busy) return;
  void (async () => {
    if (b.classList.contains('ag-settings') || b.hasAttribute('data-close-settings')) {
      settingsOpen = !settingsOpen;
      render();
      (settingsOpen ? root.querySelector('[data-param=engine]') : root.querySelector('.ag-settings')).focus();
    } else if (b.dataset.source) {
      if (b.dataset.source === state.source) return;
      if (b.dataset.source === 'browser' && session.mode === 'file') await perform('PAUSE');
      state.source = b.dataset.source;
      await save();
      if (state.source === 'browser' && session.mode !== 'browser') await perform('CONNECT', { automatic: true });
      if (state.source === 'file' && session.mode !== 'browser' && !session.file && (await storedFile('get')))
        await perform('LOAD', { demo: false });
    } else if (b.dataset.preset) {
      state = preset(b.dataset.preset, state);
      await save();
    } else if (b.dataset.compare) {
      state.compare = b.dataset.compare;
      state.active = true;
      await save();
    } else if (b.hasAttribute('data-retry')) await perform('RETRY');
    else if (b.hasAttribute('data-disconnect')) await perform('DISCONNECT');
    else if (b.hasAttribute('data-remove')) await perform('REMOVE');
    else if (b.classList.contains('ag-reset')) {
      state = reset(state);
      await save();
    } else if (b.classList.contains('ag-power')) {
      state.active = !state.active;
      await save();
    } else if (b.classList.contains('ag-choose')) root.querySelector('#ag-local-file').click();
    else if (b.classList.contains('ag-demo')) await perform('LOAD', { demo: true });
    else if (b.classList.contains('ag-file-play'))
      await perform(
        state.source === 'browser' && session.mode !== 'browser'
          ? 'CONNECT'
          : state.source === 'file' && session.mode === 'browser'
            ? 'PLAY_FILE'
            : 'PLAY',
      );
    else if (b.classList.contains('ag-export-options')) {
      exportOpen = !exportOpen;
      render();
    } else if (b.classList.contains('ag-download')) await perform('EXPORT');
    else if (b.dataset.rating) {
      if (ratingPreview) notice = 'Rating preview — no link was opened.';
      else {
        await send('RATE', { stars: Number(b.dataset.rating) });
        showRating = false;
      }
      render();
    }
  })().catch((error) => {
    notice = error.message;
    isError = true;
    render();
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsOpen && !busy) {
    event.preventDefault();
    settingsOpen = false;
    render();
    root.querySelector('.ag-settings').focus();
  }
});
async function choose(file) {
  if (!file || busy) return;
  if (file.size > 50 * 1024 * 1024) {
    notice = 'Choose a file smaller than 50 MB.';
    isError = true;
    render();
    return;
  }
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|ogg|flac)$/i.test(file.name)) {
    notice = 'Please choose an audio file.';
    isError = true;
    render();
    return;
  }
  busy = true;
  render();
  try {
    await storedFile('put', { name: file.name, blob: file }, 'pending');
    busy = false;
    await perform('LOAD', { demo: false, pending: true });
  } catch (error) {
    notice = error.message;
    isError = true;
  } finally {
    busy = false;
    render();
  }
}
root.querySelector('#ag-local-file').addEventListener('change', (event) => {
  void choose(event.target.files[0]);
  event.target.value = '';
});
for (const area of root.querySelectorAll('.ag-file-area')) {
  area.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (state.source === 'file') area.classList.add('is-dragging');
  });
  area.addEventListener('dragleave', () => area.classList.remove('is-dragging'));
  area.addEventListener('drop', (event) => {
    event.preventDefault();
    area.classList.remove('is-dragging');
    if (state.source === 'file') void choose(event.dataTransfer.files[0]);
  });
}
async function refresh() {
  if (busy || dirty || refreshing) return;
  refreshing = true;
  try {
    const waitingTab = session.connection === 'waiting' && !document.hidden ? popupTab : null;
    const value = await send('STATUS', { waitingTab });
    if (!busy && !dirty) {
      adopt(value);
      render();
    }
  } catch (error) {
    if (!notice) {
      notice = error.message;
      isError = true;
      render();
    }
  } finally {
    refreshing = false;
  }
}
render();
try {
  // Only the toolbar popup selects a tab; opening this document for inspection must not retarget audio.
  const popup = !(await chrome.tabs.getCurrent());
  ratingPreview = new URLSearchParams(location.search).get('preview') === 'rating';
  document.documentElement.classList.toggle('is-toolbar-popup', popup || ratingPreview);
  if (ratingPreview) document.title = 'Rating preview — slowed & reverb';
  const { rating } = await chrome.storage.local.get('rating');
  showRating = ratingPreview || shouldAsk(normalizeRating(rating), ratingLinks);
  adopt(await send(popup ? 'OPEN' : 'STATUS'));
  if (popup) popupTab = session.targetTab;
} catch (error) {
  notice = error.message;
  isError = true;
} finally {
  initializing = false;
  busy = false;
  render();
}
if (state.source === 'file' && session.mode !== 'browser' && !session.file && (await storedFile('get')))
  await perform('LOAD', { demo: false });
setInterval(() => {
  void refresh();
}, 500);

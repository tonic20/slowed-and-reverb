// Minimal experiment checks in a disposable Chrome profile. Node 24+, Chrome 137+.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, '.output/chrome-mv3/manifest.json'), 'utf8'));
assert.equal(manifest.action.default_popup, 'panel.html', 'toolbar action opens the audio popup');
assert.equal(manifest.side_panel, undefined, 'no sidebar entry');
assert.equal(manifest.permissions.includes('sidePanel'), false, 'no sidebar permission');
const profile = await mkdtemp('/tmp/afterglow-smoke-');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function cdp(url) {
  const ws = new WebSocket(url),
    pending = new Map(),
    events = [];
  let sequence = 0;
  const ready = new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data),
      entry = pending.get(msg.id);
    if (msg.method) events.push(msg);
    if (entry) {
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.fail(Error(JSON.stringify(msg.error)));
      else entry.ok(msg.result);
    }
  };
  async function send(method, params = {}) {
    await ready;
    return new Promise((ok, fail) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(Error(`Timeout: ${method}`));
      }, 20000);
      pending.set(id, { ok, fail, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    send,
    events,
    close: () => ws.close(),
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
  };
}
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://local').pathname;
    const path = resolve(root, `.${/^\/(vendor|assets|audio)\//.test(pathname) ? '/public' : ''}${pathname}`);
    if (!path.startsWith(root)) return res.writeHead(403).end();
    const body = await readFile(path);
    res
      .writeHead(200, {
        'content-type':
          { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' }[
            extname(path)
          ] || 'application/octet-stream',
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const child = spawn(
  process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    ...(process.env.HEADED ? [] : ['--headless=new', '--screen-info={1280x1000}']),
    '--window-size=1280,1000',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const connections = [];
async function until(fn, label) {
  for (let i = 0; i < 60; i++) {
    if (await fn()) return;
    await pause(100);
  }
  throw Error(`Timeout: ${label}`);
}
async function runBrowserChecks() {
  let port;
  await until(async () => {
    try {
      port = (await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0];
      return port;
    } catch {
      return false;
    }
  }, 'Chrome startup');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = cdp(version.webSocketDebuggerUrl);
  connections.push(browser);
  async function page(url) {
    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    ).json();
    const client = cdp(target.webSocketDebuggerUrl);
    connections.push(client);
    await until(
      () => client.evaluate(`document.URL === ${JSON.stringify(url)} && document.readyState === 'complete'`),
      url,
    );
    return { ...client, id: target.id };
  }
  if (process.argv.includes('--store')) {
    const { captureStore } = await import('../docs/store/capture-ui.mjs');
    await captureStore({ browser, page, until, root });
    return;
  }
  if (process.argv.includes('--site-audio')) {
    const { renderSiteAudio } = await import('../docs/store/render-site-audio.mjs');
    await renderSiteAudio({ page, base, root });
    return;
  }
  if (process.argv.includes('--compare')) {
    const { checkComparison } = await import('./compare-browser.mjs');
    await checkComparison(page);
    return;
  }
  if (process.argv.includes('--live')) {
    const { checkLiveComparison } = await import('./live-comparison.mjs');
    await checkLiveComparison({ page, browser, root });
    return;
  }
  if (process.argv.includes('--live-ui')) {
    const { checkLiveControls } = await import('./live-comparison.mjs');
    await checkLiveControls({ page, until });
    return;
  }
  const audioPage = await page(`${base}/tests/audio.html`);
  await until(() => audioPage.evaluate('typeof checkAudio === "function"'), 'audio engine loaded');
  console.log(
    'PASS live formant envelope after slowing down and speeding up',
    await audioPage.evaluate('checkFormants()'),
  );
  if (process.argv.includes('--formants-only')) return;
  const result = await audioPage.evaluate('checkAudio()');
  for (const mode of result.modes) {
    assert.equal(mode.duration, 2.5);
    assert.equal(mode.finite, true);
    for (const [channel, hz] of [
      ['left', 440],
      ['right', 660],
    ])
      assert.ok(Math.abs(1200 * Math.log2(mode[channel] / (hz * (mode.keep ? 1 : 0.8)))) < 15, JSON.stringify(mode));
  }
  assert.ok(result.monoRightEnergy > 1, 'mono must play in both speakers');
  assert.ok(result.protectedPeak <= 0.981);
  assert.ok(result.unprotectedPeak > 1);
  assert.equal(result.exact, true);
  assert.equal(result.truncated, 0.1);
  for (const room of result.reverbs) {
    assert.ok(room.energy > 0.0001);
    assert.equal(room.duration, 1.65);
  }
  assert.deepEqual(result.wav, { channels: 2, frames: 96000, rate: 48000 });
  console.log(
    'PASS audio kernel, both quality modes, stereo pitch, original bypass, three rooms, export tail, WAV',
    result,
  );
  console.log('PASS realtime routing, transitions and recovery', await audioPage.evaluate('checkRealtime()'));
  console.log(
    'PASS Rubber Band captured stream, pitch, engine transitions and FIFO',
    await audioPage.evaluate('checkRubberBand()'),
  );
  const extension = await browser.send('Extensions.loadUnpacked', { path: resolve(root, '.output/chrome-mv3') });
  let panel = await page(`chrome-extension://${extension.id}/panel.html`);
  await until(
    () =>
      panel.evaluate(
        "document.querySelector('.ag-popup [data-source=file]') && !document.querySelector('.ag-popup [data-source=file]').disabled",
      ),
    'extension UI',
  );
  await panel.evaluate("document.querySelector('.ag-popup [data-source=file]').click()");
  await until(
    () =>
      panel.evaluate(
        "document.querySelector('.ag-popup [data-source=file]').getAttribute('aria-pressed')==='true' && !document.querySelector('.ag-popup .ag-demo').disabled",
      ),
    'file source ready',
  );
  async function clickPreset(name, speed) {
    await panel.evaluate(`document.querySelector('[data-preset=${name}]').click()`);
    await until(
      () =>
        panel.evaluate(`!document.querySelector('[data-preset=${name}]').disabled &&
        document.querySelector('[data-preset=${name}]').getAttribute('aria-pressed') === 'true' &&
        Number(document.querySelector('[data-param=speed]').value) === ${speed}`),
      `${name} selected at ${speed}`,
    );
  }
  await panel.evaluate("document.querySelector('.ag-settings').click()");
  assert.equal(await panel.evaluate("document.querySelector('.ag-settings-panel').hidden"), false);
  assert.equal(await panel.evaluate("document.querySelector('.ag-content').hidden"), true);
  await panel.evaluate(`(() => {
    const select = document.querySelector('[data-param=engine]');
    select.value = 'rubberband';
    select.dispatchEvent(new Event('input', {bubbles:true}));
    select.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await until(
    () =>
      panel.evaluate(`(async () => !document.querySelector('.ag-settings').disabled &&
    (await chrome.storage.local.get('settings')).settings.engine === 'rubberband')()`),
    'engine choice saved',
  );
  await panel.evaluate("document.querySelector('[data-close-settings]').click()");
  assert.equal(await panel.evaluate("document.querySelector('.ag-settings-panel').hidden"), true);
  async function editSpeed(speed) {
    await panel.evaluate(`(() => {
      const input = document.querySelector('[data-param=speed]');
      input.value = ${speed};
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await until(
      () =>
        panel.evaluate(`(async () => !document.querySelector('[data-param=speed]').disabled &&
        (await chrome.storage.local.get('settings')).settings.speed === ${speed})()`),
      'edited preset saved',
    );
  }
  await clickPreset('dream', 0.75);
  await editSpeed(0.69);
  assert.equal(
    await panel.evaluate("document.querySelector('[data-preset=dream]').getAttribute('aria-pressed')"),
    'true',
  );
  await clickPreset('night', 1.2);
  await editSpeed(1.3);
  await panel.send('Page.reload');
  await until(
    () =>
      panel.evaluate(
        "document.querySelector('[data-preset=night]')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-preset=night]').disabled",
      ),
    'selected preset survives reopening',
  );
  assert.equal(await panel.evaluate("Number(document.querySelector('[data-param=speed]').value)"), 1.3);
  await clickPreset('dream', 0.69);
  await panel.evaluate("document.querySelector('.ag-reset').click()");
  await until(
    () =>
      panel.evaluate(
        "!document.querySelector('.ag-reset').disabled && Number(document.querySelector('[data-param=speed]').value) === 0.75",
      ),
    'Reset restores selected preset',
  );
  assert.equal(
    await panel.evaluate("document.querySelector('[data-preset=dream]').getAttribute('aria-pressed')"),
    'true',
  );
  await clickPreset('night', 1.2);
  await clickPreset('slow', 0.82);
  console.log('PASS preset edits, selection, persistence and Reset across presets');
  await panel.evaluate("document.querySelector('.ag-popup .ag-demo').click()");
  await until(
    () => panel.evaluate("document.querySelector('.ag-popup .ag-file-name').textContent.includes('A Foolish Game')"),
    'real decoded demo',
  );
  await panel.evaluate("document.querySelector('.ag-popup .ag-file-play').click()");
  await until(
    () => panel.evaluate("document.querySelector('.ag-popup .ag-file-play').getAttribute('aria-pressed')==='true'"),
    'real audio playback',
  );
  console.log('PASS installed extension file playback');

  const api = async (command, args = {}) =>
    panel.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ target: 'worker', command, ...args })})`);
  assert.equal((await api('STATUS')).value.settings.keep, true);
  assert.equal(
    await panel.evaluate("document.querySelector('.ag-rating').hidden"),
    true,
    'rating stays hidden on the first listening session',
  );
  const ratingSettings = (await api('STATUS')).value.settings;
  await api('RATING_RUN', { id: 'test-session-1' });
  await api('RATING_RUN', { id: 'test-session-1' });
  assert.equal((await panel.evaluate("chrome.storage.local.get('rating')")).rating.runs, 1);
  await api('RATING_RUN', { id: 'test-session-2' });
  assert.equal((await panel.evaluate("chrome.storage.local.get('rating')")).rating.runs, 2);
  const eligiblePopup = await page(`chrome-extension://${extension.id}/panel.html`);
  await until(
    () => eligiblePopup.evaluate("document.querySelector('.ag-rating')?.hidden === false"),
    'earned rating prompt',
  );
  await eligiblePopup.evaluate("document.querySelectorAll('[data-rating]')[1].click()");
  await until(
    async () => (await panel.evaluate("chrome.storage.local.get('rating')")).rating.rated === 2,
    'feedback selected',
  );
  await browser.send('Target.closeTarget', { targetId: eligiblePopup.id });
  assert.equal(
    (await panel.evaluate("chrome.storage.local.get('rating')")).rating.rated,
    2,
    'selection is remembered after opening feedback',
  );
  assert.deepEqual((await api('STATUS')).value.settings, ratingSettings, 'rating does not change effects');
  await panel.evaluate("chrome.storage.local.remove('rating')");

  // An explicit inert preview exercises the footer layout in a real Chrome action popup.
  await panel.evaluate("chrome.action.setPopup({popup:'panel.html?preview=rating'})");
  const ratingTargets = await browser.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
  await browser.send('Extensions.triggerAction', {
    id: extension.id,
    targetId: ratingTargets.targetInfos.find((t) => t.url === `${base}/tests/audio.html`).targetId,
  });
  await until(
    () =>
      panel.evaluate(
        "chrome.extension.getViews({type:'popup'})[0]?.document.querySelector('.ag-rating')?.hidden === false",
      ),
    'rating preview',
  );
  await panel.evaluate("chrome.extension.getViews({type:'popup'})[0].document.fonts.ready");
  await pause(550);
  const ratingSize = await panel.evaluate(
    "(()=>{const p=chrome.extension.getViews({type:'popup'})[0],d=p.document;return {height:p.innerHeight,scroll:d.body.scrollHeight,bottom:d.querySelector('.ag-rating').getBoundingClientRect().bottom,font:d.fonts.check('14px Onest')};})()",
  );
  assert.ok(
    ratingSize.font && ratingSize.scroll <= ratingSize.height + 1 && ratingSize.bottom <= ratingSize.height,
    JSON.stringify(ratingSize),
  );
  await panel.evaluate("chrome.extension.getViews({type:'popup'})[0].document.querySelector('.ag-settings').click()");
  await pause(250);
  const settingsSize = await panel.evaluate(`(() => {
    const popup = chrome.extension.getViews({type:'popup'})[0];
    return {height:popup.innerHeight,scroll:popup.document.body.scrollHeight,
      width:popup.innerWidth,contentWidth:popup.document.documentElement.scrollWidth};
  })()`);
  assert.ok(
    settingsSize.scroll <= settingsSize.height + 1 && settingsSize.contentWidth <= settingsSize.width,
    JSON.stringify(settingsSize),
  );
  assert.ok(settingsSize.height < ratingSize.height, 'Settings popup shrinks to fit');
  await panel.evaluate(
    "chrome.extension.getViews({type:'popup'})[0].document.querySelector('[data-close-settings]').click()",
  );
  await pause(250);
  await panel.evaluate(
    "chrome.extension.getViews({type:'popup'})[0].document.querySelectorAll('[data-rating]')[2].focus()",
  );
  assert.equal(
    await panel.evaluate(
      "chrome.extension.getViews({type:'popup'})[0].document.querySelectorAll('.ag-rating .is-highlighted').length",
    ),
    3,
  );
  await panel.evaluate(
    "chrome.extension.getViews({type:'popup'})[0].close();chrome.action.setPopup({popup:'panel.html'})",
  );
  console.log('PASS rating eligibility, persistence, keyboard stars and popup fit', ratingSize);

  const all = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  await panel.send('Page.bringToFront');
  const offTarget = all.find((t) => t.url === `chrome-extension://${extension.id}/offscreen.html`);
  assert.ok(offTarget, 'offscreen persists');
  const off = cdp(offTarget.webSocketDebuggerUrl);
  connections.push(off);
  await off.evaluate(
    `(()=>{const connect=AudioNode.prototype.connect;AudioNode.prototype.connect=function(destination,...args){const result=connect.call(this,destination,...args);if(this instanceof AudioWorkletNode&&this.parameters.size===0){globalThis.lastPitchNode=this;if(globalThis.failNextPitch){globalThis.failNextPitch=false;queueMicrotask(()=>this.dispatchEvent(new Event('processorerror')));}}if(this instanceof AudioWorkletNode&&this.parameters.has('volume')){globalThis.lastDynamics=this;const m=this.context.createAnalyser();m.fftSize=32768;m.smoothingTimeConstant=0;connect.call(this,m);globalThis.readLivePitch=()=>{const bins=new Float32Array(m.frequencyBinCount);m.getFloatFrequencyData(bins);let peak=1;for(let i=2;i<1000;i++)if(bins[i]>bins[peak])peak=i;return{hz:peak*m.context.sampleRate/m.fftSize,db:bins[peak],time:m.context.currentTime};};}return result;};})()`,
  );

  await api('UPDATE', { settings: { quality: 'light' } });
  await until(
    () => panel.evaluate("Number(document.querySelector('#ag-concept').dataset.outputLevel)>0.05"),
    'wave reads actual output',
  );
  await off.evaluate("lastPitchNode.dispatchEvent(new Event('processorerror'))");
  await until(async () => (await api('STATUS')).value.failure?.source === 'file', 'file processor failure reported');
  assert.equal((await api('STATUS')).value.playing, true, 'file continues original after failure');
  await until(() => panel.evaluate("!document.querySelector('.ag-popup [data-retry]').hidden"), 'Retry shown');
  const fileTargets = await browser.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
  await browser.send('Extensions.triggerAction', {
    id: extension.id,
    targetId: fileTargets.targetInfos.find((t) => t.url === `${base}/tests/audio.html`).targetId,
  });
  await until(
    () =>
      panel.evaluate(
        "chrome.extension.getViews({type:'popup'})[0]?.document.querySelector('[data-retry]')?.hidden === false",
      ),
    'file failure visible in real popup',
  );
  await pause(250);
  const fileFailureSize = await panel.evaluate(
    "(()=>{const p=chrome.extension.getViews({type:'popup'})[0];return {height:p.innerHeight,scroll:p.document.body.scrollHeight,retry:p.document.querySelector('[data-retry]').getBoundingClientRect().bottom,credit:p.document.querySelector('.ag-demo-credit').getBoundingClientRect().bottom};})()",
  );
  assert.ok(
    fileFailureSize.scroll <= fileFailureSize.height + 1 &&
      fileFailureSize.retry <= fileFailureSize.height &&
      fileFailureSize.credit <= fileFailureSize.height,
    'file failure, Retry and attribution fit without scrolling: ' + JSON.stringify(fileFailureSize),
  );
  await panel.evaluate("chrome.extension.getViews({type:'popup'})[0].close()");
  await panel.evaluate("document.querySelector('.ag-popup [data-retry]').click()");
  await until(async () => !(await api('STATUS')).value.failure, 'file Retry restores effect');
  await off.evaluate("lastDynamics.dispatchEvent(new Event('processorerror'))");
  await until(async () => !!(await api('STATUS')).value.failure, 'dynamics failure reported');
  assert.equal((await api('RETRY')).ok, true);
  assert.equal((await api('STATUS')).value.failure, null);
  await off.evaluate('globalThis.failNextPitch=true');
  await api('UPDATE', { settings: { quality: 'high' } });
  assert.equal((await api('STATUS')).value.failure.source, 'file', 'failed candidate safely falls back');
  assert.equal((await api('STATUS')).value.settings.quality, 'high', 'failed candidate keeps requested settings');
  await api('RETRY');
  assert.equal((await api('STATUS')).value.failure, null);

  await pause(400);
  const beforeClose = (await api('STATUS')).value.position;
  await browser.send('Target.closeTarget', { targetId: panel.id });
  await pause(300);
  panel = await page(`chrome-extension://${extension.id}/panel.html`);
  await until(
    () => panel.evaluate("document.querySelector('.ag-popup .ag-file-name').textContent.includes('A Foolish Game')"),
    'restored session',
  );
  assert.ok((await api('STATUS')).value.position > beforeClose, 'audio continues with panel closed');
  assert.equal((await api('SEEK', { position: 20 })).ok, true);
  assert.ok((await api('STATUS')).value.position >= 20);
  await api('PAUSE');
  await until(
    () => panel.evaluate("Number(document.querySelector('#ag-concept').dataset.outputLevel)<0.005"),
    'wave rests on pause',
  );
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: profile });
  const exported = await api('EXPORT');
  assert.equal(exported.ok, true, JSON.stringify(exported));
  let completed;
  await until(async () => {
    completed = (await panel.evaluate('chrome.downloads.search({state:"complete"})'))[0];
    return !!completed;
  }, 'real downloaded WAV');
  const downloaded = await readFile(completed.filename);
  assert.equal(downloaded.toString('ascii', 0, 4), 'RIFF');
  assert.ok(downloaded.length > 100000);
  assert.equal(completed.byExtensionId, extension.id);
  await until(
    async () =>
      !Object.keys(await panel.evaluate('chrome.storage.session.get(null)')).some((k) => k.startsWith('download-')),
    'download URL released',
  );

  for (const width of [380, 320]) {
    await panel.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause(550);
    assert.equal(await panel.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  }
  await api('UPDATE', { settings: { source: 'file' } });
  await pause(550);
  await panel.evaluate(
    `(async()=>{const bytes=await(await fetch(chrome.runtime.getURL('assets/vocal-demo.mp3'))).blob();const dt=new DataTransfer();dt.items.add(new File([bytes],'my-song.mp3',{type:'audio/mpeg'}));const input=document.querySelector('#ag-local-file');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(async () => (await api('STATUS')).value.file?.name === 'my-song.mp3', 'uploaded file decoded');
  await until(() => panel.evaluate("!document.querySelector('.ag-popup .ag-choose').disabled"), 'upload finished');
  await panel.evaluate(
    `(()=>{const dt=new DataTransfer();dt.items.add(new File(['broken audio'],'corrupt.mp3',{type:'audio/mpeg'}));const input=document.querySelector('#ag-local-file');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(
    () =>
      panel.evaluate("document.querySelector('.ag-popup .ag-feedback').textContent.includes('could not be decoded')"),
    'corrupt file error',
  );
  assert.equal((await api('STATUS')).value.file.name, 'my-song.mp3', 'bad upload retains decoded file');
  assert.equal((await api('LOAD')).value.file.name, 'my-song.mp3', 'bad upload retains saved file');
  await api('REMOVE');
  assert.equal((await api('LOAD')).ok, false, 'remove clears saved file');
  await pause(550);
  await panel.evaluate("document.querySelector('.ag-popup .ag-demo').click()");
  await until(
    () =>
      panel.evaluate(
        "document.querySelector('.ag-popup .ag-file-name').textContent.includes('A Foolish Game') && !document.querySelector('.ag-popup .ag-download').disabled",
      ),
    'demo for screenshot',
  );
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 380,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await writeFile(
    '/tmp/slowed-reverb-extension-simple.png',
    Buffer.from((await panel.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await api('UPDATE', {
    settings: { source: 'browser', speed: 0.82, wet: 0, volume: 100, keep: true, formant: false },
  });
  await api('PAUSE');
  const fixture = await page(`${base}/tests/player.html`);
  await until(() => fixture.evaluate("document.querySelector('audio').readyState>=2"), 'tab player ready');
  await fixture.evaluate(
    `(()=>{const n=48000*20,v=new DataView(new ArrayBuffer(44+n*2));const t=(o,s)=>[...s].forEach((x,i)=>v.setUint8(o+i,x.charCodeAt(0)));t(0,'RIFF');v.setUint32(4,36+n*2,true);t(8,'WAVE');t(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,48000,true);v.setUint32(28,96000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);t(36,'data');v.setUint32(40,n*2,true);for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.sin(2*Math.PI*440*i/48000)*6000,true);document.querySelector('audio').src=URL.createObjectURL(new Blob([v],{type:'audio/wav'}));})()`,
  );
  await until(() => fixture.evaluate("document.querySelector('audio').readyState>=2"), '440 Hz source');
  await fixture.evaluate("document.querySelector('audio').playbackRate=1.1;document.querySelector('audio').play()");
  const tabs = await browser.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
  const target = tabs.targetInfos.find((t) => t.url === `${base}/tests/player.html`);
  await browser.send('Extensions.triggerAction', { id: extension.id, targetId: target.targetId });
  await until(async () => !!(await api('STATUS')).value.targetTab, 'action grants target');
  await until(async () => (await api('STATUS')).value.mode === 'browser', 'toolbar open automatically connects');
  await until(() => panel.evaluate("chrome.extension.getViews({type:'popup'}).length===1"), 'real toolbar popup opens');
  const popupSize = await panel.evaluate(
    "(()=>{const p=chrome.extension.getViews({type:'popup'})[0];return {width:p.innerWidth,height:p.innerHeight,overflow:p.document.documentElement.scrollWidth>p.innerWidth};})()",
  );
  assert.equal(popupSize.width, 400);
  assert.ok(popupSize.height <= 600 && popupSize.height > 0);
  assert.equal(popupSize.overflow, false);
  assert.equal(
    await panel.evaluate(
      "(()=>{const d=chrome.extension.getViews({type:'popup'})[0].document;return d.querySelector('.ag-presets').getBoundingClientRect().top>=d.querySelector('.ag-source-actions').getBoundingClientRect().bottom+4;})()",
    ),
    true,
    'source actions have space above the presets without a mode switch',
  );
  assert.equal(
    await panel.evaluate(
      "(()=>{const p=chrome.extension.getViews({type:'popup'})[0];return p.document.querySelector('.ag-popup .ag-mini-status').getBoundingClientRect().bottom<=600;})()",
    ),
    true,
    'Simple browser controls fit the standard 600px popup (smaller screens can scroll)',
  );
  const starts = await Promise.all([api('CONNECT'), api('CONNECT')]);
  for (const r of starts) assert.equal(r.ok, true, JSON.stringify(r));
  const spaCapture = starts[0].value.tabId;
  await fixture.evaluate("history.pushState({}, '', '?track=next')");
  await pause(500);
  assert.equal((await api('STATUS')).value.tabId, spaCapture, 'same-document track navigation keeps capture');
  assert.equal(await fixture.evaluate("document.querySelector('audio').playbackRate"), 0.82);
  await panel.send('ServiceWorker.enable');
  await until(
    () =>
      panel.events.some(
        (e) =>
          e.method === 'ServiceWorker.workerVersionUpdated' &&
          e.params.versions.some((v) => v.scriptURL.startsWith(`chrome-extension://${extension.id}/`)),
      ),
    'worker version',
  );
  const versionEvent = panel.events
    .filter((e) => e.method === 'ServiceWorker.workerVersionUpdated')
    .flatMap((e) => e.params.versions)
    .find((v) => v.scriptURL.startsWith(`chrome-extension://${extension.id}/`));
  await panel.send('ServiceWorker.stopWorker', { versionId: versionEvent.versionId });
  assert.equal(
    (await api('STATUS')).value.tabId,
    (await api('STATUS')).value.captureTab,
    'session reconciles after worker stop',
  );
  assert.equal((await api('STATUS')).value.settings.speed, 0.82, 'settings survive worker stop');
  const staleEnd = await api('CAPTURE_ENDED', { tabId: -999 });
  assert.equal(staleEnd.value.mode, 'browser', 'stale stream end cannot stop active capture');
  assert.equal(await fixture.evaluate("document.querySelector('audio').playbackRate"), 0.82);
  assert.equal(await fixture.evaluate("document.querySelector('audio').preservesPitch"), false);
  await fixture.evaluate(
    "document.querySelector('audio').playbackRate=1;document.querySelector('audio').preservesPitch=true",
  );
  await until(
    () =>
      fixture.evaluate(
        "document.querySelector('audio').playbackRate===0.82 && !document.querySelector('audio').preservesPitch",
      ),
    'site reset cannot silently disable tempo/pitch controls',
  );
  await fixture.evaluate("document.querySelector('audio').playbackRate=0");
  await pause(1200);
  assert.equal(
    await fixture.evaluate("document.querySelector('audio').playbackRate"),
    0,
    'respect temporary site buffering hold',
  );
  await fixture.evaluate("document.querySelector('audio').playbackRate=1");
  await until(
    () => fixture.evaluate("document.querySelector('audio').playbackRate===0.82"),
    'resume requested tempo after buffering',
  );
  await until(async () => {
    const value = await off.evaluate('globalThis.readLivePitch?.()');
    return value && value.db > -70 && Math.abs(value.hz - 440) < 5;
  }, 'captured WASM preserved pitch');
  const preserved = await off.evaluate('readLivePitch()');
  const tabBeforeSourceSwitch = (await api('STATUS')).value.tabId;
  await panel.evaluate("document.querySelector('.ag-popup [data-source=file]').click()");
  await until(async () => (await api('STATUS')).value.settings.source === 'file', 'file controls selected');
  assert.equal((await api('STATUS')).value.tabId, tabBeforeSourceSwitch, 'browsing file controls keeps tab capture');
  await pause(550);
  const filePopupSize = await panel.evaluate(
    "(()=>{const p=chrome.extension.getViews({type:'popup'})[0];return{height:p.innerHeight,scroll:p.document.body.scrollHeight};})()",
  );
  assert.ok(
    filePopupSize.height <= 600 && filePopupSize.scroll <= filePopupSize.height + 1,
    'Simple file view fits: ' + JSON.stringify(filePopupSize),
  );
  assert.equal(await fixture.evaluate("document.querySelector('audio').playbackRate"), 0.82);
  await panel.evaluate("document.querySelector('.ag-popup [data-source=browser]').click()");
  await until(async () => (await api('STATUS')).value.settings.source === 'browser', 'browser controls restored');
  assert.equal((await api('STATUS')).value.tabId, tabBeforeSourceSwitch);
  const capturedBeforeClose = (await api('STATUS')).value.tabId;
  await panel.evaluate("chrome.extension.getViews({type:'popup'})[0].close()");
  await until(() => panel.evaluate("chrome.extension.getViews({type:'popup'}).length===0"), 'popup closes');
  await pause(250);
  assert.equal((await api('STATUS')).value.tabId, capturedBeforeClose, 'popup closure keeps tab capture');
  assert.ok((await off.evaluate('readLivePitch()')).db > -70, 'audio remains audible with popup closed');
  await browser.send('Extensions.triggerAction', { id: extension.id, targetId: target.targetId });
  await until(
    () =>
      panel.evaluate(
        "chrome.extension.getViews({type:'popup'})[0]?.document.querySelector('.ag-popup')?.classList.contains('is-playing')",
      ),
    'reopened popup restores playing state',
  );
  assert.equal((await api('STATUS')).value.settings.speed, 0.82);
  const popupTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const popupTarget = popupTargets.find(
    (t) => t.url === `chrome-extension://${extension.id}/panel.html` && t.id !== panel.id,
  );
  assert.ok(popupTarget, 'popup has its own renderer');
  const popup = cdp(popupTarget.webSocketDebuggerUrl);
  connections.push(popup);
  await writeFile(
    '/tmp/slowed-reverb-popup-simple.png',
    Buffer.from((await popup.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  // A stored Advanced preference from 0.5.x must never hide the only screen.
  const saved = await panel.evaluate("chrome.storage.local.get('settings')");
  await panel.evaluate(
    `chrome.storage.local.set({settings:{...${JSON.stringify(saved.settings)},mode:'advanced',tab:'settings'}})`,
  );
  await popup.send('Page.reload');
  await until(
    () => popup.evaluate("document.querySelector('.ag-popup [data-preset=night]')?.disabled === false"),
    'legacy settings reopen',
  );
  assert.equal(await popup.evaluate("document.querySelector('.ag-popup').getBoundingClientRect().height>0"), true);
  assert.equal(await popup.evaluate("document.querySelectorAll('[data-view], [data-pane], .ag-panel').length"), 0);
  await until(() => popup.evaluate('innerWidth === 400'), 'Chrome applies popup size after reload');
  const compactSize = await popup.evaluate('({width:innerWidth,height:innerHeight,scroll:document.body.scrollHeight})');
  assert.equal(compactSize.width, 400);
  assert.ok(compactSize.height <= 600 && compactSize.scroll <= compactSize.height + 1);
  await off.evaluate("lastPitchNode.dispatchEvent(new Event('processorerror'))");
  await until(async () => (await api('STATUS')).value.failure?.source === 'browser', 'live failure reported');
  await until(
    () =>
      fixture.evaluate(
        "document.querySelector('audio').playbackRate===1.1 && document.querySelector('audio').preservesPitch",
      ),
    'live failure restores source rate and pitch',
  );
  assert.equal((await api('STATUS')).value.tabId, null, 'live failure releases capture');
  await until(
    () => popup.evaluate("document.querySelector('[data-retry]')?.hidden === false"),
    'browser Retry visible',
  );
  await pause(250);
  const browserFailureSize = await popup.evaluate(
    "({height:innerHeight,scroll:document.body.scrollHeight,retry:document.querySelector('[data-retry]').getBoundingClientRect().bottom})",
  );
  assert.ok(
    browserFailureSize.scroll <= browserFailureSize.height + 1 && browserFailureSize.retry <= browserFailureSize.height,
    'browser failure fits without scrolling: ' + JSON.stringify(browserFailureSize),
  );
  assert.equal((await api('RETRY')).ok, true, 'live Retry reconnects');
  assert.equal((await api('STATUS')).value.failure, null);

  await api('UPDATE', { settings: { keep: false, quality: 'light' } });
  await until(async () => {
    const value = await off.evaluate('readLivePitch()');
    return value.db > -70 && Math.abs(value.hz - 440 * 0.82) < 6;
  }, 'captured light-profile classic pitch');
  const classic = await off.evaluate('readLivePitch()');
  const stopped = await api('DISCONNECT');
  assert.equal(stopped.ok, true);
  assert.equal(await fixture.evaluate("document.querySelector('audio').playbackRate"), 1.1);
  assert.equal(await fixture.evaluate("document.querySelector('audio').preservesPitch"), true);
  assert.equal((await api('CONNECT')).ok, true);
  await fixture.send('Page.reload');
  await until(async () => !(await api('STATUS')).value.tabId, 'navigation releases capture');
  await until(() => fixture.evaluate("document.querySelector('audio').readyState>=2"), 'reloaded media');
  await fixture.evaluate("document.querySelector('audio').play()");
  assert.equal((await api('CONNECT')).ok, true);
  await fixture.evaluate(
    "document.querySelector('audio').outerHTML='<audio controls loop src=\"../assets/vocal-demo.mp3\"></audio>'",
  );
  await until(() => fixture.evaluate("document.querySelector('audio').readyState>=2"), 'replacement media');
  await until(
    () => fixture.evaluate("document.querySelector('audio').playbackRate===0.82"),
    'replacement metadata handled',
  );
  assert.equal(
    await fixture.evaluate("document.querySelector('audio').playbackRate"),
    0.82,
    'replacement player gets tempo',
  );
  await api('DISCONNECT');
  assert.equal(await fixture.evaluate("document.querySelector('audio').playbackRate"), 1, 'replacement restored');
  // SoundCloud/Spotify-style media: created before injection, never attached to DOM.
  await fixture.send('Page.reload');
  await until(() => fixture.evaluate("document.querySelector('audio')?.readyState>=2"), 'detached fixture ready');
  await fixture.evaluate(
    "(async()=>{globalThis.detached=document.querySelector('audio');const blob=await(await fetch(detached.src)).blob();detached.src=URL.createObjectURL(blob);detached.remove();detached.playbackRate=1.1;globalThis.originalPlay=HTMLMediaElement.prototype.play})()",
  );
  await until(
    () => fixture.evaluate('detached.readyState>=2 && detached.seekable.length>0 && detached.seekable.end(0)>12'),
    'seekable detached fixture',
  );
  const undiscovered = await api('CONNECT');
  assert.equal(undiscovered.ok, false, 'late detached player needs a site play event');
  await fixture.evaluate('detached.play()');
  await fixture.send('HeapProfiler.collectGarbage');
  const detachedConnect = await api('CONNECT');
  assert.equal(
    detachedConnect.ok,
    true,
    'detached player discovered after site play: ' + JSON.stringify(detachedConnect),
  );
  assert.equal(await fixture.evaluate('detached.playbackRate'), 0.82);
  assert.equal(await fixture.evaluate('detached.preservesPitch'), false);
  await fixture.evaluate('globalThis.mutedPreview=new Audio(detached.src);mutedPreview.muted=true;mutedPreview.play()');
  await pause(400);
  assert.equal(await fixture.evaluate('detached.playbackRate'), 0.82, 'muted previews must not steal the music source');
  await fixture.evaluate('mutedPreview.pause()');
  await until(async () => (await api('STATUS')).value.level > 0.001, 'detached capture has output');
  await api('PLAY');
  assert.equal(await fixture.evaluate('detached.paused'), true, 'extension pauses detached media');
  await api('SEEK', { position: 12 });
  assert.ok(await fixture.evaluate('Math.abs(detached.currentTime-12)<0.5'), 'extension seeks detached media');
  await api('PLAY');
  await fixture.evaluate(
    'detached.pause();globalThis.nextDetached=new Audio(detached.src);nextDetached.loop=true;nextDetached.play()',
  );
  await until(
    () => fixture.evaluate('nextDetached.readyState>=2 && nextDetached.playbackRate===0.82'),
    'detached replacement tempo',
  );
  assert.equal(await fixture.evaluate('detached.playbackRate'), 1.1, 'retired source restored');
  await api('DISCONNECT');
  assert.equal(await fixture.evaluate('nextDetached.playbackRate'), 1);
  assert.equal(await fixture.evaluate('nextDetached.preservesPitch'), true);
  await fixture.evaluate('nextDetached.pause()');
  console.log('PASS detached source discovery, capture, pause/seek, track replacement and restoration');
  await fixture.send('Page.reload');
  await until(() => fixture.evaluate("document.querySelector('audio')?.readyState>=2"), 'regular fixture restored');
  await fixture.evaluate(
    "globalThis.alreadyPlaying=document.querySelector('audio');alreadyPlaying.remove();globalThis.siteClock=setInterval(()=>{globalThis.sitePosition=alreadyPlaying.currentTime},100);alreadyPlaying.play()",
  );
  const autoDiscovery = await api('CONNECT');
  assert.equal(
    autoDiscovery.ok,
    true,
    'discover existing detached playback without pause/play: ' + JSON.stringify(autoDiscovery),
  );
  assert.equal(await fixture.evaluate('alreadyPlaying.playbackRate'), 0.82);
  await api('DISCONNECT');
  await fixture.evaluate('clearInterval(siteClock);alreadyPlaying.pause()');
  await fixture.send('Page.reload');
  await until(() => fixture.evaluate("document.querySelector('audio')?.readyState>=2"), 'shadow fixture ready');
  await fixture.evaluate(
    "globalThis.shadowMedia=document.querySelector('audio');const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'open'}).append(shadowMedia);shadowMedia.play()",
  );
  const shadowConnect = await api('CONNECT');
  assert.equal(shadowConnect.ok, true, 'open shadow player connects: ' + JSON.stringify(shadowConnect));
  assert.equal(await fixture.evaluate('shadowMedia.playbackRate'), 0.82);
  await fixture.evaluate(
    "document.dispatchEvent(new FocusEvent('slowed-reverb:media',{relatedTarget:document.body}));document.dispatchEvent(new CustomEvent('slowed-reverb:media',{detail:{readyState:4,playbackRate:99,paused:false}}))",
  );
  assert.equal((await api('STATUS')).value.rate, 0.82, 'forged non-media discovery ignored');
  await fixture.evaluate(
    "shadowMedia.pause();globalThis.playerFrame=document.createElement('iframe');playerFrame.srcdoc='<audio loop src=\"'+shadowMedia.src+'\"></audio>';document.body.append(playerFrame)",
  );
  await until(
    () => fixture.evaluate("playerFrame.contentDocument?.querySelector('audio')?.readyState>=2"),
    'same-origin frame ready',
  );
  await fixture.evaluate("playerFrame.contentDocument.querySelector('audio').play()");
  await until(
    () => fixture.evaluate("playerFrame.contentDocument.querySelector('audio').playbackRate===0.82"),
    'same-origin iframe tempo',
  );
  await api('PLAY');
  assert.equal(await fixture.evaluate("playerFrame.contentDocument.querySelector('audio').paused"), true);
  await api('DISCONNECT');
  assert.equal(await fixture.evaluate("playerFrame.contentDocument.querySelector('audio').playbackRate"), 1);
  assert.equal(await fixture.evaluate('shadowMedia.playbackRate'), 1);
  await fixture.evaluate(
    "playerFrame.remove();const closedHost=document.createElement('div');document.body.append(closedHost);closedHost.attachShadow({mode:'closed'}).append(shadowMedia);shadowMedia.play()",
  );
  assert.equal((await api('CONNECT')).ok, true, 'closed shadow player connects');
  assert.equal(await fixture.evaluate('shadowMedia.playbackRate'), 0.82);
  await api('DISCONNECT');
  assert.equal(await fixture.evaluate('shadowMedia.playbackRate'), 1);
  console.log('PASS shadow player, same-origin iframe, forged discovery rejection and restoration');
  await fixture.send('Page.reload');
  await until(() => fixture.evaluate("document.querySelector('audio')?.readyState>=2"), 'final regular fixture');
  await fixture.evaluate('globalThis.originalPlay=HTMLMediaElement.prototype.play');
  await page(`${base}/tests/empty.html`);
  const emptyTabs = await browser.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
  await browser.send('Extensions.triggerAction', {
    id: extension.id,
    targetId: emptyTabs.targetInfos.find((t) => t.url === `${base}/tests/empty.html`).targetId,
  });
  await until(async () => (await api('STATUS')).value.targetTitle === 'Empty test page', 'new target selected');
  const rejected = await api('CONNECT');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /No supported/);
  assert.equal((await api('STATUS')).value.tabId, null, 'failed capture leaves no stream');
  await fixture.send('Page.bringToFront');
  await browser.send('Extensions.triggerAction', { id: extension.id, targetId: target.targetId });
  await until(async () => (await api('STATUS')).value.targetTitle.includes('test player'), 'target reselected');
  assert.equal((await api('CONNECT')).ok, true);
  await api('DISCONNECT');
  // A BFCache page can keep its extension world alive after pagehide.
  await fixture.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))");
  assert.equal((await api('CONNECT')).ok, true, 'controller can be reinjected after pagehide');
  await api('DISCONNECT');
  assert.equal(
    await fixture.evaluate("document.querySelector('audio').playbackRate"),
    1,
    'old runtime listener cannot reapply stale tempo',
  );
  assert.equal((await api('CONNECT')).ok, true);
  await browser.send('Extensions.uninstall', { id: extension.id });
  await until(
    () =>
      fixture.evaluate(
        "document.querySelector('audio').playbackRate===1 && document.querySelector('audio').preservesPitch===true",
      ),
    'uninstall restores original media settings',
  );
  assert.equal(
    await fixture.evaluate('HTMLMediaElement.prototype.play===originalPlay'),
    true,
    'uninstall removes discovery hook',
  );
  console.log('PASS measured wave, silence, file/pitch/dynamics/candidate failures and live recovery/Retry');
  console.log('PASS real toolbar popup, single compact popup without ordinary scrolling, capture through close/reopen');
  console.log('PASS upload, corrupt-file recovery, remove, worker restart, stale event and unsupported page');
  console.log('PASS real tab capture, double start, WASM frequencies, quality change, restore, reconnect, navigation', {
    preserved,
    classic,
  });
  console.log('PASS UI closes without stopping audio, seek, pause, local WAV download and 320/380px layouts');
}
try {
  await runBrowserChecks();
} finally {
  connections.forEach((c) => c.close());
  child.kill();
  server.close();
  await pause(300);
  await rm(profile, { recursive: true, force: true });
}

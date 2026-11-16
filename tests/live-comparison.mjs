import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export async function checkLiveControls({ page, until }) {
  const client = await page('http://127.0.0.1:4178/compare/realtime.html');
  await client.send('Runtime.enable');
  await client.send('Page.bringToFront');
  await until(() => client.evaluate("!document.querySelector('#play').disabled"), 'track loaded');
  assert.equal(await client.evaluate("document.querySelectorAll('#benchmark-rows tr').length"), 8);
  await client.evaluate(`(async () => {
    const {LiveEngine} = await import('/compare/live-engine.js');
    const start = LiveEngine.prototype.start;
    LiveEngine.prototype.start = async function(options) {
      globalThis.measuredPlayer = this;
      return start.call(this, options);
    };
    document.querySelector('#play').click();
  })()`);
  await until(() => client.evaluate('!!globalThis.measuredPlayer?.metrics'), 'initial live metrics');
  for (const engine of ['rubberband', 'rubberband-short', 'signalsmith']) {
    const before = await client.evaluate('measuredPlayer.position()');
    await client.evaluate(`(() => {
      globalThis.previousContext = measuredPlayer.context;
      const select = document.querySelector('#engine');
      select.value = ${JSON.stringify(engine)};
      select.dispatchEvent(new Event('change'));
    })()`);
    await until(
      () => client.evaluate(`measuredPlayer.metrics?.engine === ${JSON.stringify(engine)}`),
      'switch to ' + engine,
    );
    assert.equal(await client.evaluate('previousContext.state'), 'closed');
    assert.equal(await client.evaluate('measuredPlayer.error'), null);
    assert.ok(await client.evaluate(`measuredPlayer.position() > ${before}`), 'source position continues');
  }
  await client.evaluate("document.querySelector('#play').click()");
  await until(() => client.evaluate('measuredPlayer.context.state === "closed"'), 'pause releases audio');
  for (const width of [1280, 390]) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1050,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(await client.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`/tmp/slowed-reverb-live-${width}.png`, Buffer.from(screenshot.data, 'base64'));
  }
  assert.equal(
    client.events.some((event) => event.method === 'Runtime.exceptionThrown'),
    false,
  );
  console.log('PASS live engine switching, source continuity, context cleanup, saved results and responsive layout');
}

export async function checkLiveComparison({ page, browser, root }) {
  const client = await page('http://127.0.0.1:4178/compare/realtime.html');
  await client.send('Runtime.enable');
  await client.send('Page.bringToFront');
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  for (let i = 0; i < 100; i++) {
    if (await client.evaluate("!document.querySelector('#play').disabled")) break;
    await pause(100);
  }
  // Capture the same instance used by the UI without changing its processing.
  await client.evaluate(`(async () => {
    const {LiveEngine} = await import('/compare/live-engine.js');
    const start = LiveEngine.prototype.start;
    LiveEngine.prototype.start = async function(options) {
      globalThis.measuredPlayer = this;
      return start.call(this, options);
    };
  })()`);
  const secondsPerRun = Number(process.env.BENCH_SECONDS || 30);
  const plan = process.env.BENCH_QUICK
    ? [
        ['signalsmith', 0.82],
        ['rubberband', 0.82],
      ]
    : [
        ['native', 0.82],
        ['signalsmith', 0.82],
        ['rubberband', 0.82],
        ['signalsmith', 1.2],
        ['rubberband', 1.2],
        ['signalsmith', 0.5],
        ['rubberband', 0.5],
        ['rubberband-short', 0.82],
      ];
  const runs = [];
  const version = await browser.send('Browser.getVersion');
  const machine = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim();
  for (const [engine, speed] of plan) {
    await client.evaluate(`(() => {
      document.querySelector('#engine').value = ${JSON.stringify(engine)};
      document.querySelector('#speed').value = ${speed};
      document.querySelector('#start').value = 30;
      document.querySelector('#volume').value = 0.3;
      document.querySelector('#play').click();
    })()`);
    for (let i = 0; i < 150; i++) {
      const state = await client.evaluate(`({error:document.querySelector('#status').classList.contains('error'),
        message:document.querySelector('#status').textContent,
        ready:globalThis.measuredPlayer?.metrics?.engine === ${JSON.stringify(engine)} &&
          measuredPlayer.metrics.speed === ${speed} && measuredPlayer.context.state === 'running'})`);
      if (state.error) throw Error(state.message);
      if (state.ready) break;
      const exception = client.events.find((event) => event.method === 'Runtime.exceptionThrown');
      if (exception) throw Error(JSON.stringify(exception.params));
      await pause(100);
      if (i === 149) throw Error('Live metrics unavailable: ' + JSON.stringify(state));
    }
    await client.evaluate('measuredPlayer.resetMetrics()');
    const before = await browser.send('SystemInfo.getProcessInfo');
    const began = performance.now();
    // Small waits keep the long-running benchmark observable and interruptible.
    for (let i = 0; i < secondsPerRun; i++) await pause(1000);
    const after = await browser.send('SystemInfo.getProcessInfo');
    const elapsed = (performance.now() - began) / 1000;
    await client.evaluate("measuredPlayer.node.port.postMessage({type:'measure-snapshot',id:'final'})");
    await pause(100);
    const metrics = await client.evaluate('measuredPlayer.metrics');
    const error = await client.evaluate('measuredPlayer.error');
    assert.equal(error, null);
    assert.ok(metrics.seconds > secondsPerRun - 1, JSON.stringify(metrics));
    assert.ok(metrics.blocks > 100);
    const prior = new Map(before.processInfo.map((process) => [process.id, process.cpuTime]));
    const processCpu = after.processInfo.map((process) => ({
      type: process.type,
      percent: (Math.max(0, process.cpuTime - (prior.get(process.id) ?? process.cpuTime)) / elapsed) * 100,
    }));
    const cpuPercent = processCpu.reduce((total, process) => total + process.percent, 0);
    runs.push({ engine, speed, cpuPercent, processCpu, elapsed, metrics });
    console.log('LIVE', JSON.stringify({ engine, speed, cpuPercent, metrics }));
    await client.evaluate("document.querySelector('#play').click()");
    await pause(500);
    assert.equal(await client.evaluate('measuredPlayer.context.state'), 'closed');
  }
  const report = {
    measuredAt: new Date().toISOString(),
    machine,
    browser: version.product,
    userAgent: version.userAgent,
    headed: !!process.env.HEADED,
    secondsPerRun,
    sampleRate: 48000,
    track: 'Ed Sheeran — Thinking Out Loud',
    sourceStartSeconds: 30,
    method:
      'Real AudioContext output; one DSP at a time; 3 s warm-up; CPU sum of isolated Chrome processes; Date.now callback timings when performance.now is unavailable.',
    runs,
  };
  const destination = process.env.BENCH_QUICK
    ? '/tmp/slowed-reverb-live-probe.json'
    : resolve(root, 'docs/data/realtime-benchmark.json');
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 1050,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/slowed-reverb-live.png', Buffer.from(screenshot.data, 'base64'));
  console.log('PASS live comparison completed', destination);
}

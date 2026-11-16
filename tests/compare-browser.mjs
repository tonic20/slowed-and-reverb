import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

export async function checkComparison(page) {
  const client = await page('http://127.0.0.1:4178/compare/');
  await client.send('Runtime.enable');
  await client.send('Page.bringToFront');
  await client.send('Page.reload');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 600; attempt++) {
    const exception = client.events.find((event) => event.method === 'Runtime.exceptionThrown');
    if (exception) throw Error(JSON.stringify(exception.params));
    const state = await client.evaluate(`({status:document.querySelector('#status').textContent,
      error:document.querySelector('#status').classList.contains('error'),
      ready:!document.querySelector('#play').disabled})`);
    if (state.error) throw Error(state.status);
    if (state.ready) break;
    if (attempt === 599) throw Error('Comparison rendering timed out: ' + state.status);
    await pause(100);
  }
  const summary = await client.evaluate(`({
    title:document.querySelector('#track-name').textContent,
    status:document.querySelector('#status').textContent,
    results:[...document.querySelectorAll('.result')].map(el=>el.textContent),
    selected:document.querySelector('.variant[aria-pressed=true] strong').textContent,
    duration:Number(document.querySelector('#seek').max)
  })`);
  assert.equal(summary.results.length, 5);
  assert.ok(
    summary.results.every((text) => /dB.*s render/.test(text)),
    JSON.stringify(summary),
  );
  assert.match(summary.selected, /corrected tab/);
  assert.ok(Math.abs(summary.duration - 20 / 0.82) < 0.01);
  const pitches = await client.evaluate(`(async () => {
    const results = [];
    for (const live of [true, false]) for (const speed of [0.75, 1.2]) {
      const samples = new Float32Array(48000 * 3);
      const frequency = live ? (speed === 0.75 ? 330 : 528) : 440;
      for (let i = 0; i < samples.length; i++) samples[i] = 0.1 * Math.sin(2 * Math.PI * frequency * i / 48000);
      const output = await new Promise((resolve, reject) => {
        const worker = new Worker('/compare/rubberband-worker.js', {type:'module'});
        const timer = setTimeout(() => {worker.terminate();reject(Error('Pitch test timeout'));}, 15000);
        worker.onmessage = ({data}) => {
          clearTimeout(timer);worker.terminate();
          if (data.error) reject(Error(data.error)); else resolve(data.channels[0]);
        };
        worker.onerror = (event) => {clearTimeout(timer);worker.terminate();reject(Error(event.message));};
        worker.postMessage({channels:[samples,samples.slice()], sampleRate:48000, speed, live});
      });
      const crossings = [];
      for (let i = 48001; i < 96000; i++) if (output[i - 1] <= 0 && output[i] > 0)
        crossings.push(i - 1 - output[i - 1] / (output[i] - output[i - 1]));
      results.push({live,speed,finite:output.every(Number.isFinite),
        hz:(crossings.length - 1)*48000/(crossings.at(-1)-crossings[0]),
        frames:output.length});
    }
    return results;
  })()`);
  for (const result of pitches) {
    assert.equal(result.finite, true);
    assert.ok(Math.abs(result.hz - 440) < 2, JSON.stringify(result));
    assert.equal(result.frames, result.live ? 144000 : result.speed === 0.75 ? 192000 : 120000);
  }
  console.log('PASS Rubber Band pitch and output length for both paths and speeds', pitches);
  await client.evaluate("document.querySelector('#play').click()");
  await pause(1200);
  const before = await client.evaluate("Number(document.querySelector('#seek').value)");
  assert.ok(before > 0.5);
  for (let index = 0; index < 5; index++) {
    await client.evaluate(`document.querySelectorAll('.variant')[${index}].click()`);
    await pause(100);
    const current = await client.evaluate("Number(document.querySelector('#seek').value)");
    assert.ok(current >= before, 'switching keeps playback position');
  }
  await client.evaluate("document.querySelector('#play').click()");
  await pause(100);
  const paused = await client.evaluate("Number(document.querySelector('#seek').value)");
  await pause(250);
  assert.equal(await client.evaluate("Number(document.querySelector('#seek').value)"), paused);
  await client.evaluate(
    "document.querySelector('#seek').value=10;document.querySelector('#seek').dispatchEvent(new Event('input'))",
  );
  await pause(100);
  assert.equal(await client.evaluate("Number(document.querySelector('#seek').value)"), 10);
  await client.evaluate(
    "document.querySelectorAll('.variant')[4].focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}))",
  );
  assert.match(
    await client.evaluate("document.querySelector('.variant[aria-pressed=true] strong').textContent"),
    /corrected tab/,
  );
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/slowed-reverb-compare.png', Buffer.from(screenshot.data, 'base64'));
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(
    await client.evaluate('document.documentElement.scrollWidth <= innerWidth'),
    true,
    'mobile has no horizontal overflow',
  );
  console.log('PASS comparison renders five engines and preserves playback/seek', summary);
}

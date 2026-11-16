import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, normalize, preset, reset, pitchFor, effective } from '../utils/settings.js';

test('presets preserve pitch for slowing down and speeding up', () => {
  for (const name of ['slow', 'dream', 'tape']) {
    const s = preset(name, defaults);
    assert.equal(s.keep, true);
    assert.ok(s.speed < 1);
    assert.equal(pitchFor(s, false), 0);
    assert.ok(pitchFor(s, true) > 0);
  }
  const night = preset('night', { ...defaults, keep: false });
  assert.equal(night.keep, true);
  assert.ok(night.speed > 1);
  assert.equal(pitchFor(night, false), 0);
  assert.ok(pitchFor(night, true) < 0);
});
test('untrusted persisted values cannot produce NaN or unsafe ranges', () => {
  const s = normalize({
    speed: Infinity,
    wet: 900,
    bass: -100,
    pitch: '7',
    room: 'evil',
    safe: 'false',
    mode: 'broken',
    injected: 1,
  });
  assert.equal(s.speed, defaults.speed);
  assert.equal(s.wet, 80);
  assert.equal(s.bass, -6);
  assert.equal(s.pitch, 7);
  assert.equal(s.room, 'dark');
  assert.equal(s.safe, true);
  assert.equal(s.mode, undefined);
  assert.equal(s.injected, undefined);
});
test('bypass is neutral without overwriting saved effects; reset preserves UI preferences', () => {
  const s = normalize({ ...preset('dream'), active: false, source: 'file', volume: 60 });
  assert.equal(effective(s).speed, 1);
  assert.equal(effective(s).wet, 0);
  assert.equal(effective(s).volume, 60);
  assert.equal(s.wet, 48);
  const r = reset(s);
  assert.equal(r.source, 'file');
  assert.equal(r.preset, 'dream');
  assert.equal(r.speed, 0.75);
  assert.equal(r.wet, 48);
  assert.equal(r.pitch, 0);
});

test('each preset remembers edits through switching and storage roundtrips', () => {
  let s = { ...preset('dream'), speed: 0.69, wet: 39, keep: false };
  s = preset('night', s);
  assert.equal(s.speed, 1.2);
  s = { ...s, speed: 1.3, wet: 10 };
  s = normalize(JSON.parse(JSON.stringify(s)));
  s = preset('dream', s);
  assert.equal(s.preset, 'dream');
  assert.equal(s.speed, 0.69);
  assert.equal(s.wet, 39);
  assert.equal(s.keep, false);
  assert.equal(preset('dream', s).speed, 0.69);
  s = preset('night', s);
  assert.equal(s.speed, 1.3);
  assert.equal(s.wet, 10);
});

test('reset restores every preset and keeps the selected preset and source', () => {
  let s = { ...defaults, speed: 0.6 };
  for (const name of ['dream', 'tape', 'night']) s = { ...preset(name, s), speed: 1.4, wet: 70, keep: false };
  s = reset({ ...s, source: 'file' });
  assert.equal(s.preset, 'night');
  assert.equal(s.source, 'file');
  for (const [name, speed, wet] of [
    ['slow', 0.82, 32],
    ['dream', 0.75, 48],
    ['tape', 0.88, 15],
    ['night', 1.2, 8],
  ]) {
    s = preset(name, normalize(JSON.parse(JSON.stringify(s))));
    assert.equal(s.speed, speed);
    assert.equal(s.wet, wet);
    assert.equal(s.keep, true);
  }
});

test('legacy custom settings remain audible and attach to Slowed', () => {
  const s = normalize({ preset: 'custom', speed: 0.67, wet: 25 });
  assert.equal(s.preset, 'slow');
  assert.equal(s.speed, 0.67);
  assert.equal(preset('slow', preset('tape', s)).speed, 0.67);
});

test('stored preset overrides are bounded and cannot overwrite source or selection', () => {
  const s = normalize({
    source: 'file',
    presetValues: {
      dream: { speed: 20, wet: -10, keep: 'false', source: 'browser', preset: 'night', injected: 1 },
      tape: null,
      night: ['corrupt'],
    },
  });
  const dream = preset('dream', s);
  assert.equal(dream.speed, 1.5);
  assert.equal(dream.wet, 0);
  assert.equal(dream.keep, true);
  assert.equal(dream.source, 'file');
  assert.equal(dream.preset, 'dream');
  assert.equal(dream.presetValues.dream.injected, undefined);
  assert.equal(preset('tape', dream).speed, 0.88);
  assert.equal(preset('night', dream).speed, 1.2);
});
test('live compensation cancels source resampling; file pitch includes classic speed change', () => {
  const s = normalize({ speed: 0.5, keep: true, pitch: 7 });
  assert.equal(pitchFor(s, true), 19);
  assert.equal(pitchFor(s, false), 7);
  assert.equal(pitchFor({ ...s, keep: false }, false), -5);
  assert.equal(pitchFor({ ...s, compare: 'original' }, true), 0);
});

test('missing or corrupt settings records fall back to defaults', () => {
  for (const value of [null, undefined, false, 'old-format']) assert.deepEqual(normalize(value), defaults);
});

test('engine selection survives presets and Reset, and migrates old settings', () => {
  assert.equal(normalize().engine, 'rubberband');
  assert.equal(normalize({ speed: 0.75 }).engine, 'rubberband');
  assert.equal(normalize({ engine: 'unknown' }).engine, 'rubberband');
  const settings = normalize({ engine: 'signalsmith', speed: 0.69 });
  assert.equal(preset('night', settings).engine, 'signalsmith');
  assert.equal(reset(settings).engine, 'signalsmith');
  assert.equal(normalize(JSON.parse(JSON.stringify(settings))).engine, 'signalsmith');
});

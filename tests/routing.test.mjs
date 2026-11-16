import test from 'node:test';
import assert from 'node:assert/strict';
import { needsStretch } from '../utils/audio/routing.js';
import { bounded } from '../utils/audio/lifecycle.js';

test('only use pitch DSP when native playback cannot supply the requested pitch', () => {
  assert.equal(needsStretch({ speed: 1, pitch: 0, wet: 40, keep: true }, false), false);
  assert.equal(needsStretch({ speed: 0.8, pitch: 0, keep: true }, false), true);
  assert.equal(needsStretch({ speed: 0.8, pitch: 0, keep: false }, false), false);
  assert.equal(needsStretch({ speed: 0.8, pitch: 0, keep: false }, true), false);
  assert.equal(needsStretch({ speed: 0.8, pitch: 0, keep: true }, true), true);
  assert.equal(needsStretch({ speed: 1, pitch: 7, keep: true }, true), true);
  assert.equal(needsStretch({ speed: 0.8, pitch: 7, compare: 'original' }, false), false);
  assert.equal(needsStretch({ speed: 0.5, pitch: -12, keep: true }, false), false);
});
test('bounded work rejects a missing ready signal and disposes a late result', async () => {
  let finish,
    released = 0;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  await assert.rejects(
    bounded(pending, 10, () => released++),
    /timed out/i,
  );
  finish({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(released, 1);
  assert.equal(await bounded(Promise.resolve(42), 20), 42);
  await assert.rejects(bounded(Promise.reject(Error('processor failed')), 20), /processor failed/);
  let rejectLate;
  const lateFailure = new Promise((_, reject) => {
    rejectLate = reject;
  });
  await assert.rejects(bounded(lateFailure, 10), /timed out/i);
  rejectLate(Error('late processor failure'));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRating,
  countRun,
  rate,
  shouldAsk,
  rateTarget,
  listeningRun,
  ratingDestinations,
} from '../utils/rating.js';

const links = { reviews: 'https://example.com/reviews', feedback: 'https://example.com/feedback' };
test('rating appears after two successful sessions, only with configured destinations', () => {
  let state = normalizeRating(null);
  assert.equal(shouldAsk(state, links), false);
  state = countRun(state, 'a');
  assert.deepEqual(countRun(state, 'a'), state, 'duplicate delivery does not count twice');
  assert.equal(shouldAsk(state, links), false);
  state = countRun(state, 'b');
  assert.equal(shouldAsk(state, links), true);
  assert.equal(shouldAsk(state, { ...links, feedback: '' }), false);
  assert.equal(shouldAsk(state, { ...links, reviews: '' }), false);
  for (let stars = 1; stars <= 5; stars++) {
    assert.equal(shouldAsk(rate(state, stars), links), false);
    assert.equal(rateTarget(stars, links), stars >= 4 ? links.reviews : links.feedback);
  }
  assert.throws(() => rate(state, 6), RangeError);
  assert.throws(() => rateTarget(0, links), RangeError);
  assert.deepEqual(normalizeRating({ runs: -1, rated: '5' }), { runs: 0, rated: 0, lastRun: '' });
});

test('listening needs 30 audible seconds and counts only once per source', () => {
  const tick = listeningRun();
  const a = {},
    b = {};
  for (let i = 0; i < 29; i++) assert.equal(tick(a, true, 1000), false);
  assert.equal(tick(a, false, 1000), false, 'silence or pause does not count');
  assert.equal(tick(a, true, 1000), true);
  assert.equal(tick(a, true, 1000), false, 'same source cannot count again');
  for (let i = 0; i < 29; i++) assert.equal(tick(b, true, 1000), false);
  assert.equal(tick(b, true, 100000), false, 'suspended timers cannot fabricate listening time');
  assert.equal(tick(b, true, 1000), true);
});

test('store review URL comes from the runtime extension ID, without a configured listing ID', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(
    ratingDestinations(id, 'https://clients2.google.com/service/update2/crx', links.feedback).reviews,
    `https://chromewebstore.google.com/detail/${id}/reviews`,
  );
  assert.deepEqual(ratingDestinations(id, undefined, links.feedback), {
    reviews: links.feedback,
    feedback: links.feedback,
  });
});

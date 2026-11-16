// The store resolves the installed extension ID; no listing slug or hardcoded ID is needed.
export function ratingDestinations(id, updateUrl, feedback) {
  const storeBuild = id && updateUrl === 'https://clients2.google.com/service/update2/crx';
  return { reviews: storeBuild ? `https://chromewebstore.google.com/detail/${id}/reviews` : feedback, feedback };
}
export const MIN_LISTEN_MS = 30000;
export const RUNS_TO_ASK = 2;
const isStars = (value) => Number.isInteger(value) && value >= 1 && value <= 5;
export function normalizeRating(saved) {
  return {
    runs: Number.isSafeInteger(saved?.runs) && saved.runs >= 0 ? saved.runs : 0,
    rated: isStars(saved?.rated) ? saved.rated : 0,
    lastRun: typeof saved?.lastRun === 'string' ? saved.lastRun : '',
  };
}
export function countRun(state, id) {
  if (!id || state.lastRun === id || state.rated || state.runs >= RUNS_TO_ASK) return state;
  return { ...state, runs: state.runs + 1, lastRun: id };
}
export function rate(state, stars) {
  if (!isStars(stars)) throw new RangeError('Invalid rating.');
  return { ...state, rated: stars };
}
export const shouldAsk = (state, links) =>
  !state.rated && state.runs >= RUNS_TO_ASK && !!links.reviews && !!links.feedback;
export function rateTarget(stars, links) {
  if (!isStars(stars)) throw new RangeError('Invalid rating.');
  return stars >= 4 ? links.reviews : links.feedback;
}
// The offscreen document owns playback, including when the popup is closed.
export function listeningRun() {
  let source,
    elapsed = 0,
    counted = false;
  return (nextSource, audible, milliseconds) => {
    if (nextSource !== source) {
      source = nextSource;
      elapsed = 0;
      counted = false;
    }
    if (!source || counted || !audible || milliseconds <= 0 || milliseconds > 2500) return false;
    elapsed += milliseconds;
    if (elapsed < MIN_LISTEN_MS) return false;
    counted = true;
    return true;
  };
}

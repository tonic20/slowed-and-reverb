import { effective, pitchFor } from '../settings.js';

// Live capture already contains the page's resampling. A file source can resample itself.
export function needsStretch(value, live = false) {
  const s = effective(value);
  if (s.bypass) return false;
  const nativePitch = live ? 0 : 12 * Math.log2(s.speed);
  return Math.abs(pitchFor(s, live) - nativePitch) > 1e-6;
}

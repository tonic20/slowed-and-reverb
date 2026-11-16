export const defaults = Object.freeze({
  speed: 0.82,
  wet: 32,
  keep: true,
  pitch: 0,
  bass: 0,
  volume: 75,
  formant: true,
  duck: true,
  safe: true,
  quality: 'high',
  engine: 'rubberband',
  room: 'dark',
  tail: '3',
  tone: 'warm',
  delay: '25',
  active: true,
  compare: 'effect',
  preset: 'slow',
  source: 'browser',
  exportTail: true,
  presetValues: Object.freeze({}),
});
const ranges = { speed: [0.5, 1.5], wet: [0, 80], pitch: [-12, 12], bass: [-6, 6], volume: [0, 100] };
const choices = {
  engine: ['rubberband', 'signalsmith'],
  quality: ['high', 'light'],
  room: ['dark', 'hall', 'plate'],
  tail: ['1.5', '3', '5'],
  tone: ['warm', 'dark', 'bright'],
  delay: ['0', '25', '50'],
  compare: ['effect', 'original'],
  preset: ['slow', 'dream', 'tape', 'night'],
  source: ['browser', 'file'],
};
function normalizeValues(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const result = { ...defaults };
  for (const [key, initial] of Object.entries(defaults)) {
    if (ranges[key]) {
      const n = Number(value[key] ?? initial);
      result[key] = Number.isFinite(n) ? Math.max(ranges[key][0], Math.min(ranges[key][1], n)) : initial;
    } else if (typeof initial === 'boolean') result[key] = typeof value[key] === 'boolean' ? value[key] : initial;
    else if (choices[key]?.includes(value[key])) result[key] = value[key];
  }
  return result;
}
const moods = {
  slow: { speed: 0.82, wet: 32, keep: true, bass: 0, room: 'dark', tail: '3' },
  dream: { speed: 0.75, wet: 48, keep: true, bass: 1, room: 'hall', tail: '5' },
  tape: { speed: 0.88, wet: 15, keep: true, bass: -1, room: 'dark', tail: '1.5' },
  night: { speed: 1.2, wet: 8, keep: true, bass: 0, room: 'plate', tail: '1.5' },
};
const effectKeys = [
  'speed',
  'wet',
  'keep',
  'pitch',
  'bass',
  'formant',
  'duck',
  'safe',
  'quality',
  'room',
  'tail',
  'tone',
  'delay',
];
function effectValues(value) {
  const settings = normalizeValues(value);
  return Object.fromEntries(effectKeys.map((key) => [key, settings[key]]));
}
export function normalize(value = {}) {
  const result = normalizeValues(value);
  result.presetValues = {};
  for (const name of Object.keys(moods)) {
    const saved = value?.presetValues?.[name];
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      result.presetValues[name] = effectValues({ ...moods[name], ...saved });
  }
  return result;
}
export function preset(name, current = defaults) {
  const settings = normalize(current);
  if (!Object.hasOwn(moods, name)) return settings;
  // The active values are saved directly on every edit. Snapshot them before switching.
  settings.presetValues[settings.preset] = effectValues(settings);
  return normalize({
    ...settings,
    ...effectValues(moods[name]),
    ...settings.presetValues[name],
    preset: name,
    active: true,
    compare: 'effect',
  });
}
export function reset(current) {
  const settings = normalize(current);
  return normalize({
    ...defaults,
    ...moods[settings.preset],
    source: settings.source,
    engine: settings.engine,
    preset: settings.preset,
  });
}
export function effective(value) {
  const s = normalize(value);
  return !s.active || s.compare === 'original'
    ? { ...s, speed: 1, wet: 0, pitch: 0, keep: true, bass: 0, duck: false, bypass: true }
    : { ...s, bypass: false };
}
export function pitchFor(value, live = false) {
  const s = effective(value);
  return s.bypass
    ? 0
    : s.pitch + (live ? (s.keep ? -12 * Math.log2(s.speed) : 0) : s.keep ? 0 : 12 * Math.log2(s.speed));
}

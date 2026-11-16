// Both takes begin at the same phrase. Scale time by tempo, not by the
// rendered file length: the slowed recording also includes a reverb tail.
const player = document.querySelector('#compare');
const settings = document.querySelector('#setting');
const choices = [...document.querySelectorAll('button[data-take]')];
const waveform = document.querySelector('.console .wave');
const takes = {
  original: { speed: 1, label: 'Original · 1.00× speed · dry vocal' },
  slowed: { speed: 0.82, label: 'Slowed · 0.82× speed · 32% reverb · pitch held · Rubber Band R3' },
};
let take = 'original';
let pending = null;
let animationFrame = 0;

function updateProgress() {
  cancelAnimationFrame(animationFrame);
  const duration = player.duration;
  if (!pending) {
    const progress = Number.isFinite(duration) && duration > 0 ? player.currentTime / duration : 0;
    waveform.style.setProperty('--progress', `${Math.max(0, Math.min(1, progress)) * 100}%`);
  }
  if (!player.paused && !player.ended && !document.hidden) {
    animationFrame = requestAnimationFrame(updateProgress);
  }
}

for (const event of ['play', 'pause', 'ended', 'timeupdate', 'seeking', 'seeked', 'emptied', 'loadedmetadata']) {
  player.addEventListener(event, updateProgress);
}
document.addEventListener('visibilitychange', updateProgress);
updateProgress();
for (const choice of choices)
  choice.addEventListener('click', () => {
    const next = choice.dataset.take;
    if (take === next) return;
    const phrase = pending?.phrase ?? (player.ended ? 0 : player.currentTime * takes[take].speed);
    const resume = pending?.resume ?? (!player.paused && !player.ended);
    pending = { phrase, resume };
    take = next;
    for (const button of choices) button.setAttribute('aria-pressed', String(button === choice));
    settings.textContent = takes[next].label;
    player.src = '/assets/' + next + '.mp3';
    player.load();
  });
player.addEventListener('loadedmetadata', () => {
  if (!pending) return;
  const { phrase, resume } = pending;
  pending = null;
  player.currentTime = Math.min(phrase / takes[take].speed, Math.max(0, player.duration - 0.05));
  updateProgress();
  if (resume)
    player.play().catch(() => {
      /* Native controls remain available. */
    });
});

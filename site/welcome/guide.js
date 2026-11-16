const params = new URLSearchParams(location.search);
const title = document.querySelector('#title');
const playButton = document.querySelector('#play');
const sample = document.querySelector('#sample');
let pinned = params.has('pinned') ? params.get('pinned') === '1' : undefined;

function showStage(focus = false) {
  const stage = { '#pin': 'pin', '#try': 'try' }[location.hash] || (pinned ? 'try' : 'pin');
  document.documentElement.dataset.stage = stage;
  document.querySelector('.subtitle.listen').textContent = pinned
    ? 'Your icon is pinned. Try the Slowed preset on this tab.'
    : 'Try the Slowed preset on this tab.';
  if (stage === 'pin') sample.pause();
  if (focus) title.focus();
}
showStage();
window.addEventListener('hashchange', () => showStage(true));

playButton.hidden = false;
sample.controls = false;
playButton.addEventListener('click', async () => {
  if (!sample.paused) {
    sample.pause();
    return;
  }
  try {
    await sample.play();
  } catch {
    playButton.hidden = true;
    sample.controls = true;
  }
});
sample.addEventListener('play', () => {
  playButton.textContent = 'Ⅱ  Pause the sample';
});
sample.addEventListener('pause', () => {
  playButton.textContent = '▶  Play the 10-second sample';
});

function connect() {
  const id = params.get('id');
  if (!/^[a-p]{32}$/.test(id || '') || !globalThis.chrome?.runtime?.connect) return;
  let port;
  try {
    port = chrome.runtime.connect(id, { name: 'welcome-pin' });
  } catch {
    return;
  }
  let received = false;
  port.onMessage.addListener((message) => {
    if (typeof message?.pinned !== 'boolean') return;
    received = true;
    if (pinned === message.pinned) return;
    pinned = message.pinned;
    const url = new URL(location.href);
    url.searchParams.set('pinned', pinned ? '1' : '0');
    url.hash = '';
    history.replaceState(null, '', url);
    showStage(true);
  });
  port.onDisconnect.addListener(() => {
    // A suspended worker can close an established port. An unavailable extension
    // never sends the first reply, so the manual links stay usable without retries.
    void chrome.runtime.lastError;
    if (received) setTimeout(connect, 1000);
  });
}
connect();

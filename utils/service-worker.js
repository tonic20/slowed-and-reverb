import { browser as chrome } from 'wxt/browser';
import { defaults, normalize, effective } from './settings.js';
import { normalizeRating, countRun, rate, rateTarget, shouldAsk, ratingDestinations } from './rating.js';
import ratingConfig from './rating-links.json';

async function audioExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')],
  });
  return contexts.length > 0;
}
async function ensureAudio() {
  if (!(await audioExists()))
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'Process the user-selected tab audio and decode/export local audio files on device.',
    });
}
async function audio(command, args = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'audio', command, ...args });
  if (!response?.ok) throw Error(response?.error || 'Audio engine did not respond. Reopen the extension.');
  return response.value;
}
async function media(tabId, command, args = {}) {
  const response = await chrome.tabs.sendMessage(tabId, { target: 'media', command, ...args }, { frameId: 0 });
  if (!response?.ok)
    throw Object.assign(Error(response?.error || 'The page player did not respond.'), { code: response?.code });
  return response.value;
}
async function storedSettings() {
  return normalize((await chrome.storage.local.get('settings')).settings);
}
async function disconnect() {
  const { captureTab } = await chrome.storage.session.get('captureTab');
  try {
    if (captureTab != null) await media(captureTab, 'RESTORE');
  } catch {
    /* Navigated or closed. */
  }
  try {
    if (await audioExists()) await audio('DISCONNECT');
  } finally {
    await chrome.storage.session.remove('captureTab');
    await chrome.action.setBadgeText({ text: '' });
  }
}
async function status() {
  const settings = await storedSettings();
  const session = await chrome.storage.session.get([
    'targetTab',
    'targetTitle',
    'captureTab',
    'audioError',
    'connection',
  ]);
  let sound = (await audioExists()) ? await audio('STATUS') : { mode: null, playing: false };
  if (sound.tabId != null) {
    try {
      sound = { ...sound, ...(await media(sound.tabId, 'STATUS')) };
    } catch {
      await disconnect();
      sound = { mode: null, playing: false };
    }
  } else if (session.captureTab != null) {
    if (sound.failure?.source === 'browser' && sound.failure.tabId === session.captureTab) {
      await chrome.storage.session.set({ audioError: sound.failure });
    }
    await disconnect();
  }
  return { settings, ...session, ...sound, failure: session.audioError || sound.failure || null };
}
async function run(message) {
  if (message.command === 'RATING_RUN') {
    const { rating } = await chrome.storage.local.get('rating');
    await chrome.storage.local.set({ rating: countRun(normalizeRating(rating), message.id) });
    return null;
  }
  if (message.command === 'RATE') {
    const ratingLinks = ratingDestinations(
      chrome.runtime.id,
      chrome.runtime.getManifest().update_url,
      ratingConfig.feedback,
    );
    const { rating } = await chrome.storage.local.get('rating');
    const state = normalizeRating(rating);
    if (!shouldAsk(state, ratingLinks)) return state;
    const next = rate(state, message.stars);
    await chrome.tabs.create({ url: rateTarget(message.stars, ratingLinks) });
    await chrome.storage.local.set({ rating: next });
    return next;
  }
  if (message.command === 'OPEN') {
    // A popup replaces onClicked: the toolbar click has already granted activeTab.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const webTab = /^https?:/.test(tab?.url || '');
    await chrome.storage.session.set({
      targetTab: tab?.id ?? null,
      targetTitle: tab?.title || 'Browser tab',
      connection: webTab ? null : 'unavailable',
    });
    if (webTab && (await storedSettings()).source === 'browser')
      return run({ command: 'CONNECT', automatic: true });
    return status();
  }
  if (message.command === 'STATUS') {
    const current = await status();
    if (
      message.waitingTab != null &&
      message.waitingTab === current.targetTab &&
      current.settings.source === 'browser' &&
      current.connection === 'waiting' &&
      !current.failure
    ) {
      // A replaced document loses its controller. CONNECT reinstalls it on the selected tab.
      if (await media(current.targetTab, 'HAS_PLAYER').catch(() => true))
        return run({ command: 'CONNECT', automatic: true });
    }
    return current;
  }
  if (message.command === 'UPDATE') {
    const previous = await storedSettings(),
      settings = normalize({ ...previous, ...message.settings });
    const { captureTab } = await chrome.storage.session.get('captureTab');
    if (previous.source !== settings.source) await chrome.storage.session.remove('audioError');
    try {
      if (captureTab != null) {
        await audio('PREPARE', { settings });
        await media(captureTab, 'APPLY', { settings: effective(settings) });
      }
      if (await audioExists()) await audio('UPDATE', { settings });
      await chrome.storage.local.set({ settings });
    } catch (error) {
      if (captureTab != null)
        await chrome.storage.session.set({
          audioError: { source: 'browser', tabId: captureTab, message: error.message },
        });
      await chrome.storage.local.set({ settings });
      await disconnect();
      throw error;
    }
    return status();
  }
  if (message.command === 'CONNECT') {
    const session = await chrome.storage.session.get(['targetTab', 'captureTab']);
    const targetTab = message.retryTab ?? session.targetTab,
      captureTab = session.captureTab;
    if (targetTab == null) throw Error('Open a music tab and click the extension icon on that tab first.');
    if (captureTab === targetTab && (await audioExists())) return status();
    await disconnect();
    const settings = await storedSettings();
    try {
      await chrome.scripting.executeScript({ target: { tabId: targetTab }, files: ['media-controller.js'] });
      await chrome.scripting.executeScript({
        target: { tabId: targetTab },
        world: 'MAIN',
        files: ['media-discovery.js'],
      });
      for (let attempt = 0; ; attempt++) {
        try {
          await media(targetTab, 'APPLY', { settings: effective(settings) });
          break;
        } catch (error) {
          if (message.automatic || error.code !== 'NO_MEDIA' || attempt >= 10) throw error;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      await chrome.storage.session.set({ captureTab: targetTab });
      await ensureAudio();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: targetTab });
      await audio('CONNECT', { streamId, tabId: targetTab, settings });
      await chrome.storage.session.remove(['audioError', 'connection']);
      await chrome.action.setBadgeText({ text: 'ON' });
      await chrome.action.setBadgeBackgroundColor({ color: '#9c573c' });
      return status();
    } catch (error) {
      const unavailable = /Cannot access|extensions gallery cannot be scripted/i.test(error.message);
      const noPlayer = message.automatic && (error.code === 'NO_MEDIA' || unavailable);
      if (noPlayer) {
        await chrome.storage.session.remove('audioError');
        await chrome.storage.session.set({ connection: unavailable ? 'unavailable' : 'waiting' });
      } else {
        await chrome.storage.session.remove('connection');
        await chrome.storage.session.set({
          audioError: { source: 'browser', tabId: targetTab, message: error.message },
        });
      }
      try {
        await media(targetTab, 'RESTORE');
      } catch {
        /* No controller on restricted pages. */
      }
      await disconnect();
      if (noPlayer) return status();
      throw Error(
        error.message.includes('Cannot access')
          ? 'Chrome cannot process this page. Open a normal music tab and click the extension icon there.'
          : error.message,
      );
    }
  }
  if (message.command === 'DSP_FAILED') {
    const { captureTab } = await chrome.storage.session.get('captureTab');
    if (captureTab === message.tabId) {
      await chrome.storage.session.set({
        audioError: { source: 'browser', tabId: captureTab, message: message.error || 'The audio processor stopped.' },
      });
      await disconnect();
    }
    return status();
  }
  if (message.command === 'RETRY') {
    const current = await status();
    if (current.failure?.source === 'browser') return run({ command: 'CONNECT', retryTab: current.failure.tabId });
    if (await audioExists()) await audio('RETRY');
    return status();
  }
  if (message.command === 'CAPTURE_ENDED') {
    const { captureTab } = await chrome.storage.session.get('captureTab');
    if (captureTab === message.tabId) await disconnect();
    return status();
  }
  if (message.command === 'DISCONNECT') {
    await disconnect();
    return status();
  }
  if (message.command === 'LOAD') {
    await disconnect();
    await chrome.storage.session.remove('audioError');
    await ensureAudio();
    const settings = await storedSettings();
    await audio('UPDATE', { settings });
    await audio('LOAD', { demo: message.demo, pending: message.pending });
    if (message.pending && settings.source !== 'file')
      await chrome.storage.local.set({ settings: { ...settings, source: 'file' } });
    return status();
  }
  if (message.command === 'REMOVE') {
    if (await audioExists()) await audio('REMOVE');
    return status();
  }
  if (message.command === 'PLAY' || message.command === 'SEEK') {
    const { captureTab } = await chrome.storage.session.get('captureTab');
    if (captureTab != null) await media(captureTab, message.command, { position: message.position });
    else {
      await ensureAudio();
      await audio(message.command, { position: message.position });
    }
    return status();
  }
  if (message.command === 'PLAY_FILE') {
    await disconnect();
    await ensureAudio();
    await audio('PLAY');
    return status();
  }
  if (message.command === 'PAUSE') {
    if (await audioExists()) await audio('PAUSE');
    return status();
  }
  if (message.command === 'EXPORT') {
    await ensureAudio();
    const result = await audio('EXPORT', { settings: await storedSettings() });
    try {
      const id = await chrome.downloads.download({ url: result.url, filename: result.filename, saveAs: true });
      await chrome.storage.session.set({ ['download-' + id]: result.url });
      // A short export can finish before its URL is saved for the onChanged listener.
      const [download] = await chrome.downloads.search({ id });
      if (download && download.state !== 'in_progress') await releaseDownload(id);
      return { ...(await status()), download: result.filename };
    } catch (error) {
      await audio('REVOKE', { url: result.url });
      throw error;
    }
  }
  throw Error('Unknown command.');
}
async function releaseDownload(id) {
  const key = 'download-' + id,
    saved = await chrome.storage.session.get(key);
  if (saved[key] && (await audioExists())) await audio('REVOKE', { url: saved[key] });
  await chrome.storage.session.remove(key);
}

const website = 'https://slowedandreverb.online/';
async function openWelcome() {
  const url = new URL('welcome/', website);
  url.searchParams.set('id', chrome.runtime.id);
  try {
    const settings = await chrome.action.getUserSettings();
    if (typeof settings.isOnToolbar === 'boolean') url.searchParams.set('pinned', settings.isOnToolbar ? '1' : '0');
  } catch {
    // Older Chrome versions use the general pin instructions.
  }
  await chrome.tabs.create({ url: url.href });
}

function shareWelcomePinState(port) {
  const sender = port.sender;
  if (port.name !== 'welcome-pin' || sender?.frameId !== 0 || sender?.url?.split(/[?#]/)[0] !== website + 'welcome/') {
    port.disconnect();
    return;
  }
  let connected = true;
  let changed = false;
  const send = (settings) => {
    if (connected && typeof settings?.isOnToolbar === 'boolean') port.postMessage({ pinned: settings.isOnToolbar });
  };
  const onChange = (settings) => {
    changed = true;
    send(settings);
  };
  const changes = chrome.action.onUserSettingsChanged;
  changes?.addListener(onChange);
  port.onDisconnect.addListener(() => {
    connected = false;
    changes?.removeListener(onChange);
  });
  chrome.action
    .getUserSettings?.()
    .then((settings) => {
      if (!changed) send(settings);
    })
    .catch(() => {});
}

export function registerWorker() {
  chrome.runtime.onConnectExternal.addListener(shareWelcomePinState);
  void chrome.runtime.setUninstallURL(website + 'uninstall/').catch((error) => console.error('Uninstall URL', error));
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.target !== 'worker') return;
    // Only packaged extension pages and our media controller can reach this listener.
    if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) {
      respond({ ok: false, error: 'Not allowed.' });
      return;
    }
    (async () => {
      try {
        const value = await navigator.locks.request('sr-session', () => run(message));
        respond({ ok: true, value });
      } catch (error) {
        respond({ ok: false, error: error.message });
      }
    })();
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void stopForTab(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    // YouTube Music also emits loading/complete for same-document track changes.
    // Only release capture when our controller is gone, not on a URL change alone.
    if (change.status === 'loading' || change.status === 'complete')
      void stopForTab(tabId, { onlyIfControllerLost: true });
  });
  async function stopForTab(tabId, { onlyIfControllerLost = false } = {}) {
    try {
      await navigator.locks.request('sr-session', async () => {
        const { captureTab } = await chrome.storage.session.get('captureTab');
        if (captureTab !== tabId) return;
        if (onlyIfControllerLost) {
          try {
            await media(tabId, 'STATUS');
            return;
          } catch {
            /* The document was replaced, or its controller was disposed. */
          }
        }
        await disconnect();
      });
    } catch (error) {
      console.error('Could not release tab audio', error);
    }
  }
  chrome.downloads.onChanged.addListener((change) => {
    if (!change.state || !['complete', 'interrupted'].includes(change.state.current)) return;
    void releaseDownload(change.id).catch((error) => console.error('Download cleanup failed', error));
  });
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void openWelcome().catch((error) => console.error('Welcome page', error));
    void (async () => {
      const data = await chrome.storage.local.get('settings');
      if (!data.settings) await chrome.storage.local.set({ settings: defaults });
    })().catch((error) => console.error('Settings initialization failed', error));
  });
}

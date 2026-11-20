import { browser as chrome } from 'wxt/browser';

export function registerMediaController() {
  if (globalThis.__slowedReverbController) return;
  globalThis.__slowedReverbController = true;
  let current = null,
    desired = null,
    lastScan = -Infinity,
    correctionTimer;
  const originals = new Map(),
    known = new Set(),
    seen = new WeakSet(),
    attached = new WeakSet();
  const nativePaused = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused').get;
  function remember(media) {
    // Native brand check accepts media from same-origin iframe realms, rejects page objects.
    try {
      nativePaused.call(media);
    } catch {
      return;
    }
    if (media.isConnected) attached.add(media);
    if (seen.has(media)) return;
    seen.add(media);
    known.add(new WeakRef(media));
    media.addEventListener('play', onPlay);
    media.addEventListener('loadedmetadata', onReady);
    media.addEventListener('ratechange', onRateChange);
  }
  function candidates() {
    const list = [];
    for (const ref of known) {
      const media = ref.deref();
      if (!media) known.delete(ref);
      else if (media.readyState >= 1 && (!attached.has(media) || media.isConnected)) list.push(media);
    }
    return list;
  }
  function select() {
    const available = candidates();
    const list = available.filter((m) => !m.muted && m.volume > 0);
    return (
      (list.includes(current) && !current.paused && !current.ended ? current : null) ||
      list.find((m) => !m.paused && !m.ended) ||
      (list.includes(current) ? current : list.find((m) => m.isConnected) || list.at(-1)) ||
      (available.includes(current) ? current : null)
    );
  }
  function restoreMedia(media) {
    const original = originals.get(media);
    if (!original) return;
    try {
      media.playbackRate = original.rate;
      media.preservesPitch = original.pitch;
    } finally {
      originals.delete(media);
    }
  }
  function restore() {
    desired = null;
    clearTimeout(correctionTimer);
    for (const media of originals.keys()) {
      try {
        restoreMedia(media);
      } catch {
        /* Removed frame. */
      }
    }
    current = null;
  }
  function setCurrent(media) {
    if (current && current !== media) restoreMedia(current);
    if (!originals.has(media))
      originals.set(media, {
        rate: media.playbackRate > 0 ? media.playbackRate : media.defaultPlaybackRate || 1,
        pitch: media.preservesPitch,
      });
    current = media;
    syncCurrent();
  }
  function syncCurrent() {
    // Spotify temporarily uses rate=0 while buffering/seeking. Let it release that hold.
    if (!desired || !current || current.readyState < 1 || current.playbackRate === 0) return;
    const pitch = desired.bypass ? originals.get(current).pitch : false;
    if (current.preservesPitch !== pitch) current.preservesPitch = pitch;
    if (Math.abs(current.playbackRate - desired.speed) > 0.0001) current.playbackRate = desired.speed;
  }
  function onRateChange(event) {
    if (!desired || event.target !== current) return;
    clearTimeout(correctionTimer);
    correctionTimer = setTimeout(syncCurrent, 80);
  }
  function onPlay(event) {
    if (!event.target.isConnected) attached.delete(event.target);
    if (desired && !event.target.muted && event.target.volume > 0 && event.target.readyState >= 1)
      setCurrent(event.target);
  }
  function onReady() {
    if (
      desired &&
      (!current ||
        current.paused ||
        current.ended ||
        current.readyState < 1 ||
        (attached.has(current) && !current.isConnected))
    ) {
      const media = select();
      if (media) setCurrent(media);
    }
  }
  function discover(event) {
    remember(event.relatedTarget);
    if (desired) {
      const media = select();
      if (media && media !== current) setCurrent(media);
    }
  }
  function scan() {
    lastScan = performance.now();
    const walk = (root) => {
      for (const node of root.querySelectorAll('*')) {
        if (node.matches('audio,video')) remember(node);
        const shadow =
          node.namespaceURI === 'http://www.w3.org/1999/xhtml'
            ? chrome.dom?.openOrClosedShadowRoot(node) || node.shadowRoot
            : null;
        if (shadow) walk(shadow);
        if (node.matches('iframe,frame')) {
          try {
            if (node.contentDocument) walk(node.contentDocument);
          } catch {
            /* Cross-origin. */
          }
        }
      }
    };
    walk(document);
    document.dispatchEvent(new Event('slowed-reverb:scan'));
    if (desired) {
      const media = select();
      if (media && media !== current) setCurrent(media);
    }
  }
  function apply(config) {
    scan();
    const media = select();
    if (!media)
      throw Object.assign(
        Error(
          'No supported player found yet. Pause and play music on this site, then click Connect again. Or use Audio files.',
        ),
        { code: 'NO_MEDIA' },
      );
    desired = config;
    setCurrent(media);
    return status();
  }
  function status() {
    return {
      playing: !!current && !current.paused && !current.ended,
      position: current?.currentTime || 0,
      duration: Number.isFinite(current?.duration) ? current.duration : 0,
      title: document.title || 'Browser tab',
      rate: current?.playbackRate ?? 1,
    };
  }
  function dispose() {
    restore();
    clearInterval(heartbeat);
    document.dispatchEvent(new Event('slowed-reverb:dispose'));
    document.removeEventListener('slowed-reverb:media', discover);
    for (const ref of known) {
      const media = ref.deref();
      media?.removeEventListener('play', onPlay);
      media?.removeEventListener('loadedmetadata', onReady);
      media?.removeEventListener('ratechange', onRateChange);
    }
    known.clear();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* Extension context invalidated. */
    }
    window.removeEventListener('pagehide', dispose);
    delete globalThis.__slowedReverbController;
  }
  const heartbeat = setInterval(() => {
    try {
      if (!chrome.runtime.id) return dispose();
    } catch {
      return dispose();
    }
    if (desired) {
      scan();
      syncCurrent();
    }
  }, 1000);
  document.addEventListener('slowed-reverb:media', discover);
  window.addEventListener('pagehide', dispose);
  function onMessage(message, sender, respond) {
    if (sender.id !== chrome.runtime.id || message?.target !== 'media') return;
    (async () => {
      try {
        if (message.command === 'HAS_PLAYER') {
          // Discovery reports added media between scans. Also revisit closed shadow roots.
          if (performance.now() - lastScan >= 5000) scan();
          respond({ ok: true, value: !!select() });
          return;
        }
        if (message.command === 'APPLY') apply(message.settings);
        else if (message.command === 'RESTORE') restore();
        else if (message.command === 'PLAY') {
          if (!current) throw Error('Reconnect this tab first.');
          if (current.paused) await current.play();
          else current.pause();
        } else if (message.command === 'SEEK' && current && Number.isFinite(current.duration))
          current.currentTime = Math.max(0, Math.min(current.duration, message.position));
        respond({ ok: true, value: status() });
      } catch (error) {
        respond({ ok: false, error: error.message, code: error.code });
      }
    })();
    return true;
  }
  chrome.runtime.onMessage.addListener(onMessage);
}

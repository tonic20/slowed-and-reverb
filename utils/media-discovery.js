// MAIN-world discovery only: no extension APIs and no page-to-worker RPC.
export function registerMediaDiscovery() {
  const key = '__slowedReverbDiscovery';
  if (globalThis[key]) {
    globalThis[key]();
    return;
  }
  const realms = new Map(),
    roots = new Map();
  let active = true,
    expiry,
    lastScan = 0;
  function report(media) {
    // A native EventTarget field crosses Chrome's isolated worlds; CustomEvent.detail
    // can arrive as null for a detached node. This custom event never changes focus.
    if (active) document.dispatchEvent(new FocusEvent('slowed-reverb:media', { relatedTarget: media }));
  }
  function watchRealm(win) {
    if (realms.get(win)?.doc === win.document) return;
    if (realms.has(win)) restoreRealm(realms.get(win));
    const proto = win.HTMLMediaElement.prototype,
      methods = [],
      descriptors = [];
    for (const name of ['play', 'load']) {
      const original = proto[name];
      const wrapper = function (...args) {
        try {
          report(this);
        } catch {
          /* Discovery must not break native playback. */
        }
        return Reflect.apply(original, this, args);
      };
      try {
        proto[name] = wrapper;
        methods.push({ name, original, wrapper });
      } catch {
        /* Frozen page prototypes must not prevent ordinary DOM discovery. */
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'currentTime');
    const reported = new WeakSet();
    if (descriptor?.get && descriptor.configurable) {
      const get = function () {
        const value = descriptor.get.call(this);
        if (active && !reported.has(this)) {
          reported.add(this);
          try {
            report(this);
          } catch {
            /* Preserve native getter semantics. */
          }
        }
        return value;
      };
      try {
        Object.defineProperty(proto, 'currentTime', { ...descriptor, get });
        descriptors.push({ name: 'currentTime', original: descriptor, get });
      } catch {
        /* Frozen prototype: play/load discovery remains available. */
      }
    }
    realms.set(win, { proto, methods, descriptors, doc: win.document });
  }
  function scan(root) {
    if (!root || !active) return;
    if ((root.nodeType === 9 || root.nodeType === 11) && !roots.has(root)) {
      const observer = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) scan(node);
      });
      observer.observe(root, { childList: true, subtree: true });
      roots.set(root, observer);
    }
    const visit = (node) => {
      if (node.matches?.('audio,video')) report(node);
      if (node.shadowRoot) scan(node.shadowRoot);
      if (node.matches?.('iframe,frame')) {
        try {
          if (node.contentDocument) {
            watchRealm(node.contentWindow);
            scan(node.contentDocument);
          }
        } catch {
          /* Cross-origin frames are outside this controller's access. */
        }
      }
    };
    visit(root);
    for (const node of root.querySelectorAll?.('*') || []) visit(node);
  }
  function refresh() {
    clearTimeout(expiry);
    expiry = setTimeout(dispose, 120000);
    if (performance.now() - lastScan < 5000 && realms.size) return;
    lastScan = performance.now();
    for (const [win, realm] of realms) {
      let valid = win === window;
      try {
        valid ||= win.document === realm.doc && !!win.frameElement?.isConnected;
      } catch {
        /* Navigated. */
      }
      if (!valid) {
        restoreRealm(realm);
        realms.delete(win);
      }
    }
    for (const [root, observer] of roots) {
      let valid = root === document || (root.nodeType === 11 && root.isConnected);
      try {
        valid ||=
          root.nodeType === 9 && root.defaultView?.document === root && !!root.defaultView?.frameElement?.isConnected;
      } catch {
        /* Navigated. */
      }
      if (!valid) {
        observer.disconnect();
        roots.delete(root);
      }
    }
    watchRealm(window);
    scan(document);
  }
  function onLoad(event) {
    if (event.target.matches?.('iframe,frame')) scan(event.target);
  }
  function restoreRealm({ proto, methods, descriptors }) {
    for (const { name, original, wrapper } of methods) {
      try {
        if (proto[name] === wrapper) proto[name] = original;
      } catch {
        /* Frozen after discovery. */
      }
    }
    for (const { name, original, get } of descriptors) {
      try {
        const current = Object.getOwnPropertyDescriptor(proto, name);
        if (current?.get === get && current.set === original.set) Object.defineProperty(proto, name, original);
      } catch {
        /* Preserve later page changes. */
      }
    }
  }
  function dispose() {
    active = false;
    clearTimeout(expiry);
    for (const observer of roots.values()) observer.disconnect();
    roots.clear();
    for (const realm of realms.values()) restoreRealm(realm);
    realms.clear();
    document.removeEventListener('slowed-reverb:scan', refresh);
    document.removeEventListener('slowed-reverb:dispose', dispose);
    document.removeEventListener('load', onLoad, true);
    window.removeEventListener('pagehide', dispose);
    delete globalThis[key];
  }
  document.addEventListener('slowed-reverb:scan', refresh);
  document.addEventListener('slowed-reverb:dispose', dispose);
  document.addEventListener('load', onLoad, true);
  window.addEventListener('pagehide', dispose);
  globalThis[key] = refresh;
  refresh();
}

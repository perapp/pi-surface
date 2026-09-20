/*
 * Pi Surface bridge, injected into trusted same-origin surface documents.
 * No sandbox or privilege boundary: pi.invoke exposes the running harness.
 *
 * const files = await surface.attach(fileInput.files); // [{id,name,mimeType,size}]
 * await pi.prompt('Inspect these', { attachments: files });
 * const data = await surface.read('results.json');
 * const unwatch = surface.watch('results.json', ({path, event}) => refresh());
 * const unsubscribe = surface.on('selection', (data, envelope) => update(data));
 * pi.on(type, callback) receives the complete protocol envelope; '*' receives all.
 * surface.on(type, callback) receives custom surface-event data, then its envelope.
 * watch(callback) watches all data; watch(path, callback) watches a file, or a folder
 * when path ends in '/'. Unsubscribers remove only their own subscription.
 */
(() => {
  'use strict';
  const match = location.pathname.match(/^\/surfaces\/([^/]+)(?:\/|$)/);
  if (!match) return;
  const surfaceId = decodeURIComponent(match[1]);
  const listeners = new Map();
  const surfaceListeners = new Map();
  const watchers = new Set();
  let snapshot = null;
  let source = null;
  let closed = false;
  let reconnectAttempts = 0;
  let reconnectTimer;
  let refreshTimer;
  const reconnectHelp = 'Return to the Pi terminal, run /surface, and open the new URL.';

  function reportCallbackError(error) { console.error('[pi-surface] Listener failed:', error); }
  function notify(registry, type, ...args) {
    for (const key of new Set([type, '*'])) {
      for (const callback of registry.get(key) || []) {
        try { Promise.resolve(callback(...args)).catch(reportCallbackError); } catch (error) { reportCallbackError(error); }
      }
    }
  }
  function subscribe(registry, type, callback) {
    if (typeof callback !== 'function') throw new TypeError('A listener callback is required.');
    // Wrap so subscribing the same function twice still creates independent subscriptions.
    const listener = (...args) => callback(...args);
    if (!registry.has(type)) registry.set(type, new Set());
    registry.get(type).add(listener);
    return () => {
      registry.get(type)?.delete(listener);
      if (!registry.get(type)?.size) registry.delete(type);
    };
  }
  function showDisconnected(reason) {
    const show = () => {
      if (document.getElementById('pi-surface-connection-notice')) return;
      const notice = document.createElement('div');
      notice.id = 'pi-surface-connection-notice';
      notice.setAttribute('role', 'alert');
      notice.style.cssText = 'position:fixed;inset:auto 12px 12px;z-index:2147483647;padding:14px 18px;border:1px solid #c9d5e2;border-left:4px solid #225cc4;border-radius:5px;background:#f2f6fb;color:#172b45;box-shadow:0 5px 24px #172b4526;font:13px/1.6 system-ui,sans-serif;text-align:left;';
      notice.textContent = `${reason} ${reconnectHelp}`;
      (document.body || document.documentElement).append(notice);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
    else show();
  }
  function disconnect(reason) {
    if (closed) return;
    closed = true;
    source?.close();
    clearTimeout(reconnectTimer);
    clearTimeout(refreshTimer);
    showDisconnected(reason);
    notify(listeners, 'connection_closed', { type: 'connection_closed', reason });
  }
  async function responseBody(response) {
    if (response.status === 401) {
      const message = 'Authentication expired or is missing.';
      disconnect(message);
      throw new Error(`${message} ${reconnectHelp}`);
    }
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`Invalid server response (${response.status}).`); }
    if (!response.ok || body.ok === false) {
      throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || `Request failed (${response.status}).`);
    }
    return body;
  }
  function ensureConnected() {
    if (closed) throw new Error(`The Pi session connection is closed. ${reconnectHelp}`);
  }
  async function invoke(method, params = {}) {
    ensureConnected();
    const body = await responseBody(await fetch('/api/invoke', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Surface': '1' },
      body: JSON.stringify({ method, params }),
    }));
    return body.result;
  }
  function asFiles(files) {
    if (typeof File !== 'undefined' && files instanceof File) return [files];
    if (typeof Blob !== 'undefined' && files instanceof Blob) return [files];
    if (files == null) return [];
    return Array.from(files);
  }
  async function attach(files) {
    ensureConnected();
    // Upload sequentially and clean up on a partial failure: callers either get all IDs or none.
    const uploaded = [];
    try {
      for (const file of asFiles(files)) {
        if (!(file instanceof Blob)) throw new TypeError('surface.attach expects File or Blob objects.');
        const result = await responseBody(await fetch('/api/upload', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'X-Pi-Surface': '1', 'X-File-Name': encodeURIComponent(file.name || 'attachment'), 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        }));
        if (!result.id) throw new Error('Upload returned no attachment ID.');
        uploaded.push(result);
      }
      return uploaded;
    } catch (error) {
      await Promise.all(uploaded.map((file) => fetch(`/api/upload/${encodeURIComponent(file.id)}`, {
        method: 'DELETE', credentials: 'same-origin', headers: { 'X-Pi-Surface': '1' },
      }).catch(reportCallbackError)));
      throw error;
    }
  }
  async function normalizeAttachments(items) {
    const ids = [];
    for (const item of items || []) {
      if (typeof item === 'string') ids.push(item);
      else if (item && typeof item.id === 'string') ids.push(item.id);
      else if (typeof Blob !== 'undefined' && item instanceof Blob) ids.push((await attach(item))[0].id);
      else throw new TypeError('Attachments must be uploaded IDs, upload results, or File/Blob objects.');
    }
    return ids;
  }
  async function send(method, text, options = {}) {
    return invoke(method, { text: String(text), surfaceId, attachments: await normalizeAttachments(options.attachments) });
  }
  async function read(path) {
    ensureConnected();
    const response = await fetch(`/api/data/${encodeURIComponent(surfaceId)}?path=${encodeURIComponent(path)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) { await responseBody(response); throw new Error(`Cannot read surface data (${response.status}).`); }
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    return /(?:application\/(?:[\w.-]+\+)?json)\b/i.test(contentType) || /\.json$/i.test(String(path)) ? JSON.parse(text) : text;
  }
  function requestId() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    requestId.sequence = (requestId.sequence || 0) + 1;
    return `request-${Date.now().toString(36)}-${requestId.sequence.toString(36)}`;
  }
  function normalizePath(path) { return String(path).replace(/^(?:\.\/|\/)+/, ''); }
  function watch(path, callback) {
    if (typeof path === 'function') { callback = path; path = null; }
    if (typeof callback !== 'function') throw new TypeError('surface.watch requires a callback.');
    const watcher = { path: path == null ? null : normalizePath(path), callback };
    watchers.add(watcher);
    return () => watchers.delete(watcher);
  }
  async function updateSnapshot() {
    ensureConnected();
    snapshot = await invoke('getState');
    return snapshot;
  }
  function handleEvent(event) {
    if (event.type === 'snapshot') {
      snapshot = event.state;
      reconnectAttempts = 0;
    }
    notify(listeners, event.type, event);
    if (event.type === 'server_closing') { disconnect(event.reason || 'The Pi session server closed.'); return; }
    if (event.type === 'state_changed') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => updateSnapshot().catch(reportCallbackError), 100);
    }
    if (event.surfaceId !== surfaceId) return;
    if (event.type === 'surface_event') {
      const type = typeof event.event === 'string' ? event.event : event.event?.type || 'message';
      notify(surfaceListeners, type, event.data, event);
    } else if (event.type === 'surface_reload') {
      source?.close();
      location.reload();
    } else if (event.type === 'data_changed') {
      if (!watchers.size) { source?.close(); location.reload(); return; }
      const changed = normalizePath(event.path || '');
      for (const watcher of watchers) {
        if (watcher.path === null || watcher.path === changed || (watcher.path.endsWith('/') && changed.startsWith(watcher.path))) {
          try { Promise.resolve(watcher.callback(event)).catch(reportCallbackError); } catch (error) { reportCallbackError(error); }
        }
      }
    }
  }
  function connect() {
    if (closed) return;
    source?.close();
    source = new EventSource('/api/events');
    source.onmessage = (message) => {
      try { handleEvent(JSON.parse(message.data)); } catch (error) { reportCallbackError(error); }
    };
    source.onerror = () => {
      source?.close();
      if (closed) return;
      if (++reconnectAttempts > 3) { disconnect('The Pi session server cannot be reached.'); return; }
      reconnectTimer = setTimeout(async () => {
        // EventSource hides HTTP status. Probe state to identify authentication errors.
        try {
          snapshot = await responseBody(await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) }));
        } catch (error) { if (!closed) console.warn('[pi-surface] Reconnecting:', error.message); }
        if (!closed) connect();
      }, reconnectAttempts * 1500);
    };
  }
  const pi = {
    invoke,
    prompt: (text, options) => send('prompt', text, options),
    steer: (text, options) => send('steer', text, options),
    followUp: (text, options) => send('followUp', text, options),
    abort: () => invoke('abort'),
    getSession: async () => (await updateSnapshot())?.session,
    getState: () => updateSnapshot(),
    on: (type, callback) => subscribe(listeners, type, callback),
  };
  const surface = {
    id: surfaceId,
    pi,
    requestId,
    attach,
    read,
    watch,
    action: (action, target, data) => {
      if (target !== null && typeof target === 'object' && data === undefined) { data = target; target = undefined; }
      return invoke('surfaceAction', { surfaceId, action, ...(target !== undefined ? { target } : {}), ...(data !== undefined ? { data } : {}) });
    },
    on: (type, callback) => subscribe(surfaceListeners, type, callback),
    get state() { return snapshot; },
  };
  window.pi = pi;
  window.surface = surface;
  window.addEventListener('pagehide', () => { source?.close(); clearTimeout(reconnectTimer); clearTimeout(refreshTimer); });
  window.addEventListener('pageshow', (event) => { if (event.persisted && !closed) connect(); });
  connect();
})();

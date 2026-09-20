// Browser-only shell for protocol 1. All agent/session content is rendered as text.
// Surfaces are intentionally trusted same-origin documents, not a sandbox boundary.
const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el]));
let state = null;
let activeSurface = null;
let frameKey = '';
let stream = null;
let stopped = false;
let sending = false;
let runningStarter = null;
let actionRunning = false;
let surfaceConnectionInfo = null;
let surfaceQrVisible = false;
let connected = false;
let restartExpected = false;
let restartReason = 'reload';
let reconnectAttempts = 0;
let reconnectTimer;
let refreshTimer;
let frameTimer;
let refreshSequence = 0;
let activeMessageIndex = -1;
let followConversation = true;
let previousWorking = false;
let completionNeedsAttention = false;
const uploads = [];
const reconnectHelp = 'Return to the Pi terminal, run /surface, and open the new URL. Your draft is still here.';

// Mobile keyboards/browser chrome can shrink the visual viewport without changing
// CSS vh/dvh or the layout viewport. Keep chrome + composer inside the visible area.
const viewport = window.visualViewport;
let viewportFrame = 0;
function syncViewport() {
  viewportFrame = 0;
  // Preserve browser pinch zoom: do not reflow the application into a zoomed view.
  if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
  const height = viewport?.height ?? window.innerHeight;
  if (height <= 0) return;
  document.documentElement.style.setProperty('--surface-viewport-height', `${height}px`);
  document.documentElement.style.setProperty('--surface-viewport-top', `${viewport?.offsetTop ?? 0}px`);
}
function queueViewportSync() {
  if (!viewportFrame) viewportFrame = requestAnimationFrame(syncViewport);
}
viewport?.addEventListener('resize', queueViewportSync);
viewport?.addEventListener('scroll', queueViewportSync);
window.addEventListener('resize', queueViewportSync);
window.addEventListener('pageshow', queueViewportSync);
window.addEventListener('pagehide', () => { cancelAnimationFrame(viewportFrame); viewportFrame = 0; });
syncViewport();

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function showNotice(text, permanent = false) {
  ui.notice.hidden = false;
  ui['notice-text'].textContent = text;
  ui['notice-dismiss'].hidden = permanent;
}
let faviconStatus = '';
let faviconTimer;
function faviconUrl(color, opacity = 1) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M4 8h24M10 8v19M23 8v19h5" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="square" opacity="${opacity}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
function updateFavicon(status) {
  if (status === faviconStatus) return;
  faviconStatus = status;
  ui.favicon.dataset.status = status;
  clearInterval(faviconTimer);
  const color = status === 'offline' ? '#bd3b48' : status === 'online' ? '#365f8c' : '#d97706';
  ui.favicon.href = faviconUrl(color);
  if (status === 'working') {
    let bright = true;
    faviconTimer = setInterval(() => { bright = !bright; ui.favicon.href = faviconUrl(color, bright ? 1 : .25); }, 650);
  }
}
function pageIsViewed() { return document.visibilityState === 'visible' && document.hasFocus(); }
function updatePiMark() {
  const working = connected && state?.session?.idle === false;
  const status = !connected || stopped ? 'offline' : working ? 'working' : completionNeedsAttention ? 'attention' : 'online';
  ui['sidebar-toggle'].dataset.status = status;
  updateFavicon(status);
  const action = ui['sidebar-toggle'].getAttribute('aria-expanded') === 'true' ? 'Close' : 'Open';
  const statusLabel = status === 'offline' ? 'disconnected' : status === 'attention' ? 'completed, not viewed' : status;
  ui['sidebar-toggle'].setAttribute('aria-label', `${action} conversation — ${statusLabel}`);
  ui['sidebar-toggle'].title = `${action} conversation (Ctrl/⌘ B)`;
}
function acknowledgeCompletion() {
  if (!completionNeedsAttention || state?.session?.idle === false || !pageIsViewed()) return;
  completionNeedsAttention = false;
  updatePiMark();
}
window.addEventListener('focus', () => requestAnimationFrame(acknowledgeCompletion));
document.addEventListener('visibilitychange', acknowledgeCompletion);
document.addEventListener('pointerdown', acknowledgeCompletion, { capture: true });
document.addEventListener('keydown', acknowledgeCompletion, { capture: true });
function connection(label, status) {
  ui.connection.textContent = label;
  ui.connection.dataset.status = status;
  updatePiMark();
}
function closeConnection(reason) {
  stopped = true;
  connected = false;
  stream?.close();
  clearTimeout(reconnectTimer);
  clearTimeout(refreshTimer);
  connection('Disconnected', 'closed');
  showNotice(`${reason} ${reconnectHelp}`, true);
  if (ui.controls.open) controlNotice(`${reason} ${reconnectHelp}`, true);
  if (ui['actions-dialog'].open) actionNotice(`${reason} ${reconnectHelp}`);
  updateComposer();
}
async function request(url, options = {}) {
  const signal = !options.method || options.method === 'GET' ? AbortSignal.timeout(10000) : undefined;
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal, ...options });
  if (response.status === 401) {
    const error = new Error('Authentication expired or is missing. Open the authenticated URL printed by /surface in Pi.');
    closeConnection(error.message);
    throw error;
  }
  let body;
  const text = await response.text();
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`Unexpected server response (${response.status}).`); }
  if (!response.ok || body.ok === false) {
    const detail = typeof body.error === 'string' ? body.error : body.error?.message;
    throw new Error(detail || `Request failed (${response.status}).`);
  }
  return body;
}
async function invoke(method, params = {}) {
  if (stopped) throw new Error(`This session connection is closed. ${reconnectHelp}`);
  const body = await request('/api/invoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Surface': '1' },
    body: JSON.stringify({ method, params }),
  });
  return body.result;
}
async function refresh() {
  if (stopped) return;
  const sequence = ++refreshSequence;
  const next = await request('/api/state');
  if (sequence === refreshSequence && !stopped) applyState(next);
}
function queueRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch((error) => showNotice(error.message)), 100);
}
function applyState(next) {
  if (next.protocol !== 1) { closeConnection('This server uses an unsupported protocol.'); return; }
  const sessionChanged = !!(state?.session?.id && next.session?.id && next.session.id !== state.session.id);
  if (sessionChanged && !restartExpected) {
    closeConnection('The terminal changed sessions unexpectedly.'); return;
  }
  if (sessionChanged) { uploads.splice(0); renderUploads(); }
  state = next;
  restartExpected = false;
  state.messages ||= [];
  if (state.activeMessage && !state.messages.some((message) => message.role === state.activeMessage.role && message.timestamp != null && message.timestamp === state.activeMessage.timestamp)) state.messages.push(state.activeMessage);
  state.surfaces ||= [];
  renderSession();
  renderMessages();
  renderSurfaces();
  if (ui.controls.open) renderControls();
  if (ui['actions-dialog'].open) renderActions();
}
function directoryName(path) {
  const value = String(path || '').replace(/[\\/]+$/, '');
  return value.split(/[\\/]/).pop() || value || 'Pi';
}
function renderSession() {
  const session = state.session || {};
  const working = session.idle === false;
  if (previousWorking && !working) completionNeedsAttention = !pageIsViewed();
  if (working) completionNeedsAttention = false;
  previousWorking = working;
  ui['session-name'].textContent = session.name || 'Untitled session';
  ui['session-cwd'].textContent = session.cwd || 'Running Pi session';
  document.title = `${directoryName(session.cwd)} · Pi`;
  ui['activity-status'].textContent = state.uiPrompt ? 'Needs terminal' : working ? 'Working' : 'Ready';
  ui['model-label'].textContent = session.model?.name || session.model?.id || 'No model selected';
  const usage = session.contextUsage;
  ui['context-label'].textContent = typeof usage?.percent === 'number' ? `${Math.round(usage.percent)}% context` : '';
  renderComposerControls();
  updatePiMark();
  updateComposer();
}
function renderComposerControls() {
  const models = state?.models || [];
  const session = state?.session || {};
  const currentModel = models.findIndex(model => model.id === session.model?.id && model.provider === session.model?.provider);
  setOptions(ui['composer-model-select'], models.map((model, index) => ({ value: String(index), label: model.name || model.id })), currentModel >= 0 ? String(currentModel) : '', 'Model');
  if (document.activeElement !== ui['composer-thinking-select']) ui['composer-thinking-select'].value = session.thinkingLevel || 'off';
}
function renderMessage(message) {
  const article = element('article', 'message');
  article.dataset.role = message.role || 'event';
  const role = message.role === 'toolResult' ? `Tool · ${message.toolName || 'result'}` : message.role === 'assistant' ? 'Pi' : message.role === 'user' ? 'You' : message.role || 'Session';
  article.append(element('div', 'message-heading', role));
  const content = message.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  for (const block of blocks) {
    if (block.type === 'text') article.append(element('div', 'message-body', block.text || ''));
    else if (block.type === 'thinking') {
      const details = element('details');
      details.append(element('summary', '', 'Thinking'), element('pre', '', block.thinking || ''));
      article.append(details);
    } else if (block.type === 'toolCall') {
      const details = element('details');
      details.append(element('summary', '', `Tool call · ${block.name || 'tool'}`), element('pre', '', JSON.stringify(block.arguments ?? {}, null, 2)));
      article.append(details);
    } else if (block.type === 'image') article.append(element('div', 'message-body muted', '[Image attachment]'));
    else if (block.type === 'file' || block.type === 'attachment') article.append(element('div', 'message-body muted', `[Attachment: ${block.name || block.mimeType || 'file'}]`));
  }
  if (!blocks.length && message.text) article.append(element('div', 'message-body', message.text));
  if (message.errorMessage) article.append(element('div', 'message-body message-error', message.errorMessage));
  if (message.isError) article.classList.add('message-error');
  return article;
}
function nearBottom() { const el = ui.messages; return el.scrollHeight - el.scrollTop - el.clientHeight < 90; }
function followConversationEnd() { if (followConversation) ui.messages.scrollTop = ui.messages.scrollHeight; }
ui.messages.addEventListener('scroll', () => { followConversation = nearBottom(); }, { passive: true });
function renderMessages() {
  const follow = followConversation;
  const fragment = document.createDocumentFragment();
  for (const message of state.messages) fragment.append(renderMessage(message));
  if (!state.messages.length) fragment.append(element('p', 'muted empty-conversation', 'Your conversation appears here, including activity from the terminal.'));
  ui.messages.replaceChildren(fragment);
  activeMessageIndex = -1;
  if (follow) followConversationEnd();
}
function handleMessage(event) {
  if (!state || !event.message) return;
  const message = event.message;
  const follow = followConversation;
  let index = state.messages.findIndex((item) => message.id ? item.id === message.id : message.timestamp != null && item.timestamp === message.timestamp && item.role === message.role);
  if (index < 0 && event.type !== 'message_start' && activeMessageIndex >= 0 && state.messages[activeMessageIndex]?.role === message.role) index = activeMessageIndex;
  if (index < 0 && event.type !== 'message_start') {
    // Some Pi messages have neither an id nor a timestamp; updates replace the latest same-role message.
    const last = state.messages.length - 1;
    if (last >= 0 && state.messages[last].role === message.role) index = last;
  }
  if (index < 0) {
    index = state.messages.length;
    if (!index) ui.messages.replaceChildren();
    state.messages.push(message);
    ui.messages.append(renderMessage(message));
  } else {
    state.messages[index] = message;
    ui.messages.children[index]?.replaceWith(renderMessage(message));
  }
  activeMessageIndex = event.type === 'message_end' ? -1 : index;
  if (follow) followConversationEnd();
  if (event.type === 'message_end') queueRefresh();
}
function surfaceURL(surface) {
  const entry = String(surface.entry || 'index.html').split('/').map(encodeURIComponent).join('/');
  return `/surfaces/${encodeURIComponent(surface.id)}/${entry}`;
}
function selectSurface(id) {
  activeSurface = id;
  renderSurfaces();
  if (ui.controls.open) ui.controls.close();
}
function renderSurfaces() {
  const surfaces = state.surfaces;
  if (!surfaces.some((surface) => surface.id === activeSurface)) activeSurface = (surfaces.find((surface) => surface.default) || surfaces[0])?.id || null;
  ui['surface-count'].textContent = `${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}`;
  const tabs = surfaces.map((surface, index) => {
    const tab = element('button', 'surface-tab', surface.name || surface.id);
    tab.type = 'button';
    tab.id = `surface-tab-${index}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(surface.id === activeSurface));
    tab.setAttribute('aria-controls', 'surface-stage');
    tab.tabIndex = surface.id === activeSurface ? 0 : -1;
    tab.title = `${surface.name || surface.id} · ${surface.scope || 'session'}`;
    tab.addEventListener('click', () => selectSurface(surface.id));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % surfaces.length;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + surfaces.length) % surfaces.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = surfaces.length - 1;
      if (next !== undefined) { event.preventDefault(); selectSurface(surfaces[next].id); $(`surface-tab-${next}`)?.focus(); }
    });
    return tab;
  });
  const focusedIndex = [...ui['surface-tabs'].children].indexOf(document.activeElement);
  ui['surface-tabs'].replaceChildren(...tabs);
  if (focusedIndex >= 0) tabs.find((tab) => tab.tabIndex === 0)?.focus();
  const surface = surfaces.find((item) => item.id === activeSurface);
  ui['surface-empty'].hidden = !!surface;
  ui['surface-frame'].hidden = !surface;
  if (!surface) {
    clearTimeout(frameTimer);
    ui['surface-loading'].hidden = true;
    if (frameKey) ui['surface-frame'].removeAttribute('src');
    frameKey = '';
    ui['surface-stage'].removeAttribute('role');
    ui['surface-stage'].removeAttribute('aria-labelledby');
    return;
  }
  ui['surface-stage'].setAttribute('role', 'tabpanel');
  ui['surface-stage'].setAttribute('aria-labelledby', `surface-tab-${surfaces.indexOf(surface)}`);
  const url = surfaceURL(surface);
  if (frameKey !== url) {
    frameKey = url;
    ui['surface-frame'].title = surface.name || surface.id;
    ui['surface-loading'].textContent = 'Loading surface…';
    ui['surface-loading'].hidden = false;
    ui['surface-frame'].src = url;
    clearTimeout(frameTimer);
    frameTimer = setTimeout(() => {
      ui['surface-loading'].textContent = 'Still loading. Ask Pi to check this surface’s entry file, or select another tab.';
    }, 12000);
  }
}
ui['surface-frame'].addEventListener('load', () => {
  clearTimeout(frameTimer);
  ui['surface-loading'].hidden = true;
  // Same origin also lets us recognize a failed auth response and handle shell
  // shortcuts while focus is inside the surface.
  try {
    const doc = ui['surface-frame'].contentDocument;
    if (doc?.body?.textContent?.trim().match(/^(unauthorized|authentication required)$/i)) closeConnection('The surface is no longer authenticated.');
    doc?.addEventListener('keydown', handleGlobalShortcut, { capture: true });
  } catch { /* A trusted surface may navigate elsewhere. */ }
});
function handleEvent(event) {
  if (event.type === 'snapshot') { ++refreshSequence; applyState(event.state); }
  else if (event.type?.startsWith('message_')) handleMessage(event);
  else if (event.type === 'state_changed') queueRefresh();
  else if (event.type === 'surfaces_changed' && state) { state.surfaces = event.surfaces || []; renderSurfaces(); }
  else if (event.type === 'surface_open') {
    activeSurface = event.surfaceId;
    if (state?.surfaces.some((surface) => surface.id === activeSurface)) renderSurfaces();
    else queueRefresh();
  } else if (event.type === 'server_reloading') {
    restartExpected = true; restartReason = event.reason || 'reload'; connected = false;
    connection(restartReason === 'reload' ? 'Reloading' : 'Changing session', 'waiting'); updateComposer();
  } else if (event.type === 'server_closing') closeConnection(event.reason || 'The surface server closed.');
  else if (event.type === 'surface_error') showNotice(event.message || 'The surface encountered an error.');
  else if (event.type === 'agent_start' && state) { state.session.idle = false; renderSession(); }
  else if (event.type === 'agent_end') queueRefresh();
  else if (event.type === 'ui_prompt_start' && state) { state.uiPrompt = event; renderSession(); }
  else if (event.type === 'ui_prompt_end' && state) { state.uiPrompt = null; renderSession(); }
  else if (event.type === 'tool_execution_start') ui['activity-status'].textContent = `Running ${event.toolName || 'tool'}`;
  else if (event.type === 'tool_execution_end') queueRefresh();
  // surface_reload and data_changed belong to the injected bridge. Reloading here too races the child.
}
function connect() {
  if (stopped) return;
  stream?.close();
  stream = new EventSource('/api/events');
  stream.onopen = () => {
    if (stopped) return;
    connected = true;
    connection('Live', 'live');
    updateComposer();
  };
  stream.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      if (event.type === 'snapshot') reconnectAttempts = 0;
      handleEvent(event);
    } catch (error) { showNotice(`Could not read a session update: ${error.message}`); }
  };
  stream.onerror = () => {
    stream?.close();
    if (stopped) return;
    connected = false;
    updateComposer();
    connection(restartExpected ? (restartReason === 'reload' ? 'Reloading' : 'Changing session') : 'Reconnecting', 'waiting');
    const maxAttempts = restartExpected ? 20 : 3;
    if (++reconnectAttempts > maxAttempts) { closeConnection('The session server cannot be reached.'); return; }
    reconnectTimer = setTimeout(async () => {
      try { await refresh(); } catch (error) {
        if (!stopped && !restartExpected) showNotice(`Connection interrupted. Retrying (${reconnectAttempts}/${maxAttempts}). ${error.message}`);
      }
      if (!stopped) connect();
    }, restartExpected ? 1000 : reconnectAttempts * 1500);
  };
}
function updateComposer() {
  const busy = state?.session?.idle === false;
  ui.send.title = sending ? 'Sending…' : busy ? 'Send steering guidance to the working Pi' : 'Send a new prompt';
  ui.send.setAttribute('aria-label', sending ? 'Sending' : busy ? 'Send steering guidance' : 'Send');
  ui.send.setAttribute('aria-busy', String(sending));
  ui.send.disabled = !state || !connected || stopped || sending || uploads.some((upload) => upload.status !== 'ready');
  ui.abort.hidden = state?.session?.idle !== false;
  ui.abort.disabled = stopped || !connected;
  ui.attach.disabled = sending || stopped;
  ui['file-input'].disabled = sending || stopped;
  ui['composer-model-select'].disabled = !state || !connected || stopped || busy;
  ui['composer-thinking-select'].disabled = !state || !connected || stopped || busy;
  ui['actions-open'].disabled = !state || !connected || stopped;
  ui['actions-run'].disabled = actionRunning || !connected || stopped || !ui['actions-select'].value || state?.session?.idle === false || !!state?.session?.pending;
  updateStarterPrompts();
}
function renderUploads() {
  ui.attachments.replaceChildren(...uploads.map((upload) => {
    const item = element('div', 'attachment');
    item.dataset.status = upload.status;
    const label = upload.status === 'uploading' ? `${upload.file.name} · uploading…` : upload.status === 'error' ? `${upload.file.name} · ${upload.error}` : upload.name || upload.file.name;
    const text = element('span', '', label);
    text.title = label;
    item.append(text);
    if (upload.status === 'error') {
      const retry = element('button', '', 'Retry'); retry.type = 'button'; retry.disabled = sending || stopped;
      retry.addEventListener('click', () => performUpload(upload)); item.append(retry);
    }
    const remove = element('button', '', '×'); remove.type = 'button'; remove.disabled = sending;
    remove.setAttribute('aria-label', `Remove ${upload.file.name}`);
    remove.addEventListener('click', () => removeUpload(upload));
    item.append(remove);
    return item;
  }));
  updateComposer();
}
async function deleteUpload(id) { await request(`/api/upload/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-Pi-Surface': '1' } }); }
async function performUpload(upload) {
  upload.status = 'uploading'; upload.error = ''; renderUploads();
  try {
    const result = await request('/api/upload', { method: 'POST', headers: { 'X-Pi-Surface': '1', 'X-File-Name': encodeURIComponent(upload.file.name), 'Content-Type': upload.file.type || 'application/octet-stream' }, body: upload.file });
    if (!result.id) throw new Error('The upload returned no attachment ID.');
    if (upload.removed) { await deleteUpload(result.id); return; }
    Object.assign(upload, result, { status: 'ready' });
  } catch (error) {
    if (upload.removed) showNotice(`Could not finish removing an attachment: ${error.message}`);
    else { upload.status = 'error'; upload.error = error.message; }
  } finally { renderUploads(); }
}
function attachFiles(files) {
  if (sending || stopped) { showNotice('Wait until sending finishes, or reconnect before attaching files.'); return; }
  for (const file of files) { const upload = { file, status: 'uploading', removed: false }; uploads.push(upload); void performUpload(upload); }
}
async function removeUpload(upload) {
  if (sending || upload.status === 'removing') return;
  const previousStatus = upload.status;
  try {
    if (upload.id) {
      upload.status = 'removing'; renderUploads();
      await deleteUpload(upload.id);
    }
    upload.removed = true;
    const index = uploads.indexOf(upload);
    if (index >= 0) uploads.splice(index, 1);
  } catch (error) {
    upload.status = previousStatus;
    showNotice(`Could not remove attachment: ${error.message}`);
  } finally { renderUploads(); }
}
ui.attach.addEventListener('click', () => ui['file-input'].click());
ui['file-input'].addEventListener('change', () => { attachFiles(ui['file-input'].files); ui['file-input'].value = ''; });
ui.prompt.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); attachFiles(files); }
});
let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); dragDepth++; ui['drop-hint'].hidden = false; }
});
document.addEventListener('dragover', (event) => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; ui['drop-hint'].hidden = true; } });
document.addEventListener('drop', (event) => {
  dragDepth = 0; ui['drop-hint'].hidden = true;
  if (event.dataTransfer?.files.length) { event.preventDefault(); attachFiles(event.dataTransfer.files); }
});
function parseAdvertisedCommand(value) {
  const match = value.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match || !state?.commands?.some(command => command.name === match[1])) return;
  return { name: match[1], args: match[2] || '' };
}
ui.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (ui.send.disabled) return;
  const text = ui.prompt.value;
  if (!text.trim() && !uploads.length) { ui.prompt.focus(); return; }
  const attached = [...uploads];
  const command = parseAdvertisedCommand(text);
  sending = true; renderUploads();
  try {
    if (command && attached.length) throw new Error('Remove attachments before running a command.');
    if (command) {
      const result = await invoke('command', command);
      showNotice(`Command /${command.name} sent.${result?.note ? ` ${result.note}` : ''}`);
    } else {
      // Pi's steer delivery starts a normal user turn when idle and steers when busy.
      // Let Pi decide at delivery time, not from a potentially stale browser snapshot.
      await invoke('steer', { text, attachments: attached.map((upload) => upload.id), ...(activeSurface ? { surfaceId: activeSurface } : {}) });
    }
    if (ui.prompt.value === text) { ui.prompt.value = ''; autoSizePrompt(); }
    for (const upload of attached) { const index = uploads.indexOf(upload); if (index >= 0) uploads.splice(index, 1); }
    queueRefresh();
  } catch (error) { showNotice(`${command ? 'Command' : 'Message'} not sent. ${error.message} Your draft and attachments were kept.`); }
  finally { sending = false; renderUploads(); ui.prompt.focus(); }
});
ui.prompt.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLocaleLowerCase() === 'j') {
    event.preventDefault();
    ui.prompt.setRangeText('\n', ui.prompt.selectionStart, ui.prompt.selectionEnd, 'end');
    autoSizePrompt();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ui.composer.requestSubmit(); }
});
ui.abort.addEventListener('click', async () => { try { await invoke('abort'); queueRefresh(); } catch (error) { showNotice(error.message); } });
ui['notice-dismiss'].addEventListener('click', () => { ui.notice.hidden = true; });
function toggleSidebar(open) {
  document.querySelector('.shell').classList.toggle('sidebar-open', open);
  ui.sidebar.hidden = !open;
  ui['sidebar-backdrop'].hidden = !open;
  ui['brand-name'].hidden = !open;
  ui['sidebar-toggle'].setAttribute('aria-expanded', String(open));
  updatePiMark();
  if (open) requestAnimationFrame(followConversationEnd);
}
function togglePrompt(open, focus = true) {
  ui['prompt-panel'].hidden = !open;
  ui['prompt-quick-toggle'].setAttribute('aria-pressed', String(open));
  const label = `${open ? 'Hide' : 'Show'} prompt panel`;
  ui['prompt-quick-toggle'].setAttribute('aria-label', label);
  ui['prompt-quick-toggle'].title = `${label} (Ctrl/⌘ /)`;
  if (open) requestAnimationFrame(autoSizePrompt);
  if (focus && open) ui.prompt.focus();
}
function updateStarterPrompts() {
  const unavailable = !state || !connected || stopped || sending || state?.session?.idle === false;
  document.querySelectorAll('.starter-run').forEach((button) => {
    button.disabled = unavailable;
    const isRunning = button === runningStarter;
    button.closest('.starter-card')?.toggleAttribute('data-running', isRunning);
    button.setAttribute('aria-busy', String(isRunning));
    button.title = isRunning ? 'Sending prompt…' : unavailable ? 'Available when Pi is ready' : 'Run prompt now';
  });
  document.querySelectorAll('.starter-fill').forEach((button) => { button.disabled = stopped; });
}
function starterPrompt(button) {
  return button.querySelector('.starter-prompt')?.textContent?.trim() || '';
}
function fillStarterPrompt(button) {
  togglePrompt(true, false);
  ui.prompt.value = starterPrompt(button);
  autoSizePrompt();
  ui.prompt.focus();
}
document.querySelectorAll('.starter-fill').forEach((button) => {
  button.addEventListener('click', () => fillStarterPrompt(button));
});
document.querySelectorAll('.starter-run').forEach((button) => {
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const fillButton = button.closest('.starter-card')?.querySelector('.starter-fill');
    const text = fillButton ? starterPrompt(fillButton) : '';
    if (!text) return;
    runningStarter = button;
    sending = true;
    updateComposer();
    try {
      await invoke('steer', { text });
      queueRefresh();
    } catch (error) {
      fillStarterPrompt(fillButton);
      showNotice(`Prompt not sent. ${error.message} It is ready to edit and retry.`);
    } finally {
      sending = false;
      runningStarter = null;
      updateComposer();
    }
  });
});
ui['example-prompt'].addEventListener('click', () => {
  togglePrompt(true);
});
ui['sidebar-toggle'].addEventListener('click', () => toggleSidebar(ui['sidebar-toggle'].getAttribute('aria-expanded') !== 'true'));
ui['sidebar-backdrop'].addEventListener('click', () => toggleSidebar(false));
ui['prompt-quick-toggle'].addEventListener('click', () => {
  togglePrompt(ui['prompt-quick-toggle'].getAttribute('aria-pressed') !== 'true');
});
ui['activity-close'].addEventListener('click', () => toggleSidebar(false));

const sidebarWidthKey = 'pi-surface-sidebar-width';
function sidebarWidthBounds() {
  return { min: 260, max: Math.max(260, Math.min(720, Math.floor(window.innerWidth * .65))) };
}
function setSidebarWidth(value, persist = false) {
  const { min, max } = sidebarWidthBounds();
  const width = Math.round(Math.max(min, Math.min(max, value)));
  document.querySelector('.shell').style.setProperty('--sidebar-width', `${width}px`);
  ui['sidebar-resizer'].setAttribute('aria-valuemin', String(min));
  ui['sidebar-resizer'].setAttribute('aria-valuemax', String(max));
  ui['sidebar-resizer'].setAttribute('aria-valuenow', String(width));
  if (persist) try { localStorage.setItem(sidebarWidthKey, String(width)); } catch { /* Storage may be unavailable. */ }
  return width;
}
let sidebarWidth = 340;
try { sidebarWidth = Number(localStorage.getItem(sidebarWidthKey)) || sidebarWidth; } catch { /* Storage may be unavailable. */ }
sidebarWidth = setSidebarWidth(sidebarWidth);
let resizingSidebar = false;
ui['sidebar-resizer'].addEventListener('pointerdown', event => {
  if (matchMedia('(max-width: 760px)').matches) return;
  resizingSidebar = true;
  ui['sidebar-resizer'].setPointerCapture(event.pointerId);
  document.querySelector('.shell').classList.add('resizing-sidebar');
  event.preventDefault();
});
ui['sidebar-resizer'].addEventListener('pointermove', event => {
  if (!resizingSidebar) return;
  sidebarWidth = setSidebarWidth(event.clientX);
});
function finishSidebarResize(event) {
  if (!resizingSidebar) return;
  resizingSidebar = false;
  document.querySelector('.shell').classList.remove('resizing-sidebar');
  if (event.pointerId != null && ui['sidebar-resizer'].hasPointerCapture(event.pointerId)) ui['sidebar-resizer'].releasePointerCapture(event.pointerId);
  sidebarWidth = setSidebarWidth(sidebarWidth, true);
}
ui['sidebar-resizer'].addEventListener('pointerup', finishSidebarResize);
ui['sidebar-resizer'].addEventListener('pointercancel', finishSidebarResize);
ui['sidebar-resizer'].addEventListener('keydown', event => {
  const step = event.shiftKey ? 40 : 10;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const bounds = sidebarWidthBounds();
  sidebarWidth = setSidebarWidth(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : sidebarWidth + (event.key === 'ArrowRight' ? step : -step), true);
});
window.addEventListener('resize', () => { sidebarWidth = setSidebarWidth(sidebarWidth); autoSizePrompt(); });

function autoSizePrompt() {
  const styles = getComputedStyle(ui.prompt);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 21;
  const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  const minHeight = Math.ceil(lineHeight + verticalPadding);
  const maxHeight = Math.ceil(lineHeight * 10 + verticalPadding);
  ui.prompt.style.height = 'auto';
  const height = Math.max(minHeight, Math.min(ui.prompt.scrollHeight, maxHeight));
  ui.prompt.style.height = `${height}px`;
  ui.prompt.style.overflowY = ui.prompt.scrollHeight > maxHeight ? 'auto' : 'hidden';
}
ui.prompt.addEventListener('input', autoSizePrompt);
autoSizePrompt();

function handleGlobalShortcut(event) {
  const dialogOpen = ui.controls.open || ui['actions-dialog'].open;
  if (event.key === 'Escape') {
    if (dialogOpen) return; // Native dialog handling takes priority.
    if (ui['sidebar-toggle'].getAttribute('aria-expanded') === 'true') { event.preventDefault(); toggleSidebar(false); return; }
    if (!ui['prompt-panel'].hidden) { event.preventDefault(); togglePrompt(false, false); }
    return;
  }
  if (dialogOpen || event.repeat || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLocaleLowerCase() === 'b') {
    event.preventDefault();
    toggleSidebar(ui['sidebar-toggle'].getAttribute('aria-expanded') !== 'true');
  } else if (event.key === '/') {
    event.preventDefault();
    togglePrompt(ui['prompt-panel'].hidden);
  }
}
document.addEventListener('keydown', handleGlobalShortcut);

// Composer command picker: use the same advertised commands and validated dispatch
// as Session controls. Never pass arbitrary slash text to the model as a command.
function actionNotice(text) {
  ui['actions-notice'].textContent = text;
  ui['actions-notice'].hidden = !text;
}
function renderActionDescription() {
  const command = state?.commands?.find(command => command.name === ui['actions-select'].value);
  ui['actions-description'].textContent = command?.description || (command ? `/${command.name} · ${command.source}` : 'No matching commands. Try a different search.');
  updateComposer();
}
function renderActions() {
  const query = ui['actions-search'].value.trim().replace(/^\//, '').toLocaleLowerCase();
  const commands = (state?.commands || []).filter(command =>
    `${command.name} ${command.description || ''} ${command.source || ''}`.toLocaleLowerCase().includes(query));
  const selected = ui['actions-select'].value;
  ui['actions-select'].replaceChildren(...commands.map(command => new Option(`/${command.name} · ${command.source}`, command.name)));
  ui['actions-select'].value = commands.some(command => command.name === selected) ? selected : commands[0]?.name || '';
  renderActionDescription();
  const busyNote = 'Pi is busy. Wait for it to finish, or close this picker and abort the current turn.';
  if (state?.session?.idle === false || state?.session?.pending) actionNotice(busyNote);
  else if (ui['actions-notice'].textContent === busyNote) actionNotice('');
}
ui['actions-open'].addEventListener('click', () => {
  actionNotice(''); renderActions(); ui['actions-dialog'].showModal(); ui['actions-search'].focus();
});
ui['actions-close'].addEventListener('click', () => ui['actions-dialog'].close());
ui['actions-search'].addEventListener('input', renderActions);
ui['actions-select'].addEventListener('change', renderActionDescription);
ui['actions-controls'].addEventListener('click', () => {
  ui['actions-dialog'].close(); renderControls(); ui.controls.showModal(); void loadSurfaceConnection();
});
ui['actions-form'].addEventListener('submit', async event => {
  event.preventDefault();
  if (ui['actions-run'].disabled) return;
  const name = ui['actions-select'].value;
  if (!state?.commands?.some(command => command.name === name)) { actionNotice('Choose an available command.'); return; }
  actionRunning = true; actionNotice(''); updateComposer();
  try {
    const result = await invoke('command', { name, args: ui['actions-args'].value });
    ui['actions-dialog'].close();
    showNotice(`Command /${name} sent.${result?.note ? ` ${result.note}` : ''}`);
    queueRefresh();
  } catch (error) { actionNotice(`Command not sent. ${error.message}`); }
  finally { actionRunning = false; updateComposer(); }
});

// Controls deliberately use only server-advertised models, commands, tools and tree entries.
function controlNotice(text, error = false) {
  ui['control-notice'].hidden = false;
  ui['control-notice'].dataset.error = String(error);
  ui['control-notice'].textContent = text;
}
async function controlAction(button, method, params, success = 'Updated.') {
  if (button) button.disabled = true;
  try {
    const result = await invoke(method, params);
    controlNotice(result?.note ? `${success} ${result.note}` : success);
    queueRefresh();
    return result;
  } catch (error) { controlNotice(error.message, true); return undefined; }
  finally { if (button) button.disabled = false; }
}
function renderSurfaceConnection() {
  const info = surfaceConnectionInfo;
  ui['surface-runtime-status'].textContent = info?.running ? `Running · :${info.port}` : 'Unavailable';
  ui['surface-url'].textContent = info?.preferredUrl || 'Connection details unavailable';
  ui['surface-addresses'].replaceChildren(...(info?.urls || []).map(url => element('p', '', url)));
  ui['surface-qr'].hidden = !surfaceQrVisible || !info?.qrDataUrl;
  if (info?.qrDataUrl) { ui['surface-qr-image'].src = info.qrDataUrl; ui['surface-qr-image'].alt = `Authenticated Pi Surface QR code for ${info.preferredUrl}`; }
  ui['surface-qr-toggle'].textContent = surfaceQrVisible ? 'Hide QR' : 'Show QR';
  for (const id of ['surface-copy', 'surface-open-here']) ui[id].disabled = !info?.preferredUrl;
}
async function loadSurfaceConnection(includeQr = false, button, action = includeQr ? 'qr' : 'status') {
  if (button) button.disabled = true;
  ui['surface-runtime-status'].textContent = 'Loading…';
  try {
    surfaceConnectionInfo = await invoke('surfaceCommand', { action });
    if (includeQr) surfaceQrVisible = true;
    renderSurfaceConnection();
    return surfaceConnectionInfo;
  } catch (error) { controlNotice(error.message, true); renderSurfaceConnection(); return undefined; }
  finally { if (button) button.disabled = false; }
}
async function copyConnectionUrl() {
  const value = surfaceConnectionInfo?.preferredUrl;
  if (!value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.append(input); input.select(); document.execCommand('copy'); input.remove();
  }
  controlNotice('Authenticated Surface URL copied.');
}
function setOptions(select, options, current, placeholder) {
  if (document.activeElement === select) return;
  select.replaceChildren(...(placeholder ? [new Option(placeholder, '')] : []), ...options.map(({ value, label }) => new Option(label, value)));
  select.value = current ?? '';
}
function renderControls() {
  if (!state) return;
  const session = state.session || {};
  if (document.activeElement !== ui['rename-input']) ui['rename-input'].value = session.name || '';
  const models = state.models || [];
  setOptions(ui['model-select'], models.map((model, index) => ({ value: String(index), label: `${model.name || model.id} · ${model.provider}` })), String(models.findIndex((model) => model.id === session.model?.id && model.provider === session.model?.provider)), 'Select model');
  if (document.activeElement !== ui['thinking-select']) ui['thinking-select'].value = session.thinkingLevel || 'off';
  setOptions(ui['command-select'], (state.commands || []).map((command) => ({ value: command.name, label: `/${command.name}${command.source ? ` · ${command.source}` : ''}` })), ui['command-select'].value, 'Choose a command');
  const checked = new Map([...ui['tools-list'].querySelectorAll('input')].map((input) => [input.value, input.checked]));
  ui['tools-list'].replaceChildren(...(state.tools || []).map((tool) => {
    const label = element('label', 'tool-label');
    const check = element('input'); check.type = 'checkbox'; check.value = tool.name; check.checked = checked.has(tool.name) ? checked.get(tool.name) : !!tool.active;
    const text = element('span', '', tool.name);
    if (tool.description) text.append(element('small', '', tool.description));
    label.append(check, text); return label;
  }));
  ui['tools-save'].disabled = !(state.tools || []).length;
  renderTree();
  const sessionControl = state.capabilities?.sessionControl === true;
  for (const id of ['session-new', 'sessions-load']) ui[id].disabled = !sessionControl;
}
function renderTree() {
  const tree = state.tree || [];
  const parents = new Map(tree.map(entry => [entry.id, entry.parentId]));
  ui['tree-list'].replaceChildren(...tree.map((entry) => {
    const row = element('div', 'selection-row'); row.dataset.current = String(entry.id === state.session?.leafId);
    let depth = 0, parent = entry.parentId; const visited = new Set([entry.id]);
    while (parent && parents.has(parent) && !visited.has(parent)) { visited.add(parent); depth++; parent = parents.get(parent); }
    row.style.marginLeft = `${Math.min(depth, 8) * 10}px`; row.title = `Tree depth ${depth}`;
    const label = element('span', '', entry.label || entry.text?.slice(0, 140) || entry.type || entry.id);
    label.append(element('small', '', `${entry.type || 'entry'} · ${String(entry.id).slice(0, 12)}`));
    row.append(label);
    for (const [text, method] of [['Go', 'navigateTree'], ['Fork', 'fork']]) {
      const button = element('button', '', text); button.type = 'button'; button.disabled = state.capabilities?.sessionControl !== true || (method === 'fork' && entry.role !== 'user');
      button.setAttribute('aria-label', `${text}: ${entry.label || entry.type || entry.id}`);
      button.addEventListener('click', () => {
        if (confirm(`${text === 'Fork' ? 'Fork the session from' : 'Navigate to'} this entry? Unsaved surface state may be lost.`)) void controlAction(button, method, { entryId: entry.id });
      });
      row.append(button);
    }
    return row;
  }));
  if (!tree.length) ui['tree-list'].append(element('p', 'help', 'No navigable entries yet.'));
}
ui['controls-open'].addEventListener('click', () => { renderControls(); ui.controls.showModal(); void loadSurfaceConnection(); });
ui['controls-close'].addEventListener('click', () => ui.controls.close());
ui['surface-refresh'].addEventListener('click', () => { void loadSurfaceConnection(false, ui['surface-refresh'], 'start'); });
ui['surface-qr-toggle'].addEventListener('click', async () => {
  if (surfaceQrVisible) { surfaceQrVisible = false; renderSurfaceConnection(); }
  else await loadSurfaceConnection(true, ui['surface-qr-toggle']);
});
ui['surface-copy'].addEventListener('click', () => { void copyConnectionUrl(); });
ui['surface-open-here'].addEventListener('click', () => { if (surfaceConnectionInfo?.preferredUrl) window.open(surfaceConnectionInfo.preferredUrl, '_blank', 'noopener,noreferrer'); });
ui['surface-open-host'].addEventListener('click', () => { void controlAction(ui['surface-open-host'], 'surfaceCommand', { action: 'open' }, 'Browser requested on the Pi host.'); });
ui['surface-hide-terminal'].addEventListener('click', () => { void controlAction(ui['surface-hide-terminal'], 'surfaceCommand', { action: 'hide' }, 'Terminal QR cleared.'); });
ui['surface-stop'].addEventListener('click', () => {
  if (confirm('Stop Pi Surface? This page will disconnect. Restart it from the terminal with /surface start.')) void controlAction(ui['surface-stop'], 'surfaceCommand', { action: 'stop' }, 'Pi Surface is stopping.');
});
ui['rename-form'].addEventListener('submit', (event) => { event.preventDefault(); void controlAction(event.submitter, 'renameSession', { name: ui['rename-input'].value.trim() }); });
ui['model-select'].addEventListener('change', async () => {
  const model = state?.models?.[Number(ui['model-select'].value)];
  if (ui['model-select'].value && model) await controlAction(ui['model-select'], 'setModel', { provider: model.provider, id: model.id });
});
ui['thinking-select'].addEventListener('change', () => { void controlAction(ui['thinking-select'], 'setThinkingLevel', { level: ui['thinking-select'].value }); });
ui['composer-model-select'].addEventListener('change', async () => {
  const model = state?.models?.[Number(ui['composer-model-select'].value)];
  if (!model) return;
  ui['composer-model-select'].disabled = true;
  try { await invoke('setModel', { provider: model.provider, id: model.id }); queueRefresh(); }
  catch (error) { showNotice(`Model not changed. ${error.message}`); renderComposerControls(); }
  finally { updateComposer(); }
});
ui['composer-thinking-select'].addEventListener('change', async () => {
  ui['composer-thinking-select'].disabled = true;
  try { await invoke('setThinkingLevel', { level: ui['composer-thinking-select'].value }); queueRefresh(); }
  catch (error) { showNotice(`Reasoning effort not changed. ${error.message}`); renderComposerControls(); }
  finally { updateComposer(); }
});
ui['command-select'].addEventListener('change', () => {
  ui['command-description'].textContent = state?.commands?.find((command) => command.name === ui['command-select'].value)?.description || 'Only commands exposed by this session are available.';
});
ui['command-form'].addEventListener('submit', (event) => {
  event.preventDefault(); const name = ui['command-select'].value;
  if (!state?.commands?.some((command) => command.name === name)) { controlNotice('Choose an available command.', true); return; }
  void controlAction(event.submitter, 'command', { name, args: ui['command-args'].value }, 'Command sent to Pi.');
});
ui['sessions-load'].addEventListener('click', async () => {
  const sessions = await controlAction(ui['sessions-load'], 'listSessions', {}, 'Choose a session below.');
  if (!Array.isArray(sessions)) return;
  ui['session-list'].replaceChildren(...sessions.map((session) => {
    const row = element('div', 'selection-row');
    const label = element('span', '', session.name || session.id || 'Untitled session');
    label.append(element('small', '', session.path || ''));
    const button = element('button', '', 'Switch'); button.disabled = !session.path || session.id === state.session?.id;
    button.addEventListener('click', () => {
      if (confirm('Switch the terminal session? Then run /surface in Pi and open its new URL.')) void controlAction(button, 'switchSession', { path: session.path }, 'Session switch requested. Run /surface in Pi for the new URL.');
    });
    row.append(label, button); return row;
  }));
  if (!sessions.length) ui['session-list'].append(element('p', 'help', 'No saved sessions found.'));
});
ui['session-new'].addEventListener('click', () => {
  if (confirm('Start a new terminal session? Then run /surface in Pi and open its new URL.')) void controlAction(ui['session-new'], 'newSession', {}, 'New session requested. Run /surface in Pi for its URL.');
});
ui['tools-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const names = [...ui['tools-list'].querySelectorAll('input:checked')].map((input) => input.value);
  void controlAction(event.submitter, 'setActiveTools', { names });
});
ui['compact-form'].addEventListener('submit', (event) => { event.preventDefault(); void controlAction(event.submitter, 'compact', { instructions: ui['compact-input'].value }, 'Context compaction requested.'); });
window.addEventListener('pagehide', () => { stream?.close(); clearTimeout(reconnectTimer); clearTimeout(refreshTimer); clearInterval(faviconTimer); faviconStatus = ''; });
window.addEventListener('pageshow', (event) => { if (event.persisted && !stopped) { void refresh().catch((error) => showNotice(error.message)); connect(); } });
updateComposer();
try { await refresh(); if (!stopped) connect(); }
catch (error) { if (!stopped) closeConnection(`Cannot connect to Pi: ${error.message}`); }

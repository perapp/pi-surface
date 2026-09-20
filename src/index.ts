import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { Type } from 'typebox';
import { StringEnum, type TextContent, type ImageContent } from '@earendil-works/pi-ai';
import { CONFIG_DIR_NAME, getAgentDir, SessionManager, truncateHead, type ExtensionAPI, type ExtensionContext, type MessageStartEvent, type MessageUpdateEvent, type MessageEndEvent } from '@earendil-works/pi-coding-agent';
import { HttpError, SurfaceServer, type SurfaceServerHandoff } from './server.ts';

function text(params: Record<string, unknown>, key: string, max = 100_000): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `Invalid ${key}`);
  return value;
}
const modelInfo = (model: { id: string; name: string; provider: string }) => ({ id: model.id, name: model.name, provider: model.provider });

type HandoffEntry = { handoff: SurfaceServerHandoff; timer: ReturnType<typeof setTimeout> };
const serverHandoffsSymbol = Symbol.for('pi-surface.server-handoffs.v2');
function serverHandoffs(): Map<string, HandoffEntry> {
  const shared = globalThis as typeof globalThis & { [serverHandoffsSymbol]?: Map<string, HandoffEntry> };
  return shared[serverHandoffsSymbol] ??= new Map();
}
function handoffKey(reason: string, current: ExtensionContext, previousSessionFile?: string) {
  if (reason === 'reload') return `reload\0${current.sessionManager.getSessionId()}\0${current.cwd}`;
  const oldSessionFile = previousSessionFile ?? current.sessionManager.getSessionFile();
  return `replacement\0${reason}\0${oldSessionFile ?? current.cwd}`;
}
function removeHandoffFiles(handoff: SurfaceServerHandoff) {
  if (handoff.directory) void rm(handoff.directory, { recursive: true, force: true });
}
function stashHandoff(reason: string, current: ExtensionContext, handoff: SurfaceServerHandoff) {
  const entries = serverHandoffs();
  const key = handoffKey(reason, current);
  const previous = entries.get(key);
  if (previous) { clearTimeout(previous.timer); removeHandoffFiles(previous.handoff); }
  const timer = setTimeout(() => {
    if (entries.get(key)?.handoff !== handoff) return;
    entries.delete(key); removeHandoffFiles(handoff);
  }, 30_000);
  timer.unref();
  entries.set(key, { handoff, timer });
}
function takeHandoff(reason: string, current: ExtensionContext, previousSessionFile?: string): SurfaceServerHandoff | undefined {
  const entries = serverHandoffs();
  const key = handoffKey(reason, current, previousSessionFile);
  const entry = entries.get(key);
  if (!entry) return;
  clearTimeout(entry.timer); entries.delete(key);
  return entry.handoff;
}

/** No SDK session is created: every action below targets the extension's live session. */
export default function surfaceExtension(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let server: SurfaceServer | undefined;
  let starting: Promise<void> | undefined;
  let activeMessage: unknown;
  let lastUiPrompt: unknown;
  const controlCommand = `surface-control-${randomBytes(6).toString('hex')}`;
  const controls = new Map<string, { method: string; params: Record<string, unknown> }>();
  let controlTimer: ReturnType<typeof setTimeout> | undefined;

  pi.registerFlag('surface-host', { description: 'Pi Surface bind IP (default 0.0.0.0)', type: 'string' });
  pi.registerFlag('surface-port', { description: 'Pi Surface port (default 0: OS-assigned)', type: 'string' });
  pi.registerFlag('surface-disabled', { description: 'Disable automatic Pi Surface startup', type: 'boolean', default: false });

  const ctx = () => {
    if (!context) throw new HttpError(503, 'Pi session is not ready');
    return context;
  };
  const runtime = () => {
    if (!server) throw new HttpError(503, 'Pi Surface is not running');
    return server;
  };
  const idle = () => {
    if (!ctx().isIdle() || ctx().hasPendingMessages()) throw new HttpError(409, 'Pi is busy; abort or wait for it to finish');
  };
  const publishState = () => server?.publish({ type: 'state_changed' });

  function state() {
    const current = ctx();
    const sm = current.sessionManager;
    const entries = sm.getEntries();
    const messages = sm.getBranch().flatMap<Record<string, unknown>>(entry => {
      if (entry.type === 'message') return [{ ...entry.message, id: entry.id }];
      if (entry.type === 'custom_message' && entry.display) return [{ id: entry.id, role: 'custom', content: entry.content }];
      return [];
    });
    return {
      session: {
        id: sm.getSessionId(), name: pi.getSessionName() ?? 'Untitled session', cwd: current.cwd,
        leafId: sm.getLeafId(), model: current.model ? modelInfo(current.model) : undefined,
        thinkingLevel: pi.getThinkingLevel(), idle: current.isIdle(), pending: current.hasPendingMessages(), contextUsage: current.getContextUsage(),
      },
      messages, activeMessage, uiPrompt: lastUiPrompt,
      models: (current.scopedModels.length ? current.scopedModels.map(item => item.model) : current.modelRegistry.getAvailable()).map(modelInfo),
      commands: pi.getCommands().filter(command => command.name !== controlCommand).map(({ name, description, source }) => ({ name, description, source })),
      tools: pi.getAllTools().map(({ name, description }) => ({ name, description, active: pi.getActiveTools().includes(name) })),
      tree: entries.map(entry => ({
        id: entry.id, parentId: entry.parentId, type: entry.type, label: sm.getLabel(entry.id), role: entry.type === 'message' ? entry.message.role : undefined,
        text: entry.type === 'message' ? `${entry.message.role}: ${messageText(entry.message).slice(0, 160)}` : entry.type,
      })),
      capabilities: { sessionControl: true, surfaceControl: true, terminalDialogs: true },
    };
  }

  async function invoke(method: string, params: Record<string, unknown>): Promise<unknown> {
    const current = ctx();
    switch (method) {
      case 'prompt': case 'steer': case 'followUp': {
        if (method === 'prompt') idle();
        if (params.surfaceId !== undefined) runtime().store.get(text(params, 'surfaceId', 200));
        const files = runtime().attachmentIds(params.attachments);
        const content: (TextContent | ImageContent)[] = [];
        const userText = typeof params.text === 'string' ? params.text : '';
        if (userText.length > 100_000 || (!userText.trim() && !files.length)) throw new HttpError(400, 'Enter a message or attach a file');
        const origin = params.surfaceId ? `surface ${params.surfaceId}` : 'web';
        content.push({ type: 'text', text: `[via ${origin}]\n${userText}${files.length ? '\n\nAttachments (private temporary files; read or copy before this session closes):\n' + files.map(file => `${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join('\n') : ''}` });
        for (const file of files) {
          if (file.mimeType.startsWith('image/')) content.push({ type: 'image', data: (await readFile(file.path)).toString('base64'), mimeType: file.mimeType });
        }
        // Always specify delivery mode to avoid an idle→busy race during attachment I/O.
        pi.sendUserMessage(content, { deliverAs: method === 'steer' ? 'steer' : 'followUp' });
        files.forEach(file => { file.used = true; });
        return { accepted: true };
      }
      case 'surfaceAction': {
        const surfaceId = text(params, 'surfaceId', 200);
        runtime().store.get(surfaceId);
        const action = text(params, 'action', 200);
        // Keep the runtime-qualified ID in the action envelope. Application data can be
        // regenerated by a model and may contain an old slug or scope, so it is not an
        // authoritative return address for surface events.
        return invoke('followUp', { surfaceId, text: `Surface action:\n${JSON.stringify({ surfaceId, action, target: params.target, data: params.data })}` });
      }
      case 'surfaceCommand': {
        const action = text(params, 'action', 20);
        if (!['qr', 'open', 'status', 'hide', 'stop', 'start'].includes(action)) throw new HttpError(400, 'Unknown surface command');
        if (action === 'hide') {
          if (current.hasUI) current.ui.setWidget('pi-surface', undefined);
          return { hidden: true, note: 'Terminal QR widget cleared.' };
        }
        if (action === 'open') {
          const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [preferredUrl()], { detached: true, stdio: 'ignore' });
          child.on('error', error => server?.publish({ type: 'surface_error', message: `Could not open browser: ${error.message}` }));
          child.unref();
          return { ...(await connectionInfo(false)), note: 'Requested a browser on the Pi host.' };
        }
        if (action === 'stop') {
          const timer = setTimeout(() => { void stop('stopped from browser settings'); }, 100);
          timer.unref();
          return { accepted: true, note: 'Pi Surface is stopping. Restart it with /surface start in the terminal.' };
        }
        return connectionInfo(action === 'qr');
      }
      case 'abort': current.abort(); return { accepted: true };
      case 'setModel': {
        idle();
        const model = current.modelRegistry.find(text(params, 'provider', 200), text(params, 'id', 300));
        if (!model) throw new HttpError(400, 'Unknown model');
        if (!await pi.setModel(model)) throw new HttpError(400, 'Model authentication is not configured');
        publishState(); return { model: modelInfo(model) };
      }
      case 'setThinkingLevel': {
        idle(); const level = text(params, 'level', 20);
        if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) throw new HttpError(400, 'Invalid thinking level');
        pi.setThinkingLevel(level as ReturnType<ExtensionAPI['getThinkingLevel']>); publishState(); return {};
      }
      case 'renameSession': pi.setSessionName(text(params, 'name', 200)); publishState(); return {};
      case 'setActiveTools': {
        idle(); const names = params.names;
        const known = new Set(pi.getAllTools().map(tool => tool.name));
        if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !known.has(name))) throw new HttpError(400, 'Unknown tool');
        pi.setActiveTools(names); publishState(); return {};
      }
      case 'compact':
        idle();
        current.compact({ customInstructions: typeof params.instructions === 'string' ? params.instructions : undefined,
          onComplete: publishState, onError: error => server?.publish({ type: 'surface_error', message: error.message }) });
        return { accepted: true };
      case 'command': {
        idle(); const name = text(params, 'name', 200);
        if (name === controlCommand || !pi.getCommands().some(command => command.name === name)) throw new HttpError(400, 'Unknown command; built-in TUI commands need dedicated controls');
        const args = params.args ?? '';
        if (typeof args !== 'string' || args.length > 100_000) throw new HttpError(400, 'Invalid command arguments');
        pi.sendUserMessage(`/${name}${args ? ` ${args}` : ''}`, { expandPromptTemplates: true, deliverAs: 'followUp' });
        return { accepted: true, note: 'Commands that open terminal dialogs still require the TUI.' };
      }
      case 'listSessions':
        return (await SessionManager.list(current.cwd, current.sessionManager.getSessionDir())).map(({ id, path, name, firstMessage, modified, messageCount }) => ({ id, path, name: name || firstMessage.slice(0, 100), modified, messageCount }));
      case 'newSession': case 'switchSession': case 'fork': case 'navigateTree': case 'reload': {
        idle();
        if (controls.size) throw new HttpError(409, 'A session operation is already pending');
        if (method === 'switchSession') {
          const path = text(params, 'path', 4096);
          if (!(await SessionManager.list(current.cwd, current.sessionManager.getSessionDir())).some(item => item.path === path)) throw new HttpError(400, 'Choose a session from listSessions');
        }
        if (method === 'fork' || method === 'navigateTree') {
          const entry = current.sessionManager.getEntry(text(params, 'entryId', 200));
          if (!entry) throw new HttpError(400, 'Unknown tree entry');
          if (method === 'fork' && (entry.type !== 'message' || entry.message.role !== 'user')) throw new HttpError(400, 'Fork from a user message');
        }
        const requestId = randomBytes(16).toString('hex');
        controls.set(requestId, { method, params });
        // Send the HTTP acknowledgement before Pi tears down this extension/server.
        controlTimer = setTimeout(() => {
          try { pi.sendUserMessage(`/${controlCommand} ${requestId}`, { expandPromptTemplates: true, deliverAs: 'followUp' }); }
          catch (error) { controls.delete(requestId); server?.publish({ type: 'surface_error', message: String(error) }); }
        }, 30);
        return { accepted: true, note: 'Reconnecting this surface automatically after the session operation.' };
      }
      default: throw new HttpError(400, `Unsupported method: ${method}`);
    }
  }

  // Command context is the supported API for session mutations; event contexts cannot do this.
  pi.registerCommand(controlCommand, {
    description: 'Internal authenticated Pi Surface session operation',
    handler: async (args, commandCtx) => {
      const request = controls.get(args.trim());
      if (!request) return; // Never interpret arbitrary text as control instructions.
      controls.delete(args.trim());
      try {
        await commandCtx.waitForIdle();
        let result: { cancelled: boolean } | undefined;
        switch (request.method) {
          case 'newSession': result = await commandCtx.newSession(); break;
          case 'switchSession': result = await commandCtx.switchSession(request.params.path as string); break;
          case 'fork': result = await commandCtx.fork(request.params.entryId as string); break;
          case 'navigateTree': result = await commandCtx.navigateTree(request.params.entryId as string); break;
          case 'reload': await commandCtx.reload(); return;
        }
        // After replacement, do not access old Pi or context. This closure is already retired.
        if (result?.cancelled) server?.publish({ type: 'surface_error', message: 'Session operation cancelled in Pi' });
        else if (request.method === 'navigateTree') publishState();
      } catch (error) { server?.publish({ type: 'surface_error', message: String(error) }); }
    },
  });

  async function start(current: ExtensionContext, announceStart = true, handoff?: SurfaceServerHandoff) {
    if (server) return;
    if (starting) return starting;
    starting = (async () => {
      context = current;
      const config: Record<string, unknown> = {};
      const configPaths = [join(getAgentDir(), 'surface.json'), ...(current.isProjectTrusted() ? [join(current.cwd, CONFIG_DIR_NAME, 'surface.json')] : [])];
      for (const path of configPaths) {
        try {
          const value = JSON.parse(await readFile(path, 'utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid config: ${path}`);
          Object.assign(config, value);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const host = pi.getFlag('surface-host') ?? config.host ?? '0.0.0.0';
      const port = Number(pi.getFlag('surface-port') ?? config.port ?? 0);
      if (typeof host !== 'string' || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Pi Surface host or port');
      const candidate = new SurfaceServer({
        cwd: current.cwd, globalRoot: join(getAgentDir(), 'surfaces'), projectRoot: join(current.cwd, CONFIG_DIR_NAME, 'agent', 'surfaces'),
        trusted: current.isProjectTrusted(), host, port, state, invoke,
      }, handoff);
      await candidate.start(); server = candidate;
      if (current.hasUI) current.ui.setStatus('pi-surface', `surface :${candidate.port}`);
      if (announceStart && (!handoff || !candidate.continuedOrigin)) await announce(current, false);
    })();
    try { await starting; } finally { starting = undefined; }
  }

  function preferredUrl() {
    const urls = runtime().urls;
    return urls.find(url => !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(url).hostname)) ?? urls[0];
  }

  async function connectionInfo(includeQr: boolean) {
    const running = runtime();
    const url = preferredUrl();
    const result: Record<string, unknown> = { running: true, port: running.port, preferredUrl: url, urls: running.urls };
    if (includeQr) {
      const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'L', margin: 2, width: 320 });
      result.qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }
    return result;
  }

  async function announce(current: ExtensionContext, qr: boolean, allAddresses = false) {
    if (!current.hasUI) return;
    const url = preferredUrl();
    const addresses = allAddresses ? runtime().urls : [url];
    let message = `Pi Surface\n${addresses.join('\n')}\nToken grants control of this Pi session. HTTP: trusted networks only.`;
    if (current.mode === 'tui' && qr) {
      const code = await QRCode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
      message += `\n\n${code}\nScan to control this session.`;
    }
    // A one-off transcript notification, not a widget pinned beside every prompt.
    // Also clear a QR widget left by older versions of the extension.
    current.ui.setWidget('pi-surface', undefined);
    current.ui.notify(message, 'info');
  }

  pi.registerCommand('surface', {
    description: 'Web surface: qr, open, status, hide, stop, start',
    handler: async (args, current) => {
      const command = args.trim() || 'qr';
      if (command === 'stop') { await stop('stopped'); return; }
      if (command === 'hide') { current.ui.setWidget('pi-surface', undefined); return; }
      if (!['qr', 'open', 'status', 'start'].includes(command)) { current.ui.notify('Usage: /surface [qr|open|status|hide|stop|start]', 'warning'); return; }
      try {
        await start(current, false);
        if (command === 'open') {
          const url = preferredUrl();
          const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
          child.on('error', error => current.ui.notify(`Could not open browser: ${error.message}`, 'error')); child.unref();
        } else await announce(current, command === 'qr', command === 'status');
      } catch (error) { current.ui.notify(String(error), 'error'); }
    },
  });

  async function stop(reason: string) {
    clearTimeout(controlTimer); controls.clear();
    const previous = server; server = undefined;
    await previous?.close(reason);
    if (context?.hasUI) { context.ui.setWidget('pi-surface', undefined); context.ui.setStatus('pi-surface', undefined); }
  }

  pi.on('session_start', async (event, current) => {
    context = current; activeMessage = undefined; lastUiPrompt = undefined;
    const handoff = ['reload', 'new', 'resume', 'fork'].includes(event.reason)
      ? takeHandoff(event.reason, current, event.previousSessionFile)
      : undefined;
    if (handoff || (current.mode === 'tui' && !pi.getFlag('surface-disabled'))) {
      try { await start(current, true, handoff); } catch (error) { current.ui.notify(`Pi Surface: ${String(error)}`, 'error'); }
    }
  });
  pi.on('session_shutdown', async (event, current) => {
    clearTimeout(controlTimer); controls.clear();
    if (['reload', 'new', 'resume', 'fork'].includes(event.reason) && server) {
      const previous = server; server = undefined;
      stashHandoff(event.reason, current, await previous.preserveForRestart(event.reason));
    } else await stop(event.reason);
    context = undefined;
  });
  const changed = (_event: unknown, current: ExtensionContext) => { context = current; publishState(); };
  pi.on('agent_start', changed);
  pi.on('agent_end', changed);
  pi.on('agent_settled', changed);
  pi.on('session_info_changed', changed);
  pi.on('session_tree', changed);
  pi.on('model_select', changed);
  pi.on('thinking_level_select', changed);
  pi.on('session_compact', changed);
  pi.on('session_compact_failed', changed);
  const messageEvent = (event: MessageStartEvent | MessageUpdateEvent | MessageEndEvent, current: ExtensionContext) => {
    context = current;
    if (event.message.role === 'assistant') activeMessage = event.type === 'message_end' ? undefined : event.message;
    server?.publish({ ...event });
  };
  pi.on('message_start', messageEvent);
  pi.on('message_update', messageEvent);
  pi.on('message_end', messageEvent);
  const activityEvent = (event: { type: string }, current: ExtensionContext) => {
    context = current;
    if (event.type === 'ui_prompt_start') lastUiPrompt = event;
    if (event.type === 'ui_prompt_end') lastUiPrompt = undefined;
    server?.publish({ ...event });
  };
  pi.on('tool_execution_start', activityEvent);
  pi.on('tool_execution_update', activityEvent);
  pi.on('tool_execution_end', activityEvent);
  pi.on('ui_prompt_start', activityEvent);
  pi.on('ui_prompt_end', activityEvent);

  pi.registerTool({
    name: 'surface', label: 'Surface',
    description: 'Create/open interactive web surfaces connected to this Pi session. Actions: list, create (temporary HTML), open, promote (save to project/global), emit (push data to a live surface). Never returns auth tokens. Tool text limited to 50KB/2000 lines. Edit the returned directory with normal file tools for hot reload.',
    promptSnippet: 'Create and update reactive browser applications for this Pi session',
    promptGuidelines: ['Use surface to display interactive reports or applications; load the pi-surface skill for the browser API, and load the report-surface skill for an Adaptive Report Surface with inference-driven reading level, reading time, and section expansion. Declare mutable file dependencies in watch (paths relative to cwd); updates must not require inference. Preserve normal write-authorization rules when creating or promoting surfaces.'],
    parameters: Type.Object({
      action: StringEnum(['list', 'create', 'open', 'promote', 'emit'] as const),
      id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), html: Type.Optional(Type.String()),
      watch: Type.Optional(Type.Array(Type.String())), default: Type.Optional(Type.Boolean()),
      scope: Type.Optional(StringEnum(['project', 'global'] as const)), event: Type.Optional(Type.String()), data: Type.Optional(Type.Unknown()),
    }),
    async execute(_id, params, signal, _update, current) {
      signal?.throwIfAborted(); await start(current); const running = runtime();
      let result: unknown;
      switch (params.action) {
        case 'list': result = running.store.list(); break;
        case 'create':
          if (!params.id || !params.name || !params.html) throw new Error('create requires id (slug), name and html');
          result = await running.store.create({ id: params.id, name: params.name, html: params.html, watch: params.watch, default: params.default });
          running.publish({ type: 'surface_open', surfaceId: (result as { id: string }).id }); break;
        case 'open':
          if (!params.id) throw new Error('open requires id');
          result = running.store.get(params.id); running.publish({ type: 'surface_open', surfaceId: params.id }); break;
        case 'promote':
          if (!params.id || !params.scope) throw new Error('promote requires id and scope');
          result = await running.store.promote(params.id, params.scope); break;
        case 'emit':
          if (!params.id || !params.event) throw new Error('emit requires id and event');
          running.store.get(params.id);
          running.publish({ type: 'surface_event', surfaceId: params.id, event: params.event, data: params.data }); result = { sent: true }; break;
      }
      const truncated = truncateHead(JSON.stringify(result, null, 2));
      return { content: [{ type: 'text', text: truncated.content + (truncated.truncated ? '\n[Truncated; narrow the requested surface.]' : '') }], details: {} };
    },
  });
}

function messageText(value: unknown): string {
  const message = value as { content?: unknown };
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  return '';
}

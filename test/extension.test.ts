import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import surfaceExtension from '../src/index.ts';
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

type Handler = (event: any, ctx: any) => unknown;
async function fixture(options: { mode?: 'tui' | 'rpc'; host?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-surface-extension-test-'));
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler; description: string }>();
  const tools = new Map<string, any>();
  const sent: { content: any; options: any }[] = [];
  const notices: string[] = [];
  const widgets: unknown[] = [];
  const sessionActions: string[] = [];
  let busy = false, aborted = false;
  let name = 'Test session'; let thinking = 'medium'; let active = ['read'];
  const model = { id: 'mock-model', provider: 'mock', name: 'Mock model' };
  const sm = SessionManager.inMemory(root);
  sm.appendMessage({ role: 'user', content: 'hello from terminal', timestamp: Date.now() });
  const api = {
    on: (name: string, handler: Handler) => events.set(name, [...events.get(name) ?? [], handler]),
    registerCommand: (name: string, options: any) => commands.set(name, options), registerFlag: () => {}, registerTool: (options: any) => tools.set(options.name, options),
    getFlag: (flag: string) => flag === 'surface-host' ? options.host ?? '127.0.0.1' : undefined,
    getSessionName: () => name, setSessionName: (next: string) => { name = next; },
    getThinkingLevel: () => thinking, setThinkingLevel: (next: string) => { thinking = next; },
    getCommands: () => [...commands.entries()].map(([name, value]) => ({ name, description: value.description, source: 'extension' })),
    getAllTools: () => [{ name: 'read', description: 'Read' }, { name: 'write', description: 'Write' }],
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    setModel: async () => true,
    sendUserMessage: (content: any, options: any) => {
      sent.push({ content, options });
      if (typeof content === 'string' && options?.expandPromptTemplates) {
        const [name, ...args] = content.slice(1).split(' ');
        const command = commands.get(name);
        if (command) void command.handler(args.join(' '), context);
      }
    },
  } as unknown as ExtensionAPI;
  const context = {
    cwd: root, mode: options.mode ?? 'rpc', hasUI: true, isProjectTrusted: () => false,
    isIdle: () => !busy, abort: () => { aborted = true; busy = false; }, hasPendingMessages: () => false,
    sessionManager: sm, model, modelRegistry: { getAvailable: () => [model], find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined }, scopedModels: [],
    getContextUsage: () => ({ tokens: 100, contextWindow: 10000, percent: 1 }),
    compact: (compactOptions: any) => { sessionActions.push(`compact:${compactOptions.customInstructions ?? ''}`); compactOptions.onComplete?.(); }, waitForIdle: async () => {},
    newSession: async () => { sessionActions.push('newSession'); return { cancelled: true }; },
    fork: async (id: string) => { sessionActions.push(`fork:${id}`); return { cancelled: true }; },
    navigateTree: async (id: string) => { sessionActions.push(`navigateTree:${id}`); return { cancelled: false }; },
    reload: async () => { sessionActions.push('reload'); },
    ui: { notify: (text: string) => notices.push(text), setStatus: () => {}, setWidget: (_key: string, value: unknown) => widgets.push(value) },
  } as unknown as ExtensionCommandContext;
  commands.set('demo', { description: 'A test command', handler: () => {} });
  surfaceExtension(api);
  const emit = async (name: string, event: unknown = { type: name }) => {
    for (const handler of events.get(name) ?? []) await handler(event, context);
  };
  await emit('session_start');
  if (context.mode === 'rpc') {
    assert.equal(notices.length, 0, 'RPC does not start a network listener automatically');
    await commands.get('surface')!.handler('start', context);
  }
  const url = notices.join('\n').match(/http:\/\/[^\s]+/)![0];
  const authUrl = new URL(url); authUrl.hostname = '127.0.0.1';
  const base = authUrl.origin;
  const auth = await fetch(authUrl, { redirect: 'manual' }); const cookie = auth.headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'x-pi-surface': '1', 'content-type': 'application/json' };
  const invoke = async (method: string, params: object = {}) => {
    const response = await fetch(base + '/api/invoke', { method: 'POST', headers, body: JSON.stringify({ method, params }) });
    return { status: response.status, ...(await response.json()) };
  };
  const createSurface = async (id: string) => {
    await tools.get('surface')!.execute('test', { action: 'create', id, name: 'Test surface', html: '<p>test</p>' }, new AbortController().signal, () => {}, context);
    return `temporary:${id}`;
  };
  return { invoke, emit, sent, headers, base, sessionActions, sm, notices, widgets, url, createSurface, command: (args: string) => commands.get('surface')!.handler(args, context), setBusy: (value: boolean) => { busy = value; }, aborted: () => aborted,
    cleanup: async () => { await emit('session_shutdown', { reason: 'quit' }); await rm(root, { recursive: true, force: true }); } };
}

test('adapter uses same session, native user messages, busy delivery, validation and abort', async () => {
  const f = await fixture();
  try {
    const state = (await f.invoke('getState')).result;
    assert.equal(state.session.id, f.sm.getSessionId());
    assert.match(state.messages[0].content, /hello from terminal/);
    assert.ok(!state.commands.some((command: any) => command.name.startsWith('surface-control-')));
    assert.deepEqual(state.commands.filter((command: any) => command.source === 'builtin').map((command: any) => command.name), ['new', 'compact', 'reload']);
    assert.equal((await f.invoke('prompt', { text: 'hello from phone' })).ok, true);
    assert.match(f.sent.at(-1)!.content[0].text, /^\[via web\]\nhello from phone/);
    f.setBusy(true);
    assert.equal((await f.invoke('prompt', { text: 'busy' })).status, 409);
    assert.equal((await f.invoke('steer', { text: 'change focus' })).ok, true);
    assert.equal(f.sent.at(-1)!.options.deliverAs, 'steer');
    await f.invoke('followUp', { text: 'then summarize' });
    assert.equal(f.sent.at(-1)!.options.deliverAs, 'followUp');
    assert.equal((await f.invoke('newSession')).status, 409);
    await f.invoke('abort'); assert.equal(f.aborted(), true);
    assert.equal((await f.invoke('setModel', { provider: 'missing', id: 'missing' })).status, 400);
    assert.equal((await f.invoke('setThinkingLevel', { level: 'extreme' })).status, 400);
    await f.invoke('setThinkingLevel', { level: 'high' });
    await f.invoke('renameSession', { name: 'Renamed from phone' });
    await f.invoke('setActiveTools', { names: ['read', 'write'] });
    const updated = (await f.invoke('getState')).result;
    assert.equal(updated.session.name, 'Renamed from phone'); assert.equal(updated.session.thinkingLevel, 'high');
    assert.equal(updated.tools.filter((tool: any) => tool.active).length, 2);
    assert.equal((await f.invoke('setActiveTools', { names: ['exec-anything'] })).status, 400);
    assert.equal((await f.invoke('command', { name: 'demo', args: 'src/index.ts' })).ok, true);
    assert.equal(f.sent.at(-1)!.content, '/demo src/index.ts');
    assert.equal(f.sent.at(-1)!.options.expandPromptTemplates, true);
    assert.equal((await f.invoke('command', { name: 'settings' })).status, 400);
    assert.equal((await f.invoke('eval', { code: 'bad' })).status, 400);
  } finally { await f.cleanup(); }
});

test('surface actions expose the canonical qualified ID for response events', async () => {
  const f = await fixture();
  try {
    const surfaceId = await f.createSurface('adaptive-report');
    for (const [name, target, responseEvent] of [
      ['adaptive-report-regenerate', 'report', 'adaptive-report-replaced'],
      ['adaptive-report-expand', 'section-1', 'adaptive-report-expanded'],
    ]) {
      const response = await f.invoke('surfaceAction', {
        surfaceId,
        action: name,
        target,
        data: { protocol: 'adaptive-report/v1', surfaceId: 'adaptive-report', requestId: `request-${name}`, responseEvent },
      });
      assert.equal(response.ok, true);
      const delivered = f.sent.at(-1)!.content[0].text as string;
      const action = JSON.parse(delivered.slice(delivered.indexOf('Surface action:\n') + 'Surface action:\n'.length));
      assert.equal(action.surfaceId, 'temporary:adaptive-report');
      assert.equal(action.action, name);
      assert.equal(action.target, target);
      assert.equal(action.data.surfaceId, 'adaptive-report', 'application state is preserved but is not the return address');
    }
    assert.equal((await f.invoke('surfaceAction', { surfaceId: 'adaptive-report', action: 'adaptive-report-expand' })).ok, false);
  } finally { await f.cleanup(); }
});

test('browser settings expose authenticated surface status and QR controls', async () => {
  const f = await fixture();
  try {
    const status = await f.invoke('surfaceCommand', { action: 'status' });
    assert.equal(status.ok, true);
    assert.equal(status.result.running, true);
    assert.match(status.result.preferredUrl, /\?token=/);
    assert.ok(status.result.urls.includes(status.result.preferredUrl));
    const qr = await f.invoke('surfaceCommand', { action: 'qr' });
    assert.match(qr.result.qrDataUrl, /^data:image\/svg\+xml;base64,/);
    assert.equal((await f.invoke('surfaceCommand', { action: 'start' })).ok, true);
    assert.equal((await f.invoke('surfaceCommand', { action: 'hide' })).ok, true);
    assert.equal((await f.invoke('surfaceCommand', { action: 'invalid' })).status, 400);
  } finally { await f.cleanup(); }
});

test('native images and file references reach the same user message', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.base + '/api/upload', { method: 'POST', headers: { ...f.headers, 'x-file-name': 'picture.png' }, body: Buffer.from([137,80,78,71,13,10,26,10]) });
    const file = await response.json();
    assert.equal((await f.invoke('followUp', { text: 'describe', attachments: [file.id] })).ok, true);
    const message = f.sent.at(-1)!.content;
    assert.equal(message[1].type, 'image'); assert.equal(message[1].mimeType, 'image/png');
    assert.match(message[0].text, /picture\.png/);
    assert.equal((await fetch(f.base + '/api/upload/' + file.id, { method: 'DELETE', headers: f.headers })).status, 409);
    assert.equal((await f.invoke('prompt', { text: 'read', attachments: ['/etc/passwd'] })).status, 400);
  } finally { await f.cleanup(); }
});

test('session operations are acknowledged then dispatched through a real command handler', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.invoke('fork', { entryId: 'missing' })).status, 400);
    assert.equal((await f.invoke('navigateTree', { entryId: f.sm.getLeafId() })).ok, true);
    // bounded event-loop wait for the intentionally delayed command dispatch
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(f.sessionActions.includes('navigateTree:' + f.sm.getLeafId()));
    assert.equal(f.sent.at(-1)!.options.expandPromptTemplates, true);
    assert.equal((await f.invoke('command', { name: 'compact', args: 'Preserve decisions' })).ok, true);
    assert.ok(f.sessionActions.includes('compact:Preserve decisions'));
    assert.equal((await f.invoke('command', { name: 'new' })).ok, true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(f.sessionActions.includes('newSession'));
    assert.equal((await f.invoke('command', { name: 'new', args: 'unexpected' })).status, 400);
    assert.equal((await f.invoke('command', { name: 'reload' })).ok, true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(f.sessionActions.includes('reload'));
  } finally { await f.cleanup(); }
});

test('connection announcements use one URL and show QR only on explicit request, never pinned', async () => {
  const f = await fixture({ mode: 'tui', host: '0.0.0.0' });
  const urls = (notice: string): string[] => Array.from(notice.match(/http:\/\/[^\s]+/g) ?? []);
  const hasQr = (notice: string) => /[\u2580-\u259f]/.test(notice);
  try {
    assert.equal(f.notices.length, 1, 'one startup announcement');
    assert.equal(urls(f.notices[0]).length, 1);
    assert.equal(hasQr(f.notices[0]), false, 'no automatic QR at startup');
    await f.command('status');
    const allUrls = urls(f.notices.at(-1)!);
    assert.ok(allUrls.includes(f.url));
    assert.ok(allUrls.some(url => new URL(url).hostname === '127.0.0.1'));
    const lanUrls = allUrls.filter(url => new URL(url).hostname !== '127.0.0.1');
    if (lanUrls.length) assert.equal(f.url, lanUrls[0], 'prefer a LAN address when available');
    assert.equal(hasQr(f.notices.at(-1)!), false);
    for (const command of ['', 'qr']) {
      const before: number = f.notices.length;
      await f.command(command);
      assert.equal(f.notices.length, before + 1);
      assert.deepEqual(urls(f.notices.at(-1)!), [f.url]);
      assert.equal(hasQr(f.notices.at(-1)!), true);
    }
    assert.ok(f.widgets.every(widget => widget === undefined), 'QR must never be a persistent widget');
    const before = f.notices.length;
    await f.emit('agent_start'); await f.emit('agent_settled');
    assert.equal(f.notices.length, before, 'ordinary activity does not repeat QR or URLs');
    await f.command('stop');
    await f.command('start');
    assert.equal(f.notices.length, before + 1, 'start must not double-announce');
    assert.equal(hasQr(f.notices.at(-1)!), false);
    await f.command('stop');
    const stoppedCount = f.notices.length;
    await f.command('qr');
    assert.equal(f.notices.length, stoppedCount + 1, 'explicit QR on a stopped server is one announcement');
    assert.equal(urls(f.notices.at(-1)!).length, 1);
    assert.equal(hasQr(f.notices.at(-1)!), true);
  } finally { await f.cleanup(); }
});

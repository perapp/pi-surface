import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

// Real Pi/Jiti smoke test, no provider credentials and no inference.
test('loads in real Pi; reload preserves runtime; session replacement reconnects the same browser origin', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-surface-real-pi-'));
  await mkdir(join(root, 'agent'));
  const child = spawn(process.execPath, [resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--mode', 'rpc', '--no-session', '--no-skills', '-e', resolve('src/index.ts'), '--surface-host', '127.0.0.1'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), NO_COLOR: '1' },
  });
  const events: any[] = []; const listeners = new Set<() => void>(); let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (;;) {
      const index = stdout.indexOf('\n'); if (index === -1) break;
      const line = stdout.slice(0, index); stdout = stdout.slice(index + 1);
      try { events.push(JSON.parse(line)); } catch { /* non-protocol startup warnings are captured in stderr by Pi */ }
    }
    for (const listener of listeners) listener();
  });
  async function waitFor(predicate: (event: any) => boolean) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Pi response timeout: ${stderr}`)); }, 12_000);
      function check() {
        const event = events.find(predicate);
        if (event) { clearTimeout(timer); listeners.delete(check); resolve(event); }
      }
      listeners.add(check); check();
    });
  }
  let id = 0;
  async function rpc(type: string, data: object = {}) {
    const requestId = `test-${++id}`;
    child.stdin.write(JSON.stringify({ id: requestId, type, ...data }) + '\n');
    const response = await waitFor(event => event.type === 'response' && event.id === requestId);
    assert.equal(response.success, true, response.error); return response.data;
  }
  try {
    const commands = await rpc('get_commands');
    assert.ok(commands.commands.some((command: any) => command.name === 'surface'), stderr);
    await rpc('prompt', { message: '/surface start' });
    const notification = await waitFor(event => event.type === 'extension_ui_request' && event.method === 'notify' && /http:\/\/127/.test(event.message));
    const url = notification.message.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)[0];
    const base = new URL(url).origin;
    const auth = await fetch(url, { redirect: 'manual' });
    const cookie = auth.headers.get('set-cookie')!.split(';')[0];
    const headers = { cookie, 'content-type': 'application/json', 'x-pi-surface': '1' };
    const state = await (await fetch(base + '/api/state', { headers })).json();
    const rpcState = await rpc('get_state');
    assert.equal(state.session.id, rpcState.sessionId);
    const renamed = await fetch(base + '/api/invoke', { method: 'POST', headers, body: JSON.stringify({ method: 'renameSession', params: { name: 'Browser owns the same session' } }) });
    assert.equal(renamed.status, 200);
    assert.equal((await rpc('get_state')).sessionName, 'Browser owns the same session');

    const uploaded = await (await fetch(base + '/api/upload', {
      method: 'POST', headers: { ...headers, 'x-file-name': 'reload.txt' }, body: 'survives reload',
    })).json();
    const reloadEvents = await fetch(base + '/api/events', { headers });
    const reloadReader = reloadEvents.body!.getReader(); await reloadReader.read();
    assert.equal((await fetch(base + '/api/invoke', { method: 'POST', headers, body: JSON.stringify({ method: 'reload', params: {} }) })).status, 200);
    let sawReloading = false;
    for (;;) {
      const chunk = await reloadReader.read();
      if (chunk.done) break;
      if (new TextDecoder().decode(chunk.value).includes('server_reloading')) sawReloading = true;
    }
    assert.ok(sawReloading);
    let reloadState: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        reloadState = await fetch(base + '/api/state', { headers });
        if (reloadState.status === 200) break;
      } catch { /* listener is being rebound */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(reloadState?.status, 200, 'same authenticated origin returns after reload');
    assert.equal((await reloadState!.json()).session.id, rpcState.sessionId);
    assert.equal((await fetch(base + '/api/upload/' + uploaded.id, { method: 'DELETE', headers })).status, 200, 'attachment ID survives reload');

    const sse = await fetch(base + '/api/events', { headers }); const reader = sse.body!.getReader(); await reader.read();
    assert.equal((await fetch(base + '/api/invoke', { method: 'POST', headers, body: JSON.stringify({ method: 'newSession', params: {} }) })).status, 200);
    let sawRestarting = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = new TextDecoder().decode(chunk.value);
      if (text.includes('server_reloading') && text.includes('"reason":"new"')) sawRestarting = true;
    }
    assert.ok(sawRestarting);
    // RPC state reads can run while the asynchronous replacement is still rebinding.
    let replacement = await rpc('get_state');
    for (let attempt = 0; attempt < 100 && replacement.sessionId === rpcState.sessionId; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      replacement = await rpc('get_state');
    }
    assert.notEqual(replacement.sessionId, rpcState.sessionId);
    let replacementState: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        replacementState = await fetch(base + '/api/state', { headers });
        if (replacementState.status === 200) break;
      } catch { /* listener is being rebound */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(replacementState?.status, 200, 'same authenticated origin returns after /new');
    assert.equal((await replacementState!.json()).session.id, replacement.sessionId);
    const replacementEvents = await fetch(base + '/api/events', { headers });
    const replacementSnapshot = new TextDecoder().decode((await replacementEvents.body!.getReader().read()).value);
    assert.match(replacementSnapshot, new RegExp(replacement.sessionId));
    assert.ok(!events.some(event => event.type === 'extension_error'), JSON.stringify(events.filter(event => event.type === 'extension_error')));
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});

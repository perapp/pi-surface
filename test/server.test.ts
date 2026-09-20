import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { SurfaceServer } from '../src/server.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-surface-server-test-'));
  const calls: unknown[] = [];
  const server = new SurfaceServer({ cwd: root, globalRoot: join(root, 'global'), host: '127.0.0.1', trusted: true,
    state: () => ({ session: { id: 'same-session' }, messages: [] }),
    invoke: (method, params) => { calls.push({ method, params }); return { accepted: true }; },
  });
  try { await server.start(); } catch (e) { await rm(root, { recursive: true, force: true }); throw e; }
  const base = `http://127.0.0.1:${server.port}`;
  const auth = await fetch(server.urls[0], { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie')!.split(';')[0];
  return { server, root, calls, base, cookie, auth, cleanup: async () => { await server.close(); await rm(root, { recursive: true, force: true }); } };
}

test('every route requires authentication, including loopback and assets', async () => {
  const f = await fixture();
  try {
    for (const path of ['/', '/app.js', '/bridge.js', '/api/state', '/api/events', '/api/data/a?path=a', '/surfaces/a/index.html']) {
      assert.equal((await fetch(f.base + path)).status, 401, path);
    }
    assert.equal(f.auth.status, 200);
    assert.equal(f.auth.headers.get('location'), null);
    assert.match(await f.auth.text(), /history\.replaceState\(null,'','\/'\)/);
    assert.match(f.auth.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${f.base}/?token=bad`)).status, 401);
    assert.equal((await fetch(`${f.base}/?token=${encodeURIComponent('é'.repeat(43))}`)).status, 401);
    const response = await fetch(f.base + '/api/state', { headers: { cookie: f.cookie } });
    const state = await response.json();
    assert.equal(state.session.id, 'same-session'); assert.equal(state.protocol, 1);
    assert.ok(!JSON.stringify(state).includes(f.server.token));
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-security-policy'));
  } finally { await f.cleanup(); }
});

test('per-instance cookie and token isolation, unconditional authentication', async () => {
  const a = await fixture(); const b = await fixture();
  try {
    assert.notEqual(a.server.port, b.server.port); assert.notEqual(a.server.cookieName, b.server.cookieName);
    assert.equal((await fetch(b.base + '/api/state', { headers: { cookie: a.cookie } })).status, 401);
    assert.equal((await fetch(`${b.base}/?token=${a.server.token}`)).status, 401);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test('origin, Host and custom-header protections reject browser CSRF and rebinding', async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ method: 'prompt', params: { text: 'hello' } });
    const headers = { cookie: f.cookie, 'content-type': 'application/json' };
    assert.equal((await fetch(f.base + '/api/invoke', { method: 'POST', headers, body })).status, 403);
    for (const origin of ['http://evil.test', 'null', `http://127.0.0.1:${f.server.port + 1}`]) {
      assert.equal((await fetch(f.base + '/api/invoke', { method: 'POST', headers: { ...headers, 'x-pi-surface': '1', origin }, body })).status, 403);
    }
    assert.equal((await fetch(f.base + '/api/invoke', { method: 'POST', headers: { ...headers, 'x-pi-surface': '1', origin: f.base }, body })).status, 200);
    assert.deepEqual(f.calls, [{ method: 'prompt', params: { text: 'hello' } }]);
    const status = await new Promise(resolve => {
      const req = request(f.base + '/api/state', { headers: { Host: `evil.test:${f.server.port}`, cookie: f.cookie } }, res => { res.resume(); resolve(res.statusCode); }); req.end();
    });
    assert.equal(status, 403);
    assert.equal((await fetch(f.base + '/api/state', { headers: { cookie: f.cookie, 'sec-fetch-site': 'cross-site' } })).status, 403);
  } finally { await f.cleanup(); }
});

test('malformed JSON, shape, content type and oversized requests rejected', async () => {
  const f = await fixture();
  try {
    const headers = { cookie: f.cookie, 'content-type': 'application/json', 'x-pi-surface': '1' };
    for (const body of ['{', 'null', '[]', '{"method":"prompt","params":[]}']) {
      assert.equal((await fetch(f.base + '/api/invoke', { method: 'POST', headers, body })).status, 400);
    }
    assert.equal((await fetch(f.base + '/api/invoke', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(f.base + '/api/invoke', { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('uploads are private opaque IDs; filenames cannot select paths; image bytes are recognized', async () => {
  const f = await fixture();
  try {
    const headers = { cookie: f.cookie, 'x-pi-surface': '1', 'x-file-name': encodeURIComponent('../../meeting.txt'), 'content-type': 'image/png' };
    const response = await fetch(f.base + '/api/upload', { method: 'POST', headers, body: 'not an image' });
    assert.equal(response.status, 201);
    const file = await response.json();
    assert.equal(file.name, 'meeting.txt'); assert.equal(file.mimeType, 'application/octet-stream'); assert.ok(!file.path);
    const stored = f.server.attachmentIds([file.id])[0];
    assert.equal(await readFile(stored.path, 'utf8'), 'not an image');
    assert.equal((await stat(stored.path)).mode & 0o777, 0o600);
    assert.equal((await stat(f.server.directory)).mode & 0o777, 0o700);
    assert.throws(() => f.server.attachmentIds(['../../etc/passwd']));
    assert.equal((await fetch(f.base + '/api/upload/' + file.id, { method: 'DELETE', headers })).status, 200);
    const image = await fetch(f.base + '/api/upload', { method: 'POST', headers, body: Buffer.from([137,80,78,71,13,10,26,10]) });
    const uploadedImage = await image.json(); assert.equal(uploadedImage.mimeType, 'image/png');
    f.server.attachmentIds([uploadedImage.id])[0].used = true;
    assert.equal((await fetch(f.base + '/api/upload/' + uploadedImage.id, { method: 'DELETE', headers })).status, 409);
    const directory = f.server.directory;
    await f.server.close(); await assert.rejects(stat(directory)); await f.server.close();
  } finally { await f.cleanup(); }
});

test('SSE sends snapshot, live events, closing notification; connections close cleanly', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.base + '/api/events', { headers: { cookie: f.cookie } });
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /same-session/);
    f.server.publish({ type: 'message_update', message: { role: 'assistant', content: 'Hello phone' } });
    assert.match(new TextDecoder().decode((await reader.read()).value), /Hello phone/);
    const closing = reader.read(); await f.server.close();
    assert.match(new TextDecoder().decode((await closing).value), /server_closing/);
    reader.releaseLock();
  } finally { await f.cleanup(); }
});

test('reload handoff preserves origin, temporary surfaces, authentication and attachments', async () => {
  const f = await fixture();
  let replacement: SurfaceServer | undefined;
  try {
    const surface = await f.server.store.create({ id: 'reload-report', name: 'Reload report', html: '<p>survives</p>' });
    const uploadHeaders = { cookie: f.cookie, 'x-pi-surface': '1', 'x-file-name': 'notes.txt' };
    const uploaded = await (await fetch(f.base + '/api/upload', { method: 'POST', headers: uploadHeaders, body: 'keep me' })).json();
    f.server.attachmentIds([uploaded.id])[0].used = true;
    const events = await fetch(f.base + '/api/events', { headers: { cookie: f.cookie } });
    const reader = events.body!.getReader(); await reader.read();
    const reloading = reader.read();
    const directory = f.server.directory;
    const handoff = await f.server.preserveForReload();
    assert.match(new TextDecoder().decode((await reloading).value), /server_reloading/);
    assert.equal((await stat(directory)).isDirectory(), true);
    await f.server.close();
    assert.equal((await stat(directory)).isDirectory(), true, 'retired server no longer owns handed-off files');

    replacement = new SurfaceServer({ cwd: f.root, globalRoot: join(f.root, 'global'), host: '127.0.0.1', trusted: true,
      state: () => ({ session: { id: 'same-session' }, messages: [] }), invoke: () => ({ accepted: true }),
    }, handoff);
    await replacement.start();
    assert.equal(replacement.continuedOrigin, true);
    assert.equal(replacement.port, f.server.port);
    assert.equal(replacement.token, f.server.token);
    assert.equal(replacement.cookieName, f.server.cookieName);
    assert.ok(replacement.store.list().some(item => item.id === surface.id));
    assert.equal(await readFile(replacement.attachmentIds([uploaded.id])[0].path, 'utf8'), 'keep me');
    assert.equal(replacement.attachmentIds([uploaded.id])[0].used, true);
    assert.equal((await fetch(f.base + '/api/state', { headers: { cookie: f.cookie } })).status, 200);
    assert.equal((await fetch(f.base + '/api/upload/' + uploaded.id, { method: 'DELETE', headers: uploadHeaders })).status, 409);
    await replacement.close(); replacement = undefined;
    await assert.rejects(stat(directory));
  } finally { await replacement?.close(); await f.cleanup(); }
});

test('surface HTML receives automatic bridge; data is read only from declared dependencies', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'data.json'), '{"passed":42}');
    const surface = await f.server.store.create({ id: 'report', name: 'Report', html: '<!doctype html><html><head><title>Report</title></head><body>Hello</body></html>', watch: ['data.json'] });
    const headers = { cookie: f.cookie };
    const response = await fetch(`${f.base}/surfaces/${encodeURIComponent(surface.id)}/index.html`, { headers });
    assert.equal(response.status, 200); assert.match(await response.text(), /<head><script src="\/bridge.js"><\/script>/);
    const data = await fetch(`${f.base}/api/data/${encodeURIComponent(surface.id)}?path=data.json`, { headers });
    assert.equal(data.status, 200); assert.deepEqual(await data.json(), { passed: 42 });
    const denied = await fetch(`${f.base}/api/data/${encodeURIComponent(surface.id)}?path=private.txt`, { headers });
    assert.notEqual(denied.status, 200);
    assert.equal((await fetch(f.base + '/bridge.js', { headers })).status, 200);
  } finally { await f.cleanup(); }
});

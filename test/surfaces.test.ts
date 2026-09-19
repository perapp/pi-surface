import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SurfaceStore, type SurfaceStoreOptions } from '../src/surfaces.ts';

type Event = Record<string, unknown>;

async function fixture(overrides: Partial<SurfaceStoreOptions> = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-surface-test-'));
  const cwd = path.join(base, 'project');
  await fs.mkdir(cwd);
  const events: Event[] = [];
  const options: SurfaceStoreOptions = {
    cwd, projectRoot: path.join(cwd, '.pi/agent/surfaces'),
    globalRoot: path.join(base, 'global/surfaces'), temporaryRoot: path.join(base, 'temporary'),
    trusted: true, onEvent: event => events.push(event), ...overrides,
  };
  const store = new SurfaceStore(options);
  return { base, cwd, events, options, store, cleanup: async () => { await store.close(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function add(root: string, id: string, m: Record<string, unknown> = {}) {
  const directory = path.join(root, id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'index.html'), `<h1>${id}</h1>`);
  await fs.writeFile(path.join(directory, 'surface.json'), JSON.stringify({ name: id, entry: 'index.html', ...m }));
  return directory;
}

async function eventually(check: () => boolean, message = 'Expected watcher event') {
  const deadline = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('discovers manifests deterministically; defaults are explicit, scoped IDs do not collide', async () => {
  const f = await fixture();
  try {
    await add(f.options.projectRoot!, 'alpha');
    await add(f.options.projectRoot!, 'zeta', { default: true });
    await add(f.options.globalRoot, 'alpha', { default: true });
    await add(f.options.temporaryRoot, 'alpha');
    await fs.mkdir(path.join(f.options.projectRoot!, 'unregistered'));
    await fs.writeFile(path.join(f.options.projectRoot!, 'unregistered/index.html'), 'not a surface');
    await f.store.start();
    assert.deepEqual(f.store.list().map(s => s.id), ['project:zeta', 'project:alpha', 'temporary:alpha', 'global:alpha']);
    assert.equal(f.store.get('project:alpha').default, false);
    assert.deepEqual(f.store.get('project:alpha').watch, []);
    assert.throws(() => f.store.get('alpha'), /Unknown/);
    const copy = f.store.get('project:alpha');
    copy.watch.push('**');
    assert.deepEqual(f.store.get('project:alpha').watch, []);
    assert.equal((await f.store.asset('project:alpha', '')).body.toString(), '<h1>alpha</h1>');
  } finally { await f.cleanup(); }
});

test('missing roots are not created and later roots/manifests are discovered', async () => {
  const f = await fixture();
  try {
    await f.store.start();
    await assert.rejects(fs.stat(f.options.projectRoot!), { code: 'ENOENT' });
    await assert.rejects(fs.stat(f.options.globalRoot), { code: 'ENOENT' });
    await add(f.options.projectRoot!, 'later');
    await eventually(() => f.store.list().some(s => s.id === 'project:later'));
    await add(f.options.globalRoot, 'global-later');
    await eventually(() => f.store.list().some(s => s.id === 'global:global-later'));
    await fs.writeFile(path.join(f.options.projectRoot!, 'later/surface.json'), JSON.stringify({ name: 'Renamed', entry: 'index.html', default: true }));
    await eventually(() => f.store.get('project:later').name === 'Renamed');
    await fs.rm(path.join(f.options.projectRoot!, 'later'), { recursive: true });
    await eventually(() => !f.store.list().some(s => s.id === 'project:later'));
    assert.ok(f.events.some(event => event.type === 'surfaces_changed'));
  } finally { await f.cleanup(); }
});

test('untrusted sessions exclude project surfaces and cannot promote into the project', async () => {
  const f = await fixture({ trusted: false });
  try {
    await add(f.options.projectRoot!, 'hidden');
    await add(f.options.globalRoot, 'visible');
    await f.store.start();
    assert.deepEqual(f.store.list().map(s => s.id), ['global:visible']);
    const s = await f.store.create({ id: 'test', name: 'Temporary', html: 'hello' });
    await assert.rejects(f.store.promote(s.id, 'project'), /untrusted/);
    await add(f.options.projectRoot!, 'still-hidden');
    assert.equal(f.store.list().filter(s => s.scope === 'project').length, 0);
  } finally { await f.cleanup(); }
});

test('asset changes reload; dependencies are explicit cwd-relative globs and emit data events', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.cwd, 'data'));
    await fs.writeFile(path.join(f.cwd, 'data/a.json'), '{"a":1}');
    await f.store.start();
    const s = await f.store.create({ id: 'reactive', name: 'Reactive', html: '<p>hello</p>', watch: ['data/*.json'] });
    assert.equal((await f.store.data(s.id, 'data/a.json')).body.toString(), '{"a":1}');
    await fs.writeFile(path.join(s.directory, 'index.html'), '<p>updated</p>');
    await eventually(() => f.events.some(e => e.type === 'surface_reload' && e.surfaceId === s.id));
    await fs.writeFile(path.join(f.cwd, 'data/a.json'), '{"a":2}');
    await eventually(() => f.events.some(e => e.type === 'data_changed' && e.path === 'data/a.json' && e.event === 'change'));
    await fs.writeFile(path.join(f.cwd, 'data/b.json'), '{}');
    await eventually(() => f.events.some(e => e.type === 'data_changed' && e.path === 'data/b.json' && e.event === 'add'));
    await fs.unlink(path.join(f.cwd, 'data/b.json'));
    await eventually(() => f.events.some(e => e.type === 'data_changed' && e.path === 'data/b.json' && e.event === 'unlink'));
    await fs.writeFile(path.join(f.cwd, 'data/secret.txt'), 'secret');
    await assert.rejects(f.store.data(s.id, 'data/secret.txt'), /explicitly allowed/);
    await assert.rejects(f.store.data(s.id, 'index.html'), /explicitly allowed/);
    const plain = await f.store.create({ id: 'plain', name: 'Plain', html: '<script src="data/a.json"></script>' });
    await assert.rejects(f.store.data(plain.id, 'data/a.json'), /explicitly allowed/);
    assert.ok(!f.events.some(e => e.type === 'data_changed' && e.surfaceId === plain.id));
  } finally { await f.cleanup(); }
});

test('manifest watch updates replace dependency authorization and watching', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.cwd, 'old.json'), '{}');
    await fs.writeFile(path.join(f.cwd, 'new.json'), '{}');
    await f.store.start();
    const s = await f.store.create({ id: 'update', name: 'Update', html: '', watch: ['old.json'] });
    const before = f.events.length;
    await fs.writeFile(path.join(s.directory, 'surface.json'), JSON.stringify({ name: 'Update', entry: 'index.html', watch: ['new.json'] }));
    await eventually(() => f.events.slice(before).some(e => e.type === 'surfaces_changed'));
    await assert.rejects(f.store.data(s.id, 'old.json'), /explicitly allowed/);
    await fs.writeFile(path.join(f.cwd, 'new.json'), '{"new":true}');
    await eventually(() => f.events.some(e => e.type === 'data_changed' && e.path === 'new.json'));
  } finally { await f.cleanup(); }
});

test('rejects traversal, symlink escapes, directories and oversized files', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.base, 'secret.txt'), 'secret');
    await f.store.start();
    const s = await f.store.create({ id: 'safe', name: 'Safe', html: 'ok', watch: ['**/*'] });
    await fs.symlink(path.join(f.base, 'secret.txt'), path.join(s.directory, 'escape.txt'));
    await fs.symlink(f.base, path.join(s.directory, 'outside'));
    await fs.symlink(path.join(f.base, 'secret.txt'), path.join(f.cwd, 'escape.txt'));
    await fs.symlink(f.base, path.join(f.cwd, 'outside'));
    for (const requested of ['../secret.txt', '/etc/passwd', '..\\secret.txt', 'outside/secret.txt', 'escape.txt']) {
      await assert.rejects(f.store.asset(s.id, requested));
      await assert.rejects(f.store.data(s.id, requested));
    }
    await assert.rejects(f.store.asset(s.id, '.'));
    await fs.mkdir(path.join(f.cwd, 'folder'));
    await assert.rejects(f.store.data(s.id, 'folder'));
    const large = await fs.open(path.join(s.directory, 'big.bin'), 'w');
    await large.truncate(10 * 1024 * 1024 + 1);
    await large.close();
    await assert.rejects(f.store.asset(s.id, 'big.bin'), /10 MiB/);
    await fs.writeFile(path.join(s.directory, 'local.txt'), 'local');
    await fs.symlink('local.txt', path.join(s.directory, 'local-link.txt'));
    assert.equal((await f.store.asset(s.id, 'local-link.txt')).body.toString(), 'local');
    const mark = f.events.length;
    await fs.writeFile(path.join(f.base, 'secret.txt'), 'changed');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(!f.events.slice(mark).some(e => e.type === 'data_changed' && String(e.path).startsWith('outside/')));
  } finally { await f.cleanup(); }
});

test('invalid manifests are isolated and unsafe globs are rejected', async () => {
  const f = await fixture();
  try {
    await add(f.options.globalRoot, 'good');
    await add(f.options.globalRoot, 'bad', { watch: ['../outside'] });
    const malformed = await add(f.options.globalRoot, 'malformed');
    await fs.writeFile(path.join(malformed, 'surface.json'), '{');
    await f.store.start();
    assert.deepEqual(f.store.list().map(s => s.id), ['global:good']);
    assert.ok(f.events.some(e => e.type === 'surface_error'));
    for (const watch of [['../secret'], ['/etc/*'], ['{foo,..}/*'], ['!secret'], ['a\\..\\b']]) {
      await assert.rejects(f.store.create({ id: 'invalid', name: 'Bad', html: '', watch }));
    }
    await assert.rejects(f.store.create({ id: '../escape', name: 'Bad', html: '' }), /slug/);
  } finally { await f.cleanup(); }
});

test('promotion preserves source and never overwrites a destination', async () => {
  const f = await fixture();
  try {
    await f.store.start();
    const s = await f.store.create({ id: 'promoted', name: 'Promoted', html: '<p>persist</p>', watch: ['*.json'], default: true });
    await fs.writeFile(path.join(s.directory, 'style.css'), 'body {}');
    const promoted = await f.store.promote(s.id, 'global');
    assert.equal(promoted.id, 'global:promoted');
    assert.equal(promoted.default, true);
    assert.deepEqual(promoted.watch, ['*.json']);
    assert.equal((await f.store.asset(promoted.id, 'style.css')).body.toString(), 'body {}');
    assert.equal(f.store.get(s.id).scope, 'temporary');
    await assert.rejects(f.store.promote(s.id, 'global'), { code: 'EEXIST' });
    await assert.rejects(f.store.create({ id: 'promoted', name: 'Overwrite', html: 'bad' }), { code: 'EEXIST' });
    assert.equal((await f.store.asset(promoted.id, '')).body.toString(), '<p>persist</p>');
    const project = await f.store.promote(s.id, 'project');
    assert.equal(project.id, 'project:promoted');
  } finally { await f.cleanup(); }
});

test('close is idempotent, suppresses queued events and rejects later operations', async () => {
  const f = await fixture();
  try {
    await f.store.start();
    const s = await f.store.create({ id: 'closing', name: 'Closing', html: 'ok' });
    await fs.writeFile(path.join(s.directory, 'surface.json'), JSON.stringify({ name: 'Changed', entry: 'index.html' }));
    await f.store.close();
    const count = f.events.length;
    await fs.writeFile(path.join(s.directory, 'index.html'), 'after close');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.events.length, count);
    await f.store.close();
    await assert.rejects(f.store.start(), /closed/);
    await assert.rejects(f.store.create({ id: 'no', name: 'No', html: '' }), /closed/);
    await assert.rejects(f.store.asset(s.id, ''), /closed/);
  } finally { await f.cleanup(); }
});

test('default project root works without explicit projectRoot', async () => {
  const f = await fixture({ projectRoot: undefined });
  try {
    await add(path.join(f.cwd, '.pi/agent/surfaces'), 'default-root');
    await f.store.start();
    assert.equal(f.store.get('project:default-root').scope, 'project');
  } finally { await f.cleanup(); }
});

test('explicit dependency glob parents cannot follow an outside symlink', async () => {
  const f = await fixture();
  try {
    const external = path.join(f.base, 'external');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'secret.txt'), 'secret');
    await fs.symlink(external, path.join(f.cwd, 'linked'));
    await f.store.start();
    const s = await f.store.create({ id: 'links', name: 'Links', html: '', watch: ['linked/*.txt'] });
    await assert.rejects(f.store.data(s.id, 'linked/secret.txt'), /escapes/);
    await fs.writeFile(path.join(external, 'secret.txt'), 'changed');
    await fs.writeFile(path.join(external, 'new.txt'), 'new');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(!f.events.some(e => e.type === 'data_changed'));
  } finally { await f.cleanup(); }
});

test('closing after startup begins waits for all watcher initialization', async () => {
  const f = await fixture();
  try {
    await add(f.options.globalRoot, 'starting', { watch: ['*.json'] });
    const starting = f.store.start();
    await new Promise(resolve => setImmediate(resolve));
    const closed = f.store.close();
    await starting;
    await closed;
    const count = f.events.length;
    await fs.writeFile(path.join(f.options.globalRoot, 'starting/index.html'), 'after');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.events.length, count);
  } finally { await f.cleanup(); }
});

test('closing during startup does not leave watchers behind', async () => {
  const f = await fixture();
  try {
    const starting = f.store.start();
    const closed = f.store.close();
    await assert.rejects(starting, /closed/);
    await closed;
    assert.equal(f.events.length, 0);
  } finally { await f.cleanup(); }
});

test('literal directory dependencies include descendants and exclude siblings', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.cwd, 'notes/sub'), { recursive: true });
    await fs.writeFile(path.join(f.cwd, 'notes/sub/a.md'), 'first');
    await fs.writeFile(path.join(f.cwd, 'notes-private.md'), 'private');
    await f.store.start();
    const s = await f.store.create({ id: 'notes', name: 'Notes', html: '', watch: ['notes'] });
    assert.equal((await f.store.data(s.id, 'notes/sub/a.md')).body.toString(), 'first');
    await assert.rejects(f.store.data(s.id, 'notes-private.md'), /explicitly allowed/);
    await fs.writeFile(path.join(f.cwd, 'notes/sub/a.md'), 'updated');
    await eventually(() => f.events.some(e => e.type === 'data_changed' && e.path === 'notes/sub/a.md'));
  } finally { await f.cleanup(); }
});

test('manifest supports relative HTML entry and rejects entry traversal', async () => {
  const f = await fixture();
  try {
    const dir = await add(f.options.projectRoot!, 'nested', { entry: 'pages/report.html' });
    await fs.mkdir(path.join(dir, 'pages'));
    await fs.writeFile(path.join(dir, 'pages/report.html'), '<h1>Nested entry</h1>');
    await add(f.options.projectRoot!, 'bad-entry', { entry: '../secret.html' });
    await f.store.start();
    assert.equal(f.store.get('project:nested').entry, 'pages/report.html');
    assert.match((await f.store.asset('project:nested', '')).body.toString(), /Nested entry/);
    assert.throws(() => f.store.get('project:bad-entry'));
  } finally { await f.cleanup(); }
});

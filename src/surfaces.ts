import { constants, realpathSync, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import picomatch from 'picomatch';

export interface SurfaceInfo {
  id: string;
  name: string;
  scope: 'project' | 'global' | 'temporary';
  entry: string;
  default: boolean;
  watch: string[];
  directory: string;
}

export interface SurfaceManifest {
  name: string;
  entry: string;
  default?: boolean;
  /** Globs relative to the session cwd, never to the surface directory. */
  watch?: string[];
}

export interface SurfaceStoreOptions {
  cwd: string;
  projectRoot?: string;
  globalRoot: string;
  temporaryRoot: string;
  trusted: boolean;
  onEvent: (event: Record<string, unknown>) => void;
}

type Scope = SurfaceInfo['scope'];
const MAX_BYTES = 10 * 1024 * 1024;
const MANIFEST = 'surface.json';
const copyInfo = (s: SurfaceInfo): SurfaceInfo => ({ ...s, watch: [...s.watch] });
const contained = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function relativePath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') ||
      path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) {
    throw new Error('Path must be relative and must not escape its root');
  }
  return value;
}

function manifest(value: unknown): SurfaceManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid surface manifest');
  const m = value as Record<string, unknown>;
  if (typeof m.name !== 'string' || !m.name.trim() || (m.entry !== undefined && typeof m.entry !== 'string') ||
      (m.default !== undefined && typeof m.default !== 'boolean') ||
      (m.watch !== undefined && (!Array.isArray(m.watch) || m.watch.some(p => typeof p !== 'string')))) {
    throw new Error('Manifest requires name, optional relative HTML entry, boolean default / string[] watch');
  }
  const entry = relativePath((m.entry ?? 'index.html') as string);
  if (!/\.html$/i.test(entry)) throw new Error('Surface entry must be an HTML file');
  const watch = (m.watch ?? []) as string[];
  for (const pattern of watch) {
    relativePath(pattern);
    // Reject parent navigation even inside brace/extglob alternatives. Negative globs
    // are not an authorization language: every watch entry grants explicit access.
    if (pattern.includes('..') || pattern.startsWith('!')) throw new Error(`Unsafe watch glob: ${pattern}`);
    picomatch(pattern, { dot: true, nonegate: true });
  }
  return { name: m.name, entry, default: m.default as boolean | undefined, watch: [...new Set(watch)] };
}

function matchesWatch(pattern: string, requested: string): boolean {
  if (picomatch(pattern, { dot: true, nonegate: true })(requested)) return true;
  // A literal dependency can be a directory; include its descendants, not siblings.
  if (picomatch.scan(pattern).isGlob) return false;
  const base = path.posix.normalize(pattern).replace(/\/$/, '');
  return base === '.' || requested.startsWith(base + '/');
}

async function readWithin(root: string, requested: string): Promise<{ body: Buffer; path: string }> {
  relativePath(requested);
  const canonicalRoot = await fs.realpath(root);
  const target = await fs.realpath(path.resolve(root, requested));
  if (!contained(canonicalRoot, target)) throw new Error('Path escapes its root');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Only regular files can be served');
    if (stat.size > MAX_BYTES) throw new Error('File exceeds 10 MiB limit');
    // Bounded even when a writer grows the file after stat().
    const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('File exceeds 10 MiB limit');
    return { body: Buffer.from(buffer.subarray(0, length)), path: target };
  } finally {
    await handle.close();
  }
}

export class SurfaceStore {
  private readonly options: SurfaceStoreOptions;
  private readonly roots: Array<{ scope: Scope; directory: string }>;
  private surfaces = new Map<string, SurfaceInfo>();
  private assetWatchers = new Map<string, FSWatcher>();
  private discoveryWatcher?: FSWatcher;
  private dependencyWatcher?: FSWatcher;
  private dependencyKey = '';
  private canonicalCwd = '';
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<unknown> = Promise.resolve();
  private started?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;

  constructor(options: SurfaceStoreOptions) {
    this.options = { ...options, cwd: path.resolve(options.cwd) };
    this.roots = [
      ...(options.trusted ? [{ scope: 'project' as const, directory: path.resolve(options.projectRoot ?? path.join(options.cwd, '.pi/agent/surfaces')) }] : []),
      { scope: 'temporary', directory: path.resolve(options.temporaryRoot) },
      { scope: 'global', directory: path.resolve(options.globalRoot) },
    ];
  }

  private emit(event: Record<string, unknown>): void {
    if (!this.closed) this.options.onEvent(event);
  }

  private error(error: unknown): void {
    this.emit({ type: 'surface_error', message: error instanceof Error ? error.message : String(error) });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      if (this.closed) throw new Error('Surface store is closed');
      return operation();
    });
    this.pending = result.catch(() => undefined);
    return result;
  }

  private schedule(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(() => this.rescan()).catch(error => this.error(error));
    }, 50);
  }

  private ready(watcher: FSWatcher): Promise<void> {
    watcher.on('error', error => this.error(error));
    return new Promise((resolve, reject) => {
      const done = () => { watcher.off('error', failed); resolve(); };
      const failed = (error: unknown) => { watcher.off('ready', done); reject(error); };
      watcher.once('ready', done);
      watcher.once('error', failed);
    });
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Surface store is closed'));
    return this.started ??= this.enqueue(async () => {
      this.canonicalCwd = await fs.realpath(this.options.cwd);
      await fs.mkdir(this.root('temporary'), { recursive: true });
      // Watch an existing ancestor of missing roots. Filtering keeps an ancestor
      // such as /tmp or $HOME from becoming an unrestricted recursive watch.
      const ancestors = await Promise.all(this.roots.map(async root => {
        let current = root.directory;
        while (true) {
          try { await fs.stat(current); return current; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const parent = path.dirname(current);
            if (parent === current) throw error;
            current = parent;
          }
        }
      }));
      this.discoveryWatcher = chokidar.watch([...new Set(ancestors)], {
        ignoreInitial: true, followSymlinks: false,
        ignored: (entry: string, stat?: Stats) => {
          const absolute = path.resolve(entry);
          if (!this.roots.some(root => contained(root.directory, absolute) || contained(absolute, root.directory))) return true;
          return Boolean(stat && !stat.isDirectory() && path.basename(absolute) !== MANIFEST);
        },
      });
      this.discoveryWatcher.on('all', (event, entry) => {
        if (path.basename(entry) === MANIFEST || ((event === 'addDir' || event === 'unlinkDir') &&
          this.roots.some(root => contained(path.resolve(entry), root.directory) || path.dirname(path.resolve(entry)) === root.directory))) this.schedule();
      });
      await this.ready(this.discoveryWatcher);
      await this.rescan();
    });
  }

  private root(scope: Scope): string {
    const root = this.roots.find(root => root.scope === scope);
    if (!root) throw new Error('Project surfaces are disabled for untrusted sessions');
    return root.directory;
  }

  list(): SurfaceInfo[] {
    const priority: Record<Scope, number> = { project: 0, temporary: 1, global: 2 };
    return [...this.surfaces.values()].sort((a, b) => priority[a.scope] - priority[b.scope] ||
      Number(b.default) - Number(a.default) || a.id.localeCompare(b.id)).map(copyInfo);
  }

  get(id: string): SurfaceInfo {
    const surface = this.surfaces.get(id);
    if (!surface) throw new Error(`Unknown surface: ${id}`);
    return copyInfo(surface);
  }

  async asset(id: string, requested: string): Promise<{ body: Buffer; path: string }> {
    if (this.closed) throw new Error('Surface store is closed');
    const surface = this.get(id);
    return readWithin(surface.directory, requested || surface.entry);
  }

  async data(id: string, requested: string): Promise<{ body: Buffer; path: string }> {
    if (this.closed) throw new Error('Surface store is closed');
    const surface = this.get(id);
    relativePath(requested);
    const normalized = path.posix.normalize(requested);
    if (!surface.watch.some(pattern => matchesWatch(pattern, normalized))) {
      throw new Error('Data path is not explicitly allowed by watch globs');
    }
    return readWithin(this.options.cwd, normalized);
  }

  private async rescan(): Promise<void> {
    const next = new Map<string, SurfaceInfo>();
    for (const root of this.roots) {
      let entries;
      try { entries = await fs.readdir(root.directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error(error);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const directory = path.join(root.directory, entry.name);
        try {
          const source = await readWithin(directory, MANIFEST);
          const m = manifest(JSON.parse(source.body.toString('utf8')));
          const id = `${root.scope}:${entry.name}`;
          next.set(id, { id, name: m.name, scope: root.scope, entry: m.entry, default: m.default ?? false, watch: m.watch ?? [], directory });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error(new Error(`${directory}: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    }
    const before = JSON.stringify(this.list());
    this.surfaces = next;
    for (const [id, watcher] of this.assetWatchers) {
      if (!next.has(id)) { await watcher.close(); this.assetWatchers.delete(id); }
    }
    for (const surface of next.values()) {
      if (this.assetWatchers.has(surface.id)) continue;
      const watcher = chokidar.watch(surface.directory, {
        ignoreInitial: true, followSymlinks: false,
        ignored: entry => path.basename(entry) === MANIFEST,
      });
      this.assetWatchers.set(surface.id, watcher);
      watcher.on('all', event => {
        if (event === 'add' || event === 'change' || event === 'unlink') this.emit({ type: 'surface_reload', surfaceId: surface.id });
      });
      await this.ready(watcher);
    }
    const patterns = [...new Set([...next.values()].flatMap(surface => surface.watch))].sort();
    const key = JSON.stringify(patterns);
    if (key !== this.dependencyKey) {
      await this.dependencyWatcher?.close();
      this.dependencyWatcher = undefined;
      this.dependencyKey = key;
      if (patterns.length) {
        const watcher = chokidar.watch(patterns, {
          cwd: this.options.cwd, ignoreInitial: true, followSymlinks: false,
          ignored: (entry: string, stat?: Stats) => {
            const absolute = path.resolve(this.options.cwd, entry);
            if (!contained(this.options.cwd, absolute) || stat?.isSymbolicLink()) return true;
            // Explicit glob parents may already traverse a symlink before chokidar
            // sees it; check canonical containment before accepting any watch.
            try { return !contained(this.canonicalCwd, realpathSync(absolute)); }
            catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
          },
        });
        this.dependencyWatcher = watcher;
        watcher.on('all', (event, entry) => {
          if (event === 'add' || event === 'change' || event === 'unlink') {
            void this.dependencyEvent(event, entry).catch(error => this.error(error));
          }
        });
        await this.ready(watcher);
      }
    }
    if (before !== JSON.stringify(this.list())) this.emit({ type: 'surfaces_changed', surfaces: this.list() });
  }

  private async dependencyEvent(event: string, entry: string): Promise<void> {
    const absolute = path.resolve(this.options.cwd, entry);
    if (!contained(this.options.cwd, absolute)) return;
    try {
      const root = await fs.realpath(this.options.cwd);
      const canonical = await fs.realpath(event === 'unlink' ? path.dirname(absolute) : absolute);
      if (!contained(root, canonical)) return;
      if (event !== 'unlink' && !(await fs.stat(canonical)).isFile()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const relative = path.relative(this.options.cwd, absolute).split(path.sep).join('/');
    for (const surface of this.surfaces.values()) {
      if (surface.watch.some(pattern => matchesWatch(pattern, relative))) {
        this.emit({ type: 'data_changed', surfaceId: surface.id, path: relative, event });
      }
    }
  }

  async create(options: { id: string; name: string; html: string; watch?: string[]; default?: boolean }): Promise<SurfaceInfo> {
    await this.start();
    return this.enqueue(async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.id)) throw new Error('Surface id must be a slug');
      const m = manifest({ name: options.name, entry: 'index.html', watch: options.watch, default: options.default });
      if (Buffer.byteLength(options.html) > MAX_BYTES) throw new Error('HTML exceeds 10 MiB limit');
      const directory = path.join(this.root('temporary'), options.id);
      await fs.mkdir(directory); // Atomic reservation; never overwrite another surface.
      try {
        await fs.writeFile(path.join(directory, 'index.html'), options.html, { flag: 'wx' });
        await fs.writeFile(path.join(directory, MANIFEST), JSON.stringify(m, null, 2), { flag: 'wx' });
        await this.rescan();
        return this.get(`temporary:${options.id}`);
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async promote(id: string, scope: 'project' | 'global'): Promise<SurfaceInfo> {
    await this.start();
    return this.enqueue(async () => {
      const source = this.get(id);
      const root = this.root(scope);
      const directory = path.join(root, path.basename(source.directory));
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(directory);
      try {
        for (const entry of await fs.readdir(source.directory)) {
          await fs.cp(path.join(source.directory, entry), path.join(directory, entry), {
            recursive: true, dereference: false, force: false, errorOnExist: true, verbatimSymlinks: true,
          });
        }
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
      // Promotion copies rather than deletes: clients using the original id remain valid.
      await this.rescan();
      return this.get(`${scope}:${path.basename(directory)}`);
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    return this.closing = (async () => {
      await this.pending;
      await Promise.all([this.discoveryWatcher, this.dependencyWatcher, ...this.assetWatchers.values()].filter((w): w is FSWatcher => Boolean(w)).map(w => w.close()));
      this.assetWatchers.clear();
    })();
  }
}

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SurfaceStore } from './surfaces.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface Attachment { id: string; name: string; mimeType: string; size: number; path: string; used: boolean }
export interface ServerOptions {
  cwd: string; globalRoot: string; projectRoot?: string; trusted: boolean;
  host?: string; port?: number;
  state: () => unknown | Promise<unknown>;
  invoke: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
}
const secret = () => randomBytes(32).toString('base64url');
const equal = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const MAX_FILE = 10 * 1024 * 1024;
const MAX_UPLOADS = 100 * 1024 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};
export const contentType = (path: string) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

export class SurfaceServer {
  readonly token = secret();
  readonly cookieName = `pi_surface_${randomBytes(8).toString('hex')}`;
  readonly clients = new Set<ServerResponse>();
  readonly attachments = new Map<string, Attachment>();
  readonly cookies = new Set<string>();
  readonly server = createServer((req, res) => { void this.handle(req, res); });
  store!: SurfaceStore;
  directory = '';
  port = 0;
  urls: string[] = [];
  private hosts = new Set<string>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private closing = false;
  private reservedBytes = 0;
  private activeUploads = 0;
  private operations = new Set<Promise<unknown>>();

  constructor(readonly options: ServerOptions) {
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
  }

  async start() {
    const host = this.options.host ?? '0.0.0.0';
    if (!isIP(host)) throw new Error('surface host must be a literal IPv4 or IPv6 address');
    this.directory = await mkdtemp(join(tmpdir(), 'pi-surface-'));
    try {
      await mkdir(join(this.directory, 'uploads'), { mode: 0o700 });
      this.store = new SurfaceStore({
        cwd: this.options.cwd, globalRoot: this.options.globalRoot, projectRoot: this.options.projectRoot,
        trusted: this.options.trusted, temporaryRoot: join(this.directory, 'surfaces'), onEvent: event => this.publish(event),
      });
      await this.store.start();
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.options.port ?? 0, host, () => { this.server.off('error', reject); resolve(); });
      });
      this.server.on('error', error => this.publish({ type: 'surface_error', message: error.message }));
      this.port = (this.server.address() as { port: number }).port;
      const addresses = host === '0.0.0.0' || host === '::'
        ? ['127.0.0.1', ...(host === '::' ? ['::1'] : []), ...Object.values(networkInterfaces()).flatMap(items =>
          (items ?? []).filter(item => !item.internal && item.family === 'IPv4').map(item => item.address))]
        : [host];
      this.hosts = new Set(addresses.map(address => `${address.includes(':') ? `[${address}]` : address}:${this.port}`));
      if (addresses.includes('127.0.0.1') || addresses.includes('::1')) this.hosts.add(`localhost:${this.port}`);
      this.urls = [...this.hosts].filter(item => !item.startsWith('localhost:')).map(item => `http://${item}/?token=${this.token}`);
      this.heartbeat = setInterval(() => {
        for (const client of this.clients) if (!client.write(': heartbeat\n\n')) client.destroy();
      }, 15_000);
      this.heartbeat.unref();
      return this;
    } catch (error) { await this.close(); throw error; }
  }

  publish(event: Record<string, unknown>) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      // A disconnected/slow phone must not buffer an unbounded transcript in Pi.
      if (client.writableLength > 1024 * 1024) { client.destroy(); this.clients.delete(client); }
      else client.write(payload);
    }
  }

  async snapshot() {
    return { ...(await this.options.state() as Record<string, unknown>), protocol: 1, surfaces: this.store.list() };
  }

  attachmentIds(ids: unknown): Attachment[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string')) throw new HttpError(400, 'Invalid attachments (maximum 10)');
    return [...new Set(ids)].map(id => {
      const file = this.attachments.get(id);
      if (!file) throw new HttpError(400, 'Attachment does not exist in this session');
      return file;
    });
  }

  private authenticated(req: IncomingMessage) {
    const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim());
    return cookies.some(part => part.startsWith(`${this.cookieName}=`) && this.cookies.has(part.slice(this.cookieName.length + 1)));
  }

  private json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
  }

  private async body(req: IncomingMessage, limit: number) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request too large');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'Request too large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private async upload(req: IncomingMessage, res: ServerResponse) {
    // Reserve the maximum before reading to enforce quota even for concurrent chunked uploads.
    const used = [...this.attachments.values()].reduce((n, file) => n + file.size, 0);
    if (this.attachments.size + this.activeUploads >= 100 || used + this.reservedBytes + MAX_FILE > MAX_UPLOADS) throw new HttpError(413, 'Session upload quota reached');
    this.reservedBytes += MAX_FILE; this.activeUploads++;
    try {
      let name: string;
      try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'attachment')); }
      catch { throw new HttpError(400, 'Invalid file name'); }
      name = basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 180) || 'attachment';
      const body = await this.body(req, MAX_FILE);
      if (this.closing) throw new HttpError(503, 'Session is closing');
      const id = randomBytes(16).toString('hex');
      const path = join(this.directory, 'uploads', `${id}-${name}`);
      await writeFile(path, body, { mode: 0o600, flag: 'wx' });
      const mimeType = detectImage(body) ?? 'application/octet-stream';
      const attachment = { id, name, mimeType, size: body.length, path, used: false };
      this.attachments.set(id, attachment);
      this.json(res, 201, { id, name, mimeType, size: body.length });
    } finally { this.reservedBytes -= MAX_FILE; this.activeUploads--; }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const work = this.route(req, res).catch(error => {
      if (res.headersSent) { res.end(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
      this.json(res, status, { ok: false, error: status === 500 ? 'Request failed; inspect Pi for details' : error.message });
      if (status === 500) this.publish({ type: 'surface_error', message: String(error.message ?? error) });
    });
    this.operations.add(work);
    try { await work; } finally { this.operations.delete(work); }
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // No outside network resources by default; generated apps are trusted harness clients,
    // not a sandbox. Inline code is intentional for agent-authored HTML.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
    if (this.closing) throw new HttpError(503, 'Session is closing');
    const host = req.headers.host ?? '';
    if (!this.hosts.has(host)) throw new HttpError(403, 'Unrecognized Host');
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'Invalid request target');
    const origin = `http://${host}`;
    const url = new URL(req.url, origin);
    if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Cross-origin request rejected');
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (!equal(url.searchParams.get('token') ?? '', this.token)) throw new HttpError(401, 'Invalid access token');
      if (this.cookies.size >= 32) throw new HttpError(429, 'Too many browser sessions; restart pi-surface');
      const cookie = secret(); this.cookies.add(cookie);
      res.setHeader('Set-Cookie', `${this.cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(303, { Location: '/' }); res.end(); return;
    }
    if (!this.authenticated(req)) throw new HttpError(401, 'Open the authenticated URL from /surface in Pi');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request rejected');
    if (req.method !== 'GET' && req.headers['x-pi-surface'] !== '1') throw new HttpError(403, 'Missing X-Pi-Surface header');

    if (req.method === 'GET' && url.pathname === '/api/state') { this.json(res, 200, await this.snapshot()); return; }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (this.clients.size >= 64) throw new HttpError(429, 'Too many event streams');
      const state = await this.snapshot();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      this.clients.add(res); res.on('close', () => this.clients.delete(res));
      res.write(`data: ${JSON.stringify({ type: 'snapshot', state })}\n\n`); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/invoke') {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected JSON');
      const body = JSON.parse((await this.body(req, 1024 * 1024)).toString('utf8'));
      if (!body || typeof body.method !== 'string' || !body.params || typeof body.params !== 'object' || Array.isArray(body.params)) throw new HttpError(400, 'Expected {method, params}');
      const result = body.method === 'getState' ? await this.snapshot() : await this.options.invoke(body.method, body.params);
      this.json(res, 200, { ok: true, result: result ?? null }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') { await this.upload(req, res); return; }
    const uploadMatch = /^\/api\/upload\/([a-f0-9]{32})$/.exec(url.pathname);
    if (req.method === 'DELETE' && uploadMatch) {
      const file = this.attachments.get(uploadMatch[1]);
      if (!file) throw new HttpError(404, 'Attachment not found');
      if (file.used) throw new HttpError(409, 'Attachment belongs to a sent message and is retained until session shutdown');
      await rm(file.path, { force: true }); this.attachments.delete(file.id);
      this.json(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/data/')) {
      const file = await this.store.data(decodeURIComponent(url.pathname.slice('/api/data/'.length)), url.searchParams.get('path') ?? '');
      res.writeHead(200, { 'Content-Type': contentType(file.path) }); res.end(file.body); return;
    }
    const surface = /^\/surfaces\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (req.method === 'GET' && surface) {
      const file = await this.store.asset(decodeURIComponent(surface[1]), decodeURIComponent(surface[2]));
      let body: Buffer | string = file.body;
      if (extname(file.path).toLowerCase() === '.html') {
        const html = body.toString('utf8');
        const script = '<script src="/bridge.js"></script>';
        body = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, match => match + script) : script + html;
      }
      res.writeHead(200, { 'Content-Type': contentType(file.path) }); res.end(body); return;
    }
    const assets: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/bridge.js': 'bridge.js' };
    if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
      res.writeHead(200, { 'Content-Type': contentType(assets[url.pathname]) });
      res.end(await readFile(join(webRoot, assets[url.pathname]))); return;
    }
    throw new HttpError(404, 'Not found');
  }

  async close(reason = 'shutdown') {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.heartbeat);
    this.publish({ type: 'server_closing', reason });
    for (const client of this.clients) client.end();
    this.clients.clear(); this.cookies.clear();
    await this.store?.close();
    // Close active requests too, so a stalled upload cannot hold Pi shutdown hostage.
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await Promise.allSettled([...this.operations]);
    this.attachments.clear();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

function detectImage(body: Buffer): string | undefined {
  if (body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
}

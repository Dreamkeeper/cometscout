// The workspace server (cli.mjs serve): node:http, no dependency. Static files from web/, the three browser modules
// from node_modules under /vendor/, pack files under /files/packs/, release-note images under /media/ (only the ones
// release.json names), and the JSON API (lib/workspace.mjs).
// Until sign-in exists (M5b) it listens on loopback only. Every request must name the bound host and port in its
// Host header (a DNS-rebinding page cannot); every POST must carry "X-CometScout: 1" and a JSON body (a cross-site
// form can do neither). The header from before the rename (lib/legacy-names.mjs) is accepted too.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError, todayPayload, jobPayload, packPayload, postStatus, postLater, postInterview, postSettings, settingsPayload, labelsPayload, resolvePackFile, updatePayload, postUpdate, whatsNewPayload, postWhatsNew, labelPayload, labelJobPayload, postLabel } from './workspace.mjs';
import { mediaFile } from './update.mjs';
import { OLD_HEADER } from './legacy-names.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(CODE, 'web');
const MAX_BODY = 64 * 1024;

// ---------- vendor modules ----------
// URL under /vendor/ -> [package, file inside it]. These three files are all the browser loads from node_modules.
export const VENDOR = {
  'preact.module.js': ['preact', ['dist', 'preact.module.js']],
  'preact-hooks.module.js': ['preact', ['hooks', 'dist', 'hooks.module.js']],
  'htm.module.js': ['htm', ['dist', 'htm.module.js']],
};
/** node_modules/<name>: the nearest one above the code folder, as Node itself would look; null when not installed. */
export function packageDir(name, from = CODE) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const p = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
    if (path.dirname(dir) === dir) return null;
  }
}
/** { ok, versions: { preact, htm }, missing: [files] }: whether every /vendor/ file can be served. */
export function vendorCheck() {
  const versions = {}, missing = [];
  for (const [pkg, parts] of Object.values(VENDOR)) {
    const dir = packageDir(pkg);
    if (!dir || !fs.existsSync(path.join(dir, ...parts))) { missing.push(`${pkg}/${parts.join('/')}`); continue; }
    try { versions[pkg] = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { versions[pkg] = '?'; }
  }
  return { ok: !missing.length, versions, missing };
}
const vendorFile = name => { const v = VENDOR[name]; if (!v) return null; const dir = packageDir(v[0]); return dir ? path.join(dir, ...v[1]) : null; };

// ---------- hosts ----------
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const WILDCARD = new Set(['0.0.0.0', '::', '[::]']);
export const isLoopback = host => LOOPBACK.has(String(host || '').toLowerCase()) || /^127(\.\d{1,3}){3}$/.test(String(host || ''));
const hostPart = h => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);
/** Host headers this server answers: the bound host and port; on loopback also localhost and 127.0.0.1 with that port. */
export function allowedHosts(host, port) {
  const names = new Set([hostPart(host)]);
  if (isLoopback(host)) for (const h of ['localhost', '127.0.0.1', '[::1]']) names.add(h);
  return new Set([...names].map(h => `${h}:${port}`.toLowerCase()));
}

// ---------- responses ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin' };
const send = (res, status, body, type, headers = {}) => {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
};
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
const notFound = res => json(res, 404, { error: 'not found' });

// The page's Content-Security-Policy allows its one inline script (the import map) by hash.
function indexPage() {
  const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  const hashes = [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  const csp = ["default-src 'self'", `script-src 'self' ${hashes.join(' ')}`, "style-src 'self'", "img-src 'self' data:", "frame-src 'self'", "object-src 'none'",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "connect-src 'self'"].join('; ');
  return { html, csp };
}

/** A file under web/ for a /web/ URL path (still percent-encoded), or null. Plain names only, real path inside web/. */
export function resolveWebFile(rest) {
  let names; try { names = String(rest || '').split('/').map(decodeURIComponent); } catch { return null; }
  if (!names.length || names.some(n => !n || n === '.' || n === '..' || n.startsWith('.') || /[/\\:\0]/.test(n))) return null;
  if (!TYPES[path.extname(names[names.length - 1]).toLowerCase()]) return null;
  try {
    const root = fs.realpathSync(WEB_DIR), real = fs.realpathSync(path.join(WEB_DIR, ...names)), rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    // a body over the limit is read to its end and dropped, so the client still gets the 413
    req.on('data', c => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => (size > MAX_BODY ? reject(new HttpError(413, 'body too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

const API_GET = {
  '/api/today': () => todayPayload(),
  '/api/job': q => jobPayload(q.get('file') || ''),
  '/api/pack': q => packPayload(q.get('file') || ''),
  '/api/labels': () => labelsPayload(),
  '/api/settings': () => settingsPayload(),
  '/api/update': () => updatePayload(),
  '/api/whats-new': () => whatsNewPayload(),
  '/api/label': q => labelPayload(q.get('set') || ''),
  '/api/label/job': q => labelJobPayload(q.get('set') || '', q.get('file') || ''),
};
const API_POST = { '/api/status': postStatus, '/api/later': postLater, '/api/interview': postInterview, '/api/settings': b => postSettings(b), '/api/update': b => postUpdate(b), '/api/whats-new': b => postWhatsNew(b), '/api/label': postLabel };

/** The request handler. hosts() returns the Host header values to accept (they depend on the port actually bound). */
export function makeHandler({ hosts, log = () => {} }) {
  return async (req, res) => {
    try {
      if (!hosts().has(String(req.headers.host || '').toLowerCase())) return send(res, 421, 'Misdirected request: open the workspace at the address cli.mjs serve printed.\n', 'text/plain; charset=utf-8');
      const url = new URL(req.url, 'http://workspace.invalid');
      const p = url.pathname;
      if (req.method === 'POST') {
        if (!API_POST[p]) return notFound(res);
        if (req.headers['x-cometscout'] !== '1' && req.headers[OLD_HEADER] !== '1') return json(res, 403, { error: 'missing header X-CometScout: 1' });
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return json(res, 415, { error: 'send JSON (Content-Type: application/json)' });
        let body; try { body = JSON.parse(await readBody(req) || 'null'); } catch (e) { if (e instanceof HttpError) throw e; return json(res, 400, { error: 'body is not valid JSON' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'send a JSON object' });
        const out = API_POST[p](body); log(`${p} ${body.file || ''} ${body.status || body.days || ''}`.trim());
        return json(res, 200, out);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD, POST' });
      if (API_GET[p]) return json(res, 200, API_GET[p](url.searchParams));
      if (p.startsWith('/api/')) return notFound(res);
      // /label?set=<name> is the labelling screen: the same page, web/app.js picks the view from the path
      if (p === '/' || p === '/index.html' || p === '/label') { const { html, csp } = indexPage(); return send(res, 200, html, TYPES['.html'], { 'Content-Security-Policy': csp, 'Cache-Control': 'no-cache' }); }
      if (p.startsWith('/web/')) {
        const f = resolveWebFile(p.slice('/web/'.length)); if (!f) return notFound(res);
        return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f).toLowerCase()], { 'Cache-Control': 'no-cache' });
      }
      if (p.startsWith('/vendor/')) {
        const f = vendorFile(p.slice('/vendor/'.length)); if (!f || !fs.existsSync(f)) return notFound(res);
        return send(res, 200, fs.readFileSync(f), TYPES['.js'], { 'Cache-Control': 'no-cache' });
      }
      if (p.startsWith('/media/')) {
        let rel; try { rel = decodeURIComponent(p.slice('/media/'.length)); } catch { return notFound(res); }
        const f = mediaFile(rel); if (!f) return notFound(res);
        return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f).toLowerCase()], { 'Cache-Control': 'no-cache' });
      }
      if (p.startsWith('/files/packs/')) {
        const f = resolvePackFile(p.slice('/files/packs/'.length)); if (!f) return notFound(res);
        const disp = f.type.startsWith('application/vnd') ? 'attachment' : 'inline';
        return send(res, 200, fs.readFileSync(f.path), f.type, { 'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'no-cache' });
      }
      return notFound(res);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      log(`error: ${e.stack || e.message}`);
      return json(res, 500, { error: e.message });
    }
  };
}

/**
 * Start the server. Refuses a non-loopback host unless unsafeNoAuth (there is no sign-in yet), and refuses to start
 * without the browser modules. Resolves to { server, url, host, port, close }.
 */
export async function startServer({ host = '127.0.0.1', port = 8787, unsafeNoAuth = false, log = console.log } = {}) {
  // The Host check answers only the bound address, so a wildcard bind could be reached by no name at all.
  if (WILDCARD.has(String(host).toLowerCase())) throw new Error(`refusing to listen on ${host}: bind the address you will open (e.g. --host 192.168.1.5), even with --unsafe-no-auth`);
  if (!isLoopback(host) && !unsafeNoAuth) throw new Error(`refusing to listen on ${host}: the workspace has no sign-in yet, so it binds to loopback only. Reach it through an SSH tunnel (ssh -L ${port}:127.0.0.1:${port} <server>), or add --unsafe-no-auth if you accept that anyone who can reach ${host}:${port} can read your queue and packs`);
  const v = vendorCheck();
  if (!v.ok) throw new Error(`the workspace needs preact and htm from node_modules (missing: ${v.missing.join(', ')}); run npm install in ${CODE}`);
  let bound = null;
  const server = http.createServer(makeHandler({ hosts: () => bound || new Set(), log }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  bound = allowedHosts(host, actual);
  const url = `http://${hostPart(host)}:${actual}/`;
  return { server, url, host, port: actual, close: () => new Promise(r => server.close(() => r())) };
}

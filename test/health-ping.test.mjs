// Health ping: GET <url> on exit 0, <url>/<code> otherwise, 10 s timeout, never fatal, never logs the URL.
// fetch is injected; the last test runs cli.mjs run against a local HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-ping-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));
const { healthPing } = await import('../lib/ops.mjs');

const URL_SECRET = 'https://hc-ping.example/0b1c2d3e-secret-uuid';
const fakeFetch = (respond) => { const calls = []; const f = async (url, opts) => { calls.push({ url, opts }); return respond(url, opts); }; f.calls = calls; return f; };
async function captured(fn) {
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try { return { result: await fn(), out: lines.join('\n') }; } finally { console.log = orig; }
}

test('no ping_url: nothing is fetched', async () => {
  const f = fakeFetch(() => ({ ok: true, status: 200 }));
  assert.equal(await healthPing(0, { url: '', fetch: f }), 'off');
  assert.equal(f.calls.length, 0);
});

test('exit 0 pings the URL, any other exit pings <url>/<code>, with a timeout', async () => {
  const f = fakeFetch(() => ({ ok: true, status: 200 }));
  const { result, out } = await captured(() => healthPing(0, { url: URL_SECRET, fetch: f }));
  assert.equal(result, 'sent');
  await healthPing(3, { url: `${URL_SECRET}/`, fetch: f });
  await healthPing(1, { url: URL_SECRET, fetch: f });
  assert.deepEqual(f.calls.map(c => c.url), [URL_SECRET, `${URL_SECRET}/3`, `${URL_SECRET}/1`]);
  assert.equal(f.calls[0].opts.method, 'GET');
  assert.ok(f.calls[0].opts.signal instanceof AbortSignal);
  assert.ok(!out.includes('secret-uuid'), 'the URL is never logged');
});

test('failures are logged without the URL and never throw', async () => {
  for (const [name, f] of [
    ['network', fakeFetch(() => { throw new TypeError(`fetch failed for ${URL_SECRET}`); })],
    ['http', fakeFetch(() => ({ ok: false, status: 500 }))],
    ['timeout', async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))],
  ]) {
    const alive = setInterval(() => {}, 1000);   // AbortSignal.timeout does not keep the process alive on its own; a real request does
    const { result, out } = await captured(() => healthPing(2, { url: URL_SECRET, fetch: f, timeoutMs: 50 }));
    clearInterval(alive);
    assert.equal(result, 'failed', name);
    assert.match(out, /health ping failed/);
    assert.ok(!out.includes('secret-uuid'), `${name}: the URL is never logged`);
    if (name === 'timeout') assert.match(out, /timed out/);
    if (name === 'http') assert.match(out, /HTTP 500/);
  }
});

test('cli.mjs run pings after the run (here: skipped, no profile yet, exit 0)', async () => {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.end('OK'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/ping-secret-uuid`;
  const settings = path.join(tmp, 'run-settings.json');
  fs.writeFileSync(settings, JSON.stringify({ timezone: 'UTC', health: { ping_url: url } }));
  const child = spawn(process.execPath, [path.join(ROOT, 'cli.mjs'), 'run'], { env: { ...process.env, COMETSCOUT_SETTINGS: settings, NO_PROXY: '*' } });
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const code = await new Promise(r => child.on('close', r));
  server.close();
  assert.equal(code, 0, out);
  assert.match(out, /no profile\/ yet/);
  assert.deepEqual(hits, ['/ping-secret-uuid']);
  assert.match(out, /health ping sent \(exit 0\)/);
  assert.ok(!out.includes('ping-secret-uuid'));
});

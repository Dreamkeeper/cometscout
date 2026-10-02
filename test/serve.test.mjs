// cli.mjs serve: starts on a free port, GET / returns the page with the import map, every module the page loads
// (the import map's targets, the entry and everything it imports, followed recursively) answers 200 with a
// JavaScript type; a non-loopback --host is refused unless --unsafe-no-auth, which warns. Synthetic, empty data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-serve-'));
const settings = path.join(tmp, 'settings.json');
fs.writeFileSync(settings, JSON.stringify({ timezone: 'UTC' }));
const env = { ...process.env, JOBPILOT_HOME: tmp, JOBPILOT_DATA: path.join(tmp, 'data'), JOBPILOT_SETTINGS: settings };

/** Start `cli.mjs serve` and wait for the address it prints. */
function serve(args) {
  const child = spawn(process.execPath, [path.join(ROOT, 'cli.mjs'), 'serve', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no address after 20 s:\n${out}`)), 20000);
    child.stdout.on('data', c => { out += c; const m = out.match(/jobpilot workspace: (http:\/\/\S+\/)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.stderr.on('data', c => { out += c; });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`serve exited with ${code}:\n${out}`)); });
  });
  return { child, ready, output: () => out };
}
const stop = child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(); });

// Module specifiers in a JavaScript file: static imports and re-exports ("import x from '...'", "import '...'", "export ... from '...'").
const specifiers = js => [...js.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"']+)["']/g)].map(m => m[1]);

test('serve answers GET / with the import map, and every module it references with a JavaScript type', async () => {
  const s = serve(['--port', '0']);
  try {
    const base = await s.ready;
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    const html = await page.text();
    const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
    assert.deepEqual(Object.keys(map).sort(), ['htm', 'preact', 'preact/hooks']);
    const entries = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(entries, ['/web/app.js']);
    const css = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
    for (const c of css) { const r = await fetch(new URL(c, base)); assert.equal(r.status, 200, c); assert.match(r.headers.get('content-type'), /^text\/css/); }
    // Follow every import from the entry and the import map's targets.
    const seen = new Set(), queue = [...entries, ...Object.values(map)].map(u => new URL(u, base).href);
    while (queue.length) {
      const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
      const r = await fetch(url);
      assert.equal(r.status, 200, url);
      assert.match(r.headers.get('content-type'), /^text\/javascript/, url);
      for (const spec of specifiers(await r.text())) {
        if (map[spec]) queue.push(new URL(map[spec], base).href);
        else { assert.match(spec, /^\.{1,2}\//, `${url} imports "${spec}", which is neither relative nor in the import map`); queue.push(new URL(spec, url).href); }
      }
    }
    const paths = [...seen].map(u => new URL(u).pathname);
    for (const p of ['/web/app.js', '/vendor/preact.module.js', '/vendor/preact-hooks.module.js', '/vendor/htm.module.js', '/web/lib/logic.js', '/web/components/PackPane.js']) assert.ok(paths.includes(p), p);
    const today = await (await fetch(new URL('/api/today', base))).json();
    assert.deepEqual(today.picks, []);
    assert.deepEqual(today.pool, []);
  } finally { await stop(s.child); }
});

test('a non-loopback --host is refused; --unsafe-no-auth starts it with a warning', async () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'serve', '--host', '0.0.0.0', '--port', '0'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /refusing to listen on 0\.0\.0\.0: the workspace has no sign-in yet/);
  assert.match(spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'serve', '--port', 'x'], { env, encoding: 'utf8', timeout: 30000 }).stdout, /--port must be a number/);
  const s = serve(['--host', '0.0.0.0', '--port', '0', '--unsafe-no-auth']);
  try {
    const base = await s.ready;
    assert.match(s.output(), /^WARNING: --unsafe-no-auth: the workspace has no sign-in/m);
    const r2 = await fetch(base.replace('0.0.0.0', '127.0.0.1'));
    assert.equal(r2.status, 421, 'bound to 0.0.0.0, it still answers only Host: 0.0.0.0:<port>');
  } finally { await stop(s.child); }
});

test('doctor reports the workspace modules', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'doctor'], { env, encoding: 'utf8', timeout: 120000 });
  assert.match(r.stdout, /^ok {3}workspace modules: preact \d+\.\d+\.\d+, htm \d+\.\d+\.\d+$/m);
});

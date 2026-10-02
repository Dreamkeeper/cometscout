// applications.json safety: a broken file stops cli.mjs run / sources before any source runs, sources check it before
// they mark anything seen, cli.mjs applied/status never overwrite it; a record without role words is announced;
// scripts started through a symlinked (or junction) folder still run. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-apps-'));
const DATA = path.join(tmp, 'data'), DROP = path.join(tmp, 'drop');
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = DATA;
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC', sources: { drop_dir: { enabled: true, dir: DROP, settle_sec: 0 } } }));
for (const d of [DROP, path.join(DATA, 'state'), path.join(DATA, 'decoded')]) fs.mkdirSync(d, { recursive: true });
const APPS = path.join(DATA, 'state', 'applications.json');
const DROPPED = path.join(DROP, 'job.md');
fs.writeFileSync(DROPPED, '---\ncompany: "Quillmark"\nrole: "Product Manager"\nurl: "https://quillmark.example/1"\n---\n\nSynthetic job text.\n');
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { encoding: 'utf8', env: process.env, timeout: 60000 });
const BROKEN = '{ "manual:acme|pm": { "company": "Acme", ';

test('scripts run when started through a symlinked or junction folder', t => {
  const link = path.join(tmp, 'linked-home');
  try { fs.symlinkSync(ROOT, link, 'junction'); } catch (e) { t.skip(`cannot create a link here: ${e.code}`); return; }
  const run = file => spawnSync(process.execPath, [path.join(link, file), ...(file.includes('decoder') ? ['--picks'] : [])], { encoding: 'utf8', env: { ...process.env, JOBPILOT_DATA: path.join(tmp, 'link-data') }, timeout: 60000 });
  const dec = run(path.join('decoder', 'decoder.mjs'));
  assert.equal(dec.status, 0, dec.stderr);
  assert.match(dec.stdout, /no picks \(0 open\)/, 'the decoder did its work');
  assert.match(run(path.join('sources', 'outcomes.mjs')).stdout, /outcomes: disabled in settings\.json/);
});

test('a record without role words prints a warning; one with role words does not', () => {
  fs.rmSync(APPS, { force: true });
  const a = cli('applied', 'Zephyrine', '--manual');
  assert.equal(a.status, 0, a.stdout);
  assert.match(a.stdout, /^Note: no role words recorded, so every pick at Zephyrine is now treated as closed\./m);
  assert.match(cli('status', 'Yarrowby', 'screen', 'PM', '--manual').stdout, /^Note: no role words recorded/m, '"PM" has no word longer than 2 characters');
  assert.doesNotMatch(cli('status', 'Xanthe', 'applied', 'Data', 'Analyst', '--manual').stdout, /Note:/);
});

test('cli.mjs applied and status refuse to overwrite a broken applications.json', () => {
  fs.writeFileSync(APPS, BROKEN);
  for (const args of [['applied', 'Acme', '--manual'], ['status', 'Acme', 'rejected', 'PM', '--manual']]) {
    const r = cli(...args);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /applications\.json is not valid JSON .*fix it and run again\. Nothing was recorded\./);
    assert.equal(fs.readFileSync(APPS, 'utf8'), BROKEN, 'the file is untouched');
  }
});

test('cli.mjs sources and run stop before any source runs when applications.json is broken', () => {
  fs.writeFileSync(APPS, BROKEN);
  for (const args of [['sources'], ['run', '--example']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^jobpilot: .*applications\.json is not valid JSON .*fix it and run again$/m);
    assert.ok(fs.existsSync(DROPPED), 'the drop-dir source did not run');
    assert.ok(!fs.existsSync(path.join(DATA, 'state', 'drop-dir.json')), 'nothing marked');
  }
  assert.equal(fs.readFileSync(APPS, 'utf8'), BROKEN);
});

test('a source checks applications.json before it marks anything seen', async () => {
  fs.writeFileSync(APPS, BROKEN);
  const { run } = await import('../sources/drop-dir.mjs');
  await assert.rejects(run({ fetch: async () => { throw new Error('no network in tests'); } }), /applications\.json is not valid JSON/);
  assert.ok(fs.existsSync(DROPPED));
  assert.ok(!fs.existsSync(path.join(DROP, 'processed')));
  assert.ok(!fs.existsSync(path.join(DATA, 'state', 'drop-dir.json')));
  fs.rmSync(APPS);
  const r = await run({ fetch: async () => { throw new Error('no network in tests'); } });
  assert.equal(r.ran, true, 'with a valid (here: missing) file the same run goes ahead');
});

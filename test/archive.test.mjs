// Export / import: round trip (folder and .tar.gz), damage detection, conflicts, profile/settings opt-in, .env never exported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-archive-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, 'profile'), { recursive: true });
fs.writeFileSync(path.join(home, 'profile', 'profile.md'), '# Me\nfacts');
fs.writeFileSync(path.join(home, '.env'), 'RTJ_API_TOKEN=secret-value-123');
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ candidate_name: 'Me' }));
process.env.JOBPILOT_HOME = home;
process.env.JOBPILOT_DATA = path.join(home, 'data');
delete process.env.JOBPILOT_SETTINGS;
const { DATA } = await import('../lib/config.mjs');
const { exportData, importData, openArchive } = await import('../lib/archive.mjs');

const ORIGINAL = '---\ncompany: "Acme"\n---\nbody\n';
const JOB = path.join(DATA, 'decoded', '2026-09-01--acme--pm.md');
fs.mkdirSync(path.dirname(JOB), { recursive: true });
fs.writeFileSync(JOB, ORIGINAL);
fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'state', 'applications.json'), JSON.stringify({ x: { status: 'applied', events: [{ date: '2026-09-02', type: 'applied' }] } }));
fs.writeFileSync(path.join(DATA, 'state', 'run.lock'), '123');

test('folder export carries data, never .env or the lock; profile and settings only on request', () => {
  const out = path.join(tmp, 'exp-folder');
  const r = exportData({ out, withProfile: true, withSettings: true });
  assert.equal(r.counts.decoded, 1);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.format, 'jobpilot-export-v1');
  assert.ok(m.files['data/state/applications.json']);
  assert.ok(m.files['profile/profile.md']);
  assert.ok(m.files['settings.json']);
  assert.equal(m.files['data/state/run.lock'], undefined);
  assert.ok(!Object.keys(m.files).some(f => f.includes('.env')));
});

test('tar.gz round trip into an empty install; a repeat import changes nothing', () => {
  const gz = path.join(tmp, 'exp.tar.gz');
  exportData({ out: gz });
  assert.equal(openArchive(gz).bad.length, 0);
  const target = path.join(tmp, 'other-data');
  const run = args => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, JOBPILOT_DATA: target }, encoding: 'utf8' });
  const first = run(['import', '--from', gz]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Imported from jobpilot .*: 2 new, 0 already identical, 0 conflict/);
  assert.equal(fs.readFileSync(path.join(target, 'decoded', '2026-09-01--acme--pm.md'), 'utf8'), ORIGINAL);
  const again = run(['import', '--from', gz]);
  assert.match(again.stdout, /0 new, 2 already identical, 0 conflict/);
});

test('a changed file in the archive is refused; a local conflict needs --force', () => {
  const damaged = path.join(tmp, 'exp-damaged');
  exportData({ out: damaged });
  fs.appendFileSync(path.join(damaged, 'data', 'decoded', '2026-09-01--acme--pm.md'), 'tampered');
  assert.throws(() => importData({ from: damaged }), /damaged/);

  const clean = path.join(tmp, 'exp-clean');
  exportData({ out: clean });
  fs.writeFileSync(JOB, 'local edit\n');
  assert.equal(importData({ from: clean, dryRun: true }).plan.conflict.length, 1);
  assert.throws(() => importData({ from: clean }), /conflict/);
  assert.equal(fs.readFileSync(JOB, 'utf8'), 'local edit\n', 'a refused import leaves local files alone');
  importData({ from: clean, force: true });
  assert.equal(fs.readFileSync(JOB, 'utf8'), ORIGINAL, '--force puts the archived copy back');
});

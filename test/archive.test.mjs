// Export / import, format v2 (zip) and v1 (folder, tar.gz): manifest, what is never exported (secrets scanned for),
// byte-for-byte round trip, dry-run plan, the three conflict modes, refusals (newer schema, damage, unsafe names).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(CODE, 'cli.mjs');
const PKG = JSON.parse(fs.readFileSync(path.join(CODE, 'package.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-archive-'));
const home = path.join(tmp, 'home');
const PLANTED = 'planted-secret-value-7f3a9c';
const COOKIE = 'planted-cookie-value-1b2c3d';
fs.mkdirSync(path.join(home, 'profile'), { recursive: true });
fs.writeFileSync(path.join(home, 'profile', 'profile.md'), '# Alex Example\nsynthetic facts');
fs.writeFileSync(path.join(home, '.env'), `RTJ_API_TOKEN=${PLANTED}\n`);
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ candidate_name: 'Alex Example', timezone: 'UTC' }));
process.env.JOBPILOT_HOME = home;
process.env.JOBPILOT_DATA = path.join(home, 'data');
delete process.env.JOBPILOT_SETTINGS;
const { DATA } = await import('../lib/config.mjs');
const { exportArchive, importArchive, openArchive, defaultExportName, collect, SCHEMA_VERSION } = await import('../lib/archive.mjs');
const { readZip, readEntry } = await import('../lib/zip.mjs');

const ORIGINAL = '---\ncompany: "Acme"\n---\nbody\n';
const JOB = path.join(DATA, 'decoded', '2026-09-01--acme--pm.md');
const PDF = crypto.randomBytes(5000);
const put = (rel, body) => { const p = path.join(DATA, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
put('decoded/2026-09-01--acme--pm.md', ORIGINAL);
put('packs/2026-09-01--acme--pm/Резюме.pdf', PDF);
put('state/applications.json', JSON.stringify({ x: { status: 'applied', events: [{ date: '2026-09-02', type: 'applied' }] } }));
put('state/hirify-cookies.json', JSON.stringify({ env: 'x', cookies: { s: COOKIE } }));
put('state/hirify-cookies.json.replaced-2026-09-01', JSON.stringify({ cookies: { s: COOKIE } }));
put('state/run.lock', '123');
put('state/half.json.tmp', '{');

// A second install for imports: its own home and data folder
const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env: { ...process.env, ...env } });
function freshHome(name) {
  const h = path.join(tmp, name); fs.mkdirSync(h, { recursive: true });
  return { home: h, env: { JOBPILOT_HOME: h, JOBPILOT_DATA: path.join(h, 'data') } };
}
async function allEntries(zipFile) {
  const z = readZip(zipFile); const out = {};
  for (const e of z.entries) out[e.name] = await readEntry(z, e);
  return out;
}
const filesIn = dir => fs.readdirSync(dir, { recursive: true }).filter(f => fs.statSync(path.join(dir, f)).isFile()).sort();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

test('a v2 zip carries data, profile and settings with a full manifest; never secrets, the lock or temp files', async () => {
  const out = path.join(tmp, 'full.zip');
  const r = await exportArchive({ out });
  const files = await allEntries(out);
  const m = JSON.parse(files['manifest.json'].toString('utf8'));
  assert.equal(m.format, 'jobpilot-export'); assert.equal(m.version, 2);
  assert.equal(m.app_version, PKG.version); assert.equal(m.schema_version, SCHEMA_VERSION);
  assert.ok(m.exported_at && m.source_host);
  assert.deepEqual(m.contents, ['data', 'profile', 'settings']);
  assert.deepEqual(Object.keys(m.files).sort(), ['data/decoded/2026-09-01--acme--pm.md', 'data/packs/2026-09-01--acme--pm/Резюме.pdf', 'data/state/applications.json', 'profile/profile.md', 'settings.json']);
  assert.deepEqual(m.counts, { decoded: 1, packs: 1, state: 1, profile: 1, 'settings.json': 1 });
  for (const [rel, h] of Object.entries(m.files)) assert.equal(sha(files[rel]), h, rel);
  assert.ok(files['data/packs/2026-09-01--acme--pm/Резюме.pdf'].equals(PDF));
  assert.equal(r.files, 5);
  // scan every name and every byte, compressed and not, for the secrets
  const raw = fs.readFileSync(out);
  assert.ok(!Object.keys(files).some(n => /(^|\/)\.env/.test(n) || n.includes('hirify-cookies') || n.includes('run.lock') || n.endsWith('.tmp')));
  for (const blob of [raw, ...Object.values(files)]) for (const s of [PLANTED, COOKIE, '.env']) assert.ok(!blob.includes(s), `found ${s}`);
  assert.match(defaultExportName(), new RegExp(`^jobpilot-export-\\d{4}-\\d{2}-\\d{2}-v${PKG.version.replace(/\./g, '\\.')}\\.zip$`));
});

test('--data-only leaves profile and settings out', async () => {
  const out = path.join(tmp, 'data-only.zip');
  const r = await exportArchive({ out, dataOnly: true });
  assert.deepEqual(r.manifest.contents, ['data']);
  assert.ok(Object.keys(r.manifest.files).every(f => f.startsWith('data/')));
  assert.deepEqual(collect({ dataOnly: true }).contents, ['data']);
});

test('export, import into an empty install, export again: identical hashes and bytes; a repeat import changes nothing', async () => {
  const first = path.join(tmp, 'rt1.zip'); await exportArchive({ out: first });
  const other = freshHome('rt-home');
  const imp = cli(['import', '--from', first], other.env);
  assert.equal(imp.status, 0, imp.stdout + imp.stderr);
  assert.match(imp.stdout, /5 new, 0 identical, 0 conflicting/);
  assert.match(imp.stdout, /Imported 5 file\(s\)/);
  assert.ok(fs.readFileSync(path.join(other.home, 'data', 'packs', '2026-09-01--acme--pm', 'Резюме.pdf')).equals(PDF));
  assert.equal(fs.readFileSync(path.join(other.home, 'profile', 'profile.md'), 'utf8'), '# Alex Example\nsynthetic facts');
  assert.ok(!fs.existsSync(path.join(other.home, '.env')));
  const second = path.join(tmp, 'rt2.zip');
  const exp = cli(['export', '--out', second], other.env);
  assert.equal(exp.status, 0, exp.stdout + exp.stderr);
  const [a, b] = [await allEntries(first), await allEntries(second)];
  assert.deepEqual(JSON.parse(a['manifest.json']).files, JSON.parse(b['manifest.json']).files);
  for (const n of Object.keys(a)) if (n !== 'manifest.json') assert.ok(a[n].equals(b[n]), n);
  const again = cli(['import', '--from', first], other.env);
  assert.match(again.stdout, /0 new, 5 identical, 0 conflicting/);
});

// A v1 archive as the old code wrote it: a folder with manifest { format: "jobpilot-export-v1", version: 1, ... }
function v1Folder(dir) {
  const files = { 'data/decoded/2026-08-01--globex--pm.md': '---\ncompany: "Globex"\n---\nold\n', 'data/state/rtj-state.json': '{"last_before":null}' };
  for (const [rel, body] of Object.entries(files)) { const p = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
  const m = { format: 'jobpilot-export-v1', version: 1, exported_at: '2026-08-02T10:00:00.000Z', source: 'jobpilot', counts: { decoded: 1, state: 1 }, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(Buffer.from(v))])) };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return files;
}
test('v1 archives still import: a folder and a tar.gz', async t => {
  const dir = path.join(tmp, 'v1'); const files = v1Folder(dir);
  const a = freshHome('v1-folder');
  const r = cli(['import', '--from', dir], a.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /jobpilot-export v1/); assert.match(r.stdout, /2 new/);
  assert.equal(fs.readFileSync(path.join(a.home, 'data', 'decoded', '2026-08-01--globex--pm.md'), 'utf8'), files['data/decoded/2026-08-01--globex--pm.md']);
  const tgz = path.join(tmp, 'v1.tar.gz');
  const t1 = spawnSync('tar', ['-czf', path.basename(tgz), '-C', dir, '.'], { cwd: tmp, encoding: 'utf8' });
  if (t1.error || t1.status !== 0) { t.skip('no tar on this system'); return; }
  const b = freshHome('v1-tgz');
  const r2 = cli(['import', '--from', tgz], b.env);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(fs.readFileSync(path.join(b.home, 'data', 'state', 'rtj-state.json'), 'utf8'), '{"last_before":null}');
});

test('dry run prints new, identical and conflicting files and writes nothing', async () => {
  const out = path.join(tmp, 'plan.zip'); await exportArchive({ out });
  const other = freshHome('plan-home');
  fs.mkdirSync(path.join(other.home, 'data', 'decoded'), { recursive: true });
  fs.writeFileSync(path.join(other.home, 'data', 'decoded', '2026-09-01--acme--pm.md'), 'their local edit\n');
  fs.mkdirSync(path.join(other.home, 'data', 'state'), { recursive: true });
  fs.writeFileSync(path.join(other.home, 'data', 'state', 'applications.json'), fs.readFileSync(path.join(DATA, 'state', 'applications.json')));
  const before = filesIn(other.home);
  const r = cli(['import', '--from', out, '--dry-run'], other.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Dry run, nothing written/);
  assert.match(r.stdout, /3 new, 1 identical, 1 conflicting/);
  assert.match(r.stdout, /data\/decoded\/2026-09-01--acme--pm\.md: keep yours/);
  assert.match(r.stdout, /New:\n(.*\n)*\s+profile\/profile\.md/);
  assert.deepEqual(filesIn(other.home), before);
});

test('conflict modes: keep, theirs (the replaced file is backed up first), both', async () => {
  const out = path.join(tmp, 'modes.zip'); await exportArchive({ out, dataOnly: true });
  fs.writeFileSync(JOB, 'local edit\n');
  let r = await importArchive({ from: out, onConflict: 'keep' });
  assert.deepEqual(r.plan.conflict.map(c => [c.rel, c.action]), [['data/decoded/2026-09-01--acme--pm.md', 'keep']]);
  assert.equal(fs.readFileSync(JOB, 'utf8'), 'local edit\n');

  r = await importArchive({ from: out, onConflict: 'both', date: '2026-10-02' });
  const copy = path.join(DATA, 'decoded', '2026-09-01--acme--pm.imported-2026-10-02.md');
  assert.equal(r.plan.conflict[0].as, copy);
  assert.equal(fs.readFileSync(copy, 'utf8'), ORIGINAL);
  assert.equal(fs.readFileSync(JOB, 'utf8'), 'local edit\n');
  r = await importArchive({ from: out, onConflict: 'both', date: '2026-10-02', dryRun: true });
  assert.match(r.plan.conflict[0].as, /\.imported-2026-10-02-2\.md$/, 'an existing .imported copy is never overwritten');
  fs.rmSync(copy);

  r = await importArchive({ from: out, onConflict: 'theirs' });
  assert.equal(fs.readFileSync(JOB, 'utf8'), ORIGINAL);
  assert.ok(r.saved && fs.existsSync(r.saved), 'replaced files saved first');
  assert.match(path.basename(r.saved), /^jobpilot-backup-.*--pre-import\.zip$/);
  assert.equal(path.dirname(r.saved), path.join(home, 'backups'));
  const saved = await allEntries(r.saved);
  assert.equal(saved['data/decoded/2026-09-01--acme--pm.md'].toString(), 'local edit\n');
  const sm = JSON.parse(saved['manifest.json']); assert.equal(sm.partial, true); assert.equal(sm.label, 'pre-import');
});

test('profile and settings conflicts need an explicit choice; without one nothing is written', async () => {
  const out = path.join(tmp, 'choice.zip'); await exportArchive({ out });
  const other = freshHome('choice-home');
  fs.mkdirSync(path.join(other.home, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(other.home, 'profile', 'profile.md'), '# Someone else\n');
  const r = cli(['import', '--from', out], other.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /profile\/profile\.md: needs --on-conflict keep, theirs or both/);
  assert.match(r.stdout, /Import stopped: .*choose with --on-conflict/);
  assert.ok(!fs.existsSync(path.join(other.home, 'data', 'decoded', '2026-09-01--acme--pm.md')), 'no new file written either');
  const k = cli(['import', '--from', out, '--on-conflict', 'keep'], other.env);
  assert.equal(k.status, 0, k.stdout);
  assert.equal(fs.readFileSync(path.join(other.home, 'profile', 'profile.md'), 'utf8'), '# Someone else\n');
  assert.ok(fs.existsSync(path.join(other.home, 'data', 'decoded', '2026-09-01--acme--pm.md')));
  const d = cli(['import', '--from', out, '--data-only'], freshHome('choice-data-only').env);
  assert.equal(d.status, 0, d.stdout); assert.match(d.stdout, /left out/);
});

test('a newer schema or format is refused, and so is a damaged archive or an unsafe name, before anything is written', async () => {
  const mk = (name, edit) => {
    const dir = path.join(tmp, name); v1Folder(dir);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    Object.assign(m, { format: 'jobpilot-export', version: 2, schema_version: SCHEMA_VERSION });
    edit(m, dir); fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m)); return dir;
  };
  const target = freshHome('refuse-home');
  const tryImport = dir => cli(['import', '--from', dir], target.env);
  let r = tryImport(mk('newer-schema', m => { m.schema_version = SCHEMA_VERSION + 1; }));
  assert.equal(r.status, 1); assert.match(r.stdout, /newer data schema .*update jobpilot first/);
  r = tryImport(mk('newer-format', m => { m.version = 3; }));
  assert.match(r.stdout, /made by a newer jobpilot/);
  r = tryImport(mk('damaged', (m, dir) => fs.appendFileSync(path.join(dir, 'data', 'state', 'rtj-state.json'), 'x')));
  assert.match(r.stdout, /archive is damaged: 1 file.*rtj-state\.json.*nothing was imported/);
  r = tryImport(mk('unsafe', m => { m.files['../outside.txt'] = sha(Buffer.from('x')); }));
  assert.match(r.stdout, /"\.\.\/outside\.txt": name contains "\.\."/);
  assert.ok(!fs.existsSync(path.join(target.home, 'data', 'decoded', '2026-08-01--globex--pm.md')), 'nothing written by any refused import');
  // a zip with a bad CRC is refused too
  const z = path.join(tmp, 'crc.zip'); await exportArchive({ out: z, dataOnly: true });
  const raw = fs.readFileSync(z); const i = raw.indexOf(Buffer.from(ORIGINAL)); assert.ok(i > 0, 'small file stored'); raw[i + 3] ^= 0x20; fs.writeFileSync(z, raw);
  await assert.rejects(openArchive(z), /CRC mismatch/);
});

test('export refuses a .tar.gz name and a non-empty folder; a folder export imports like a zip', async () => {
  await assert.rejects(exportArchive({ out: path.join(tmp, 'x.tar.gz') }), /ZIP files now/);
  const dir = path.join(tmp, 'folder-export'); await exportArchive({ out: dir });
  await assert.rejects(exportArchive({ out: dir }), /not empty/);
  const a = await openArchive(dir); a.cleanup();
  assert.equal(a.version, 2); assert.deepEqual(a.bad, []);
  assert.ok(fs.readFileSync(path.join(dir, 'data', 'packs', '2026-09-01--acme--pm', 'Резюме.pdf')).equals(PDF));
});

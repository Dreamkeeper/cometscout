// Backups: names and labels, pruning over a synthetic 120-day history, offsite copy, the nightly backup in cli.mjs run
// (and its failure path), doctor lines, restore (a backup first, the run lock, dry run, damaged backups).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-backup-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, 'profile'), { recursive: true });
fs.writeFileSync(path.join(home, 'profile', 'profile.md'), '# Alex Example\n');
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ timezone: 'UTC', sources: {}, pack: { enabled: false } }));
fs.writeFileSync(path.join(home, '.env'), 'RTJ_API_TOKEN=planted-backup-secret-42\n');
process.env.JOBPILOT_HOME = home;
process.env.JOBPILOT_DATA = path.join(home, 'data');
delete process.env.JOBPILOT_SETTINGS;
const { DATA } = await import('../lib/config.mjs');
const B = await import('../lib/backup.mjs');
const { readZip, readEntry } = await import('../lib/zip.mjs');
const { APP_VERSION } = await import('../lib/archive.mjs');

const JOB = path.join(DATA, 'decoded', '2026-09-01--acme--pm.md');
fs.mkdirSync(path.dirname(JOB), { recursive: true });
fs.writeFileSync(JOB, 'original\n');
const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env: { ...process.env, ...env } });
const manifestOf = async f => { const z = readZip(f); return JSON.parse(await readEntry(z, z.entries.find(e => e.name === 'manifest.json'))); };

test('names carry date, time, version and label; labels are cleaned', () => {
  assert.equal(B.backupName({ date: '2026-10-02', time: '183005' }, 'pre-update-v0.4.0', '0.3.1'), 'jobpilot-backup-2026-10-02-183005-v0.3.1--pre-update-v0.4.0.zip');
  assert.deepEqual(B.parseName('jobpilot-backup-2026-10-02-183005-v0.3.1--pre-update-v0.4.0.zip'), { name: 'jobpilot-backup-2026-10-02-183005-v0.3.1--pre-update-v0.4.0.zip', date: '2026-10-02', time: '183005', version: '0.3.1', label: 'pre-update-v0.4.0' });
  assert.equal(B.parseName('jobpilot-backup-2026-10-02-183005-v0.4.0-beta.1.zip').version, '0.4.0-beta.1');
  assert.equal(B.parseName('notes.txt'), null);
  assert.equal(B.cleanLabel('Before Moving / Server!'), 'before-moving-server');
  assert.throws(() => B.cleanLabel('///'), /cannot be used/);
  assert.deepEqual(B.stamp(new Date('2026-10-02T22:30:05Z'), 'Europe/Madrid'), { date: '2026-10-03', time: '003005' });
  assert.deepEqual(B.stamp(new Date('2026-10-02T22:30:05Z'), 'Not/AZone'), { date: '2026-10-02', time: '223005' });
});

test('pruning a 120-day history keeps 7 daily, 4 weekly, 6 monthly and labelled backups up to 90 days', () => {
  const list = [];
  const add = (date, time = '183000', label = null) => list.push(B.parseName(B.backupName({ date, time }, label, '0.1.0')));
  for (let t = Date.parse('2026-06-05T00:00:00Z'); t <= Date.parse('2026-10-02T00:00:00Z'); t += 86400000) add(new Date(t).toISOString().slice(0, 10));
  assert.equal(list.length, 120);
  add('2026-09-26', '060000');                         // an earlier backup the same day: the daily slot takes the newest
  add('2026-09-15', '120000', 'pre-update-v0.2.0');    // 17 days old: kept
  add('2026-06-20', '120000', 'pre-update-v0.1.5');    // 104 days old: pruned
  const { keep, remove } = B.prunePlan(list, '2026-10-02');
  const day = n => n.slice(16, 26);
  assert.deepEqual(keep.filter(n => !B.parseName(n).label).map(day), [
    '2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29', '2026-09-28', '2026-09-27', '2026-09-26',   // 7 daily
    '2026-09-20', '2026-09-13',                                                                            // weekly (Mon to Sun) beyond those
    '2026-08-31', '2026-07-31', '2026-06-30',                                                              // monthly beyond those
  ]);
  assert.deepEqual(keep.filter(n => B.parseName(n).label), ['jobpilot-backup-2026-09-15-120000-v0.1.0--pre-update-v0.2.0.zip']);
  assert.ok(remove.includes('jobpilot-backup-2026-09-26-060000-v0.1.0.zip'));
  assert.ok(remove.includes('jobpilot-backup-2026-06-20-120000-v0.1.0--pre-update-v0.1.5.zip'));
  assert.equal(keep.length + remove.length, list.length);
});

test('the newest three backups of any kind are never pruned', () => {
  const l = ['2025-01-04', '2025-01-03', '2025-01-02', '2025-01-01'].map(d => B.parseName(B.backupName({ date: d, time: '100000' }, 'pre-restore', '0.1.0')));
  const { keep, remove } = B.prunePlan(l, '2026-10-02');
  assert.equal(keep.length, 3); assert.deepEqual(remove, [l[3].name]);
});

test('backup writes a v2 zip with its label into backups/, prunes old ones, never includes .env or other backups', async () => {
  const dir = B.backupsDir(); fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= 10; n++) fs.writeFileSync(path.join(dir, B.backupName({ date: `2025-01-${String(n).padStart(2, '0')}`, time: '100000' }, null, '0.1.0')), 'old');
  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'not a backup');
  const now = new Date('2026-10-02T18:30:00Z');
  const r = await B.backup({ now, label: 'Manual Test' });
  assert.equal(path.basename(r.file), `jobpilot-backup-2026-10-02-183000-v${APP_VERSION}--manual-test.zip`);
  assert.equal(path.dirname(r.file), dir);
  const m = await manifestOf(r.file);
  assert.equal(m.label, 'manual-test'); assert.equal(m.version, 2);
  assert.deepEqual(m.contents, ['data', 'profile', 'settings']);
  assert.ok(!Object.keys(m.files).some(f => f.includes('.env') || f.startsWith('backups')));
  assert.ok(!fs.readFileSync(r.file).includes('planted-backup-secret-42'));
  // 2025-01-01 to 01-10: today's backup is labelled, so the 7 daily slots take 01-10 to 01-04; weekly and monthly add nothing older
  assert.deepEqual(r.pruned, ['03', '02', '01'].map(d => `jobpilot-backup-2025-01-${d}-100000-v0.1.0.zip`));
  assert.ok(fs.existsSync(path.join(dir, 'keep-me.txt')), 'other files in backups/ are left alone');
  const second = await B.backup({ now, label: 'Manual Test' });
  assert.match(path.basename(second.file), /-183001-/, 'a second backup in the same second gets the next second');
  const list = cli(['backups']);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /2026-10-02 18:30:00 {2}v\S+ +\d.* manual-test/);
});

test('offsite copy: a folder, a command with {file}; a failure is logged and not fatal', async () => {
  const f = path.join(tmp, 'jobpilot-backup-2026-10-02-120000-v0.1.0.zip'); fs.writeFileSync(f, 'zip bytes');
  const to = path.join(tmp, 'offsite');
  assert.equal(B.copyOffsite(f, to), 'copied');
  assert.equal(fs.readFileSync(path.join(to, path.basename(f)), 'utf8'), 'zip bytes');
  const cmd = `"${process.execPath}" -e "require('fs').copyFileSync(process.argv[1], process.argv[1] + '.sent')" {file}`;
  assert.equal(B.copyOffsite(f, cmd), 'copied');
  assert.equal(fs.readFileSync(`${f}.sent`, 'utf8'), 'zip bytes');
  assert.equal(B.copyOffsite(f, `"${process.execPath}" -e "process.exit(4)" {file}`), 'failed');
  assert.equal(B.copyOffsite(f, ''), 'off');
});

test('cli.mjs run makes the nightly backup; a failed backup is alerted and does not fail the run', () => {
  const ok = path.join(tmp, 'run-home'); fs.mkdirSync(path.join(ok, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(ok, 'profile', 'profile.md'), '# Alex Example\n');
  fs.writeFileSync(path.join(ok, 'settings.json'), JSON.stringify({ timezone: 'UTC', sources: {}, pack: { enabled: false } }));
  const env = { JOBPILOT_HOME: ok, JOBPILOT_DATA: path.join(ok, 'data') };
  let r = cli(['run'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /backup: jobpilot-backup-\d{4}-\d{2}-\d{2}-\d{6}-v\S+\.zip/);
  assert.equal(fs.readdirSync(path.join(ok, 'backups')).filter(n => n.endsWith('.zip')).length, 1);
  // backups/ is a file here, so the backup fails; Telegram is off, so the alert is logged
  fs.rmSync(path.join(ok, 'backups'), { recursive: true }); fs.writeFileSync(path.join(ok, 'backups'), 'in the way');
  r = cli(['run'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /backup failed: /);
  assert.match(r.stdout, /notify: Telegram delivery is off, not sent: jobpilot: the nightly backup failed/);
  // backup.nightly: false turns it off
  fs.rmSync(path.join(ok, 'backups'));
  fs.writeFileSync(path.join(ok, 'settings.json'), JSON.stringify({ timezone: 'UTC', sources: {}, pack: { enabled: false }, backup: { nightly: false } }));
  r = cli(['run'], env);
  assert.equal(r.status, 0); assert.ok(!fs.existsSync(path.join(ok, 'backups')));
  // a trial run on the example profile backs up nothing
  const trial = path.join(tmp, 'trial-home'); fs.mkdirSync(trial);
  fs.writeFileSync(path.join(trial, 'settings.json'), JSON.stringify({ timezone: 'UTC', sources: {}, pack: { enabled: false } }));
  r = cli(['run', '--example'], { JOBPILOT_HOME: trial, JOBPILOT_DATA: path.join(trial, 'data') });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(!fs.existsSync(path.join(trial, 'backups')));
});

test('nightlyBackup calls the alert on failure and never throws', async () => {
  const blocker = path.join(tmp, 'blocker'); fs.writeFileSync(blocker, 'x');
  const sent = [];
  assert.equal(await B.nightlyBackup({ dir: path.join(blocker, 'backups'), alert: t => sent.push(t) }), null);
  assert.match(sent[0], /^jobpilot: the nightly backup failed: /);
  assert.equal(await B.nightlyBackup({ dir: path.join(blocker, 'b2'), alert: () => { throw new Error('telegram down'); } }), null);
});

test('doctor: last backup age (warn after 2 days) and free space against the last backup', () => {
  const dir = path.join(tmp, 'doc'); fs.mkdirSync(dir);
  const big = { bavail: 1000, bsize: 1 }, roomy = { bavail: 1e9, bsize: 4096 };
  assert.match(B.backupDoctor({ dir, statfs: () => roomy })[0].text, /none yet \(the evening run makes one\)/);
  fs.writeFileSync(path.join(dir, B.backupName({ date: '2026-09-28', time: '183000' }, null, '0.1.0')), Buffer.alloc(500));
  let d = B.backupDoctor({ dir, now: new Date('2026-09-30T12:00:00Z'), statfs: () => roomy });
  assert.equal(d[0].level, 'ok'); assert.match(d[0].text, /last backup: 2026-09-28 \(2 day\(s\) ago, 500 B; 1 in backups\/\)/);
  d = B.backupDoctor({ dir, now: new Date('2026-10-01T12:00:00Z'), statfs: () => big });
  assert.equal(d[0].level, 'warn'); assert.match(d[0].fix, /more than 2 days/);
  assert.equal(d[1].level, 'warn'); assert.match(d[1].text, /less than three times the last backup/);
  const out = cli(['doctor']);
  assert.match(out.stdout, /^(ok {2}|warn) last backup: /m);
  assert.match(out.stdout, /^(ok {2}|warn) free disk space: /m);
});

test('restore: refused while the run lock is held; dry run changes nothing; it backs up the current state first', async () => {
  const dir = B.backupsDir();
  fs.writeFileSync(JOB, 'original\n');
  const src = await B.backup({ now: new Date('2026-10-03T10:00:00Z'), copy: false });
  fs.writeFileSync(JOB, 'changed after the backup\n');
  const NEW = path.join(DATA, 'decoded', '2026-10-03--initech--pm.md'); fs.writeFileSync(NEW, 'new since\n');
  const name = path.basename(src.file);

  const lock = path.join(DATA, 'state', 'run.lock'); fs.writeFileSync(lock, String(process.pid));   // a live process
  const before = fs.readdirSync(dir).length;
  let r = cli(['restore', name]);
  assert.equal(r.status, 1); assert.match(r.stdout, /another jobpilot run is in progress/);
  assert.equal(fs.readFileSync(JOB, 'utf8'), 'changed after the backup\n');
  assert.equal(fs.readdirSync(dir).length, before, 'no backup made while locked');
  fs.rmSync(lock);

  r = cli(['restore', name, '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Dry run, nothing written/);
  assert.match(r.stdout, /data\/decoded\/2026-09-01--acme--pm\.md: replace with the archived copy/);
  assert.equal(fs.readFileSync(JOB, 'utf8'), 'changed after the backup\n');
  assert.equal(fs.readdirSync(dir).length, before);

  r = cli(['restore', name]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(JOB, 'utf8'), 'original\n');
  assert.ok(fs.existsSync(NEW), 'files that are not in the backup stay');
  const pre = r.stdout.match(/The state before the restore is in (.+)$/m)[1].trim();
  assert.match(path.basename(pre), /--pre-restore\.zip$/);
  const z = readZip(pre); const e = z.entries.find(x => x.name === 'data/decoded/2026-09-01--acme--pm.md');
  assert.equal((await readEntry(z, e)).toString(), 'changed after the backup\n');
  assert.ok(fs.existsSync(src.file), 'the restored backup is not pruned by the pre-restore backup');
});

test('a damaged backup is refused before the pre-restore backup is made; an unknown name is explained', async () => {
  const dir = B.backupsDir();
  const f = path.join(dir, B.backupName({ date: '2026-10-04', time: '100000' }, null, '0.1.0'));
  fs.writeFileSync(f, 'PK\x03\x04 not really a zip');
  const before = fs.readdirSync(dir).length;
  await assert.rejects(B.restore({ ref: path.basename(f) }), /not a readable zip/);
  assert.equal(fs.readdirSync(dir).length, before);
  await assert.rejects(B.restore({ ref: 'nope.zip' }), /no backup "nope\.zip"; node cli\.mjs backups lists them/);
  fs.rmSync(f);
});

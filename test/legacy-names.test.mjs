// Names from before the rename to CometScout (lib/legacy-names.mjs): each JOBPILOT_ variable works alone and loses to
// its COMETSCOUT_ name, hooks see both, old systemd units are replaced by cli.mjs timer and reported by doctor, old
// backups are listed, pruned per name family and restored, old export and secrets formats import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-legacy-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, 'profile'), { recursive: true });
fs.writeFileSync(path.join(home, 'profile', 'profile.md'), '# Alex Example\n');
const envDump = path.join(tmp, 'env.json'), dumper = path.join(tmp, 'dump-env.mjs');
fs.writeFileSync(dumper, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(COMETSCOUT|JOBPILOT)_/.test(k)))));`);
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ timezone: 'UTC', sources: {}, pack: { enabled: false }, hooks: { picks: `node "${dumper}" "${envDump}"` } }));
for (const k of Object.keys(process.env)) if (/^(COMETSCOUT|JOBPILOT)_/i.test(k)) delete process.env[k];
process.env.COMETSCOUT_HOME = home;
process.env.COMETSCOUT_DATA = path.join(home, 'data');
const L = await import('../lib/legacy-names.mjs');
const { DATA } = await import('../lib/config.mjs');
const { runHook } = await import('../lib/hooks.mjs');
const { installTimer, oldUnitsDoctor, UNITS } = await import('../lib/ops.mjs');
const B = await import('../lib/backup.mjs');
const { exportArchive, openArchive, importArchive, defaultExportName, FORMAT } = await import('../lib/archive.mjs');
const S = await import('../lib/secrets.mjs');

// a child's environment without any variable of either name from this process
const cleanEnv = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COMETSCOUT|JOBPILOT)_/i.test(k))), ...extra });

test('envVar: every variable, the new name wins, the old one works alone, empty counts as unset', () => {
  for (const n of ['HOME', 'DATA', 'SETTINGS', 'RUN_DATE', 'SECRETS_PASSPHRASE', 'EVENING', 'TIME', 'EVENT']) {
    assert.equal(L.envVar(n, { [`COMETSCOUT_${n}`]: 'new', [`JOBPILOT_${n}`]: 'old' }), 'new', n);
    assert.equal(L.envVar(n, { [`JOBPILOT_${n}`]: 'old' }), 'old', n);
    assert.equal(L.envVar(n, { [`COMETSCOUT_${n}`]: '', [`JOBPILOT_${n}`]: 'old' }), 'old', n);
    assert.equal(L.envVar(n, {}), '', n);
  }
  assert.deepEqual(L.oldEnvVars({ JOBPILOT_HOME: '/x', JOBPILOT_DATA: '/d', COMETSCOUT_DATA: '/d2', OTHER: '1' }), [{ old: 'JOBPILOT_HOME', new: 'COMETSCOUT_HOME' }]);
});

test('config reads the old HOME, DATA, SETTINGS and RUN_DATE alone, and the new ones win', () => {
  const a = path.join(tmp, 'cfg-a'), b = path.join(tmp, 'cfg-b');
  for (const d of [a, b]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'other.json'), '{"timezone":"UTC"}'); }
  const show = env => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const c = await import(${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).href)}); console.log(JSON.stringify([c.ROOT, c.DATA, c.SETTINGS_FILE, c.today()]));`], { encoding: 'utf8', env: cleanEnv(env) });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim());
  };
  const old = { JOBPILOT_HOME: a, JOBPILOT_DATA: path.join(a, 'd'), JOBPILOT_SETTINGS: path.join(a, 'other.json'), JOBPILOT_RUN_DATE: '2026-01-02' };
  assert.deepEqual(show(old), [a, path.join(a, 'd'), path.join(a, 'other.json'), '2026-01-02']);
  const both = { ...old, COMETSCOUT_HOME: b, COMETSCOUT_DATA: path.join(b, 'd'), COMETSCOUT_SETTINGS: path.join(b, 'other.json'), COMETSCOUT_RUN_DATE: '2026-03-04' };
  assert.deepEqual(show(both), [b, path.join(b, 'd'), path.join(b, 'other.json'), '2026-03-04']);
});

test('the secrets passphrase: the new variable wins, the old one works alone', async () => {
  const ask = async () => { throw new Error('must not ask'); };
  assert.equal(await S.readPassphrase({ env: { JOBPILOT_SECRETS_PASSPHRASE: 'old-pass-123' }, ask }), 'old-pass-123');
  assert.equal(await S.readPassphrase({ env: { JOBPILOT_SECRETS_PASSPHRASE: 'old-pass-123', COMETSCOUT_SECRETS_PASSPHRASE: 'new-pass-456' }, ask }), 'new-pass-456');
});

test('hooks get every variable under both names, with COMETSCOUT_EVENT and JOBPILOT_EVENT', () => {
  process.env.JOBPILOT_RUN_DATE = '2026-05-06';
  try {
    const [r] = runHook('picks', { date: '2026-05-06' }); assert.equal(r.ok, true, r.error);
    const got = JSON.parse(fs.readFileSync(envDump, 'utf8'));
    assert.equal(got.COMETSCOUT_EVENT, 'picks'); assert.equal(got.JOBPILOT_EVENT, 'picks');
    assert.equal(got.COMETSCOUT_HOME, home); assert.equal(got.JOBPILOT_HOME, home);
    assert.equal(got.COMETSCOUT_RUN_DATE, '2026-05-06', 'an old-only variable reaches the hook under the new name too');
  } finally { delete process.env.JOBPILOT_RUN_DATE; }
  assert.deepEqual(L.withOldNames({ COMETSCOUT_A: 'n', JOBPILOT_A: 'o', JOBPILOT_B: 'b', PATH: 'p' }), { COMETSCOUT_A: 'n', JOBPILOT_A: 'n', JOBPILOT_B: 'b', COMETSCOUT_B: 'b', PATH: 'p' });
});

test('cli.mjs timer replaces old units: the old timer and bot are stopped and disabled first, the files and links go', () => {
  const dir = path.join(tmp, 'units'); fs.mkdirSync(path.join(dir, 'timers.target.wants'), { recursive: true });
  for (const u of L.OLD_UNITS) fs.writeFileSync(path.join(dir, u), '[Unit]\n');
  fs.writeFileSync(path.join(dir, 'timers.target.wants', 'jobpilot.timer'), 'link');
  fs.writeFileSync(path.join(dir, 'unrelated.service'), 'keep');
  assert.match(oldUnitsDoctor({ dir })[0].text, /old systemd units still installed: jobpilot\.timer, jobpilot-bot\.service, jobpilot\.service, jobpilot-failure@\.service/);
  assert.match(oldUnitsDoctor({ dir })[0].fix, /node cli\.mjs timer/);
  const runs = [];
  const r = installTimer({ time: '19:30', tz: 'UTC', bot: true, dir, run: (cmd, args) => runs.push([cmd, ...args].join(' ')), stdio: 'ignore' });
  assert.equal(r.code, 0);
  // new units first; the old bot is stopped last and without blocking (this may be running inside it)
  assert.deepEqual(runs, ['systemctl --user daemon-reload', 'systemctl --user enable --now cometscout.timer', 'systemctl --user enable --now cometscout-bot.service',
    'systemctl --user stop jobpilot.timer', 'systemctl --user disable jobpilot.timer', 'systemctl --user disable jobpilot-bot.service',
    'systemctl --user daemon-reload', 'systemctl --user stop --no-block jobpilot-bot.service']);
  assert.ok(r.lines.some(l => /Removed the units from before the rename: jobpilot\.timer/.test(l)));
  for (const u of L.OLD_UNITS) assert.ok(!fs.existsSync(path.join(dir, u)), u);
  assert.ok(!fs.existsSync(path.join(dir, 'timers.target.wants', 'jobpilot.timer')));
  for (const u of Object.values(UNITS)) assert.ok(fs.existsSync(path.join(dir, u)), u);
  assert.ok(fs.existsSync(path.join(dir, 'unrelated.service')));
  assert.deepEqual(oldUnitsDoctor({ dir }), []);
  // a second install finds nothing old and stops nothing
  runs.length = 0; installTimer({ time: '19:30', tz: 'UTC', bot: false, dir, run: (cmd, args) => runs.push([cmd, ...args].join(' ')), stdio: 'ignore' });
  assert.deepEqual(runs, ['systemctl --user daemon-reload', 'systemctl --user enable --now cometscout.timer']);
});

test('doctor reports old units and old variables, with what to do', () => {
  const fakeHome = path.join(tmp, 'user-home'), units = path.join(fakeHome, '.config', 'systemd', 'user');
  fs.mkdirSync(units, { recursive: true }); fs.writeFileSync(path.join(units, 'jobpilot.timer'), '[Unit]\n');
  const r = spawnSync(process.execPath, [CLI, 'doctor'], { encoding: 'utf8', env: cleanEnv({ COMETSCOUT_HOME: home, COMETSCOUT_DATA: path.join(home, 'data'), JOBPILOT_SECRETS_PASSPHRASE: 'not-printed-123', HOME: fakeHome, USERPROFILE: fakeHome }) });
  assert.match(r.stdout, /^warn old systemd units still installed: jobpilot\.timer {2}-> {2}node cli\.mjs timer installs the CometScout units and removes these$/m);
  assert.match(r.stdout, /^warn JOBPILOT_SECRETS_PASSPHRASE is read as COMETSCOUT_SECRETS_PASSPHRASE {2}-> {2}rename it in your environment/m);
  assert.ok(!r.stdout.includes('not-printed-123'));
});

test('backups: new names; old and new names are listed, and each family keeps its own newest backups', () => {
  assert.match(B.backupName({ date: '2026-10-02', time: '183005' }), /^cometscout-backup-2026-10-02-183005-v/);
  assert.equal(B.parseName('jobpilot-backup-2026-01-02-030405-v0.1.0--pre-restore.zip').family, 'jobpilot');
  const list = [];
  const add = (family, date, label = null) => list.push(B.parseName(B.backupName({ date, time: '183000' }, label, '0.1.0').replace(/^cometscout/, family)));
  // a long old history up to the day of the update, then a few new backups
  for (let t = Date.parse('2026-06-05T00:00:00Z'); t <= Date.parse('2026-09-28T00:00:00Z'); t += 86400000) add('jobpilot', new Date(t).toISOString().slice(0, 10));
  for (const d of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) add('cometscout', d);
  const { keep, remove } = B.prunePlan(list, '2026-10-02');
  const newestOld = 'jobpilot-backup-2026-09-28-183000-v0.1.0.zip';
  assert.ok(keep.includes(newestOld), 'the newest old backup stays');
  assert.equal(keep.filter(n => n.startsWith('jobpilot-')).length, 12, 'the old family keeps its own 7 daily, weekly and monthly slots');
  assert.ok(list.filter(b => b.family === 'cometscout').every(b => keep.includes(b.name)));
  assert.equal(keep.length + remove.length, list.length);
  // with only old backups the plan is what it always was
  const onlyOld = B.prunePlan(list.filter(b => b.family === 'jobpilot'), '2026-10-02');
  assert.deepEqual(onlyOld.keep, keep.filter(n => n.startsWith('jobpilot-')));
});

test('prune and restore with old and new names in backups/', async () => {
  const dir = B.backupsDir(); fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'decoded'), { recursive: true });
  const job = path.join(DATA, 'decoded', '2026-09-01--acme--pm.md'); fs.writeFileSync(job, 'before the update\n');
  const made = await B.backup({ now: new Date('2026-09-20T18:30:00Z'), prune: false, copy: false });
  const old = path.join(dir, path.basename(made.file).replace(/^cometscout-/, 'jobpilot-')); fs.renameSync(made.file, old);
  for (let n = 1; n <= 9; n++) fs.writeFileSync(path.join(dir, `jobpilot-backup-2025-01-0${n}-100000-v0.1.0.zip`), 'old');
  const r = await B.backup({ now: new Date('2026-10-02T18:30:00Z'), copy: false });
  assert.match(path.basename(r.file), /^cometscout-backup-2026-10-02-/);
  const names = B.listBackups(dir).map(b => b.name);
  assert.ok(names.includes(path.basename(old)) && names.includes(path.basename(r.file)), 'both newest backups stay');
  assert.ok(r.pruned.length > 0 && r.pruned.every(n => n.startsWith('jobpilot-backup-2025-01-')));
  fs.writeFileSync(job, 'after the update\n');
  const res = await B.restore({ ref: path.basename(old), now: new Date('2026-10-02T19:00:00Z') });
  assert.equal(fs.readFileSync(job, 'utf8'), 'before the update\n');
  assert.match(path.basename(res.pre.file), /^cometscout-backup-.*--pre-restore\.zip$/);
});

test('export writes cometscout-export; import reads cometscout-export v2, jobpilot-export v2 and jobpilot-export-v1', async () => {
  assert.equal(FORMAT, 'cometscout-export');
  assert.match(defaultExportName(), /^cometscout-export-\d{4}-\d{2}-\d{2}-v.+\.zip$/);
  const zip = path.join(tmp, 'new.zip'); const r = await exportArchive({ out: zip, dataOnly: true });
  assert.equal(r.manifest.format, 'cometscout-export'); assert.equal(r.manifest.version, 2);
  const folder = path.join(tmp, 'fmt'); await exportArchive({ out: folder, dataOnly: true });
  const mf = path.join(folder, 'manifest.json'), m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  for (const [format, version, want] of [['cometscout-export', 2, 2], ['jobpilot-export', 2, 2], ['jobpilot-export-v1', 1, 1]]) {
    fs.writeFileSync(mf, JSON.stringify({ ...m, format, version }));
    const a = await openArchive(folder); a.cleanup();
    assert.equal(a.version, want, format); assert.deepEqual(a.bad, []);
    const plan = await importArchive({ from: folder, dryRun: true });
    assert.equal(plan.plan.conflict.length, 0, format);
  }
  fs.writeFileSync(mf, JSON.stringify({ ...m, format: 'someone-else-export' }));
  await assert.rejects(openArchive(folder), /unsupported format "someone-else-export"/);
  const zipped = (await openArchive(zip)); zipped.cleanup(); assert.equal(zipped.version, 2);
});

test('secrets: new files say cometscout-secrets; a file made before the rename still decrypts', () => {
  const kdf = { N: 1024, r: 8, p: 1 };
  assert.equal(S.encrypt({ '.env': Buffer.from('A=1\n') }, 'pass-phrase-1', kdf).format, 'cometscout-secrets');
  // an old file, as the old code wrote it: format id "jobpilot-secrets", which is also the associated data
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync('pass-phrase-1', salt, 32, kdf);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from('jobpilot-secrets/1'));
  const data = Buffer.concat([c.update(JSON.stringify({ exported_at: 'x', source_host: 'h', files: { '.env': Buffer.from('OLD=1\n').toString('base64') } })), c.final()]);
  const doc = { format: 'jobpilot-secrets', version: 1, kdf: { name: 'scrypt', ...kdf, salt: salt.toString('base64') }, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  assert.equal(S.decrypt(doc, 'pass-phrase-1').files['.env'].toString(), 'OLD=1\n');
  // the format id is authenticated: relabelling a file breaks it
  assert.throws(() => S.decrypt({ ...doc, format: 'cometscout-secrets' }, 'pass-phrase-1'), /wrong passphrase, or the secrets file is damaged/);
  assert.throws(() => S.decrypt({ ...doc, format: 'other-secrets' }, 'pass-phrase-1'), /not a CometScout secrets file/);
});

test('the commands: cometscout and jobpilot both point at cli.mjs; help exits 0', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'cometscout');
  assert.deepEqual(pkg.bin, { cometscout: 'cli.mjs', jobpilot: 'cli.mjs' });
  for (const a of ['--help', 'help']) {
    const r = spawnSync(process.execPath, [CLI, a], { encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0); assert.match(r.stdout, /^\/\/ CometScout command line/);
  }
  assert.equal(spawnSync(process.execPath, [CLI, 'no-such-command'], { encoding: 'utf8', env: process.env }).status, 1);
});

test('install.sh: the new names, JOBPILOT_TIME still read, an old ~/jobpilot install found and left in place', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'deploy', 'install.sh'), 'utf8');
  assert.match(sh, /node app\/current\/cli\.mjs timer \$\{KEEP_OLD\} "\$\{COMETSCOUT_TIME:-\$\{JOBPILOT_TIME:-\}\}"/);
  assert.match(sh, /OLD_HOME="\$HOME\/jobpilot"/);
  assert.match(sh, /It is left as it is/);
  // the old install keeps its units (and keeps running) until it is moved
  assert.match(sh, /KEEP_OLD="--keep-old-units"/);
  assert.match(sh, /node cli\.mjs export --out .* node cli\.mjs import --from /s);
  assert.ok(fs.existsSync(path.join(ROOT, 'deploy', 'cometscout-failure@.service')));
});

test('export-secrets: the default file name is cometscout-secrets-<date>.enc; the old passphrase variable works on the command line', () => {
  const cwd = path.join(tmp, 'secrets-cwd'); fs.mkdirSync(cwd, { recursive: true });
  const h = path.join(tmp, 'secrets-home'); fs.mkdirSync(h, { recursive: true }); fs.writeFileSync(path.join(h, '.env'), 'RTJ_API_TOKEN=planted-legacy-token-1\n');
  const env = cleanEnv({ COMETSCOUT_HOME: h, COMETSCOUT_DATA: path.join(h, 'data'), COMETSCOUT_RUN_DATE: '2026-10-05', JOBPILOT_SECRETS_PASSPHRASE: 'old-variable-pass' });
  const r = spawnSync(process.execPath, [CLI, 'export-secrets'], { encoding: 'utf8', cwd, input: '', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = path.join(cwd, 'cometscout-secrets-2026-10-05.enc');
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).format, 'cometscout-secrets');
  assert.equal(S.importSecrets({ from: out, passphrase: 'old-variable-pass', dryRun: true }).dryRun, true);
});

test('timer: a failed systemctl leaves the old units running; --keep-old-units keeps them on purpose', () => {
  const mk = name => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); for (const u of L.OLD_UNITS) fs.writeFileSync(path.join(d, u), '[Unit]\n'); return d; };
  const dir = mk('units-fail'), runs = [];
  const r = installTimer({ time: '19:30', tz: 'UTC', bot: false, dir, stdio: 'ignore', run: (cmd, args) => { runs.push(args.join(' ')); return { status: args.includes('enable') ? 1 : 0 }; } });
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /systemctl --user failed: enable --now cometscout\.timer.*nothing old was removed/s);
  assert.ok(!runs.some(x => /jobpilot/.test(x)), 'no old unit touched');
  for (const u of L.OLD_UNITS) assert.ok(fs.existsSync(path.join(dir, u)), u);
  const keep = mk('units-keep'), runs2 = [];
  const k = installTimer({ time: '19:30', tz: 'UTC', bot: false, dir: keep, stdio: 'ignore', keepOld: true, run: (cmd, args) => { runs2.push(args.join(' ')); return { status: 0 }; } });
  assert.equal(k.code, 0);
  assert.deepEqual(runs2, ['--user daemon-reload', '--user enable --now cometscout.timer']);
  assert.match(k.lines.join('\n'), /Kept the units of the older install/);
  for (const u of L.OLD_UNITS) assert.ok(fs.existsSync(path.join(keep, u)), u);
});

test('COMETSCOUT_LLM_FAKE is never loaded from .env; doctor says so, and says so when it is set in the environment', () => {
  const h = path.join(tmp, 'fake-env-home'); fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, '.env'), 'COMETSCOUT_LLM_FAKE=1\nJOBPILOT_LLM_FAKE=1\n');
  const run = extra => spawnSync(process.execPath, [CLI, 'doctor'], { encoding: 'utf8', env: cleanEnv({ COMETSCOUT_HOME: h, COMETSCOUT_DATA: path.join(h, 'data'), ...extra }) });
  const a = run({});
  assert.match(a.stdout, /^TODO real model calls \(no COMETSCOUT_LLM_FAKE\) {2}-> {2}COMETSCOUT_LLM_FAKE, JOBPILOT_LLM_FAKE in \.env is ignored/m);
  fs.writeFileSync(path.join(h, '.env'), '');
  const b = run({ COMETSCOUT_LLM_FAKE: '1' });
  assert.match(b.stdout, /^TODO real model calls .*unset COMETSCOUT_LLM_FAKE/m);
  const c = run({ COMETSCOUT_LLM_FAKE: '1', COMETSCOUT_LOCK_PARENT: '12345' });
  assert.match(c.stdout, /^ok +real model calls/m, 'an update verify step sets it on purpose');
});

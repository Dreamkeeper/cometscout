// Fixes from the first end-to-end onboarding test (docs/tasks/26, PR B): the name from the profile and what the example
// profile leaves behind, the model CLI found in ~/.local/bin, reset keeping the install's state, a timer that never
// starts a run, settings set and onboarding-state from a shell, the home's docs and wrapper scripts after adopt and
// update, Personio and Gem boards, the drop folder, the salary answer, the example P&L rule. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.mjs');
const FIX = path.join(ROOT, 'test', 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-onboarding-'));
for (const k of Object.keys(process.env)) if (/^(COMETSCOUT|JOBPILOT)_/i.test(k)) delete process.env[k];

/** A home with settings (and a profile unless profile is false); returns { h, data, env, settings }. */
function home(name, { settings = {}, profile = '# Sam Example\n\nProduct manager, synthetic.\n' } = {}) {
  const h = path.join(tmp, name), data = path.join(h, 'data');
  fs.mkdirSync(path.join(data, 'state'), { recursive: true });
  if (profile !== false) { fs.mkdirSync(path.join(h, 'profile'), { recursive: true }); fs.writeFileSync(path.join(h, 'profile', 'profile.md'), profile); }
  const file = path.join(h, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ timezone: 'UTC', sources: {}, pack: { enabled: false }, update: { check: false }, backup: { nightly: false }, ...settings }, null, 2) + '\n');
  return { h, data, settings: file, env: { ...process.env, COMETSCOUT_HOME: h, COMETSCOUT_DATA: data, COMETSCOUT_SETTINGS: file } };
}
const cli = (x, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...x.env, ...env }, timeout: 120000 });

// this process reads its own home
const me = home('self');
Object.assign(process.env, { COMETSCOUT_HOME: me.h, COMETSCOUT_DATA: me.data, COMETSCOUT_SETTINGS: me.settings });
const C = await import('../lib/config.mjs');
const D = await import('../lib/doctor.mjs');
const O = await import('../lib/ops.mjs');
const Sch = await import('../lib/schedule.mjs');
const L = await import('../lib/layout.mjs');
const B = await import('../lib/boards.mjs');
const A = await import('../pack/answers.mjs');
const { packMessage } = await import('../pack/message.mjs');

// ---------- item 4: the candidate's name, and what the example profile leaves behind ----------
test('the name comes from profile.md: a Name: line, else the first heading without its parentheses', () => {
  assert.equal(C.nameFromProfile('# Alex Rivera (FICTIONAL EXAMPLE PROFILE)\n\ntext'), 'Alex Rivera');
  assert.equal(C.nameFromProfile('intro\n- **Name:** Robin Vale\n# Heading'), 'Robin Vale');
  assert.equal(C.nameFromProfile('# Profile\n\nno name here'), null, 'a generic heading is no name');
  assert.equal(C.nameFromProfile(''), null);
  assert.equal(C.candidateName({ candidate_name: null }, '# Sam Example\n'), 'Sam Example');
  assert.equal(C.candidateName({ candidate_name: '  Sam E.  ' }, '# Sam Example\n'), 'Sam E.', 'a name in settings wins');
  assert.equal(C.candidateName({}, ''), 'the candidate');
  assert.equal(C.SETTINGS.candidate_name, 'Sam Example', 'this process: null in settings, the name from profile.md');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8')).candidate_name, null, 'the example settings name nobody');
});

test('doctor: a TODO for the example name and for decodes made with the example profile (a warning under an update check)', () => {
  const x = home('leftovers', { settings: { candidate_name: 'Alex Rivera' } });
  const dec = path.join(x.data, 'decoded'); fs.mkdirSync(dec, { recursive: true });
  fs.writeFileSync(path.join(dec, '2026-10-01--acme--pm.md'), '---\ncompany: "Acme"\n---\n\n## Decode Result\nverdict: long-shot\n');
  fs.writeFileSync(path.join(x.data, 'state', 'example-decodes.json'), JSON.stringify({ files: ['2026-10-01--acme--pm.md', '2026-09-01--gone--pm.md'] }));
  const out = cli(x, ['doctor']).stdout;
  assert.match(out, /^TODO candidate_name: "Alex Rivera", the example person's name {2}-> {2}set candidate_name to null/m);
  assert.match(out, /^TODO 1 decode\(s\) in data\/ were made with the example profile {2}-> {2}decodes from the example profile: `node cli\.mjs reset --yes` clears them/m, 'a listed file that is gone is not counted');
  const under = cli(x, ['doctor'], { COMETSCOUT_LOCK_PARENT: '12345' }).stdout;
  assert.match(under, /^warn candidate_name: "Alex Rivera"/m); assert.match(under, /^warn 1 decode\(s\)/m);
  assert.doesNotMatch(under, /^TODO (candidate_name|1 decode)/m, 'an update\'s check never fails on advice');
  const clean = home('clean');
  assert.doesNotMatch(cli(clean, ['doctor']).stdout, /example person's name|made with the example profile/);
  assert.deepEqual(D.exampleLeftovers({ settingsFile: clean.settings, dirs: [path.join(clean.data, 'decoded')], record: path.join(clean.data, 'state', 'example-decodes.json') }), { name: null, decodes: 0 });
});

test('the decoder records decodes made with the example profile (no profile/ yet)', () => {
  const x = home('example-run', { profile: false });
  fs.cpSync(path.join(ROOT, 'profile.example'), path.join(x.h, 'profile.example'), { recursive: true });
  const inbox = path.join(x.data, 'inbox'); fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, '2026-10-02--birch--pm.md'), `---\ncompany: "Birch"\nrole: "PM"\nfound: 2026-10-02\n---\n\n# Birch - PM\n\n${'A synthetic product role in logistics software, remote in Europe. '.repeat(8)}\n`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'decoder', 'decoder.mjs'), '--no-telegram'], { encoding: 'utf8', env: { ...x.env, COMETSCOUT_LLM_FAKE: '1' }, timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.data, 'state', 'example-decodes.json'), 'utf8')).files, ['2026-10-02--birch--pm.md']);
});

// ---------- item 5: the model CLI in ~/.local/bin ----------
test('findCli: a bare name not on the PATH is found in ~/.local/bin; a path or a missing file is not', () => {
  const fake = path.join(tmp, 'fake-home'), bin = path.join(fake, '.local', 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), 'synthetic');
  const version = p => (p === 'claude' ? null : p === path.join(bin, 'claude') ? '9.9.9 (synthetic)' : null);
  assert.deepEqual(D.findCli('claude', { home: fake, version, platform: 'linux' }), { version: '9.9.9 (synthetic)', where: 'local-bin' });
  assert.deepEqual(D.findCli('claude', { home: fake, version: () => '1.0 (on PATH)', platform: 'linux' }), { version: '1.0 (on PATH)', where: 'path' });
  assert.deepEqual(D.findCli('codex', { home: fake, version, platform: 'linux' }), { version: null, where: null });
  assert.deepEqual(D.findCli('/opt/x/claude', { home: fake, version, platform: 'linux' }), { version: null, where: null }, 'a path is not looked up again');
  fs.writeFileSync(path.join(bin, 'claude.exe'), 'synthetic');
  assert.equal(D.findCli('claude', { home: fake, version: p => (p === path.join(bin, 'claude.exe') ? '9.9.9' : null), platform: 'win32' }).where, 'local-bin');
});

test('doctor: claude in ~/.local/bin of a shell whose PATH lacks it is ok, with a note', { skip: process.platform === 'win32' && 'a script without an extension does not run on Windows' }, () => {
  const fake = path.join(tmp, 'fake-home-doctor'), bin = path.join(fake, '.local', 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code, synthetic)"\n', { mode: 0o755 });
  const x = home('local-bin', { settings: { llm: { provider: 'claude' } } });
  const out = cli(x, ['doctor'], { HOME: fake, PATH: path.dirname(process.execPath) }).stdout;
  assert.match(out, /^ok {3}claude CLI: 9\.9\.9 \(Claude Code, synthetic\), found in ~\/\.local\/bin \(this shell's PATH lacks it; the timer adds it\)$/m);
});

test('the units\' PATH has ~/.local/bin once', () => {
  assert.equal(O.unitPath('/home/sam/.local/bin:/usr/bin:/bin:/usr/bin', '/home/sam'), '/home/sam/.local/bin:/usr/bin:/bin');
  assert.equal(O.unitPath('/usr/bin', '/home/sam'), '/home/sam/.local/bin:/usr/bin');
});

// ---------- item 7: reset keeps the install's state ----------
test('reset --yes keeps schema.json, update.json and runs.jsonl and says so', () => {
  const x = home('reset');
  const st = f => path.join(x.data, 'state', f);
  for (const f of ['schema.json', 'update.json', 'runs.jsonl', 'picks.json', 'applications.json']) fs.writeFileSync(st(f), '{}\n');
  fs.mkdirSync(path.join(x.data, 'decoded'), { recursive: true }); fs.writeFileSync(path.join(x.data, 'decoded', 'a.md'), 'x');
  const ask = cli(x, ['reset']);
  assert.equal(ask.status, 1); assert.match(ask.stdout, /Kept: data\/state\/schema\.json, data\/state\/update\.json, data\/state\/runs\.jsonl/);
  const r = cli(x, ['reset', '--yes']);
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /Kept: data\/state\/schema\.json/);
  for (const f of ['schema.json', 'update.json', 'runs.jsonl']) assert.ok(fs.existsSync(st(f)), f);
  for (const f of ['picks.json', 'applications.json']) assert.ok(!fs.existsSync(st(f)), f);
  assert.deepEqual(fs.readdirSync(path.join(x.data, 'decoded')), []);
});

// ---------- item 8: the timer never starts a run ----------
test('timer: Persistent= only once a run happened; stopped first, the stamp reset to now, the next run printed', () => {
  assert.deepEqual(O.timerPlan({ ranBefore: false }), { persistent: false, resetStamp: false });
  assert.deepEqual(O.timerPlan({ ranBefore: true }), { persistent: true, resetStamp: true });
  const u = O.unitFiles({ root: '/srv/cs', node: '/usr/bin/node', time: '18:30', envPath: '/usr/bin' });
  assert.doesNotMatch(u['cometscout.timer'], /Persistent/);
  assert.match(O.unitFiles({ root: '/srv/cs', node: '/usr/bin/node', time: '18:30', envPath: '/usr/bin', persistent: true })['cometscout.timer'], /^Persistent=true$/m);
  const now = new Date('2026-10-24T15:00:00Z'), runs = [], dir = path.join(tmp, 'units'), stamp = path.join(tmp, 'timers', 'stamp-cometscout.timer');
  const run = (cmd, args) => { runs.push(args.join(' ')); return { status: 0 }; };
  const first = O.installTimer({ time: '09:00', tz: 'UTC', bot: false, transcribe: null, dir, run, stdio: 'ignore', stamp, ranBefore: false, now });
  assert.equal(first.code, 0);
  assert.deepEqual(runs, ['--user stop cometscout.timer', '--user daemon-reload', '--user enable --now cometscout.timer']);
  assert.ok(!fs.existsSync(stamp), 'no stamp touched before any run');
  assert.ok(first.lines.includes('Next run: 2026-10-25 (Sun) at 09:00 UTC.'), first.lines.join('\n'));
  assert.match(first.lines.join('\n'), /Installing it started no run/);
  // after a run: persistent, and the stamp says "last run: now", so 09:00 today does not count as missed
  fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, ''); fs.utimesSync(stamp, new Date('2026-10-20T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
  runs.length = 0;
  O.installTimer({ time: '09:00', tz: 'UTC', bot: false, transcribe: null, dir, run, stdio: 'ignore', stamp, ranBefore: true, now });
  assert.match(fs.readFileSync(path.join(dir, 'cometscout.timer'), 'utf8'), /^Persistent=true$/m);
  assert.equal(fs.statSync(stamp).mtimeMs, now.getTime());
  assert.equal(runs[0], '--user stop cometscout.timer', 'stopped before the reload, so the start reads the stamp again');
  // a dry run writes and runs nothing
  runs.length = 0; const before = fs.readFileSync(path.join(dir, 'cometscout.timer'), 'utf8');
  const dry = O.installTimer({ time: '20:15', tz: 'UTC', bot: false, transcribe: null, dir, run, stdio: 'ignore', stamp, ranBefore: true, now, dryRun: true });
  assert.deepEqual(runs, []); assert.equal(fs.readFileSync(path.join(dir, 'cometscout.timer'), 'utf8'), before);
  assert.ok(dry.lines.includes('Next run: 2026-10-24 (Sat) at 20:15 UTC.'), dry.lines.join('\n'));
  assert.match(Sch.nextRunLine({ timezone: 'UTC', schedule: { days: [1, 2, 3, 4, 5], time: '18:00' } }, now), /^Next run: 2026-10-24 \(Sat\) at 18:00 UTC, an off day .*the next digest is on 2026-10-26\)\.$/);
});

test('cli timer --dry-run prints the next run and installs nothing', () => {
  const x = home('timer-dry', { settings: { schedule: { days: [1, 2, 3, 4, 5, 6, 7], time: '18:00' } } });
  const r = cli(x, ['timer', '--dry-run']);
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /^Dry run: would install the daily timer at 18:00 UTC; nothing written\. Installing it never starts a run\.$/m);
  assert.match(r.stdout, /^Next run: \d{4}-\d{2}-\d{2} \(\w{3}\) at 18:00 UTC\.$/m);
});

// ---------- items 9 and 12: settings set and onboarding-state from a shell ----------
test('settings set: --dry-run shows the diff and writes nothing; without it writes; refusals are clear', () => {
  const x = home('settings-set', { settings: { picks: { per_day: 2 } } });
  const before = fs.readFileSync(x.settings, 'utf8');
  const dry = cli(x, ['settings', 'set', 'picks.per_day', '3', '--dry-run']);
  assert.equal(dry.status, 0, dry.stdout); assert.match(dry.stdout, /^-\s+"per_day": 2$/m); assert.match(dry.stdout, /^\+\s+"per_day": 3$/m);
  assert.match(dry.stdout, /Dry run: nothing written/); assert.equal(fs.readFileSync(x.settings, 'utf8'), before);
  const w = cli(x, ['settings', 'set', 'picks.per_day', '3']);
  assert.equal(w.status, 0, w.stdout); assert.match(w.stdout, /Wrote picks\.per_day to settings\.json/);
  assert.equal(JSON.parse(fs.readFileSync(x.settings, 'utf8')).picks.per_day, 3);
  assert.match(cli(x, ['settings', 'set', 'picks.per_day', '3']).stdout, /No change/);
  const notJson = cli(x, ['settings', 'set', 'locale', 'ru']);
  assert.equal(notJson.status, 1); assert.match(notJson.stdout, /must be JSON.*'"ru"'/s);
  const locked = cli(x, ['settings', 'set', 'llm.bin', '"/tmp/x"']);
  assert.equal(locked.status, 1); assert.match(locked.stdout, /llm\.bin is locked/);
  assert.match(cli(x, ['settings', 'set', 'picks.nosuch', '1']).stdout, /not a known setting/);
  assert.match(cli(x, ['settings', 'get', 'x']).stdout, /^Usage: node cli\.mjs settings set/m);
});

test('onboarding-state: one line per step with its AGENTS.md number, the next step in shell terms, --json', () => {
  const x = home('onboarding', { profile: false });
  const r = cli(x, ['onboarding-state']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^\[ \] step 2: Profile \(profile\/profile\.md\): missing$/m);
  assert.match(r.stdout, /^Next: AGENTS\.md step 2, Profile \(profile\/profile\.md\): interview the user, one question per turn/m);
  assert.doesNotMatch(r.stdout, /settings_set|secrets_form/, 'shell lines, not MCP tool names');
  const j = JSON.parse(cli(x, ['onboarding-state', '--json']).stdout);
  assert.equal(j.next, 'profile'); assert.ok(j.steps.every(s => s.shell && Number.isInteger(s.step)));
});

// ---------- item 6: the home's docs and scripts after adopt and update ----------
/** A fake installed home: a clone's files in the home, release v<version> in app/releases with app/current. */
function cloneHome(name, version = '9.1.0') {
  const h = path.join(tmp, name), rel = L.releaseDir(h, version);
  const write = (base, f, text) => { const p = path.join(base, ...f.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  for (const f of ['cli.mjs', 'AGENTS.md', 'README.md', 'settings.example.json', 'profile.example/profile.md', 'deploy/install.sh', 'tools/gmail-auth.mjs', 'lib/old.mjs']) write(h, f, `old ${f}\n`);
  for (const f of ['cli.mjs', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'settings.example.json', 'profile.example/profile.md', 'profile.example/new.md', 'deploy/install.sh', 'tools/gmail-auth.mjs']) write(rel, f, `new ${f}\n`);
  write(rel, 'tools/gmail-auth.mjs', 'console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.COMETSCOUT_HOME, me: import.meta.url }));\n');
  L.writeFileList(rel, ['cli.mjs', 'AGENTS.md', 'README.md'], version);
  fs.mkdirSync(path.join(h, 'app'), { recursive: true }); L.pointCurrent(h, version);
  return { h, rel };
}

test('refreshHome: docs and the example copied from the release, the named scripts become wrappers, edits saved first', () => {
  const { h, rel } = cloneHome('home-refresh');
  // the first install's release (adopted from the clone) shipped the old copies; README was then edited by the user
  const first = L.releaseDir(h, '9.0.0'), old = ['cli.mjs', 'AGENTS.md', 'README.md', 'settings.example.json', 'profile.example/profile.md', 'deploy/install.sh', 'tools/gmail-auth.mjs'];
  for (const f of old) { const p = path.join(first, ...f.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(path.join(h, ...f.split('/')), p); }
  L.writeFileList(first, old, '9.0.0');
  fs.writeFileSync(path.join(h, 'README.md'), 'my own notes\n');
  assert.deepEqual(L.staleHomeFiles(h).sort(), ['AGENTS.md', 'README.md', 'deploy/install.sh', 'settings.example.json', 'tools/gmail-auth.mjs'].sort());
  const r = L.refreshHome({ root: h, release: rel, now: new Date('2026-10-24T12:00:00Z') });
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'settings.example.json', 'profile.example/profile.md', 'profile.example/new.md']) assert.equal(fs.readFileSync(path.join(h, f), 'utf8'), `new ${f}\n`, f);
  assert.deepEqual(r.saved, ['README.md'], 'only the edited file is saved; the first install\'s AGENTS.md is in git');
  assert.equal(fs.readFileSync(path.join(h, 'app', 'replaced', '2026-10-24T12-00-00', 'README.md'), 'utf8'), 'my own notes\n');
  assert.match(fs.readFileSync(path.join(h, 'deploy', 'install.sh'), 'utf8'), /CometScout wrapper: runs the installed release's copy, app\/current\/deploy\/install\.sh/);
  assert.equal(fs.readFileSync(path.join(h, 'lib', 'old.mjs'), 'utf8'), 'old lib/old.mjs\n', 'the clone\'s other code is left alone');
  assert.equal(fs.readFileSync(path.join(h, 'cli.mjs'), 'utf8'), 'old cli.mjs\n', 'cli.mjs hands over by itself');
  assert.ok(!fs.existsSync(path.join(h, 'deploy', 'modules')), 'a script the home does not have is not created');
  assert.deepEqual(L.staleHomeFiles(h), []);
  assert.deepEqual(L.refreshHome({ root: h, release: rel }).changed, [], 'again: nothing to do');
  // the wrapper runs the release's copy with the home set
  const w = spawnSync(process.execPath, [path.join(h, 'tools', 'gmail-auth.mjs'), '--flag', 'x'], { encoding: 'utf8', env: { ...process.env, COMETSCOUT_HOME: '' } });
  assert.equal(w.status, 0, w.stderr);
  const got = JSON.parse(w.stdout.trim());
  assert.deepEqual(got.args, ['--flag', 'x']); assert.equal(fs.realpathSync(got.home), fs.realpathSync(h)); assert.match(got.me, /app\/(current|releases\/v9\.1\.0)\/tools\/gmail-auth\.mjs$/, 'the release\'s copy (a junction resolves on Windows)');
  // not a clone home, or the release is the home itself: nothing
  assert.deepEqual(L.refreshHome({ root: path.join(tmp, 'no-such-home'), release: rel }).changed, []);
  assert.deepEqual(L.refreshHome({ root: h, release: h }).changed, []);
});

test('the shell wrapper runs app/current\'s script with COMETSCOUT_HOME', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 && 'no bash here' }, t => {
  const { h, rel } = cloneHome('home-sh');
  fs.writeFileSync(path.join(rel, 'deploy', 'install.sh'), 'echo "release install.sh $1 home=$COMETSCOUT_HOME"\n');
  L.refreshHome({ root: h, release: rel });
  const sh = process.platform === 'win32' ? spawnSync('cygpath', ['-u', path.join(h, 'deploy', 'install.sh')], { encoding: 'utf8' }).stdout?.trim() : path.join(h, 'deploy', 'install.sh');
  if (!sh) { t.skip('no cygpath for Git Bash paths'); return; }
  const r = spawnSync('bash', [sh, 'arg1'], { encoding: 'utf8', env: { ...process.env, COMETSCOUT_HOME: '' } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^release install\.sh arg1 home=.*home-sh$/m);
});

test('adopt refuses a clone whose scripts are wrappers; update --refresh-home refreshes from app/current', () => {
  const clone = path.join(tmp, 'wrapped-clone'); fs.mkdirSync(path.join(clone, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ version: '9.2.0' })); fs.writeFileSync(path.join(clone, 'cli.mjs'), '');
  fs.writeFileSync(path.join(clone, 'deploy', 'install.sh'), L.wrapperText('deploy/install.sh'));
  const r = L.adopt({ root: clone, code: clone, files: ['cli.mjs', 'package.json', 'deploy/install.sh'] });
  assert.equal(r.code, 1); assert.match(r.lines[0], /deploy\/install\.sh .* run app\/current, which is gone\. Restore them first \(git checkout -- deploy\/install\.sh\)/);
  const ps = L.wrapperText('deploy/modules/coach.ps1');
  assert.match(ps, /Join-Path \$PSScriptRoot '\.\.\\\.\.'/); assert.match(ps, /app\\current\\deploy\\modules\\coach\.ps1/);
  const x = home('refresh-cli');
  assert.match(cli(x, ['update', '--refresh-home']).stdout, /There is no app\/current here/);
});

test('every script the shipped docs name from the home is wrapped by refreshHome, or is cli.mjs', () => {
  const named = new Set(L.HOME_DOCS.filter(d => d.endsWith('.md')).flatMap(f => L.scriptsNamedIn(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
  assert.ok(named.has('deploy/install.sh') && named.has('tools/gmail-auth.mjs'), [...named].join(', '));
  assert.deepEqual(L.scriptsNamedIn('run `bash deploy/x.sh` or `node cli.mjs doctor`, `node /opt/y.mjs`, -File deploy\\modules\\coach.ps1'), ['deploy/modules/coach.ps1', 'deploy/x.sh']);
  for (const p of named) assert.ok(L.HOME_SCRIPTS.includes(p), `${p} is named in the docs but would stay a stale copy in an installed home`);
});

// ---------- item 10: Personio and Gem ----------
test('Personio: offices, remote from an office or keyword, the job link, the description from CDATA; a position without id skipped', () => {
  const jobs = B.parsePersonio(fs.readFileSync(path.join(FIX, 'boards', 'personio.xml'), 'utf8'), 'northwind.jobs.personio.de');
  assert.deepEqual(jobs.map(j => j.role), ['Senior Product Manager, Energy Platform (m/w/d)', 'Product Owner Integrations', 'Operations Analyst']);
  const [pm, po, ops] = jobs;
  assert.equal(pm.url, 'https://northwind.jobs.personio.de/job/4100001');
  assert.equal(pm.location, 'Berlin | Hamburg; full-time'); assert.deepEqual(pm.places, ['Berlin', 'Hamburg']);
  assert.match(pm.text, /^Your role\nYou own the roadmap of a synthetic energy platform & work with engineers every day\./);
  assert.match(pm.text, /- Discovery with operations teams/); assert.match(pm.text, /What you bring\nFive years in product management\.\nEnglish required/);
  assert.match(pm.text, /Department: Product & Design\nEmployment: permanent\nSeniority: experienced\nExperience: 5-7/);
  assert.equal(pm.posted, '2026-10-02T09:15:00+00:00');
  assert.equal(po.location, 'Remote (EU); full-or-part-time; remote'); assert.deepEqual(po.places, ['Remote (EU); remote']);
  assert.match(ops.location, /; remote$/, 'a "Home office" keyword marks it remote');
  assert.deepEqual(B.personioHosts('northwind'), ['northwind.jobs.personio.de', 'northwind.jobs.personio.com']);
  assert.deepEqual(B.personioHosts('https://northwind.jobs.personio.com/xml'), ['northwind.jobs.personio.com']);
  assert.deepEqual(B.parsePersonio('<html>not a feed</html>', 'x'), []);
});

test('Gem: title, link, places from the location and the offices, the location type, plain text; a post without a link skipped', () => {
  const jobs = B.parseGem(JSON.parse(fs.readFileSync(path.join(FIX, 'boards', 'gem.json'), 'utf8')));
  assert.deepEqual(jobs.map(j => j.role), ['Senior Product Manager', 'Data Analyst']);
  assert.deepEqual(jobs[0], { role: 'Senior Product Manager', url: 'https://jobs.gem.com/lumenfield/5100001', location: 'Lisbon, Portugal | Madrid, Spain; remote',
    places: ['Lisbon, Portugal; remote', 'Madrid, Spain; remote'], posted: '2026-09-02T10:00:00.000Z', text: 'About the role\nLocation:\n Remote within Europe.\nYou lead discovery for a synthetic routing product.' });
  assert.equal(jobs[1].text, 'Synthetic hybrid role. Three office days a week.', 'no plain text: the HTML as text');
  assert.equal(jobs[1].posted, '2026-08-15T10:00:00.000Z'); assert.equal(jobs[1].location, 'Berlin, Germany; hybrid');
  assert.deepEqual(B.parseGem({ not: 'a list' }), []);
});

// ---------- item 11: the drop folder default, the salary answer, the P&L rule ----------
test('a salary expectation is left blank with the floor and the posting\'s range as a note; other answers are untouched', () => {
  const facts = fs.readFileSync(path.join(ROOT, 'profile.example', 'profile.md'), 'utf8');
  assert.equal(A.payFloor(facts), 'EUR 60,000 gross a year (about EUR 5,000 a month)');
  assert.equal(A.payFloor('no floor here'), null);
  for (const f of ['Salary expectations', 'What are your compensation expectations?', 'Desired salary (EUR)', 'Gehaltsvorstellung', 'Ожидания по зарплате']) assert.ok(A.isSalaryField(f), f);
  for (const f of ['Why do you want to join?', 'Have you built payroll and compensation software for enterprise customers in the past?', 'Notice period']) assert.ok(!A.isSalaryField(f), f);
  const r = A.holdSalary([{ field: 'Salary expectations', answer: 'EUR 60,000', own_words: false }, { field: 'Why us?', answer: 'Routing.', own_words: true }], { floor: 'EUR 60,000 gross a year', range: 'EUR 65,000 - 80,000' });
  assert.deepEqual(r.answers[0], { field: 'Salary expectations', answer: '', own_words: false, note: 'Left blank for you to decide. Your floor (profile): EUR 60,000 gross a year. The posting: EUR 65,000 - 80,000.' });
  assert.deepEqual(r.answers[1], { field: 'Why us?', answer: 'Routing.', own_words: true });
  assert.deepEqual(r.flags, ['Salary: "Salary expectations" is left blank for you to decide (your floor is a minimum, not the figure to ask for).']);
  assert.match(A.holdSalary([{ field: 'Salary', answer: '1' }]).answers[0].note, /not in your profile\. The posting: states no range\./);
  const msg = packMessage({ fm: { company: 'Acme', role: 'PM', url: 'https://x' }, flags: [], answers: r.answers, form: { ats: 'ashby' }, clNeed: 'no' });
  assert.match(msg, /▸ Salary expectations\n\n\(Left blank for you to decide\./);
  assert.match(fs.readFileSync(path.join(ROOT, 'pack', 'prompt.md'), 'utf8'), /never put the pay floor in as the expectation/);
});

test('the example P&L rule is anchored on the candidate\'s verb: a posting\'s "P&L ownership" is not flagged', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.example', 'fact-rules.json'), 'utf8')).rules;
  const pnl = new RegExp(rules.find(r => r.id === 'pnl-owner').pattern, 'i');
  assert.ok(pnl.test('Alex owned the P&L of the logistics unit.'));
  assert.ok(pnl.test('ran a EUR 4M P&L'));
  assert.ok(!pnl.test('The role comes with full P&L ownership.'));
  assert.ok(!pnl.test('Experience with P&L management is a plus.'));
});

test('sources --only runs one source with its arguments; an unknown name gets the usage line', () => {
  const x = home('only', { settings: { sources: { drop_dir: { enabled: true, dir: path.join(tmp, 'only-drop'), settle_sec: 0 } } } });
  const r = cli(x, ['sources', '--only', 'drop_dir', '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /does not exist yet \(the first real run creates it\)/);
  const bad = cli(x, ['sources', '--only', 'nope']);
  assert.equal(bad.status, 1); assert.match(bad.stdout, /^Usage: node cli\.mjs sources --only <ats_boards\|rtj\|/m);
  assert.match(cli(x, ['install-module', 'nope']).stdout, /^Usage: node cli\.mjs install-module <coach\|transcribe>/m);
});

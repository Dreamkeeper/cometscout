// The interview coach module: the installer (with a fake git that records its arguments), the hand-off file for the
// coach's kickoff, and the doctor lines. Synthetic data only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.mjs');
const EXAMPLE = path.join(ROOT, 'profile.example');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-coach-'));
const HOME = path.join(tmp, 'home');
const COACH = path.join(tmp, 'coach');
fs.mkdirSync(HOME, { recursive: true });
process.env.COMETSCOUT_HOME = HOME;
process.env.COMETSCOUT_DATA = path.join(HOME, 'data');
process.env.COMETSCOUT_RUN_DATE = '2026-10-02';
process.env.COMETSCOUT_SETTINGS = path.join(HOME, 'settings.json');
const SECRET = 'synthetic-secret-value-4711';
process.env.SYNTHETIC_API_TOKEN = SECRET;   // named like a secret, so SECRET_VALUES() holds it
const settings = { timezone: 'UTC', modules: { coach: { enabled: true, path: COACH } } };
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify(settings));

const coach = await import('../lib/coach.mjs');
const DATA = process.env.COMETSCOUT_DATA;

// Synthetic applications: an upcoming interview, a past one, a test task, a skipped role and a "later" only entry.
const ev = (date, type, extra = {}) => ({ date, type, source: 'cli', ...extra });
const APPS = {
  '2026-09-10--lumenfield--product-owner.md': { company: 'Lumenfield', role: 'Product Owner', status: 'interview', updated: '2026-09-29',
    events: [ev('2026-09-12', 'applied'), ev('2026-09-29', 'interview', { source: 'gmail', event_date: '2026-10-08', round: 2, note: 'Your second interview is on 8 October.' })] },
  'manual:ridgeway labs|platform pm': { company: 'Ridgeway Labs', role: 'Platform PM', status: 'interview', updated: '2026-09-20',
    events: [ev('2026-09-05', 'applied'), ev('2026-09-20', 'interview', { event_date: '2026-09-25' })] },
  'manual:quarry systems|product manager': { company: 'Quarry Systems', role: 'Product Manager', status: 'applied', updated: '2026-09-30',
    events: [ev('2026-09-28', 'applied'), ev('2026-09-30', 'test_task', { event_date: '2026-10-05' })] },
  'manual:bluefjord|data pm': { company: 'Bluefjord', role: 'Data PM', status: 'rejected', updated: '2026-09-18', events: [ev('2026-09-01', 'applied'), ev('2026-09-18', 'rejection')] },
  'manual:northwind devices|growth pm': { company: 'Northwind Devices', role: 'Growth PM', status: 'skipped', updated: '2026-09-11', events: [ev('2026-09-11', 'skipped')] },
  '2026-09-30--copperline--pm.md': { events: [ev('2026-09-30', 'later', { until: '2026-10-07' })] },
};
fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'state', 'applications.json'), JSON.stringify(APPS, null, 1));
const JOB_TEXT = 'SYNTHETIC-JOB-POSTING-TEXT-marker';
fs.mkdirSync(path.join(DATA, 'decoded'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'decoded', '2026-09-10--lumenfield--product-owner.md'), `---\ncompany: "Lumenfield"\nrole: "Product Owner"\n---\n\n${JOB_TEXT}\n`);
fs.mkdirSync(path.join(DATA, 'packs', 'lumenfield'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'packs', 'lumenfield', 'answers.md'), 'SYNTHETIC-PACK-ANSWERS-marker\n');
fs.writeFileSync(path.join(HOME, '.env'), `TELEGRAM_BOT_TOKEN=${SECRET}\n`);

const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env: { ...process.env, ...env } });
const at = (text, s) => { const i = text.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };

test('the hand-off has every section, built from the example profile and the applications', () => {
  const { text, example } = coach.buildHandoff({ profileDir: EXAMPLE, now: new Date('2026-10-02T09:00:00Z') });
  assert.equal(example, true);
  const order = ['# CometScout hand-off for the interview coach', '## Who I am and what I want', '## My CV', '## How I write', '## Where I stand', '### Coming up', '### Applications (newest first)'];
  const pos = order.map(s => at(text, s));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'sections in order');
  assert.match(text, /2026-10-02 09:00 UTC/);
  assert.match(text, /snapshot: CometScout keeps the live record/);
  assert.match(text, /fictional example profile/);
  // profile.md as written, headings under the hand-off's own; scope guards labelled
  assert.match(text, /^#### Scope guards \(never claim more than this\)$/m);
  assert.match(text, /Pay floor: EUR 60,000/);
  // the CV library: taglines, summaries, every role and bullet, skills, education; no contact line
  for (const s of ['Senior Product Manager  |  B2B SaaS, APIs & Integrations', 'Product manager with seven years', 'Brightgrid (fictional)', 'Product Manager, Carrier Integrations',
    'Took the grid-analytics product', 'Shipped a public API', 'Languages: English (C1), Spanish (native)', 'BSc Computer Science', 'SELECTED AI WORK']) at(text, s);
  assert.ok(!text.includes('alex.rivera@example.com'), 'no contact line');
  at(text, 'Plain and direct. Opens with the answer');
});

test('upcoming interviews come first, soonest first; past ones, skipped roles and "later" entries do not', () => {
  const { text } = coach.buildHandoff({ profileDir: EXAMPLE });
  const coming = text.slice(at(text, '### Coming up'), at(text, '### Applications'));
  const lines = coming.split('\n').filter(l => l.startsWith('- '));
  assert.deepEqual(lines, ['- 2026-10-05: test task due, Quarry Systems, Product Manager', '- 2026-10-08: interview (round 2), Lumenfield, Product Owner',
    '- in progress: interview, Ridgeway Labs, Platform PM, last news 2026-09-20']);
  assert.ok(at(text, 'Lumenfield, Product Owner') < at(text, '| Lumenfield |'), 'the interview is listed before the applications table');
  const table = text.slice(at(text, '### Applications')).split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Company'));
  assert.deepEqual(table, [
    '| Quarry Systems | Product Manager | applied | test task | 2026-09-30 |',
    '| Lumenfield | Product Owner | interview | interview | 2026-09-29 |',
    '| Ridgeway Labs | Platform PM | interview | interview | 2026-09-20 |',
    '| Bluefjord | Data PM | rejected | rejection email | 2026-09-18 |',
  ]);
  assert.ok(!text.includes('Northwind') && !text.includes('Copperline'));
});

test('imported records: in-progress statuses and events dated today or later are listed, dated items first', () => {
  // round is free text in imported records; no event_date anywhere; a contact and a registry status sync come last
  const apps = {
    'imp:1': { company: 'Saltmarsh Analytics', role: 'Senior PM', status: 'interview', updated: '2026-09-26',
      events: [ev('2026-09-02', 'applied'), ev('2026-09-26', 'interview', { round: 'final, with the CTO' }), ev('2026-09-27', 'contact'), ev('2026-09-28', 'registry-status')] },
    'imp:2': { company: 'Orchard Freight', role: 'Product Owner', status: 'applied', updated: '2026-10-06',
      events: [ev('2026-09-30', 'applied'), ev('2026-10-06', 'interview', { round: 'hiring manager' })] },
    'imp:3': { company: 'Kestrel Grid', role: 'Platform PM', status: 'screen', updated: '2026-10-02', events: [ev('2026-09-29', 'applied'), ev('2026-10-02', 'screen')] },
    'imp:4': { company: 'Larkspur Health', role: 'PM', status: 'offer', round: 'verbal', updated: '2026-09-30' },
    'imp:5': { company: 'Fernway', role: 'PM', status: 'rejected', updated: '2026-10-02', events: [ev('2026-09-20', 'applied'), ev('2026-10-02', 'rejected')] },
    'imp:6': { company: 'Gullwing', role: 'PM', status: 'interview', updated: '2026-10-01', events: [ev('2026-09-21', 'applied'), ev('2026-10-01', 'interview', { source: 'gmail', event_date: '2026-10-04', round: 1 })] },
  };
  const { text } = coach.buildHandoff({ profileDir: EXAMPLE, apps });
  const coming = text.slice(at(text, '### Coming up'), at(text, '### Applications')).split('\n').filter(l => l.startsWith('- '));
  assert.deepEqual(coming, [
    '- 2026-10-02: screen, Kestrel Grid, Platform PM',
    '- 2026-10-04: interview (round 1), Gullwing, PM',
    '- 2026-10-06: interview (hiring manager), Orchard Freight, Product Owner',
    '- in progress: offer (verbal), Larkspur Health, PM, last news 2026-09-30',
    '- in progress: interview (final, with the CTO), Saltmarsh Analytics, Senior PM, last news 2026-09-26',
  ]);
  assert.ok(!coming.some(l => l.includes('Fernway')), 'a rejected application has nothing coming up');
  // last event: contact and registry-status are skipped; statuses and Gmail types are named
  const row = name => text.split('\n').find(l => l.startsWith(`| ${name} |`));
  assert.equal(row('Saltmarsh Analytics'), '| Saltmarsh Analytics | Senior PM | interview | interview | 2026-09-26 |');
  assert.equal(row('Fernway'), '| Fernway | PM | rejected | rejected | 2026-10-02 |');
  assert.equal(row('Larkspur Health'), '| Larkspur Health | PM | offer |  | 2026-09-30 |');
  assert.ok(!/contact|registry/.test(text.slice(at(text, '## Where I stand'))));
  assert.deepEqual(coach.upcoming({}, '2026-10-02'), { dated: [], progress: [] });
  // a malformed entry (events not a list) is shown without its events, never a crash
  assert.deepEqual(coach.upcoming({ x: { company: 'Odd', role: 'PM', status: 'interview', events: { a: 1 }, updated: '2026-09-01' } }, '2026-10-02').progress,
    [{ status: 'interview', round: '', since: '2026-09-01', company: 'Odd', role: 'PM' }]);
  assert.match(coach.buildHandoff({ profileDir: EXAMPLE, apps: {} }).text, /Nothing with a date ahead or in progress is recorded\./);
});

test('a job the user holds (accepted) is listed under "Jobs I hold", never in progress; its interview date ahead is a possible probation review', () => {
  const apps = {
    'manual:saltmarsh analytics|senior pm': { company: 'Saltmarsh Analytics', role: 'Senior PM', status: 'accepted', updated: '2026-09-15',
      events: [ev('2026-08-20', 'applied'), ev('2026-09-10', 'offer', { source: 'gmail' }), ev('2026-09-15', 'accepted'), ev('2026-10-02', 'offer', { source: 'gmail' })] },
    'manual:gullwing|platform pm': { company: 'Gullwing', role: 'Platform PM', status: 'interview', updated: '2026-09-30',
      events: [ev('2026-09-21', 'applied'), ev('2026-09-30', 'interview')] },
  };
  let { text } = coach.buildHandoff({ profileDir: EXAMPLE, apps });
  const section = (from, to) => text.slice(at(text, from), at(text, to)).split('\n').filter(l => l.startsWith('- '));
  assert.ok(at(text, '## Where I stand') < at(text, '### Jobs I hold') && at(text, '### Jobs I hold') < at(text, '### Coming up'));
  assert.deepEqual(section('### Jobs I hold', '### Coming up'), ['- Saltmarsh Analytics, Senior PM, since 2026-09-15']);
  assert.deepEqual(section('### Coming up', '### Applications'), ['- in progress: interview, Gullwing, Platform PM, last news 2026-09-30'],
    'the held job is not in progress, and an offer email dated today is not something coming up');
  assert.equal(text.split('\n').find(l => l.startsWith('| Saltmarsh Analytics |')), '| Saltmarsh Analytics | Senior PM | accepted | offer | 2026-10-02 |');

  // an interview booked after accepting (a probation review, say) is still coming up, with a note
  apps['manual:saltmarsh analytics|senior pm'].events.push(ev('2026-10-01', 'interview', { source: 'gmail', event_date: '2026-10-09' }));
  ({ text } = coach.buildHandoff({ profileDir: EXAMPLE, apps }));
  assert.deepEqual(section('### Coming up', '### Applications'), [
    '- 2026-10-09: interview, Saltmarsh Analytics, Senior PM (a job I hold: this may be a probation review)',
    '- in progress: interview, Gullwing, Platform PM, last news 2026-09-30',
  ]);
  assert.deepEqual(section('### Jobs I hold', '### Coming up'), ['- Saltmarsh Analytics, Senior PM, since 2026-09-15']);
  // no job held: no section
  assert.ok(!coach.buildHandoff({ profileDir: EXAMPLE, apps: { g: apps['manual:gullwing|platform pm'] } }).text.includes('Jobs I hold'));
  // no accepted event (an imported record): since is the day it was updated
  assert.deepEqual(coach.heldJobs({ x: { company: 'Orchard Freight', role: 'PM', status: 'accepted', updated: '2026-07-01' } }), [{ company: 'Orchard Freight', role: 'PM', since: '2026-07-01' }]);
});

test('no secret, job text, pack or email note ends up in the hand-off', () => {
  const { text } = coach.buildHandoff({ profileDir: EXAMPLE });
  for (const s of [SECRET, JOB_TEXT, 'SYNTHETIC-PACK-ANSWERS-marker', 'Your second interview is on 8 October']) assert.ok(!text.includes(s), s);
});

test('a scope guard heading without "never claim" is labelled; without one, the fact rules give the list', () => {
  const dir = path.join(tmp, 'profile-a'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.md'), '# Sam Example\n\n## Who I am\n- Product manager, 5 years.\n\n## Scope guards\n- Never led a team.\n');
  let { text } = coach.buildHandoff({ profileDir: dir, apps: {} });
  assert.match(text, /^#### Scope guards \(never claim\)$/m);
  assert.match(text, /No CV library yet/);
  assert.match(text, /No voice card yet/);
  assert.match(text, /No applications recorded yet/);
  const dir2 = path.join(tmp, 'profile-b'); fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'profile.md'), '# Sam Example\n\n## Who I am\n- Product manager, 5 years.\n');
  fs.writeFileSync(path.join(dir2, 'fact-rules.json'), JSON.stringify({ rules: [{ id: 'team', pattern: 'led a team', why: 'Sam never led a team.' }] }));
  ({ text } = coach.buildHandoff({ profileDir: dir2, apps: {} }));
  assert.match(text, /### Scope guards \(never claim\)\n\n- Sam never led a team\./);
});

test('scope guards: a bullet that mentions them is not a heading; fact-rule reasons are always listed, without repeats', () => {
  // the bullet-only case: "scope guard" in a bullet, no heading, so the fact rules must still give the list
  const dir = path.join(tmp, 'profile-c'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.md'), '# Sam Example\n\n## Who I am\n- Careful with claims; my scope guard is the fact rules file.\n');
  const rules = [{ id: 'team', pattern: 'led a team', why: 'Sam never led a team.' }, { id: 'ml', pattern: 'built models', why: 'Sam never built ML models.' },
    { id: 'team2', pattern: 'managed a team', why: 'Sam never led a team.' }, { id: 'nowhy', pattern: 'x' }];
  fs.writeFileSync(path.join(dir, 'fact-rules.json'), JSON.stringify({ rules }));
  let { text } = coach.buildHandoff({ profileDir: dir, apps: {} });
  assert.match(text, /### Scope guards \(never claim\)\n\n- Sam never led a team\.\n- Sam never built ML models\.\n/);
  assert.match(text, /^- Careful with claims; my scope guard is the fact rules file\.$/m, 'the bullet is kept as written, not labelled');
  // a labelled heading in the profile: fact-rule reasons it already says are not repeated, the others are added
  fs.writeFileSync(path.join(dir, 'profile.md'), '# Sam Example\n\n## Scope guards\n- Sam never led a team.\n\n## What I want\n- PM roles.\n');
  ({ text } = coach.buildHandoff({ profileDir: dir, apps: {} }));
  assert.match(text, /^#### Scope guards \(never claim\)$/m);
  assert.match(text, /### Scope guards from my fact rules \(never claim\)\n\n- Sam never built ML models\.\n/);
  assert.equal(text.split('Sam never led a team.').length - 1, 1, 'listed once');
  // the example profile: its own section plus the reasons from its fact rules
  ({ text } = coach.buildHandoff({ profileDir: EXAMPLE, apps: {} }));
  assert.match(text, /Scope guards from my fact rules \(never claim\)\n\n- Alex mentored two junior PMs/);
});

test('a value from .env in the profile stops the hand-off; nothing is written', () => {
  const dir = path.join(tmp, 'profile-secret'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.md'), `# Sam\n\nPasted by mistake: ${SECRET}\n`);
  const out = path.join(tmp, 'secret-out', 'h.md'), lines = [];
  assert.equal(coach.coachHandoff({ out, profileDir: dir, log: l => lines.push(l) }), 1);
  assert.match(lines.join('\n'), /value from \.env/);
  assert.ok(!fs.existsSync(out));
});

test('cli coach-handoff: --out is honoured, the default goes into the coach folder, a missing coach or profile is clear', () => {
  fs.cpSync(EXAMPLE, path.join(HOME, 'profile'), { recursive: true });
  try {
    const out = path.join(tmp, 'out', 'handoff.md');
    let r = cli(['coach-handoff', '--out', out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /In the coach, say: kickoff, and give it handoff\.md/);
    const text = fs.readFileSync(out, 'utf8');
    at(text, '## Where I stand'); at(text, '2026-10-08: interview');
    assert.ok(!text.includes(SECRET) && !text.includes(JOB_TEXT));
    assert.ok(!/fictional example profile \(profile\.example/.test(text), 'profile/ is not the example');
    r = cli(['coach-handoff', '--out']);
    assert.equal(r.status, 1); assert.match(r.stdout, /Usage: node cli\.mjs coach-handoff/);
    // no coach folder yet: no file, a clear message (the folder is not created, so the installer can still clone)
    r = cli(['coach-handoff']);
    assert.equal(r.status, 1); assert.match(r.stdout, /not installed at/); assert.ok(!fs.existsSync(COACH));
    fs.mkdirSync(COACH);
    r = cli(['coach-handoff']);
    assert.equal(r.status, 0, r.stdout);
    // the default is materials/ in the coach's folder (the coach's .gitignore covers it); materials/ is made when missing
    assert.ok(fs.existsSync(path.join(COACH, 'materials', 'cometscout-handoff.md')));
    assert.ok(!fs.existsSync(path.join(COACH, 'cometscout-handoff.md')));
    assert.match(r.stdout, /give it materials\/cometscout-handoff\.md/);
  } finally { fs.rmSync(path.join(HOME, 'profile'), { recursive: true, force: true }); fs.rmSync(COACH, { recursive: true, force: true }); }
  // a home with no profile at all
  const bare = path.join(tmp, 'bare'); fs.mkdirSync(bare);
  const r = cli(['coach-handoff', '--out', path.join(tmp, 'bare-out.md')], { COMETSCOUT_HOME: bare, COMETSCOUT_DATA: path.join(bare, 'data') });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No profile to hand off: .*profile\.md is missing or empty/);
  assert.ok(!fs.existsSync(path.join(tmp, 'bare-out.md')));
});

test('cli.mjs run refreshes the hand-off when the coach is enabled; a missing coach is logged and never fails the run', () => {
  const home = path.join(tmp, 'run-home'); fs.mkdirSync(path.join(home, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profile', 'profile.md'), '# Sam Example\n\n## Who I am\n- Product manager, 5 years.\n');
  const coachDir = path.join(tmp, 'run-coach');
  const conf = coach => JSON.stringify({ timezone: 'UTC', sources: {}, pack: { enabled: false }, backup: { nightly: false }, modules: { coach } });
  const env = { COMETSCOUT_HOME: home, COMETSCOUT_DATA: path.join(home, 'data'), COMETSCOUT_SETTINGS: path.join(home, 'settings.json') };
  const file = path.join(coachDir, 'materials', 'cometscout-handoff.md');
  // enabled, not installed: one log line, exit 0, no folder made
  fs.writeFileSync(env.COMETSCOUT_SETTINGS, conf({ enabled: true, path: coachDir }));
  let r = cli(['run'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /coach-handoff: not refreshed: The coach is not installed at/);
  assert.ok(!fs.existsSync(coachDir));
  // installed: the file is written in materials/
  fs.mkdirSync(coachDir);
  r = cli(['run'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /coach-handoff: refreshed .*cometscout-handoff\.md/);
  assert.match(fs.readFileSync(file, 'utf8'), /- Product manager, 5 years\./);
  // disabled: nothing is written or said
  fs.rmSync(file);
  fs.writeFileSync(env.COMETSCOUT_SETTINGS, conf({ enabled: false, path: coachDir }));
  r = cli(['run'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /coach-handoff/);
  assert.ok(!fs.existsSync(file));
});

test('refreshHandoff never throws: a hand-off that cannot be built is one log line', () => {
  const dir = path.join(tmp, 'profile-refresh'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.md'), `# Sam\n\nPasted by mistake: ${SECRET}\n`);
  const lines = [];
  const out = path.join(tmp, 'refresh-out', 'h.md');
  assert.equal(coach.refreshHandoff({ settings: { modules: { coach: { enabled: true, path: COACH } } }, out, profileDir: dir, log: l => lines.push(l) }), 1);
  assert.deepEqual(lines.length, 1); assert.match(lines[0], /^coach-handoff: not refreshed: .*value from \.env/);
  assert.ok(!fs.existsSync(out));
  assert.equal(coach.refreshHandoff({ settings: {}, log: l => lines.push(l) }), null);
  assert.equal(lines.length, 1);
});

// ---------- installer ----------

const FAKE_GIT = path.join(tmp, 'fake-git.mjs');
const GIT_LOG = path.join(tmp, 'git-calls.jsonl');
fs.writeFileSync(FAKE_GIT, `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ args, prompt: process.env.GIT_TERMINAL_PROMPT ?? null, gcm: process.env.GCM_INTERACTIVE ?? null }) + '\\n');
if (process.env.FAKE_GIT_FAIL && args.includes(process.env.FAKE_GIT_FAIL)) { console.error('fatal: synthetic failure'); process.exit(1); }
const at = () => args[args.indexOf('-C') + 1];
if (args[0] === 'clone') {
  const dir = args[args.length - 1];
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'origin'), args[args.length - 2]);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'skill v1\\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme\\n');
} else if (args.includes('get-url')) {
  try { console.log(fs.readFileSync(path.join(at(), '.git', 'origin'), 'utf8')); } catch { console.error("error: No such remote 'origin'"); process.exit(2); }
} else if (args.includes('pull')) {
  fs.writeFileSync(path.join(at(), 'SKILL.md'), process.env.FAKE_GIT_SKILL || 'skill v2\\n');
} else if (args.includes('log')) console.log('abc1234 2026-09-30');
`);
const records = () => (fs.existsSync(GIT_LOG) ? fs.readFileSync(GIT_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const calls = () => records().map(r => r.args);
const pulls = () => calls().filter(c => c.includes('pull'));
const withGit = (env, fn) => {
  const keep = { GIT: process.env.GIT, FAKE_GIT_LOG: process.env.FAKE_GIT_LOG, FAKE_GIT_FAIL: process.env.FAKE_GIT_FAIL, FAKE_GIT_SKILL: process.env.FAKE_GIT_SKILL };
  Object.assign(process.env, { GIT: FAKE_GIT, FAKE_GIT_LOG: GIT_LOG }, env);
  fs.rmSync(GIT_LOG, { force: true });
  try { return fn(); } finally { for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
// every file under dir (except .git) with its content
const snapshot = dir => {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.name === '.git') continue; if (e.isDirectory()) walk(p); else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8'); } };
  walk(dir); return out;
};
const install = (target, extra = {}) => { const lines = []; const code = coach.installCoach({ settings: { modules: { coach: { path: target, ...extra } } }, log: l => lines.push(l) }); return { code, out: lines.join('\n') }; };

test('installer: the first install clones the upstream with depth 1 and activates the skill', () => withGit({}, () => {
  const target = path.join(tmp, 'install-1', 'interview-coach');
  const r = install(target);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(calls()[0], ['clone', '--depth', '1', '--', coach.COACH_REPO, target]);
  assert.ok(!calls().some(c => c.includes('pull')));
  assert.equal(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8'), 'skill v1\n');
  assert.match(r.out, /Interview coach: .*interview-coach \(abc1234, 2026-09-30\)/);
  assert.ok(r.out.includes(coach.startLine(target)), 'prints how to start it');
  assert.match(r.out, /Then say: kickoff/);
  assert.match(r.out, /Noam Segal, MIT license/);
  assert.match(r.out, /modules\.coach\.enabled/);
  // git never waits for a username or password
  assert.ok(records().length > 0 && records().every(x => x.prompt === '0' && x.gcm === 'never'), JSON.stringify(records()));
  // an empty folder counts as not installed; modules.coach.repo is honoured
  const empty = path.join(tmp, 'install-empty'); fs.mkdirSync(empty);
  assert.equal(install(empty, { repo: 'https://git.example/coach.git' }).code, 0);
  assert.deepEqual(calls().filter(c => c[0] === 'clone').at(-1), ['clone', '--depth', '1', '--', 'https://git.example/coach.git', empty]);
}));

test('installer: an update pulls fast-forward only and never deletes or changes the coach\'s own files', () => withGit({}, () => {
  const target = path.join(tmp, 'install-2');
  install(target);
  fs.writeFileSync(path.join(target, 'coaching_state.md'), '# synthetic coaching state\n');
  fs.mkdirSync(path.join(target, 'materials', 'acme'), { recursive: true });
  fs.writeFileSync(path.join(target, 'materials', 'acme', 'transcript.md'), 'synthetic transcript\n');
  fs.writeFileSync(path.join(target, 'cometscout-handoff.md'), 'synthetic hand-off\n');
  const before = snapshot(target);
  fs.rmSync(GIT_LOG, { force: true });
  const r = install(target);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(calls().slice(0, 2), [['-C', target, 'remote', 'get-url', 'origin'], ['-C', target, 'pull', '--ff-only']]);
  assert.ok(!calls().some(c => c[0] === 'clone'));
  assert.ok(records().every(x => x.prompt === '0' && x.gcm === 'never'));
  const after = snapshot(target);
  for (const f of Object.keys(before)) assert.ok(f in after, `${f} still there`);
  for (const f of ['coaching_state.md', 'materials/acme/transcript.md', 'cometscout-handoff.md', 'README.md']) assert.equal(after[f], before[f], f);
  // an existing CLAUDE.md is never overwritten, even an unedited copy of the old SKILL.md; the output says how to update it
  assert.equal(after['SKILL.md'], 'skill v2\n');
  assert.equal(after['CLAUDE.md'], 'skill v1\n');
  assert.match(r.out, /CLAUDE\.md differs from SKILL\.md and was left as it is/);
}));

test('installer: a CLAUDE.md the user edited is left as it is; a missing one is created again', () => withGit({ FAKE_GIT_SKILL: 'skill v3\n' }, () => {
  const target = path.join(tmp, 'install-2');
  fs.writeFileSync(path.join(target, 'CLAUDE.md'), 'my own edits\n');
  let r = install(target);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8'), 'my own edits\n');
  assert.match(r.out, /left as it is/);
  const keep = fs.readFileSync(path.join(target, 'CLAUDE.md'));
  fs.rmSync(path.join(target, 'CLAUDE.md'));
  r = install(target);
  assert.equal(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8'), 'skill v3\n');
  assert.match(r.out, /Activated the coach/);
  fs.writeFileSync(path.join(target, 'CLAUDE.md'), keep);
}));

test('installer: a checkout of another repository is never pulled', () => withGit({}, () => {
  const target = path.join(tmp, 'install-2');
  const before = snapshot(target);
  let r = install(target, { repo: 'https://git.example/someone-else/coach.git' });
  assert.equal(r.code, 1);
  assert.match(r.out, /is a checkout of https:\/\/github\.com\/noamseg\/interview-coach-skill\.git, not of modules\.coach\.repo \(https:\/\/git\.example\/someone-else\/coach\.git\)/);
  assert.deepEqual(pulls(), []);
  assert.deepEqual(snapshot(target), before);
  // the same address in another spelling (case, no .git, a trailing slash) is the same repository
  fs.rmSync(GIT_LOG, { force: true });
  r = install(target, { repo: 'https://GitHub.com/noamseg/interview-coach-skill/' });
  assert.equal(r.code, 0, r.out);
  assert.equal(pulls().length, 1);
  // a checkout with no origin at all is not updated either
  const lone = path.join(tmp, 'no-origin'); fs.mkdirSync(path.join(lone, '.git'), { recursive: true });
  fs.rmSync(GIT_LOG, { force: true });
  r = install(lone);
  assert.equal(r.code, 1); assert.match(r.out, /is a checkout of no origin/); assert.deepEqual(pulls(), []);
}));

test('installer: a failed pull and a folder that is not a checkout leave everything in place', () => withGit({ FAKE_GIT_FAIL: 'pull' }, () => {
  const target = path.join(tmp, 'install-2');
  const before = snapshot(target);
  let r = install(target);
  assert.equal(r.code, 1);
  assert.match(r.out, /git pull --ff-only failed: fatal: synthetic failure/);
  // the advice never destroys edits: git status to see what differs, a copy kept elsewhere; never git checkout
  assert.ok(r.out.includes(`git -C "${target}" status`), r.out);
  assert.match(r.out, /keep a copy of your edits somewhere else/);
  assert.doesNotMatch(r.out.split(target).join('<dir>'), /checkout --|reset|clean|stash/);   // the folder's own path may hold any word
  assert.deepEqual(snapshot(target), before);
  const other = path.join(tmp, 'not-a-checkout'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'notes.md'), 'someone else\'s notes\n');
  fs.rmSync(GIT_LOG, { force: true });
  r = install(other);
  assert.equal(r.code, 1);
  assert.match(r.out, /is not a git checkout of the coach/);
  assert.deepEqual(calls(), []);
  assert.deepEqual(snapshot(other), { 'notes.md': 'someone else\'s notes\n' });
  assert.equal(install(path.join(tmp, 'x'), { repo: '--upload-pack=evil' }).code, 1);
}));

test('installer: a failed clone says so', () => withGit({ FAKE_GIT_FAIL: 'clone' }, () => {
  const r = install(path.join(tmp, 'install-fail'));
  assert.equal(r.code, 1);
  assert.match(r.out, /git clone failed: fatal: synthetic failure/);
}));

test('coach settings: the default folder is next to the home; relative paths are relative to the home', () => {
  assert.equal(coach.coachSettings({}, HOME).path, path.resolve(HOME, '..', 'interview-coach'));
  assert.equal(coach.coachSettings({ modules: { coach: { path: 'coach-here' } } }, HOME).path, path.resolve(HOME, 'coach-here'));
  assert.equal(coach.coachSettings({ modules: { coach: { path: '~/ic' } } }, HOME).path, path.join(os.homedir(), 'ic'));
  assert.deepEqual(coach.coachSettings({}, HOME), { enabled: false, path: path.resolve(HOME, '..', 'interview-coach'), repo: coach.COACH_REPO });
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8'));
  assert.deepEqual(example.modules.coach, { enabled: false, path: null, repo: coach.COACH_REPO });
});

// The wrappers call node by name: put this node first on the PATH. Windows spells it Path, and two spellings in one
// environment would leave the child with either, so every other spelling is dropped.
const envFor = settingsFile => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  const dirs = Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] || '';
  return { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${dirs}`, COMETSCOUT_SETTINGS: settingsFile };
};
test('deploy/modules/coach.sh runs the installer with GIT honoured', { skip: process.platform === 'win32' ? 'bash on Windows may be WSL; coach.ps1 is tested there' : !coach.onPath('bash') && 'bash not found' }, () => withGit({}, () => {
  const target = path.join(tmp, 'install-sh');
  const env = envFor(path.join(tmp, 'settings-sh.json'));
  fs.writeFileSync(env.COMETSCOUT_SETTINGS, JSON.stringify({ modules: { coach: { path: target } } }));
  let r = spawnSync('bash', [path.join(ROOT, 'deploy', 'modules', 'coach.sh')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls()[0], ['clone', '--depth', '1', '--', coach.COACH_REPO, target]);
  assert.ok(records().every(x => x.prompt === '0' && x.gcm === 'never'));
  fs.writeFileSync(path.join(target, 'coaching_state.md'), 'keep me\n');
  r = spawnSync('bash', [path.join(ROOT, 'deploy', 'modules', 'coach.sh')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(calls().some(c => c.join(' ') === `-C ${target} pull --ff-only`));
  assert.equal(fs.readFileSync(path.join(target, 'coaching_state.md'), 'utf8'), 'keep me\n');
  assert.match(r.stdout, /Then say: kickoff/);
}));

const PS = process.platform === 'win32' ? 'powershell' : coach.onPath('pwsh') ? 'pwsh' : null;
test('deploy/modules/coach.ps1 runs the installer with GIT honoured', { skip: !PS && 'PowerShell not found' }, () => withGit({}, () => {
  const target = path.join(tmp, 'install-ps');
  const env = envFor(path.join(tmp, 'settings-ps.json'));
  fs.writeFileSync(env.COMETSCOUT_SETTINGS, JSON.stringify({ modules: { coach: { path: target } } }));
  const run = () => spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'deploy', 'modules', 'coach.ps1')], { encoding: 'utf8', env });
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls()[0], ['clone', '--depth', '1', '--', coach.COACH_REPO, target]);
  fs.writeFileSync(path.join(target, 'coaching_state.md'), 'keep me\n');
  r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(calls().some(c => c.join(' ') === `-C ${target} pull --ff-only`));
  assert.equal(fs.readFileSync(path.join(target, 'coaching_state.md'), 'utf8'), 'keep me\n');
}));

// ---------- doctor ----------

test('doctor: off, not installed, installed, not a checkout, not activated, claude on the PATH', () => withGit({}, () => {
  const lines = (c, hasClaude = () => true) => coach.coachDoctor({ settings: { modules: { coach: c } }, hasClaude });
  assert.deepEqual(lines({ enabled: false }), [{ level: 'ok', text: `interview coach: off (optional: ${coach.INSTALL_COMMAND}, README: Interview coach)` }]);
  assert.deepEqual(coach.coachDoctor({ settings: {} }).map(l => l.text), [`interview coach: off (optional: ${coach.INSTALL_COMMAND}, README: Interview coach)`]);
  const missing = path.join(tmp, 'doctor-missing');
  let l = lines({ enabled: true, path: missing }, () => false);
  assert.deepEqual(l[0], { level: 'todo', text: `interview coach: not installed at ${missing}`, fix: coach.INSTALL_COMMAND });
  assert.equal(l[1].level, 'todo'); assert.match(l[1].text, /claude on the PATH .*not found/);
  const target = path.join(tmp, 'install-2');
  l = lines({ enabled: true, path: target });
  assert.deepEqual(l[0], { level: 'ok', text: `interview coach: ${target} (abc1234, 2026-09-30)` });
  assert.equal(l.length, 2); assert.equal(l[1].level, 'ok');
  l = lines({ enabled: true, path: path.join(tmp, 'not-a-checkout') });
  assert.equal(l[0].level, 'todo'); assert.match(l[0].text, /is not a git checkout/);
  const bare = path.join(tmp, 'doctor-no-claude-md'); fs.mkdirSync(path.join(bare, '.git'), { recursive: true });
  l = lines({ enabled: true, path: bare });
  assert.equal(l[0].level, 'ok'); assert.deepEqual(l[1], { level: 'todo', text: 'interview coach: not activated (no CLAUDE.md in its folder)', fix: coach.INSTALL_COMMAND });
}));

test('onPath finds a command, with PATHEXT on Windows', () => {
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '');
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '');
  // platform 'linux' splits PATH on ":", which a Windows path with a drive letter cannot pass through
  const host = process.platform === 'win32' ? 'win32' : 'linux';
  assert.equal(coach.onPath('claude', { env: { PATH: bin }, platform: host }), true);
  assert.equal(coach.onPath('nothing-here', { env: { PATH: bin }, platform: host }), false);
  assert.equal(coach.onPath('codex', { env: { Path: bin, PATHEXT: '.EXE;.CMD' }, platform: 'win32' }), true);
  if (host === 'linux') assert.equal(coach.onPath('codex', { env: { PATH: bin }, platform: 'linux' }), false, 'no PATHEXT off Windows');
});

test('cli doctor prints the coach lines', () => {
  const s = path.join(tmp, 'settings-doctor.json');
  fs.writeFileSync(s, JSON.stringify({ modules: { coach: { enabled: true, path: path.join(tmp, 'doctor-missing') } } }));
  let r = cli(['doctor'], { COMETSCOUT_SETTINGS: s });
  assert.match(r.stdout, /^TODO interview coach: not installed at .*doctor-missing {2}-> {2}/m);
  fs.writeFileSync(s, JSON.stringify({ modules: { coach: { enabled: false } } }));
  r = cli(['doctor'], { COMETSCOUT_SETTINGS: s });
  assert.match(r.stdout, /^ok {3}interview coach: off/m);
});

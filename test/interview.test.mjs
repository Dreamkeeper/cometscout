// Booked interviews: cli.mjs interview and POST /api/interview write an "interview" event with event_date and
// event_time (the status moves to interview unless it is further), the coach hand-off shows the time, and the
// workspace's settings API and Today prep banner. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-interview-'));
const DATA = path.join(tmp, 'data');
const DAY = new Date().toISOString().slice(0, 10);
const addDays = n => { const d = new Date(`${DAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = DATA;
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
process.env.JOBPILOT_RUN_DATE = DAY;
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC', candidate_name: 'Sam Example', schedule: { days: [1, 2, 3, 4, 5, 6, 7], time: '18:00' } }, null, 2));
for (const d of ['decoded', 'rejected', 'inbox', 'state', 'packs']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
const APPS = path.join(DATA, 'state', 'applications.json');
const job = (company, role, verdict = 'strong-fit') => {
  const file = `${DAY}--${company.toLowerCase()}--${role.toLowerCase().replace(/\W+/g, '-')}.md`;
  fs.writeFileSync(path.join(DATA, 'decoded', file), ['---', `company: "${company}"`, `role: "${role}"`, `url: "https://jobs.example/${file}"`, 'location: "Remote"', `found: ${DAY}`, '---', '',
    `# ${company} - ${role}`, '', 'text', '', '## Decode Result', `Decoded ${DAY} by jobpilot (claude/sonnet).`, `verdict: ${verdict}`, 'confidence: high', 'apply_priority: 2', 'rationale: r', 'action: Apply.', ''].join('\n'));
  return file;
};
const F = { glen: job('Glenmoor', 'Product Manager'), ferro: job('Ferrovia', 'Platform Product Owner'), kite: job('Kitewell', 'Data Product Manager') };
fs.writeFileSync(APPS, JSON.stringify({ [F.kite]: { company: 'Kitewell', role: 'Data Product Manager', status: 'offer', updated: DAY, events: [{ date: DAY, type: 'offer', source: 'cli' }] } }, null, 1));
const apps = () => JSON.parse(fs.readFileSync(APPS, 'utf8'));
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { encoding: 'utf8', env: process.env, timeout: 60000 });

const W = await import('../lib/workspace.mjs');
const { upcoming, buildHandoff } = await import('../lib/coach.mjs');
const { addInterview } = await import('../lib/applications.mjs');

test('cli.mjs interview writes the event with date, time and round, and sets the status', () => {
  const r = cli('interview', 'Glenmoor', addDays(2), '9:30', 'product', '--round', 'final, with the CTO');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`Glenmoor: Product Manager -> interview on ${addDays(2)} 09:30 \\(final, with the CTO\\)`));
  const a = apps()[F.glen];
  assert.equal(a.status, 'interview'); assert.equal(a.updated, DAY);
  assert.deepEqual(a.events.at(-1), { date: DAY, type: 'interview', event_date: addDays(2), event_time: '09:30', round: 'final, with the CTO', source: 'cli' });
  // an offer stays an offer; the interview is still recorded
  const k = cli('interview', 'Kitewell', addDays(1));
  assert.equal(k.status, 0); assert.match(k.stdout, /status stays offer/);
  assert.equal(apps()[F.kite].status, 'offer'); assert.equal(apps()[F.kite].events.at(-1).event_date, addDays(1));
  assert.equal(apps()[F.kite].events.at(-1).event_time, undefined, 'no time given, none stored');
  // refusals write nothing
  const before = fs.readFileSync(APPS, 'utf8');
  for (const bad of [['interview', 'Glenmoor', '2026-02-30'], ['interview', 'Glenmoor', addDays(1), '25:00'], ['interview', 'Nowhere', addDays(1)], ['interview', 'Glenmoor']]) {
    const x = cli(...bad); assert.equal(x.status, 1, bad.join(' ')); assert.equal(fs.readFileSync(APPS, 'utf8'), before);
  }
  assert.equal(cli('interview', 'Nowhere Labs', addDays(1), '--manual').status, 0, '--manual records a role that is not in the queue');
  assert.equal(apps()['manual:nowhere labs|'].status, 'interview');
});

test('POST /api/interview writes the same event; unknown job 404, bad input 400', () => {
  const r = W.postInterview({ file: F.ferro, date: addDays(1), time: '14:00', round: 'round 2' });
  assert.equal(r.ok, true);
  assert.deepEqual(apps()[F.ferro].events.at(-1), { date: DAY, type: 'interview', event_date: addDays(1), event_time: '14:00', round: 'round 2', source: 'workspace' });
  assert.throws(() => W.postInterview({ file: 'gone.md', date: addDays(1) }), e => e.status === 404);
  assert.throws(() => W.postInterview({ file: F.ferro, date: 'tomorrow' }), e => e.status === 400);
  assert.throws(() => W.postInterview({ file: F.ferro, date: addDays(1), time: 1400 }), e => e.status === 400);
  assert.throws(() => W.postInterview({ file: F.ferro }), e => e.status === 400);
});

test('the coach hand-off\'s "Coming up" shows the interview time when known', () => {
  const { dated } = upcoming(apps(), DAY);
  const ferro = dated.find(u => u.company === 'Ferrovia'), glen = dated.find(u => u.company === 'Glenmoor'), kite = dated.find(u => u.company === 'Kitewell');
  assert.equal(ferro.time, '14:00'); assert.equal(glen.time, '09:30'); assert.equal(kite.time, '');
  const { text } = buildHandoff({ profileDir: path.join(ROOT, 'profile.example'), apps: apps(), date: DAY, secrets: [] });
  assert.ok(text.includes(`- ${addDays(1)} 14:00: interview (round 2), Ferrovia, Platform Product Owner`), text);
  assert.ok(text.includes(`- ${addDays(1)}: interview, Kitewell, Data Product Manager`), 'no time: the day only');
});

test('Today shows prep mode like the digest; the settings API reads and writes through the writer', () => {
  const t = W.todayPayload();
  assert.equal(t.prep.company, 'Ferrovia'); assert.equal(t.prep.days, 1); assert.equal(t.prep.step, 'practice');
  assert.match(t.prep.lines[0], /^📅 Interview tomorrow: Ferrovia, round 2, .+, 14:00$/);
  assert.match(t.prep.lines.at(-1), /roles wait until after the interview\.$/, 'no picks today: the wait line');
  const s = W.settingsPayload();
  assert.deepEqual({ days: s.days, time: s.time, prep_days: s.prep_days, writable: s.writable }, { days: [1, 2, 3, 4, 5, 6, 7], time: '18:00', prep_days: 2, writable: true });
  const seen = [];
  const r = W.postSettings({ days: [1, 2, 3], prep_days: 0, ignored: true }, { write: p => { seen.push(p); return { ok: true, view: { days: [1, 2, 3] }, timer: null, message: 'Saved.' }; } });
  assert.deepEqual(seen, [{ days: [1, 2, 3], prep_days: 0 }], 'only the known keys reach the writer');
  assert.equal(r.message, 'Saved.');
  assert.throws(() => W.postSettings({}, { write: () => ({ ok: true }) }), e => e.status === 400);
  assert.throws(() => W.postSettings({ days: [] }), e => e.status === 400 && /at least one day/.test(e.message));
  // the real writer: settings.json changes, and so does the Today screen
  const w = W.postSettings({ prep_days: 0 });
  assert.equal(w.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(process.env.JOBPILOT_SETTINGS, 'utf8')).picks.prep.days_before, 0);
  assert.equal(W.todayPayload().prep, null, 'prep off: no banner');
});

test('addInterview refuses a long round and a broken applications.json', () => {
  assert.equal(addInterview({ file: F.glen, date: addDays(1), round: 'x'.repeat(121) }).code, 1);
  const keep = fs.readFileSync(APPS, 'utf8');
  fs.writeFileSync(APPS, '{ broken');
  assert.equal(addInterview({ file: F.glen, date: addDays(1) }).broken, true);
  fs.writeFileSync(APPS, keep);
});

test('the server routes: GET and POST /api/settings, POST /api/interview (with the X-Jobpilot header)', async () => {
  const { startServer } = await import('../lib/server.mjs');
  const srv = await startServer({ port: 0, log: () => {} });
  try {
    const base = `http://127.0.0.1:${srv.port}`, post = (p, body, h = { 'X-Jobpilot': '1' }) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
    const g = await fetch(`${base}/api/settings`); assert.equal(g.status, 200); assert.equal((await g.json()).timezone, 'UTC');
    assert.equal((await post('/api/settings', { days: [1, 2, 3, 4, 5] }, {})).status, 403, 'no header, no write');
    const s = await post('/api/settings', { days: [1, 2, 3, 4, 5] }); assert.equal(s.status, 200, await s.clone().text());
    assert.deepEqual((await s.json()).settings.days, [1, 2, 3, 4, 5]);
    assert.equal((await post('/api/settings', { time: 'soon' })).status, 400);
    const i = await post('/api/interview', { file: F.glen, date: addDays(3) }); assert.equal(i.status, 200);
    assert.equal(apps()[F.glen].events.at(-1).event_date, addDays(3));
  } finally { await srv.close(); }
});

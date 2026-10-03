// Status "accepted" (an offer the user took and now works in): cli.mjs status writes it, an email never undoes it,
// the decoder and the queue treat the role as closed like an offer, the Today pool leaves it out, the workspace can
// record it, and export then import carries it unchanged. Synthetic data only; Gmail and the model are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-accepted-'));
const DATA = path.join(tmp, 'data');
const DAY = new Date().toISOString().slice(0, 10);
const addDays = n => { const d = new Date(`${DAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = DATA;
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
process.env.JOBPILOT_RUN_DATE = DAY;
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC', sources: { outcomes: { enabled: true, max_emails: 50 } }, picks: { per_day: 2, window_days: 14, max_shown: 3 } }));
for (const d of ['decoded', 'rejected', 'inbox', 'state', 'packs']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
const APPS = path.join(DATA, 'state', 'applications.json');
const readApps = () => JSON.parse(fs.readFileSync(APPS, 'utf8'));
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { encoding: 'utf8', cwd: tmp, env: { ...process.env, ...env }, timeout: 60000 });

const job = (company, role) => {
  const file = `${DAY}--${company.toLowerCase()}--${role.toLowerCase().replace(/\W+/g, '-')}.md`;
  fs.writeFileSync(path.join(DATA, 'decoded', file), ['---', `company: "${company}"`, `role: "${role}"`, `url: "https://jobs.example/${file}"`, 'source: "ats_boards"', 'location: "Remote"',
    `found: ${DAY}`, '---', '', `# ${company} - ${role}`, '', 'Synthetic job text.', '', '## Decode Result', `Decoded ${DAY} by jobpilot (claude/sonnet).`,
    'verdict: strong-fit', 'confidence: high', 'apply_priority: 2', 'rationale: Fits the synthetic profile.', 'fit_signals: APIs', 'gaps: none', 'action: Apply today.', ''].join('\n'));
  return file;
};
const HELD = job('Copperline', 'Product Manager, Payments');
const OPEN = job('Driftmoor', 'Platform Product Manager');
const VIA_API = job('Emberly', 'Data Product Owner');

const o = await import('../sources/outcomes.mjs');
const { messageText } = await import('../lib/gmail.mjs');
const d = await import('../decoder/decoder.mjs');
const q = await import('../lib/queue.mjs');
const ws = await import('../lib/workspace.mjs');
const { STATUSES } = await import('../lib/applications.mjs');

// One Gmail message, as the real client returns it.
const b64 = s => Buffer.from(s, 'utf8').toString('base64url');
const msg = ({ id, from, subject, body, at }) => ({ id, threadId: `t-${id}`, internalDate: String(Date.parse(at)),
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date(at).toUTCString() }], body: { data: b64(body) } } });
const gmailOf = messages => ({ list: () => messages.map(m => ({ id: m.id })), get: id => messages.find(m => m.id === id) });

test('accepted sits after offer in the statuses', () => {
  assert.equal(STATUSES.indexOf('accepted'), STATUSES.indexOf('offer') + 1);
});

test('cli.mjs status <company> accepted writes the event and the status; a later offer email leaves it accepted', async () => {
  const r = cli(['status', 'Copperline', 'accepted', 'Payments', '--note', 'started on the first']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Copperline: Product Manager, Payments -> accepted$/m);
  let a = readApps()[HELD];
  assert.equal(a.status, 'accepted');
  assert.equal(a.updated, DAY);
  assert.deepEqual(a.events, [{ date: DAY, type: 'accepted', note: 'started on the first', source: 'cli' }]);
  assert.match(cli(['status', 'Copperline', 'hired']).stdout, /Use one of: applied, screen, interview, offer, accepted, rejected, skipped, closed/);

  // the next day an offer email for the same role (a reminder, a contract note): the event is kept, the status is not
  const at = `${addDays(1)}T10:00:00Z`;
  const offer = msg({ id: 'acc1', from: 'Copperline <people@copperline.example>', subject: 'Your offer', body: 'We are happy to offer you the position of Product Manager, Payments.', at });
  const run = await o.runOutcomes({ gmail: gmailOf([offer]), messageText, send: null, now: new Date(`${addDays(1)}T18:00:00Z`),
    classify: async () => ({ type: 'offer', company: 'Copperline', role: 'Product Manager, Payments', event_date: '', evidence: 'We are happy to offer you the position.' }) });
  assert.equal(run.matched.length, 1);
  assert.equal(run.matched[0].changed, false);
  a = readApps()[HELD];
  assert.equal(a.status, 'accepted', 'an email never moves an accepted application');
  assert.equal(a.updated, DAY);
  assert.deepEqual(a.events.map(e => e.type), ['accepted', 'offer']);
  assert.equal(a.events[1].gmail_id, 'acc1');
  // the decoder's view of the past agrees: the offer email did not undo the accepted status
  assert.equal(d.asOf(a, addDays(5)).status, 'accepted');
  // the same view when the record changed after the cutoff (the user closed it later): the history is replayed, and the
  // offer email still does not undo the accepted status
  const later = { ...a, status: 'closed', updated: addDays(10), events: [...a.events, { date: addDays(10), type: 'closed', source: 'user' }] };
  assert.equal(d.asOf(later, addDays(5)).status, 'accepted');
  assert.equal(d.asOf(later, addDays(11)).status, 'closed');
});

test('no email of any kind changes an accepted application, whatever its date', () => {
  for (const type of ['offer', 'interview', 'test_task', 'rejection', 'application_received']) {
    const apps = { k: { company: 'Copperline', role: 'PM', status: 'accepted', updated: '2026-09-01', events: [{ date: '2026-09-01', type: 'accepted', source: 'cli' }] } };
    const r = o.applyOutcome(apps, { key: 'k' }, { type, evidence: '' }, { id: `x-${type}`, date: '2026-09-20', ms: Date.parse('2026-09-20T10:00:00Z') }, { reopen: true });
    assert.equal(apps.k.status, 'accepted', type);
    assert.equal(apps.k.updated, '2026-09-01', type);
    assert.equal(r.changed, false, type);
    assert.equal(apps.k.events.at(-1).type, type, 'the event is still recorded');
  }
});

test('the decoder and the queue treat a role the user holds as closed, the same as an offer', () => {
  const fm = { company: 'Copperline', role: 'Senior Product Manager, Payments' };
  for (const status of ['offer', 'accepted']) {
    const A = { 'manual:copperline|product manager payments': { company: 'Copperline', role: 'Product Manager, Payments', status, updated: DAY } };
    assert.equal(d.closedRole({ file: 'new-posting.md', fm }, A), true, status);
    assert.equal(d.closedRole({ file: 'other.md', fm: { company: 'Copperline', role: 'Head of Design' } }, A), false, `${status}: another role at the employer stays open`);
  }
  // a new posting of the held role (another title, so the queue's exact-title rule does not catch it first) is a
  // duplicate of the application
  const w = q.writeJob({ company: 'Copperline', role: 'Senior Product Manager, Payments', url: 'https://other-board.example/copperline/77', source: 'test', text: 'x' });
  assert.equal(w.written, false);
  assert.match(w.reason, /^already in applications: Copperline: Product Manager, Payments \(accepted\)$/);
});

test('Today API: a role the user holds is not in the pool; the workspace can record accepted', () => {
  const t = ws.todayPayload();
  const files = [...t.picks, ...t.pool].map(i => i.file);
  assert.ok(!files.includes(HELD), 'accepted: left out');
  assert.ok(files.includes(OPEN) && files.includes(VIA_API), 'open roles stay');
  const r = ws.postStatus({ file: VIA_API, status: 'accepted' });
  assert.equal(r.ok, true);
  assert.equal(r.application.status, 'accepted');
  assert.equal(r.application.events.at(-1).source, 'workspace');
  assert.ok(![...ws.todayPayload().pool].some(i => i.file === VIA_API), 'gone from the pool once recorded');
  assert.equal(ws.labelsPayload('en').labels['ws.status.accepted'], 'Accepted, working');
  assert.equal(ws.labelsPayload('ru').labels['ws.status.accepted'], 'Работаю здесь');
});

test('export then import carries an accepted application unchanged', async () => {
  const before = readApps();
  assert.equal(before[HELD].status, 'accepted');
  const out = path.join(tmp, 'accepted.zip');
  const exp = cli(['export', '--out', out, '--data-only']);
  assert.equal(exp.status, 0, exp.stdout + exp.stderr);
  const other = path.join(tmp, 'other-home');
  fs.mkdirSync(other, { recursive: true });
  const imp = cli(['import', '--from', out], { JOBPILOT_HOME: other, JOBPILOT_DATA: path.join(other, 'data'), JOBPILOT_SETTINGS: '' });
  assert.equal(imp.status, 0, imp.stdout + imp.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(other, 'data', 'state', 'applications.json'), 'utf8')), before);
});

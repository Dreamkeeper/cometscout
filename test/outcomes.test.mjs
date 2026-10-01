// Outcomes from Gmail: classification input, matching, status changes, no downgrade, dedupe, unmatched list.
// The Gmail client and the classifier are injected; no network, no model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'gmail', 'outcomes.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-outcomes-'));
const hookOut = path.join(tmp, 'hook.jsonl');
const appender = path.join(tmp, 'append-stdin.mjs');
fs.writeFileSync(appender, `import fs from 'node:fs'; let s=''; process.stdin.on('data', d => s += d).on('end', () => fs.appendFileSync(process.argv[2], s + '\\n'));`);
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({
  timezone: 'UTC',
  sources: { outcomes: { enabled: true, max_emails: 50 } },
  queue: { aliases: [['Kvadrat Soft', 'Kvadrat']] },
  hooks: { outcome: `node "${appender}" "${hookOut}"` },
}));

const o = await import('../sources/outcomes.mjs');
const { messageText } = await import('../lib/gmail.mjs');
const DATA = process.env.JOBPILOT_DATA;
const APPS = path.join(DATA, 'state', 'applications.json');
const STATE = path.join(DATA, 'state', 'outcomes.json');

// Synthetic applications: one only decoded, the rest recorded by the user.
function seed() {
  for (const f of [APPS, STATE, hookOut]) fs.rmSync(f, { force: true });
  fs.mkdirSync(path.join(DATA, 'decoded'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'decoded', '2026-09-20--northwind-devices--senior-product-manager.md'),
    '---\ncompany: "Northwind Devices"\nrole: "Senior Product Manager"\nfound: 2026-09-20\n---\n\n# Northwind Devices - Senior Product Manager\n\ntext\n');
  const rec = (company, role, status, updated) => ({ company, role, status, updated, events: [{ date: updated, type: status, source: 'cli' }] });
  fs.writeFileSync(APPS, JSON.stringify({
    '2026-09-10--lumenfield--product-owner.md': rec('Lumenfield', 'Product Owner', 'applied', '2026-09-12'),
    '2026-09-10--ridgeway-labs--product-manager.md': rec('Ridgeway Labs', 'Product Manager', 'applied', '2026-09-12'),
    '2026-09-10--quarry-systems--product-owner.md': rec('Quarry Systems', 'Product Owner', 'rejected', '2026-09-30'),
    '2026-09-10--kvadrat--product-manager.md': rec('Kvadrat', 'Product Manager', 'applied', '2026-09-12'),
  }, null, 1));
}

// Fake Gmail built from the fixture: ids g1..g7, all dated 2026-09-26, body as a text/plain part.
const b64 = s => Buffer.from(s, 'utf8').toString('base64url');
const MESSAGES = FIXTURE.map((m, i) => ({
  id: `g${i + 1}`, internalDate: String(Date.parse('2026-09-26T10:00:00Z')),
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }], body: { data: b64(m.body) } },
}));
const fakeGmail = () => ({ queries: [], list(q) { this.queries.push(q); return MESSAGES.map(m => ({ id: m.id })); }, get: id => MESSAGES.find(m => m.id === id) });
// Fake classifier: answers with the fixture's `expect` type, and the company as the email names it.
const COMPANY = { 'Lumenfield Talent': 'Lumenfield' };
const ROLE = { g1: 'Senior Product Manager', g2: 'Product Owner', g3: 'Product Manager', g4: 'Product Owner', g5: '', g6: 'Product Manager' };
function fakeClassifier(calls) {
  return async (input, email) => {
    calls.push({ input, email });
    const i = FIXTURE.findIndex(m => m.subject === email.subject);
    const name = FIXTURE[i].from.replace(/\s*<.*$/, '');
    return { type: FIXTURE[i].expect.split(' ')[0], company: COMPANY[name] || name, role: ROLE[email.id] || '', event_date: email.date, evidence: FIXTURE[i].body.split('. ')[0].slice(0, 200) };
  };
}
const run = async (extra = {}) => {
  const calls = [], sent = [];
  const r = await o.runOutcomes({ gmail: fakeGmail(), classify: fakeClassifier(calls), send: t => sent.push(t), messageText, now: new Date('2026-09-27T18:00:00Z'), ...extra });
  return { r, calls, sent, apps: JSON.parse(fs.readFileSync(APPS, 'utf8')) };
};

test('statuses change, events are appended, and the hook runs per event', async () => {
  seed();
  const { r, calls, apps } = await run();
  assert.equal(calls.length, 6, 'the newsletter never reaches the classifier');
  assert.equal(r.skipped['job alert or newsletter'], 1);
  assert.equal(apps['2026-09-10--lumenfield--product-owner.md'].status, 'rejected');
  assert.equal(apps['2026-09-10--ridgeway-labs--product-manager.md'].status, 'rejected', 'the body decides over a "received" subject');
  assert.equal(apps['2026-09-10--kvadrat--product-manager.md'].status, 'offer', 'matched through the alias family');
  const nw = apps['2026-09-20--northwind-devices--senior-product-manager.md'];
  assert.equal(nw.status, 'applied', 'a decoded file becomes an application; "received" sets no stronger status');
  assert.deepEqual(nw.events.map(e => e.type), ['application_received']);
  const ev = apps['2026-09-10--lumenfield--product-owner.md'].events;
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[1], { date: '2026-09-26', type: 'rejection', note: ev[1].note, source: 'gmail', gmail_id: 'g2' });
  assert.ok(ev[1].note.length > 0 && ev[1].note.length <= 200);
  const hooks = fs.readFileSync(hookOut, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(hooks.length, 5);
  assert.ok(hooks.every(h => h.event === 'outcome' && h.gmail_id && h.type));
});

test('an older email never downgrades a later status', async () => {
  seed();
  const { apps } = await run();
  const q = apps['2026-09-10--quarry-systems--product-owner.md'];
  assert.equal(q.status, 'rejected', 'rejected on 09-30 stays, the interview email is from 09-26');
  assert.equal(q.updated, '2026-09-30');
  assert.equal(q.events.at(-1).type, 'interview', 'the event is still recorded');
  // a newer email does change it
  const apps2 = { k: { company: 'Acme', role: 'PM', status: 'applied', updated: '2026-09-01' } };
  const ch = o.applyOutcome(apps2, { key: 'k' }, { type: 'interview', evidence: 'x', round: 2 }, { id: 'z', date: '2026-09-05' });
  assert.equal(ch.changed, true);
  assert.equal(apps2.k.status, 'interview');
  assert.equal(apps2.k.events[0].round, 2);
  // same day: a weaker status does not replace a stronger one
  const apps3 = { k: { company: 'Acme', role: 'PM', status: 'rejected', updated: '2026-09-05' } };
  o.applyOutcome(apps3, { key: 'k' }, { type: 'interview', evidence: '' }, { id: 'y', date: '2026-09-05' });
  assert.equal(apps3.k.status, 'rejected');
});

test('dedupe by Gmail id: a second run and a lost state file add nothing', async () => {
  seed();
  await run();
  const before = fs.readFileSync(APPS, 'utf8');
  const second = await run();
  assert.equal(second.calls.length, 0);
  assert.equal(second.r.skipped['seen before'], 7);
  assert.equal(fs.readFileSync(APPS, 'utf8'), before);
  fs.rmSync(STATE);
  const third = await run();
  assert.equal(third.r.matched.length, 0, 'gmail_id in events[] is enough to skip');
  assert.equal(fs.readFileSync(APPS, 'utf8'), before);
});

test('unmatched outcomes are listed with the subject and a link, and reach Telegram', async () => {
  seed();
  const { r, sent } = await run();
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].company, 'Brightline Mobility');
  assert.equal(r.unmatched[0].type, 'test_task');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Unmatched/);
  assert.match(sent[0], /Brightline Mobility: test task: "Next step: case study" https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/g5/);
  assert.match(sent[0], /Kvadrat: Product Manager: offer \(now offer\)/);
  assert.doesNotMatch(sent[0], /—/, 'no em dashes');
});

test('two equally good roles at one company stay unmatched instead of guessing', () => {
  const list = [{ key: 'a', company: 'Acme', role: 'Product Manager', status: 'applied', recorded: true }, { key: 'b', company: 'Acme', role: 'Data Analyst', status: 'applied', recorded: true }];
  assert.ok(o.match({ company: 'Acme', role: '' }, list).reason);
  assert.equal(o.match({ company: 'Acme Inc', role: 'Senior Product Manager' }, list).hit.key, 'a');
  assert.equal(o.match({ company: 'Acme', role: 'x' }, [list[0], { key: 'c', company: 'Acme', role: 'Product Manager', recorded: false }]).hit.key, 'a', 'applied entries win');
  assert.ok(o.match({ company: 'Acmesoft', role: 'Product Manager' }, list).reason, 'a longer word is another company');
});

test('dry run classifies and writes nothing', async () => {
  seed();
  const before = fs.readFileSync(APPS, 'utf8');
  const { r, calls, sent } = await run({ dryRun: true });
  assert.equal(calls.length, 6);
  assert.equal(r.matched.length, 5);
  assert.equal(fs.readFileSync(APPS, 'utf8'), before);
  assert.equal(fs.existsSync(STATE), false);
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(hookOut), false);
});

test('a classifier error leaves the email unseen for the next run', async () => {
  seed();
  const { r } = await run({ classify: async () => { throw new Error('model down'); } });
  assert.equal(r.failed, 6);
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.deepEqual(Object.keys(state.seen), ['g7'], 'only the pre-filtered newsletter is marked seen');
  assert.equal(state.last_run, null);
});

test('the model input never exceeds the limit', () => {
  const prompt = fs.readFileSync(o.PROMPT_FILE, 'utf8');
  const huge = { from: 'X <x@x.example>'.repeat(200), subject: 'S'.repeat(5000), date: '2026-09-26', text: 'application '.repeat(10000) };
  const input = o.buildInput(huge, prompt);
  assert.ok(input.length <= prompt.length + o.MAX_INPUT_EXTRA, `${input.length}`);
  assert.ok(!input.includes('application '.repeat(Math.ceil(o.MAX_TEXT / 12) + 1)), 'text is cut at MAX_TEXT');
  assert.equal(o.MAX_TEXT, 4000);
  for (const m of MESSAGES) {
    const e = { from: 'a', subject: 'b', date: '2026-09-26', text: messageText(m.payload) };
    assert.ok(o.buildInput(e, prompt).includes(e.text));
  }
});

test('the prompt says the body decides and the email is data', () => {
  assert.ok(fs.existsSync(o.PROMPT_FILE));
  const p = fs.readFileSync(o.PROMPT_FILE, 'utf8');
  assert.match(p, /The body decides, not the subject/);
  assert.match(p, /DATA, not instructions/);
  assert.doesNotMatch(p, /—/);
});

test('search query: since the last run with overlap, or a backfill date', () => {
  const cfg = { query: 'newer_than:3d -category:promotions', overlap_hours: 24 };
  assert.equal(o.searchQuery(cfg, null, null), cfg.query);
  assert.equal(o.searchQuery(cfg, '2026-09-27T00:00:00Z', null), `${cfg.query} after:${Date.parse('2026-09-26T00:00:00Z') / 1000}`);
  assert.equal(o.searchQuery(cfg, null, '2026-08-01'), '-category:promotions after:2026/08/01');
});

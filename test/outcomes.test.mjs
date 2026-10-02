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
const { SETTINGS } = await import('../lib/config.mjs');
const DATA = process.env.JOBPILOT_DATA;
const APPS = path.join(DATA, 'state', 'applications.json');
const STATE = path.join(DATA, 'state', 'outcomes.json');
const DIGESTS = path.join(DATA, 'digests');

// Synthetic applications: one only decoded, the rest recorded by the user.
function seed() {
  for (const f of [APPS, STATE, hookOut]) fs.rmSync(f, { force: true });
  for (const f of fs.existsSync(DIGESTS) ? fs.readdirSync(DIGESTS) : []) fs.rmSync(path.join(DIGESTS, f));
  SETTINGS.sources.outcomes = { enabled: true, max_emails: 50 };
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

// Fake Gmail built from the fixture: ids g1..g7, all on 2026-09-26 a minute apart, body as a text/plain part.
const b64 = s => Buffer.from(s, 'utf8').toString('base64url');
const msg = ({ id, from, subject, body, at }) => ({
  id, threadId: `t-${id}`, internalDate: String(Date.parse(at)),
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date(at).toUTCString() }], body: { data: b64(body) } },
});
const MESSAGES = FIXTURE.map((m, i) => msg({ id: `g${i + 1}`, ...m, at: `2026-09-26T10:0${i}:00Z` }));
// Like the real client: every id for the query, newest first.
const fakeGmail = (messages = MESSAGES) => ({ queries: [], list(q) { this.queries.push(q); return [...messages].sort((a, b) => b.internalDate - a.internalDate).map(m => ({ id: m.id })); }, get: id => messages.find(m => m.id === id) });
// Fake classifier: answers with the fixture's `expect` type, and the company as the email names it.
const COMPANY = { 'Lumenfield Talent': 'Lumenfield' };
const ROLE = { g1: 'Senior Product Manager', g2: 'Product Owner', g3: 'Product Manager', g4: 'Product Owner', g5: '', g6: 'Product Manager' };
function fakeClassifier(calls) {
  return async (input, email) => {
    calls.push({ input, email });
    const i = FIXTURE.findIndex(m => m.subject === email.subject);
    const name = FIXTURE[i].from.replace(/\s*<.*$/, '');
    return { type: FIXTURE[i].expect.split(' ')[0], company: COMPANY[name] || name, role: ROLE[email.id] || '', event_date: '', evidence: FIXTURE[i].body.split('. ')[0].slice(0, 200) };
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
  // D2: the hook also carries the thread, the raw Date header, sender, subject and the evidence
  const lf = hooks.find(h => h.gmail_id === 'g2');
  assert.equal(lf.thread_id, 't-g2');
  assert.equal(lf.email_date, new Date('2026-09-26T10:01:00Z').toUTCString());
  assert.equal(lf.from, FIXTURE[1].from);
  assert.equal(lf.subject, FIXTURE[1].subject);
  assert.equal(lf.evidence, lf.note);
  assert.ok(lf.evidence.length > 0);
  assert.equal(lf.status, 'rejected');
  assert.equal(lf.previous_status, 'applied');
  assert.equal(lf.reopened, false);
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
  // same day, recorded by hand (no time): a weaker status does not replace a stronger one
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
  assert.equal(o.match({ company: 'Acme', role: 'Product Manager' }, [list[0], { key: 'c', company: 'Acme', role: 'Product Manager', recorded: false }]).hit.key, 'a', 'at equal role overlap applied entries win');
  assert.equal(o.match({ company: 'Acme', role: '' }, [list[0], { key: 'c', company: 'Acme', role: 'Product Manager', recorded: false }]).hit.key, 'a', 'no role named: applied entries win');
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
  assert.equal(o.searchQuery(cfg, '2026-09-27T00:00:00Z', null), `-category:promotions after:${Date.parse('2026-09-26T00:00:00Z') / 1000}`, 'newer_than: goes when after: comes');
  assert.equal(o.searchQuery(cfg, null, '2026-08-01'), '-category:promotions after:2026/08/01');
});

// ---------- review fixes: each scenario uses synthetic emails, the fake Gmail client and a fake classifier ----------
const NOW = new Date('2026-09-27T18:00:00Z');
const rec = (company, role, status, updated) => ({ company, role, status, updated, events: [{ date: updated, type: status, source: 'cli' }] });
// answers: Gmail id -> what the classifier says (company, role, type, ...).
async function scenario({ apps, messages, answers, settings = {}, ...extra }) {
  seed();
  if (apps) fs.writeFileSync(APPS, JSON.stringify(apps, null, 1));
  Object.assign(SETTINGS.sources.outcomes, settings);
  const calls = [], sent = [], gmail = fakeGmail(messages);
  const classify = async (input, email) => { calls.push(email.id); return { company: '', role: '', event_date: '', evidence: 'quoted sentence', ...answers[email.id] }; };
  const r = await o.runOutcomes({ gmail, classify, send: t => sent.push(t), messageText, now: NOW, ...extra });
  return { r, calls, sent, gmail, apps: JSON.parse(fs.readFileSync(APPS, 'utf8')) };
}
const OSTRAVA = {
  'os-analyst.md': rec('Ostrava Tools', 'Data Analyst', 'rejected', '2026-09-15'),
  'os-backend.md': rec('Ostrava Tools', 'Backend Developer', 'applied', '2026-09-15'),
};
const ostravaInterview = (id, role) => msg({ id, from: 'Ostrava Tools <hr@ostrava.example>', subject: `Interview for ${role}`, body: `We would like to invite you to an interview for the ${role} role.`, at: '2026-09-26T10:00:00Z' });

test('an email for another role never re-labels an application at the same company', async () => {
  const { r, apps, calls } = await scenario({ apps: OSTRAVA, messages: [ostravaInterview('w1', 'Product Manager')], answers: { w1: { type: 'interview', company: 'Ostrava Tools', role: 'Product Manager' } } });
  assert.deepEqual(calls, ['w1']);
  assert.equal(r.matched.length, 0);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].reason, 'no application for this role at this company');
  assert.deepEqual(apps['os-analyst.md'], OSTRAVA['os-analyst.md'], 'the rejected Data Analyst application is untouched');
  assert.deepEqual(apps['os-backend.md'], OSTRAVA['os-backend.md']);
  // role overlap outranks "recorded": a decoded Product Manager file beats a rejected Data Analyst application
  const list = [{ key: 'r', company: 'Acme', role: 'Data Analyst', status: 'rejected', recorded: true }, { key: 'd', company: 'Acme', role: 'Product Manager', recorded: false }];
  assert.equal(o.match({ company: 'Acme', role: 'Product Manager' }, list).hit.key, 'd');
  // at equal overlap an open application beats a rejected or closed one
  const twice = [{ key: 'old', company: 'Acme', role: 'Product Manager', status: 'rejected', updated: '2026-09-20', recorded: true }, { key: 'new', company: 'Acme', role: 'Product Manager', status: 'applied', updated: '2026-08-01', recorded: true }];
  assert.equal(o.match({ company: 'Acme', role: 'Product Manager' }, twice).hit.key, 'new');
});

test('a prefix company match needs a shared role word', () => {
  const list = [{ key: 'r', company: 'Ridgeway Labs', role: 'Product Manager', status: 'applied', recorded: true }];
  assert.ok(o.match({ company: 'Ridgeway', role: 'Data Analyst' }, list).reason);
  assert.ok(o.match({ company: 'Ridgeway', role: '' }, list).reason);
  assert.equal(o.match({ company: 'Ridgeway', role: 'Product Manager' }, list).hit.key, 'r');
  assert.equal(o.match({ company: 'Ridgeway Labs', role: 'Data Analyst' }, list).hit.key, 'r', 'exact company with one application');
});

test('a later email reopens a rejection only for the same role or a single application', async () => {
  // same role: reopened, with a "reopened" event, in the report and in the hook
  const same = await scenario({ apps: OSTRAVA, messages: [ostravaInterview('w2', 'Data Analyst')], answers: { w2: { type: 'interview', company: 'Ostrava Tools', role: 'Data Analyst' } } });
  const a = same.apps['os-analyst.md'];
  assert.equal(a.status, 'interview');
  assert.deepEqual(a.events.slice(1).map(e => e.type), ['interview', 'reopened']);
  assert.equal(a.events[2].gmail_id, 'w2');
  assert.equal(same.r.matched[0].reopened, true);
  assert.match(same.sent[0], /Ostrava Tools: Data Analyst: interview \(now interview; reopened, was rejected\)/);
  const hook = JSON.parse(fs.readFileSync(hookOut, 'utf8').trim());
  assert.equal(hook.reopened, true);
  assert.equal(hook.previous_status, 'rejected');
  // one application at the company: reopened even though the email names another role
  const one = await scenario({
    apps: { 'pc-qa.md': rec('Pinecrest Health', 'QA Engineer', 'rejected', '2026-09-15') },
    messages: [msg({ id: 'w3', from: 'Pinecrest Health <hr@pinecrest.example>', subject: 'Offer', body: 'We are happy to offer you the position of Release Manager.', at: '2026-09-26T10:00:00Z' })],
    answers: { w3: { type: 'offer', company: 'Pinecrest Health', role: 'Release Manager' } },
  });
  assert.equal(one.apps['pc-qa.md'].status, 'offer');
  assert.equal(one.apps['pc-qa.md'].events.at(-1).type, 'reopened');
  // two applications and no role named: the email cannot reopen the rejected one
  const blocked = o.applyOutcome({ k: rec('Acme', 'PM', 'rejected', '2026-09-01') }, { key: 'k' }, { type: 'interview', evidence: '' }, { id: 'z', date: '2026-09-05' });
  assert.ok(blocked.blocked);
  const two = await scenario({
    apps: { 'os-analyst.md': OSTRAVA['os-analyst.md'], 'os-ops.md': rec('Ostrava Tools', 'Operations Lead', 'closed', '2026-09-15') },
    messages: [ostravaInterview('w4', 'role')], answers: { w4: { type: 'interview', company: 'Ostrava Tools', role: '' } },
  });
  assert.equal(two.r.matched.length, 0);
  assert.equal(two.r.unmatched.length, 1);
  assert.equal(two.apps['os-analyst.md'].status, 'rejected');
});

test('max_emails caps the model calls; the rest come in the next runs, oldest first', async () => {
  const messages = [0, 1, 2, 3, 4].map(i => msg({ id: `c${i}`, from: `Firm ${i} <hr@firm${i}.example>`, subject: 'Your application', body: 'Thanks for your application.', at: `2026-09-26T10:0${i}:00Z` }));
  const answers = Object.fromEntries(messages.map((m, i) => [m.id, { type: 'application_received', company: `Firm ${i}` }]));
  const first = await scenario({ messages, answers, settings: { max_emails: 2 } });
  assert.deepEqual(first.calls, ['c0', 'c1'], 'oldest first');
  assert.equal(first.r.capped, true);
  let state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(state.last_run, '2026-09-26T10:00:00.000Z', 'last_run is the oldest processed email, not now');
  // the next runs (state kept) pick up the rest
  const runAgain = async () => { const calls = [], gmail = fakeGmail(messages); await o.runOutcomes({ gmail, classify: async (i, e) => { calls.push(e.id); return { ...answers[e.id], role: '', event_date: '', evidence: '' }; }, messageText, now: NOW }); return { calls, gmail }; };
  const second = await runAgain();
  assert.deepEqual(second.calls, ['c2', 'c3']);
  assert.match(second.gmail.queries[0], new RegExp(`after:${Date.parse('2026-09-25T10:00:00Z') / 1000}$`));
  const third = await runAgain();
  assert.deepEqual(third.calls, ['c4']);
  state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(state.last_run, NOW.toISOString(), 'not capped: last_run is now');
  assert.deepEqual(Object.keys(state.seen).sort(), ['c0', 'c1', 'c2', 'c3', 'c4']);
});

test('a gap longer than newer_than keeps every email in the search', () => {
  const cfg = { query: 'newer_than:3d -category:promotions -category:social', overlap_hours: 24 };
  const q = o.searchQuery(cfg, '2026-09-10T18:00:00Z', null);
  assert.doesNotMatch(q, /newer_than/);
  assert.equal(q, `-category:promotions -category:social after:${Date.parse('2026-09-09T18:00:00Z') / 1000}`);
});

test('job board senders are not skipped; their subscription mail is, by subject', async () => {
  const messages = [
    msg({ id: 'h1', from: 'hh.ru <noreply@hh.ru>', subject: 'Приглашение на собеседование', body: 'Здравствуйте! Работодатель пригласил вас на собеседование по вакансии Продакт-менеджер.', at: '2026-09-26T10:00:00Z' }),
    msg({ id: 'h2', from: 'hh.ru <noreply@hh.ru>', subject: 'Новые вакансии для вас', body: 'Подборка вакансий по вашему резюме.', at: '2026-09-26T10:01:00Z' }),
    msg({ id: 'h3', from: 'HeadHunter <noreply@headhunter.ru>', subject: 'Отказ по вакансии Аналитик', body: 'К сожалению, работодатель отказал по вашему отклику.', at: '2026-09-26T10:02:00Z' }),
    msg({ id: 'h4', from: 'Acme Careers <alerts@acme.example>', subject: 'Update on your application', body: 'We decided not to move forward with your application.', at: '2026-09-26T10:03:00Z' }),
    msg({ id: 'h5', from: 'Job Board <alerts@board.example>', subject: '25 new product manager jobs', body: 'Apply now to these roles.', at: '2026-09-26T10:04:00Z' }),
  ];
  const { calls, r } = await scenario({ messages, answers: { h1: { type: 'interview' }, h3: { type: 'rejection' }, h4: { type: 'rejection' } } });
  assert.deepEqual(calls, ['h1', 'h3', 'h4'], 'the hh.ru invitation reaches the classifier');
  assert.equal(r.skipped['job alert or newsletter'], 2);
  assert.equal(o.prefilter({ from: 'noreply@hh.ru', subject: 'Приглашение на собеседование', text: 'Вас пригласили на собеседование.' }), null);
});

test('the run report is written to data/digests whether Telegram is off or fails', async () => {
  seed();
  const off = await o.runOutcomes({ gmail: fakeGmail(), classify: fakeClassifier([]), send: null, messageText, now: NOW });
  const file = path.join(DIGESTS, 'outcomes-2026-09-27.md');
  assert.equal(off.reportFile, file);
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /Unmatched/);
  assert.match(body, /Brightline Mobility: test task: "Next step: case study" https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/g5/);
  assert.match(body, /Lumenfield: Product Owner: rejection \(now rejected\)\. "[^"]+" https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/g2/, 'matched lines link to the email too');
  assert.doesNotMatch(body, /—/);
  // Telegram fails: the unmatched email is still in the file (and stays seen, so the file is the record)
  seed();
  const failing = await o.runOutcomes({ gmail: fakeGmail(), classify: fakeClassifier([]), send: async () => { throw new Error('telegram down'); }, messageText, now: NOW });
  assert.equal(failing.unmatched.length, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /#all\/g5/);
  // a second run the same day appends
  seed();
  await o.runOutcomes({ gmail: fakeGmail(), classify: fakeClassifier([]), send: null, messageText, now: NOW });
  await o.runOutcomes({ gmail: fakeGmail([msg({ id: 'g9', from: 'Brightline Mobility <hr@brightline.example>', subject: 'Interview', body: 'Your interview is booked.', at: '2026-09-27T09:00:00Z' })]), classify: async () => ({ type: 'interview', company: 'Brightline Mobility', role: '', event_date: '', evidence: 'x' }), send: null, messageText, now: NOW });
  assert.equal(fs.readFileSync(file, 'utf8').split('Outcomes from email:').length - 1, 2);
});

test('edits to applications.json made while the model runs are kept', async () => {
  seed();
  let first = true;
  const inner = fakeClassifier([]);
  const classify = async (input, email) => {
    if (first) {   // what `cli.mjs status` / `applied` would do in another shell
      first = false;
      const cur = JSON.parse(fs.readFileSync(APPS, 'utf8'));
      cur['manual:zephyr analytics|designer'] = rec('Zephyr Analytics', 'Designer', 'applied', '2026-09-27');
      cur['2026-09-10--ridgeway-labs--product-manager.md'].note = 'referred by a friend';
      fs.writeFileSync(APPS, JSON.stringify(cur, null, 1));
    }
    return inner(input, email);
  };
  const r = await o.runOutcomes({ gmail: fakeGmail(), classify, send: null, messageText, now: NOW });
  const apps = JSON.parse(fs.readFileSync(APPS, 'utf8'));
  assert.equal(r.matched.length, 5);
  assert.equal(apps['manual:zephyr analytics|designer'].status, 'applied', 'the hand edit survives');
  assert.equal(apps['2026-09-10--ridgeway-labs--product-manager.md'].note, 'referred by a friend');
  assert.equal(apps['2026-09-10--ridgeway-labs--product-manager.md'].status, 'rejected', 'and the outcome is applied on top');
  assert.equal(apps['2026-09-10--lumenfield--product-owner.md'].status, 'rejected');
});

test('the date the email sets for the event is kept apart from the email date', async () => {
  const { apps } = await scenario({
    apps: { 'lf.md': rec('Lumenfield', 'Product Owner', 'applied', '2026-09-12') },
    messages: [msg({ id: 'e1', from: 'Lumenfield <hr@lumenfield.example>', subject: 'Interview on 2 October', body: 'Your interview is scheduled for 2 October at 14:00.', at: '2026-09-26T10:00:00Z' })],
    answers: { e1: { type: 'interview', company: 'Lumenfield', role: 'Product Owner', event_date: '2026-10-02' } },
  });
  const ev = apps['lf.md'].events.at(-1);
  assert.equal(ev.date, '2026-09-26');
  assert.equal(ev.event_date, '2026-10-02');
  assert.equal(apps['lf.md'].updated, '2026-09-26');
  // no date or a malformed one: no event_date field
  const apps2 = { k: rec('Acme', 'PM', 'applied', '2026-09-01') };
  o.applyOutcome(apps2, { key: 'k' }, { type: 'interview', evidence: '', event_date: '' }, { id: 'n', date: '2026-09-05' });
  assert.equal('event_date' in apps2.k.events.at(-1), false);
});

test('two emails on one day: the later one decides, whatever the order they are processed in', () => {
  const offer = { id: 'of', date: '2026-09-05', ms: Date.parse('2026-09-05T15:00:00Z') };
  const rejection = { id: 'rj', date: '2026-09-05', ms: Date.parse('2026-09-05T09:00:00Z') };
  const base = () => ({ k: rec('Acme', 'Product Manager', 'interview', '2026-09-01') });
  const a = base();   // offer first, then the earlier rejection: offer stays
  o.applyOutcome(a, { key: 'k' }, { type: 'offer', evidence: '' }, offer, { reopen: true });
  o.applyOutcome(a, { key: 'k' }, { type: 'rejection', evidence: '' }, rejection, { reopen: true });
  assert.equal(a.k.status, 'offer');
  assert.equal(a.k.updated_at, '2026-09-05T15:00:00.000Z');
  const b = base();   // rejection first, then the later offer: offer
  o.applyOutcome(b, { key: 'k' }, { type: 'rejection', evidence: '' }, rejection, { reopen: true });
  o.applyOutcome(b, { key: 'k' }, { type: 'offer', evidence: '' }, offer, { reopen: true });
  assert.equal(b.k.status, 'offer');
  assert.equal(a.k.events.length, 3);
  assert.equal(b.k.events.length, 4, 'interview, rejection, offer, reopened');
  // and the reverse: a later rejection beats an earlier offer on the same day
  const c = base();
  o.applyOutcome(c, { key: 'k' }, { type: 'offer', evidence: '' }, { ...offer, ms: Date.parse('2026-09-05T08:00:00Z') });
  o.applyOutcome(c, { key: 'k' }, { type: 'rejection', evidence: '' }, rejection);
  assert.equal(c.k.status, 'rejected');
});

test('links use sources.outcomes.account_index', async () => {
  const { r, sent } = await scenario({
    messages: [msg({ id: 'a1', from: 'Nobody Known <hr@nobody.example>', subject: 'Your application', body: 'We received your application.', at: '2026-09-26T10:00:00Z' })],
    answers: { a1: { type: 'application_received', company: 'Nobody Known' } }, settings: { account_index: 2 },
  });
  assert.equal(r.unmatched[0].link, 'https://mail.google.com/mail/u/2/#all/a1');
  assert.match(sent[0], /mail\/u\/2\/#all\/a1/);
});

test('README documents the report file, --no-telegram and the outcome hook payload', () => {
  const readme = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8');
  assert.match(readme, /--no-telegram/);
  assert.match(readme, /data\/digests\/outcomes-YYYY-MM-DD\.md/);
  assert.match(readme, /account_index/);
  const hooks = readme.slice(readme.indexOf('### Hooks'));
  for (const f of ['thread_id', 'email_date', 'from', 'subject', 'evidence', 'note', 'gmail_id', 'reopened', 'event_date']) assert.match(hooks, new RegExp(`\`${f}\``), f);
});

// ---------- second review round ----------
test('generic role words never make a match or reopen a rejection', async () => {
  // "senior" alone does not tie Senior Product Manager to a rejected Senior Data Analyst
  const apps = { 'os-sda.md': rec('Ostrava Tools', 'Senior Data Analyst', 'rejected', '2026-09-15'), 'os-backend.md': rec('Ostrava Tools', 'Backend Developer', 'applied', '2026-09-15') };
  const { r, apps: after } = await scenario({ apps, messages: [ostravaInterview('s1', 'Senior Product Manager')], answers: { s1: { type: 'interview', company: 'Ostrava Tools', role: 'Senior Product Manager' } } });
  assert.equal(r.matched.length, 0);
  assert.equal(r.unmatched.length, 1);
  assert.deepEqual(after, apps, 'nothing is reopened or re-labelled');
  // "manager" alone does not tie Product Manager to Engineering Manager
  const list = [{ key: 'em', company: 'Acme', role: 'Engineering Manager', status: 'applied', recorded: true }, { key: 'da', company: 'Acme', role: 'Data Analyst', status: 'applied', recorded: true }];
  assert.ok(o.match({ type: 'interview', company: 'Acme', role: 'Product Manager' }, list).reason);
  assert.equal(o.match({ type: 'interview', company: 'Acme', role: 'Senior Engineering Manager' }, list).hit.key, 'em', 'a real role word still matches');
  // Russian seniority and filler words do not count either
  const ru = [{ key: 'a', company: 'Квадрат', role: 'Старший инженер по данным', status: 'rejected', recorded: true }, { key: 'b', company: 'Квадрат', role: 'Аналитик', status: 'applied', recorded: true }];
  assert.ok(o.match({ type: 'interview', company: 'Квадрат', role: 'Старший менеджер по продукту' }, ru).reason);
  assert.equal(o.overlap('Ведущий разработчик', 'Главный разработчик'), 0);
  assert.equal(o.overlap('Senior Product Manager', 'Product Manager'), 1);
  // the single-application exception still works for an interview naming another role
  assert.equal(o.match({ type: 'interview', company: 'Acme', role: 'Product Manager' }, [list[0]]).hit.key, 'em');
});

test('a rejection naming another role does not close the only application at the company', async () => {
  const apps = { 'pc-qa.md': rec('Pinecrest Health', 'QA Engineer', 'applied', '2026-09-15') };
  const rejection = (id, role) => msg({ id, from: 'Pinecrest Health <hr@pinecrest.example>', subject: 'Your application', body: `We will not move forward with your application for ${role || 'the role'}.`, at: '2026-09-26T10:00:00Z' });
  const other = await scenario({ apps, messages: [rejection('r1', 'Release Manager')], answers: { r1: { type: 'rejection', company: 'Pinecrest Health', role: 'Release Manager' } } });
  assert.equal(other.r.matched.length, 0);
  assert.equal(other.r.unmatched.length, 1);
  assert.equal(other.r.unmatched[0].type, 'rejection');
  assert.deepEqual(other.apps, apps, 'the QA Engineer application stays open');
  assert.match(other.sent[0], /Unmatched/);
  // same role, or no role named: it closes
  const same = await scenario({ apps, messages: [rejection('r2', 'Senior QA Engineer')], answers: { r2: { type: 'rejection', company: 'Pinecrest Health', role: 'Senior QA Engineer' } } });
  assert.equal(same.apps['pc-qa.md'].status, 'rejected');
  const none = await scenario({ apps, messages: [rejection('r3', '')], answers: { r3: { type: 'rejection', company: 'Pinecrest Health', role: '' } } });
  assert.equal(none.apps['pc-qa.md'].status, 'rejected');
  // other types keep the single-application exception
  for (const type of ['interview', 'test_task', 'offer', 'application_received']) {
    const r = await scenario({ apps, messages: [rejection('r4', 'Release Manager')], answers: { r4: { type, company: 'Pinecrest Health', role: 'Release Manager' } } });
    assert.equal(r.r.matched.length, 1, type);
    assert.equal(r.apps['pc-qa.md'].events.at(-1).type, type);
  }
});

test('a closed application is protected like a rejected one', async () => {
  // no role named and reopen not allowed: blocked, nothing changes
  const blocked = o.applyOutcome({ k: rec('Acme', 'Product Manager', 'closed', '2026-09-01') }, { key: 'k' }, { type: 'interview', evidence: '' }, { id: 'z', date: '2026-09-05' });
  assert.ok(blocked.blocked);
  assert.match(blocked.blocked, /closed/);
  // another role at a company with two applications: unmatched, the closed one stays closed
  const two = { 'os-ops.md': rec('Ostrava Tools', 'Operations Lead', 'closed', '2026-09-15'), 'os-backend.md': rec('Ostrava Tools', 'Backend Developer', 'applied', '2026-09-15') };
  const other = await scenario({ apps: two, messages: [ostravaInterview('c1', 'Senior Data Manager')], answers: { c1: { type: 'interview', company: 'Ostrava Tools', role: 'Senior Data Manager' } } });
  assert.equal(other.r.matched.length, 0);
  assert.deepEqual(other.apps, two);
  // the same role: reopened with a "closed -> interview" event
  const same = await scenario({ apps: two, messages: [ostravaInterview('c2', 'Operations Lead')], answers: { c2: { type: 'interview', company: 'Ostrava Tools', role: 'Operations Lead' } } });
  const ops = same.apps['os-ops.md'];
  assert.equal(ops.status, 'interview');
  assert.deepEqual(ops.events.slice(1).map(e => e.type), ['interview', 'reopened']);
  assert.equal(ops.events[2].note, 'closed -> interview');
  assert.equal(same.r.matched[0].reopened, true);
  assert.match(same.sent[0], /reopened, was closed/);
  // the single application at a company: an offer for another role reopens it too
  const one = await scenario({
    apps: { 'pc-qa.md': rec('Pinecrest Health', 'QA Engineer', 'closed', '2026-09-15') },
    messages: [msg({ id: 'c3', from: 'Pinecrest Health <hr@pinecrest.example>', subject: 'Offer', body: 'We are happy to offer you the position of Release Manager.', at: '2026-09-26T10:00:00Z' })],
    answers: { c3: { type: 'offer', company: 'Pinecrest Health', role: 'Release Manager' } },
  });
  assert.equal(one.apps['pc-qa.md'].status, 'offer');
  assert.deepEqual(one.apps['pc-qa.md'].events.at(-1), { date: '2026-09-26', type: 'reopened', note: 'closed -> offer', source: 'gmail', gmail_id: 'c3' });
});

test('a failed report write marks no email seen', async () => {
  seed();
  // a directory where the report file should be: the write fails
  fs.mkdirSync(path.join(DIGESTS, 'outcomes-2026-09-27.md'), { recursive: true });
  await assert.rejects(o.runOutcomes({ gmail: fakeGmail(), classify: fakeClassifier([]), send: null, messageText, now: NOW }));
  assert.equal(fs.existsSync(STATE), false, 'the state file is not written, so the unmatched email comes back next run');
  fs.rmSync(path.join(DIGESTS, 'outcomes-2026-09-27.md'), { recursive: true });
  const again = await o.runOutcomes({ gmail: fakeGmail(), classify: fakeClassifier([]), send: null, messageText, now: NOW });
  assert.deepEqual(again.unmatched.map(u => u.id), ['g5'], 'the unmatched email is reported on the retry');
  assert.match(fs.readFileSync(path.join(DIGESTS, 'outcomes-2026-09-27.md'), 'utf8'), /#all\/g5/);
});

test('email_date falls back to the internal date when the Date header is missing', async () => {
  const m = msg({ id: 'd1', from: 'Lumenfield <hr@lumenfield.example>', subject: 'Interview', body: 'We would like to invite you to an interview.', at: '2026-09-26T10:00:00Z' });
  m.payload.headers = m.payload.headers.filter(h => h.name !== 'Date');
  const email = await o.toEmail(m, messageText);
  assert.equal(email.date_header, new Date('2026-09-26T10:00:00Z').toUTCString());
  await scenario({ apps: { 'lf.md': rec('Lumenfield', 'Product Owner', 'applied', '2026-09-12') }, messages: [m], answers: { d1: { type: 'interview', company: 'Lumenfield', role: 'Product Owner' } } });
  const hook = JSON.parse(fs.readFileSync(hookOut, 'utf8').trim());
  assert.equal(hook.email_date, 'Sat, 26 Sep 2026 10:00:00 GMT');
});

test('job board notifications are skipped without a model call; invitations and rejections are not', async () => {
  const notices = [
    ['hh.ru <noreply@hh.ru>', 'Работодатель просмотрел ваше резюме', 'Ваше резюме просмотрела компания.'],
    ['hh.ru <noreply@hh.ru>', 'Компания просмотрела ваш отклик', 'Ваш отклик на вакансию просмотрен.'],
    ['hh.ru <noreply@hh.ru>', 'Ваше резюме просмотрели 3 компании', 'Посмотрите, кто интересовался вашим резюме.'],
    ['hh.ru <noreply@hh.ru>', 'Похожие вакансии', 'Вакансии, похожие на ваш отклик.'],
    ['hh.ru <noreply@hh.ru>', 'Статистика по вашему резюме за неделю', 'Ваше резюме показали 40 раз.'],
    ['hh.ru <noreply@hh.ru>', 'Статистика по резюме', 'Ваше резюме показали 12 раз.'],
    ['Job Board <noreply@board.example>', 'Your application was viewed', 'Acme viewed your application for Product Manager.'],
    ['Job Board <noreply@board.example>', 'You appeared in 12 searches this week', 'Recruiters searching for candidates found your profile.'],
    ['Job Board <noreply@board.example>', 'Jobs you may be interested in', 'Apply to these roles: Product Manager at Acme.'],
  ];
  const messages = notices.map(([from, subject, body], i) => msg({ id: `n${i}`, from, subject, body, at: `2026-09-26T10:0${i}:00Z` }));
  messages.push(msg({ id: 'n9', from: 'hh.ru <noreply@hh.ru>', subject: 'Приглашение на собеседование', body: 'Работодатель пригласил вас на собеседование по вакансии Аналитик.', at: '2026-09-26T11:00:00Z' }));
  messages.push(msg({ id: 'n10', from: 'hh.ru <noreply@hh.ru>', subject: 'Отказ по вакансии Аналитик', body: 'К сожалению, работодатель отказал по вашему отклику.', at: '2026-09-26T11:01:00Z' }));
  messages.push(msg({ id: 'n11', from: 'Job Board <noreply@board.example>', subject: 'Update on your application', body: 'Acme decided not to move forward with your application.', at: '2026-09-26T11:02:00Z' }));
  const { calls, r } = await scenario({ messages, answers: { n9: { type: 'interview' }, n10: { type: 'rejection' }, n11: { type: 'rejection' } } });
  assert.deepEqual(calls, ['n9', 'n10', 'n11']);
  assert.equal(r.skipped['job alert or newsletter'], notices.length);
});

test('"screen" ranks between applied and interview: a same-day interview email moves a screen on', () => {
  assert.ok(o.RANK.applied < o.RANK.screen && o.RANK.screen < o.RANK.interview, 'a screen never downgrades an interview');
  const at = Date.parse('2026-09-05T09:00:00Z');
  const apps = { k: { company: 'Acme', role: 'PM', status: 'screen', updated: '2026-09-05', updated_at: new Date(at).toISOString(), events: [{ date: '2026-09-05', type: 'screen', source: 'gmail' }] } };
  const r = o.applyOutcome(apps, { key: 'k' }, { type: 'interview', evidence: '' }, { id: 's1', date: '2026-09-05', ms: at });
  assert.equal(r.status, 'interview');
  assert.equal(r.from, 'screen');
});

test('the outcomes match keeps its exact / prefix company rule after the move to lib/companies.mjs', () => {
  assert.equal(o.companyMatch('Kvadrat', 'Kvadrat Soft'), 'exact', 'alias family from queue.aliases');
  assert.equal(o.companyMatch('Ridgeway', 'Ridgeway Labs'), 'prefix');
  assert.equal(o.companyMatch('Labs', 'Ridgeway Labs'), null, 'not the looser containment the queue uses');
  assert.ok(o.ROLE_STOPWORDS.has('senior'));
});

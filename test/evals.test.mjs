// Label sets and the decode eval (evals/sets.mjs, evals/decode.mjs, the /api/label endpoints): stratified sampling that
// is deterministic by seed, labels appended with the latest winning, the labelling payloads free of any verdict, gate
// or decoder note, a known confusion table, replay with the history cut at the job's own date, --compare with paired
// counts and an exact McNemar p-value, file:<path> systems, and the CLI with COMETSCOUT_LLM_FAKE. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-evals-'));
const DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = DATA;
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
process.env.COMETSCOUT_RUN_DATE = '2026-10-07';
process.env.COMETSCOUT_LLM_FAKE = '1';   // a safety net: no test here may reach a real model
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC', candidate_name: 'Sam Example' }));
fs.mkdirSync(path.join(tmp, 'profile'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'profile', 'profile.md'), '# Sam Example (synthetic)\n\nSenior product manager for logistics software. Remote in Europe. No German.\n');
fs.writeFileSync(path.join(tmp, 'profile', 'fact-rules.json'), JSON.stringify({ rules: [{ id: 'first-pm', pattern: 'first PM', why: 'Sam was never the first PM.' }] }));
fs.writeFileSync(path.join(tmp, 'profile', 'eval-rubric.md'), 'Yes when remote in Europe and logistics.\n');
for (const d of ['inbox', 'decoded', 'rejected', 'state', 'packs']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const LONG = 'The team builds routing software for parcel carriers across Europe. You will own discovery, the roadmap and launches, and work with engineers every day. '.repeat(4);
/** A decoded or rejected queue file; returns its name. */
function job(dir, day, company, role, verdict, { gate, flags, note } = {}) {
  const file = `${day}--${company.toLowerCase().replace(/\W+/g, '-')}--${role.toLowerCase().replace(/\W+/g, '-')}.md`;
  fs.writeFileSync(path.join(DATA, dir, file), ['---', `company: "${company}"`, `role: "${role}"`, `url: "https://jobs.example/${file}"`, 'source: "ats_boards"', 'location: "Remote, Europe"',
    ...(note ? [`notes: "${note}"`] : []), `found: ${day}`, '---', '', `# ${company} - ${role}`, '', LONG, '', '## Decode Result', `Decoded ${day} by CometScout (claude/sonnet).`,
    `verdict: ${verdict}${gate ? ` (${gate})` : ''}`, 'confidence: high', 'rationale: DECODER-RATIONALE-TEXT', 'fit_signals: logistics', 'gaps: none', 'action: DECODER-ACTION-TEXT',
    'hold_reason: DECODER-HOLD-TEXT', ...(flags ? [`fact_flags: ${flags}`] : []), ''].join('\n'));
  return file;
}
const dirOf = v => (['gate-reject', 'weak-fit', 'failed'].includes(v) ? 'rejected' : 'decoded');

// The sampling pool: 20 worth applying, 3 held, 10 weak, 15 gate rejects, 2 unreadable.
const POOL = [];
const add = (n, v, from) => { for (let i = 0; i < n; i++) POOL.push(job(dirOf(v), `2026-09-${String(from + (i % 9)).padStart(2, '0')}`, `Pool${v.replace(/\W/g, '')}${i}`, 'Product Manager', v)); };
add(10, 'strong-fit', 1); add(10, 'investable-stretch', 1); add(3, 'long-shot', 1); add(10, 'weak-fit', 1); add(15, 'gate-reject', 1); add(2, 'unreadable', 1);

// The known set: one job per case of the confusion table.
const K = {
  a: job('decoded', '2026-09-20', 'Alder', 'PM', 'strong-fit'), b: job('decoded', '2026-09-20', 'Birch', 'PM', 'investable-stretch'),
  c: job('decoded', '2026-09-20', 'Cedar', 'PM', 'long-shot'), d: job('rejected', '2026-09-20', 'Dune', 'PM', 'gate-reject', { gate: 'language' }),
  e: job('rejected', '2026-09-20', 'Elm', 'PM', 'weak-fit'), f: job('rejected', '2026-09-20', 'Fir', 'PM', 'gate-reject', { gate: 'betting' }),
  g: job('decoded', '2026-09-20', 'Gorse', 'PM', 'strong-fit'), h: job('decoded', '2026-09-20', 'Hazel', 'PM', 'strong-fit', { flags: 'first-pm' }),
  i: job('decoded', '2026-09-20', 'Ivy', 'PM', 'strong-fit', { note: 'DECODER-NOTE-TEXT' }),
};

const S = await import('../evals/sets.mjs');
const D = await import('../evals/decode.mjs');
const { mcnemarExact, rng, shuffle } = await import('../evals/stats.mjs');
const ws = await import('../lib/workspace.mjs');
const { startServer } = await import('../lib/server.mjs');
const { LABELS } = await import('../lib/i18n.mjs');

S.createSet('known', { include: Object.values(K), size: Object.keys(K).length });
const label = (k, surface, reason = '', fm) => S.appendLabel('known', { file: K[k], surface, reason, ...(fm ? { failure_mode: fm } : {}) });

test('sampling: stratified so rare verdicts are in, deterministic by seed, forced files, date range, mixed order', () => {
  const all = S.queueJobs().filter(j => POOL.includes(j.file));
  const a = S.drawSample(all, { size: 12, seed: 7 }), b = S.drawSample(all, { size: 12, seed: 7 }), c = S.drawSample(all, { size: 12, seed: 8 });
  assert.deepEqual(a.jobs.map(j => j.file), b.jobs.map(j => j.file), 'same seed, same sample in the same order');
  assert.notDeepEqual(a.jobs.map(j => j.file), c.jobs.map(j => j.file));
  assert.deepEqual(a.strata, { worth: 3, held: 3, weak: 2, gate: 2, unreadable: 2 }, 'one per stratum in turn: all 3 held and both unreadable are in');
  assert.ok(a.jobs.every(j => !/## Decode Result|verdict:/.test(j.text)), 'the sample holds the text only');
  const strata = a.jobs.map(j => all.find(x => x.file === j.file).stratum);
  assert.notDeepEqual(strata, [...strata].sort(), 'the order is mixed, not grouped by verdict');
  const forced = S.drawSample(all, { size: 3, seed: 1, include: [POOL[0], POOL[1]] });
  assert.deepEqual(forced.jobs.map(j => j.file).sort(), [POOL[0], POOL[1], forced.jobs.map(j => j.file).find(f => f !== POOL[0] && f !== POOL[1])].sort());
  assert.throws(() => S.drawSample(all, { include: ['nope.md'] }), /not in data\/decoded or data\/rejected: nope\.md/);
  const ranged = S.drawSample(all, { size: 100, from: '2026-09-03', to: '2026-09-04' });
  assert.ok(ranged.jobs.length > 0 && ranged.jobs.every(j => j.date >= '2026-09-03' && j.date <= '2026-09-04'));
  const big = S.drawSample(all, { size: 1000 });
  assert.equal(big.jobs.length, all.length, 'never more than there is');
  const r = rng(3); assert.deepEqual(shuffle([1, 2, 3, 4, 5], rng(3)), shuffle([1, 2, 3, 4, 5], r));
});

test('evals sample writes sample.json once; set names are folder names', () => {
  const r = S.createSet('pool', { size: 10, seed: 2 });
  assert.equal(r.count, 10);
  const s = S.readSample('pool');
  assert.equal(s.jobs.length, 10); assert.equal(s.seed, 2); assert.ok(!JSON.stringify(s).includes('DECODER-RATIONALE-TEXT'));
  assert.throws(() => S.createSet('pool', {}), /exists already/);
  for (const bad of ['../x', 'a/b', '', '.hidden', 'a b']) assert.throws(() => S.setDir(bad), /not a valid set name/, bad);
  assert.throws(() => S.createSet('x2', { from: '10/01/2026' }), /YYYY-MM-DD/);
});

test('labels: appended as JSONL, the latest line per file wins, a cut last line is survived, Unsure needs a reason', () => {
  S.createSet('labels-only', { include: [K.a, K.b], size: 2 });
  S.appendLabel('labels-only', { file: K.a, surface: 'no', reason: 'first try' });
  S.appendLabel('labels-only', { file: K.a, surface: 'yes', reason: 'changed my mind' });
  fs.appendFileSync(S.labelsFile('labels-only'), '{"file":"cut');   // a crash mid-write
  S.appendLabel('labels-only', { file: K.b, surface: 'unsure', reason: 'remote scope not stated' });
  const lines = fs.readFileSync(S.labelsFile('labels-only'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  const r = S.readLabels('labels-only');
  assert.equal(r.latest.get(K.a).surface, 'yes'); assert.equal(r.latest.get(K.a).reason, 'changed my mind');
  assert.equal(r.latest.get(K.b).surface, 'unsure'); assert.equal(r.bad, 1);
  assert.equal(r.latest.get(K.a).labeler, 'Sam Example'); assert.match(r.latest.get(K.a).labelled_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.throws(() => S.appendLabel('labels-only', { file: K.a, surface: 'unsure' }), /needs a reason/);
  assert.throws(() => S.appendLabel('labels-only', { file: K.c, surface: 'yes' }), /not in this set/);
  assert.throws(() => S.appendLabel('labels-only', { file: K.a, surface: 'maybe' }), /yes, no or unsure/);
  assert.throws(() => S.appendLabel('labels-only', { file: K.a, surface: 'no', failure_mode: 'vibes' }), /failure_mode must be one of/);
});

const srv = await startServer({ port: 0, log: () => {} });
after(() => srv.close());
function request(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: { Host: `127.0.0.1:${srv.port}`, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, text, json }); });
    });
    req.on('error', reject); if (body !== undefined) req.write(body); req.end();
  });
}
const post = (p, obj, headers = {}) => request('POST', p, { headers: { 'Content-Type': 'application/json', 'X-CometScout': '1', ...headers }, body: JSON.stringify(obj) });
const SECRETS = /DECODER-(RATIONALE|ACTION|HOLD|NOTE)-TEXT|gate-reject|strong-fit|investable-stretch|long-shot|weak-fit|verdict|Decode Result/;

test('/api/label: sets, the set with its resume point and rubric, one job with no verdict, gate or decoder note', async () => {
  S.createSet('api', { include: [K.d, K.i, K.a], size: 3 });
  const sets = await request('GET', '/api/label');
  assert.equal(sets.status, 200); assert.ok(sets.json.sets.some(s => s.name === 'api' && s.total === 3 && s.labelled === 0));
  const ov = await request('GET', '/api/label?set=api');
  assert.equal(ov.json.total, 3); assert.equal(ov.json.resume, 0); assert.match(ov.json.rubric, /remote in Europe/);
  assert.doesNotMatch(ov.text, SECRETS, 'the overview names no verdict');
  for (const f of ov.json.files) {
    const j = await request('GET', `/api/label/job?set=api&file=${encodeURIComponent(f)}`);
    assert.equal(j.status, 200);
    assert.deepEqual(Object.keys(j.json).sort(), ['company', 'file', 'location', 'role', 'salary', 'text', 'url']);
    assert.match(j.json.text, /routing software/); assert.doesNotMatch(j.text, SECRETS, f);
  }
  assert.equal((await request('GET', '/api/label/job?set=api&file=nope.md')).status, 404);
  assert.equal((await request('GET', '/api/label?set=missing')).status, 404);
  assert.equal((await request('GET', '/api/label?set=..%2Fx')).status, 400);
  const page = await request('GET', '/label?set=api');
  assert.equal(page.status, 200); assert.match(page.text, /importmap/, '/label serves the workspace page');
});

test('POST /api/label appends, the latest wins, resume moves on; header, validation and unknown sets refused', async () => {
  const first = ws.labelPayload('api').files[0];
  assert.equal((await post('/api/label', { set: 'api', file: first, surface: 'yes' }, { 'X-CometScout': '' })).status, 403);
  assert.equal((await post('/api/label', { set: 'api', file: first, surface: 'unsure' })).status, 400, 'Unsure without a reason');
  assert.equal((await post('/api/label', { set: 'nope', file: first, surface: 'yes' })).status, 404);
  const a = await post('/api/label', { set: 'api', file: first, surface: 'no', reason: 'too junior', failure_mode: 'too_junior' });
  assert.equal(a.status, 200); assert.equal(a.json.labelled, 1); assert.equal(a.json.label.failure_mode, 'too_junior');
  const b = await post('/api/label', { set: 'api', file: first, surface: 'yes', reason: 'on reflection' });
  assert.equal(b.json.labelled, 1, 'a changed label is still one label');
  const ov = ws.labelPayload('api');
  assert.equal(ov.labels[first].surface, 'yes'); assert.equal(ov.resume, 1); assert.equal(ov.labelled, 1);
  assert.equal(fs.readFileSync(S.labelsFile('api'), 'utf8').trim().split('\n').length, 2, 'both lines kept');
});

// Labels for the known set: g unsure, h left unlabelled.
label('a', 'yes'); label('b', 'no', 'too senior', 'too_senior'); label('c', 'yes', 'exactly my domain'); label('d', 'yes', 'German is a plus, not required');
label('e', 'no'); label('f', 'no'); label('g', 'unsure', 'remote scope not stated'); label('i', 'yes');

test('decode eval on a known set: confusion table, precision and recall, missed and noise, gates, unsure, fact flags', async () => {
  const sample = S.readSample('known'), labels = S.readLabels('known').latest;
  const e = D.evaluate(sample, labels, D.queueVerdicts(sample));
  assert.deepEqual(e.confusion, { tp: 2, fp: 1, fn: 2, tn: 2 });
  assert.deepEqual(e.precision, { value: 2 / 3, num: 2, den: 3 }); assert.deepEqual(e.recall, { value: 0.5, num: 2, den: 4 });
  assert.deepEqual(e.missed.map(r => r.file).sort(), [K.c, K.d].sort());
  assert.equal(e.missed.find(r => r.file === K.d).reason, 'German is a plus, not required');
  assert.deepEqual(e.noise.map(r => [r.file, r.reason, r.failure_mode]), [[K.b, 'too senior', 'too_senior']]);
  assert.equal(e.gate.judged, 2); assert.deepEqual(e.gate.labelled_yes.map(r => [r.file, r.gate]), [[K.d, 'language']]);
  assert.equal(e.unsure, 1); assert.equal(e.unlabelled, 1); assert.deepEqual(e.fact_flags, { 'first-pm': 1 });
  assert.deepEqual(e.by_verdict['strong-fit'], { yes: 2, no: 0, unsure: 1 });
  const r = await D.decodeEval({ set: 'known', system: 'queue', date: '2026-10-07' });
  assert.ok(fs.existsSync(r.json) && r.md.endsWith('report-2026-10-07-queue.md'));
  const md = fs.readFileSync(r.md, 'utf8');
  assert.match(md, /Surfaced precision: 0\.67 \(2 of 3\)/); assert.match(md, /Surfaced recall: 0\.50 \(2 of 4\)/);
  assert.match(md, /Missed good roles \(labelled yes, not surfaced\): 2/); assert.match(md, /held-out set/);
  assert.ok(!md.includes('\u2014'), 'no em dash');
});

test('compare: paired counts, disagreements with the side the label agreed with, exact McNemar p', async () => {
  assert.equal(mcnemarExact(0, 0), 1); assert.equal(mcnemarExact(1, 6), 0.125); assert.equal(mcnemarExact(0, 5), 0.0625);
  assert.equal(mcnemarExact(3, 3), 1); assert.ok(Math.abs(mcnemarExact(2, 20) - 0.000121) < 1e-6);
  assert.ok(Number.isFinite(mcnemarExact(0, 2000)) && Number.isFinite(mcnemarExact(900, 1100)), 'a large n gives a number, not NaN');
  const other = path.join(tmp, 'other-pipeline.json');
  fs.writeFileSync(other, JSON.stringify({ [K.a]: 'weak-fit', [K.b]: 'weak-fit', [K.c]: { verdict: 'strong-fit' }, [K.d]: 'strong-fit', [K.e]: 'weak-fit', [K.f]: 'gate-reject', [K.i]: 'strong-fit' }));
  const r = await D.decodeEval({ set: 'known', system: 'queue', compare: `file:${other}`, date: '2026-10-07' });
  const c = r.report.compare;
  assert.deepEqual(c.paired, { both_right: 3, a_only: 1, b_only: 3, both_wrong: 0 });
  assert.equal(c.n, 7); assert.equal(c.mcnemar_p, 0.625);
  assert.deepEqual(c.disagreements.map(d => [d.file, d.agreed]).sort(), [[K.a, 'a'], [K.b, 'b'], [K.c, 'b'], [K.d, 'b']].sort());
  assert.equal(r.report.other_result.no_verdict.length, 0); assert.ok(r.md.endsWith('report-2026-10-07-queue-vs-file-other-pipeline.md'));
  assert.match(fs.readFileSync(r.md, 'utf8'), /Exact McNemar p-value: 0\.6250 \(1 vs 3 discordant\)/);
  await assert.rejects(D.decodeEval({ set: 'known', system: 'queue', compare: 'queue' }), /same system/);
  await assert.rejects(D.decodeEval({ set: 'known', system: 'nonsense' }), /unknown system/);
});

test('replay: each job decoded with the history cut at its own date; no later outcome or decode reaches the prompt', async () => {
  const k = job('decoded', '2026-09-10', 'Kestrel Labs', 'Senior PM', 'strong-fit');
  job('decoded', '2026-09-05', 'Kestrel Labs', 'Data PM', 'investable-stretch');
  job('rejected', '2026-09-12', 'Kestrel Labs', 'Growth PM', 'weak-fit');
  fs.writeFileSync(path.join(DATA, 'state', 'applications.json'), JSON.stringify({
    'manual:kestrel labs|ops pm': { company: 'Kestrel Labs', role: 'Ops PM', status: 'rejected', updated: '2026-09-20', note: 'LATER-REJECTION-NOTE',
      events: [{ date: '2026-09-01', type: 'applied', source: 'cli' }, { date: '2026-09-20', type: 'rejection', source: 'gmail' }] },
    'manual:kestrel labs|platform pm': { company: 'Kestrel Labs', role: 'Platform PM', status: 'applied', updated: '2026-09-15' },
    [k]: { company: 'Kestrel Labs', role: 'Senior PM', status: 'interview', updated: '2026-09-25' },
  }));
  S.createSet('replay', { include: [k, K.a], size: 2 });
  const prompts = [];
  const call = async ({ prompt }) => { prompts.push(prompt); return { value: { verdict: prompt.includes('Kestrel') ? 'weak-fit' : 'strong-fit', confidence: 'high', rationale: 'r', fit_signals: [], gaps: [], action: 'a', hold_reason: null } }; };
  const r = await D.decodeEval({ set: 'replay', system: 'replay', call, date: '2026-10-07' });
  const p = prompts.find(x => x.includes('## History with Kestrel Labs'));
  const hist = p.slice(p.indexOf('## History with'), p.indexOf('## Job file'));
  assert.match(hist, /2026-09-01: Ops PM: applied/, 'the application as it stood on the job date');
  assert.match(hist, /2026-09-05: decoded "Data PM"/);
  for (const later of ['LATER-REJECTION-NOTE', 'rejected', 'Platform PM', 'Growth PM', 'interview', 'Senior PM']) assert.ok(!hist.includes(later), `"${later}" leaked into the history`);
  assert.ok(!p.includes('## Decode Result') && !p.includes('DECODER-RATIONALE-TEXT'), 'the old verdict is not in the job text');
  const replay = JSON.parse(fs.readFileSync(path.join(S.setDir('replay'), 'replay-2026-10-07.json'), 'utf8'));
  assert.equal(replay[k].verdict, 'weak-fit'); assert.equal(replay[K.a].verdict, 'strong-fit');
  assert.equal(r.report.result.unlabelled, 2);
  const again = D.fileVerdicts(path.join(S.setDir('replay'), 'replay-2026-10-07.json'), S.readSample('replay'));
  assert.equal(again[k].verdict, 'weak-fit', 'a replay file works as file:<path>');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'state', 'applications.json'), 'utf8'))[k].status, 'interview', 'replay writes nothing to the queue or applications');
  assert.ok(fs.existsSync(path.join(DATA, 'decoded', k)));
});

test('cli: evals sample, sets and decode --system replay with COMETSCOUT_LLM_FAKE (no model, no network)', () => {
  const env = { ...process.env, COMETSCOUT_LLM_FAKE: '1' };
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'evals', ...a], { env, encoding: 'utf8' });
  const s = run('sample', '--set', 'cli-set', '--size', '6', '--seed', '4');
  assert.equal(s.status, 0, s.stdout + s.stderr); assert.match(s.stdout, /set "cli-set": 6 jobs sampled/); assert.match(s.stdout, /\/label\?set=cli-set/);
  assert.equal(run('sample', '--set', 'cli-set').status, 1, 'an existing set is not overwritten');
  assert.match(run('sets').stdout, /cli-set: 0 of 6 labelled/);
  const d = run('decode', '--set', 'known', '--system', 'replay');
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /replay: precision n\/a \(0 of 0\), recall 0\.00 \(0 of 4\)/, 'every canned verdict is long-shot');
  assert.match(d.stdout, /report: .*report-2026-10-07-replay\.md/);
  assert.equal(run('decode').status, 1);
  assert.match(run('nonsense').stdout, /Usage:/);
});

test('export and backups carry data/evals (labels are human work)', async () => {
  const { collect } = await import('../lib/archive.mjs');
  const rels = collect({ dataOnly: true }).files.map(f => f.rel);
  assert.ok(rels.includes('data/evals/known/sample.json') && rels.includes('data/evals/known/labels.jsonl'));
});

test('Russian labels exist for the labelling screen', () => {
  const keys = Object.keys(LABELS.en).filter(k => k.startsWith('ws.label.'));
  assert.ok(keys.length >= 20);
  for (const k of keys) { assert.ok(LABELS.ru[k], k); assert.notEqual(LABELS.ru[k], LABELS.en[k], k); }
});

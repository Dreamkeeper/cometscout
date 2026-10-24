// Decoder pieces that need no model: alias-aware history with a cutoff, fact flags with the negation guard,
// decoder.prompt_file (and its doctor line). Synthetic companies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-decoder-'));
const DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = DATA;
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
process.env.COMETSCOUT_RUN_DATE = '2026-10-01';
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC', candidate_name: 'Sam Example', queue: { aliases: [['Acme Robotics', 'Acme']] } }));
for (const d of ['decoded', 'rejected', 'state']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const decoded = (dir, file, company, role, verdict, day) => fs.writeFileSync(path.join(DATA, dir, file),
  `---\ncompany: "${company}"\nrole: "${role}"\nfound: ${day}\n---\n\n# ${company} - ${role}\n\ntext\n\n## Decode Result\nDecoded ${day} by CometScout (claude/sonnet).\nverdict: ${verdict}\nconfidence: high\nrationale: r\naction: a\n`);
decoded('decoded', '2026-08-01--acme-robotics--product-manager-robotics.md', 'Acme Robotics', 'Product Manager, Robotics', 'strong-fit', '2026-08-01');
decoded('rejected', '2026-09-20--acme--data-analyst.md', 'Acme', 'Data Analyst', 'weak-fit', '2026-09-20');
decoded('decoded', '2026-09-25--driftwood--product-owner.md', 'Driftwood', 'Product Owner', 'strong-fit', '2026-09-25');
fs.writeFileSync(path.join(DATA, 'state', 'applications.json'), JSON.stringify({
  '2026-08-01--acme-robotics--product-manager-robotics.md': { company: 'Acme Robotics', role: 'Product Manager, Robotics', status: 'rejected', updated: '2026-09-10', note: 'filled internally',
    events: [{ date: '2026-08-02', type: 'applied', source: 'cli' }, { date: '2026-09-10', type: 'rejection', source: 'gmail' }] },
  'manual:acme|robotics qa': { company: 'Acme', role: 'Robotics QA', status: 'offer', updated: '2026-09-20',
    events: [{ date: '2026-08-25', type: 'test_task', source: 'gmail' }, { date: '2026-08-26', type: 'reopened', source: 'gmail' }, { date: '2026-09-20', type: 'offer', source: 'gmail' }] },
  'manual:acme|vision lead': { company: 'Acme', role: 'Vision Lead', status: 'applied', updated: '2026-09-05', events: [{ date: '2026-09-05', type: 'applied', source: 'cli' }] },
  'manual:acme|firmware lead': { company: 'ACME', role: 'Firmware Lead', status: 'applied', updated: '2026-08-15',
    events: [{ date: '2026-09-02', type: 'interview', source: 'gmail' }] },
}, null, 1));

const d = await import('../decoder/decoder.mjs');
const { SETTINGS, PROFILE } = await import('../lib/config.mjs');

// history() as the decode prompt shows it: [the user's block, the block of other roles CometScout read]
const blocks = h => { const [mine, others] = h.split(`## ${d.OTHERS_HEADING}\n`); return { mine, others }; };
const NONE_APPLIED = 'none: the user has not applied to this company';

test('history: two labelled blocks; applications through alias families; other decodes with date and role only', () => {
  const h = d.history('Acme');
  const { mine, others } = blocks(h);
  assert.ok(mine.startsWith(`## ${d.RECORDED_HEADING}\n`), h);
  assert.equal(d.RECORDED_HEADING, 'Applications and outcomes the user recorded');
  assert.equal(d.OTHERS_HEADING, 'Other roles at this company that CometScout read (not applications)');
  assert.match(mine, /2026-09-10: Product Manager, Robotics: rejected \(filled internally\)/, 'application under the family name');
  assert.match(mine, /2026-08-15: Firmware Lead: applied/);
  assert.doesNotMatch(mine, /Data Analyst/, 'a decode is never in the user\'s block');
  assert.match(others, /^- 2026-08-01: Product Manager, Robotics$/m);
  assert.match(others, /^- 2026-09-20: Data Analyst$/m);
  assert.doesNotMatch(h, /strong-fit|weak-fit|investable|long-shot|decoded "/, 'no verdict from an earlier decode reaches the prompt');
  assert.doesNotMatch(h, /Driftwood|Product Owner/);
});

test('history of a company with only past decodes: the none line in the first block and no verdict text', () => {
  assert.equal(d.history('Driftwood'), `## ${d.RECORDED_HEADING}\n${NONE_APPLIED}\n\n## ${d.OTHERS_HEADING}\n- 2026-09-25: Product Owner`);
  assert.equal(d.history('Lumenfield'), `## ${d.RECORDED_HEADING}\n${NONE_APPLIED}\n\n## ${d.OTHERS_HEADING}\nnone`);
});

test('history leaves out decodes from the same day and from the same run (verdicts must not anchor on each other)', () => {
  const same = '2026-10-01--acme--ops-lead.md', earlier = '2026-09-28--acme--qa-lead.md';
  decoded('decoded', same, 'Acme', 'Ops Lead', 'investable-stretch', '2026-10-01');   // the run date (COMETSCOUT_RUN_DATE)
  decoded('decoded', earlier, 'Acme', 'QA Lead', 'strong-fit', '2026-09-28');
  try {
    assert.doesNotMatch(d.history('Acme'), /Ops Lead/, 'decoded today: left out');
    assert.match(blocks(d.history('Acme')).others, /^- 2026-09-28: QA Lead$/m);
    assert.doesNotMatch(d.history('Acme', { skip: new Set([earlier]) }), /QA Lead/, 'a file of this run: left out whatever its date');
    assert.match(d.history('Acme', { before: '2026-10-02' }), /^- 2026-10-01: Ops Lead$/m, 'a replay cutoff decides instead of today');
    assert.match(d.historyParts('Acme').decodes.map(x => x.role).join(), /Ops Lead/, 'the workspace still sees every decode');
  } finally { fs.rmSync(path.join(DATA, 'decoded', same)); fs.rmSync(path.join(DATA, 'decoded', earlier)); }
});

test('decodeText: the prompt carries both blocks and no verdict; the verdict carries the call\'s cost', async () => {
  const prompts = [];
  const call = async ({ prompt }) => { prompts.push(prompt); return { value: { verdict: 'investable-stretch', confidence: 'high', apply_priority: 2, rationale: 'r', fit_signals: [], gaps: [], action: 'a' }, cost: 0.0123 }; };
  const body = `# Acme - Planning Lead\n\n${'Plans the robot fleet roll-out with operations and engineering. '.repeat(8)}`;
  const job = { file: '2026-10-01--acme--planning-lead.md', fm: { company: 'Acme', role: 'Planning Lead' }, body, text: `---\ncompany: "Acme"\n---\n\n${body}` };
  const v = await d.decodeText(job, 'PROMPT', { call });
  assert.equal(v.cost_usd, 0.0123);
  const p = prompts[0];
  assert.ok(p.includes(`## ${d.RECORDED_HEADING}\n- 2026-09-20: Robotics QA: offer`), p);
  assert.match(p, /^- 2026-09-10: Product Manager, Robotics: rejected \(filled internally\)/m);
  assert.ok(p.indexOf(`## ${d.OTHERS_HEADING}`) < p.indexOf('## Job file'));
  assert.doesNotMatch(p.slice(0, p.indexOf('## Job file')), /strong-fit|weak-fit|History with/);
  assert.equal((await d.decodeText(job, 'PROMPT', { call: async () => ({ value: { verdict: 'weak-fit', confidence: 'low', rationale: 'r', fit_signals: [], gaps: [], action: 'a' } }) })).cost_usd, 0, 'no cost reported: 0');
});

test('a decoded file decoded again never shows the model its own old decode block; the pack prompt drops cost_usd', async () => {
  const { withoutDecode, decodeForPrompt } = await import('../lib/queue.mjs');
  const body = `# Acme - Planning Lead\n\n${'Plans the robot fleet roll-out with operations and engineering. '.repeat(8)}`;
  const text = `---\ncompany: "Acme"\n---\n\n${body}\n\n## Decode Result\nDecoded 2026-09-01 by CometScout (claude/sonnet).\nverdict: strong-fit\nrationale: OLD-RATIONALE-TEXT\naction: OLD-ACTION-TEXT\ncost_usd: 0.0100\n`;
  const prompts = [];
  const call = async ({ prompt }) => { prompts.push(prompt); return { value: { verdict: 'long-shot', confidence: 'low', rationale: 'r', fit_signals: [], gaps: [], action: 'a' } }; };
  await d.decodeText({ file: 'x.md', fm: { company: 'Acme' }, body, text }, 'PROMPT', { call });
  const job = prompts[0].slice(prompts[0].indexOf('## Job file'));
  assert.match(job, /Plans the robot fleet/);
  for (const old of ['## Decode Result', 'OLD-RATIONALE-TEXT', 'OLD-ACTION-TEXT', 'strong-fit', 'cost_usd']) assert.ok(!job.includes(old), old);
  assert.equal(withoutDecode('a\n## Decode Result\nverdict: x\n\n## Decode Result\nverdict: y\n'), 'a\n## Decode Result\nverdict: x\n', 'cut at the last block');
  assert.equal(withoutDecode('no decode here\n'), 'no decode here\n');
  assert.equal(decodeForPrompt('## Decode Result\nverdict: x\ncost_usd: 0.0100\naction: a\n'), '## Decode Result\nverdict: x\naction: a\n');
});

test('the decode prompt tells the model which block is the user\'s history', () => {
  const p = d.buildPrompt();
  assert.ok(p.includes(`only the block "${d.RECORDED_HEADING}" is the candidate's history`), 'the rule names the first block');
  assert.ok(p.includes(`"${d.OTHERS_HEADING}"`) && /never state or imply that the candidate applied/.test(p));
});

test('history before a day shows the world as it was then', () => {
  const h = d.history('Acme Robotics', { before: '2026-09-01' });
  assert.match(h, /^- 2026-08-02: Product Manager, Robotics: applied \[events: 2026-08-02 applied\]$/m,
    'applied before the cutoff, rejected after it: shown as applied on the day of that event, without the later note');
  assert.doesNotMatch(h, /rejected|filled internally|rejection/);
  assert.match(h, /^- 2026-08-25: Robotics QA: interview \[events: 2026-08-25 test_task; 2026-08-26 reopened\]/m, 'a test task sets "interview"; an event with no status is skipped');
  assert.doesNotMatch(h, /offer/);
  assert.doesNotMatch(h, /Vision Lead/, 'nothing before the cutoff');
  assert.match(h, /2026-08-15: Firmware Lead: applied$/m, 'updated before the cutoff, its only event after it: no events shown');
  assert.match(blocks(h).others, /^- 2026-08-01: Product Manager, Robotics$/m);
  assert.doesNotMatch(h, /Data Analyst/, 'decoded after the cutoff');
  const later = d.history('Acme Robotics', { before: '2026-09-15' });
  assert.match(later, /2026-09-10: Product Manager, Robotics: rejected \(filled internally\) \[events: 2026-08-02 applied; 2026-09-10 rejection\]/);
  assert.match(later, /Firmware Lead: applied \[events: 2026-09-02 interview\]/);
  assert.match(later, /2026-09-05: Vision Lead: applied/);
});

test('asOf maps every event type to a status', () => {
  const app = (type, source = 'gmail') => ({ status: 'closed', updated: '2026-09-30', events: [{ date: '2026-09-01', type, source }] });
  const want = { rejection: 'rejected', interview: 'interview', test_task: 'interview', offer: 'offer', application_received: 'applied',
    applied: 'applied', screen: 'screen', skipped: 'skipped', closed: 'closed' };
  for (const [type, status] of Object.entries(want)) assert.equal(d.asOf(app(type), '2026-09-15').status, status, type);
  assert.equal(d.asOf(app('rejection'), '2026-09-15').date, '2026-09-01');
  assert.equal(d.asOf(app('rejection'), '2026-09-01'), null, 'an event on the cutoff day is not before it');
  assert.equal(d.asOf({ status: 'applied', events: 'broken' }, '2026-09-15'), null);
});

test('history excludeFile drops the job\'s own application and decode', () => {
  const h = d.history('Acme', { excludeFile: '2026-08-01--acme-robotics--product-manager-robotics.md' });
  assert.doesNotMatch(h, /Product Manager, Robotics/);
  assert.match(h, /^## Applications and outcomes the user recorded\n/);
  assert.match(h, /Firmware Lead/);
  assert.match(h, /Data Analyst/);
});

const rule = (id, pattern, guard) => ({ id, pattern, why: `${id} why`, ...(guard ? { guard: true } : {}) });
test('fact flags: every text field, the first match per rule with an excerpt', () => {
  const rules = [rule('first-pm', '\\bfirst PM\\b'), rule('team', 'managed a team of \\w+')];
  const v = { rationale: 'Good fit.', fit_signals: ['shipped billing'], gaps: ['frameable: managed a team of designers is asked'], action: 'Apply.', hold_reason: 'Was the first PM at a startup; the first PM again here' };
  assert.deepEqual(d.factFlags(v, rules), [
    { id: 'first-pm', why: 'first-pm why', excerpt: 'first PM' },
    { id: 'team', why: 'team why', excerpt: 'managed a team of designers' },
  ]);
  const long = d.factFlags({ rationale: `claims ${'x'.repeat(120)}` }, [rule('long', 'claims x+')]);
  assert.equal(long[0].excerpt.length, 80);
  assert.deepEqual(d.factFlags({ rationale: 'nothing here', fit_signals: [], action: '' }, rules), []);
});

test('fact flags: a guarded rule ignores a negated match and an employer opening', () => {
  const rules = [rule('first-pm', '\\bthe first PM\\b', true)];
  const flag = text => d.factFlags({ rationale: text }, rules).map(f => f.excerpt);
  assert.deepEqual(flag('Sam was never the first PM anywhere.'), []);
  assert.deepEqual(flag('This is the first PM hire for the team.'), []);
  assert.deepEqual(flag('Sam would be the first PM hired by the founders.'), [], 'a prefix: "hired"');
  assert.deepEqual(flag('The company is the first PM hiring in this unit.'), [], 'a prefix: "hiring"');
  assert.deepEqual(flag('They want the first PM: someone to set up the process.'), []);
  assert.deepEqual(flag('Sam would join as the first PM there.'), ['the first PM']);
  assert.deepEqual(flag('Sam was never the first PM hire at the agency in its early years, then became the first PM there.'), ['the first PM'], 'a later match outside the 50 characters counts');
  assert.deepEqual(flag('Knowledgeable about the first PM there.'), ['the first PM'], '"no" inside a word is not a negation');
  assert.deepEqual(d.factFlags({ rationale: 'Sam was never the first PM.' }, [rule('first-pm', '\\bthe first PM\\b')]).length, 1, 'an unguarded rule still flags');
});

test('decoder.prompt_file replaces decoder/prompt.md, relative to the profile folder or absolute', () => {
  assert.equal(d.promptFile(), d.DEFAULT_PROMPT_FILE);
  assert.match(d.buildPrompt(), /You are the decode step of Sam Example's job-search pipeline/);
  const own = path.join(tmp, 'my-prompt.md');
  fs.writeFileSync(own, 'Judge for {{NAME}}. Profile: {{PROFILE}}. Again {{NAME}}.');
  SETTINGS.decoder = { prompt_file: own };
  try {
    assert.equal(d.promptFile(), own);
    const p = d.buildPrompt();
    assert.ok(p.startsWith('Judge for Sam Example. Profile: '));
    assert.ok(p.includes(PROFILE.facts.slice(0, 40)));
    assert.ok(p.endsWith('Again Sam Example.'));
    SETTINGS.decoder = { prompt_file: 'prompts/decode.md' };
    assert.equal(d.promptFile(), path.join(PROFILE.dir, 'prompts', 'decode.md'));
    assert.throws(() => d.buildPrompt(), /decoder\.prompt_file not found/);
  } finally { delete SETTINGS.decoder; }
});

test('doctor reports the prompt in use and fails on a missing prompt_file', () => {
  const settings = path.join(tmp, 'doctor-settings.json');
  const run = decoder => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'doctor'], { encoding: 'utf8', timeout: 120000,
    env: { ...process.env, COMETSCOUT_SETTINGS: settings }, input: '', ...(fs.writeFileSync(settings, JSON.stringify({ timezone: 'UTC', decoder })), {}) }).stdout;
  assert.match(run({}), /^ok {3}decoder prompt: built-in \(decoder\/prompt\.md\)$/m);
  const own = path.join(tmp, 'my-prompt.md');
  assert.match(run({ prompt_file: own }), new RegExp(`^ok {3}decoder prompt: ${own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(run({ prompt_file: path.join(tmp, 'missing.md') }), /^TODO decoder prompt: .*missing\.md {2}->  decoder\.prompt_file not found/m);
});

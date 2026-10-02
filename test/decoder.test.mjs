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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-decoder-'));
const DATA = path.join(tmp, 'data');
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = DATA;
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
process.env.JOBPILOT_RUN_DATE = '2026-10-01';
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC', candidate_name: 'Sam Example', queue: { aliases: [['Acme Robotics', 'Acme']] } }));
for (const d of ['decoded', 'rejected', 'state']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const decoded = (dir, file, company, role, verdict, day) => fs.writeFileSync(path.join(DATA, dir, file),
  `---\ncompany: "${company}"\nrole: "${role}"\nfound: ${day}\n---\n\n# ${company} - ${role}\n\ntext\n\n## Decode Result\nDecoded ${day} by jobpilot (claude/sonnet).\nverdict: ${verdict}\nconfidence: high\nrationale: r\naction: a\n`);
decoded('decoded', '2026-08-01--acme-robotics--product-manager-robotics.md', 'Acme Robotics', 'Product Manager, Robotics', 'strong-fit', '2026-08-01');
decoded('rejected', '2026-09-20--acme--data-analyst.md', 'Acme', 'Data Analyst', 'weak-fit', '2026-09-20');
decoded('decoded', '2026-09-25--driftwood--product-owner.md', 'Driftwood', 'Product Owner', 'strong-fit', '2026-09-25');
fs.writeFileSync(path.join(DATA, 'state', 'applications.json'), JSON.stringify({
  '2026-08-01--acme-robotics--product-manager-robotics.md': { company: 'Acme Robotics', role: 'Product Manager, Robotics', status: 'rejected', updated: '2026-09-10',
    events: [{ date: '2026-08-02', type: 'applied', source: 'cli' }, { date: '2026-08-20', type: 'interview', source: 'gmail' }, { date: '2026-09-10', type: 'rejection', source: 'gmail' }] },
  'manual:acme|firmware lead': { company: 'ACME', role: 'Firmware Lead', status: 'applied', updated: '2026-08-15',
    events: [{ date: '2026-09-02', type: 'interview', source: 'gmail' }] },
}, null, 1));

const d = await import('../decoder/decoder.mjs');
const { SETTINGS, PROFILE } = await import('../lib/config.mjs');

test('history matches the company through alias families, applications and decodes', () => {
  const h = d.history('Acme');
  assert.match(h, /2026-09-10: Product Manager, Robotics: rejected/, 'application under the family name');
  assert.match(h, /2026-08-15: Firmware Lead: applied/);
  assert.match(h, /decoded "Product Manager, Robotics": strong-fit/);
  assert.match(h, /decoded "Data Analyst": weak-fit/);
  assert.doesNotMatch(h, /Driftwood|Product Owner/);
  assert.equal(d.history('Lumenfield'), '(nothing before with this company)');
});

test('history before a day: only applications updated, events dated and decodes made before it', () => {
  const h = d.history('Acme Robotics', { before: '2026-09-01' });
  assert.doesNotMatch(h, /rejected/, 'the application updated after the cutoff is left out');
  assert.match(h, /2026-08-15: Firmware Lead: applied \[recorded by the candidate\]$/m, 'updated before the cutoff, its only event after it: no events shown');
  assert.match(h, /decoded "Product Manager, Robotics"/);
  assert.doesNotMatch(h, /Data Analyst/, 'decoded after the cutoff');
  const later = d.history('Acme Robotics', { before: '2026-09-15' });
  assert.match(later, /rejected \[events: 2026-08-02 applied; 2026-08-20 interview; 2026-09-10 rejection\]/);
  assert.match(later, /Firmware Lead: applied \[events: 2026-09-02 interview\]/);
});

test('history excludeFile drops the job\'s own application and decode', () => {
  const h = d.history('Acme', { excludeFile: '2026-08-01--acme-robotics--product-manager-robotics.md' });
  assert.doesNotMatch(h, /Product Manager, Robotics/);
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
    env: { ...process.env, JOBPILOT_SETTINGS: settings }, input: '', ...(fs.writeFileSync(settings, JSON.stringify({ timezone: 'UTC', decoder })), {}) }).stdout;
  assert.match(run({}), /^ok {3}decoder prompt: built-in \(decoder\/prompt\.md\)$/m);
  const own = path.join(tmp, 'my-prompt.md');
  assert.match(run({ prompt_file: own }), new RegExp(`^ok {3}decoder prompt: ${own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(run({ prompt_file: path.join(tmp, 'missing.md') }), /^TODO decoder prompt: .*missing\.md {2}->  decoder\.prompt_file not found/m);
});

// What the decoder really sends the model, end to end through cli.mjs and a fake `claude` that keeps every prompt:
// jobs decoded in the same run never see each other, a decode from the same day is left out, an older one appears as
// date and role with no verdict, and decode --dry-run --file never shows a job its own old decode. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-decode-prompt-'));
const H = path.join(tmp, 'home'), DATA = path.join(H, 'data'), DAY = '2026-10-06', PROMPTS = path.join(tmp, 'prompts');
const TEXT = 'The team builds routing software for parcel carriers across Europe. You will own discovery, the roadmap and launches. '.repeat(5);
for (const d of ['profile', 'data/inbox', 'data/decoded', 'data/rejected', 'data/state']) fs.mkdirSync(path.join(H, d), { recursive: true });
fs.mkdirSync(PROMPTS);
fs.writeFileSync(path.join(H, 'profile', 'profile.md'), '# Sam Example (synthetic)\n\nSenior product manager for logistics software, remote in Europe.\n');
// the fake model CLI: each prompt into its own file, a canned verdict back
const fake = path.join(tmp, 'fake-claude.mjs');
fs.writeFileSync(fake, `import fs from 'node:fs'; import path from 'node:path';
let s = ''; process.stdin.on('data', d => s += d).on('end', () => {
  fs.writeFileSync(path.join(${JSON.stringify(PROMPTS)}, Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.txt'), s);
  process.stdout.write(JSON.stringify({ structured_output: { verdict: 'long-shot', confidence: 'low', apply_priority: 4, rationale: 'Synthetic.', fit_signals: [], gaps: [], action: 'Hold.', hold_reason: 'Synthetic.' }, total_cost_usd: 0 }));
});\n`);
fs.writeFileSync(path.join(H, 'settings.json'), JSON.stringify({ timezone: 'UTC', llm: { provider: 'claude', model: 'sonnet', bin: fake }, pack: { enabled: false }, update: { check: false }, backup: { nightly: false } }));
const job = (dir, file, role, decode = '') => fs.writeFileSync(path.join(DATA, dir, file),
  `---\ncompany: "Acme Robotics"\nrole: "${role}"\nurl: "https://jobs.example/${role.replace(/\W+/g, '-')}"\nfound: ${file.slice(0, 10)}\n---\n\n# Acme Robotics - ${role}\n\n${TEXT}\n${decode}`);
const block = (day, verdict) => `\n## Decode Result\nDecoded ${day} by CometScout (claude/sonnet).\nverdict: ${verdict}\nconfidence: high\nrationale: OLD-RATIONALE-${verdict}\naction: OLD-ACTION-${verdict}\ncost_usd: 0.0100\n`;
// an older decode, a decode from today (an earlier run the same day), and two new jobs at the same company
job('decoded', '2026-09-20--acme-robotics--fleet-pm.md', 'Fleet PM', block('2026-09-20', 'strong-fit'));
job('rejected', `${DAY}--acme-robotics--same-day-pm.md`, 'Same Day PM', block(DAY, 'weak-fit'));
job('inbox', `${DAY}--acme-robotics--sibling-one-pm.md`, 'Sibling One PM');
job('inbox', `${DAY}--acme-robotics--sibling-two-pm.md`, 'Sibling Two PM');
const env = { ...process.env, COMETSCOUT_HOME: H, COMETSCOUT_DATA: DATA, COMETSCOUT_SETTINGS: path.join(H, 'settings.json'), COMETSCOUT_RUN_DATE: DAY };
for (const k of ['COMETSCOUT_LLM_FAKE', 'COMETSCOUT_EVENING']) delete env[k];
const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...a], { encoding: 'utf8', env, timeout: 120000 });
const takePrompts = () => { const out = fs.readdirSync(PROMPTS).sort().map(f => fs.readFileSync(path.join(PROMPTS, f), 'utf8')); for (const f of fs.readdirSync(PROMPTS)) fs.rmSync(path.join(PROMPTS, f)); return out; };
const history = p => p.slice(p.indexOf('## Applications and outcomes the user recorded'), p.indexOf('## Job file'));

test('decode: the run\'s own siblings and today\'s decode are not in the history; the older one is date and role, no verdict', () => {
  const r = cli('decode', '--no-telegram');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const prompts = takePrompts();
  assert.equal(prompts.length, 2, 'one call per inbox job');
  for (const p of prompts) {
    const h = history(p);
    assert.match(h, /^## Applications and outcomes the user recorded\nnone: the user has not applied to this company\n/);
    assert.match(h, /^- 2026-09-20: Fleet PM$/m, 'the older decode, as date and role');
    assert.doesNotMatch(h, /Same Day PM/, 'a decode dated today is left out');
    assert.doesNotMatch(h, /Sibling (One|Two) PM/, 'a job of the same run is left out');
    // the verdict scale names every verdict; after it (history and job file) no earlier verdict may appear
    assert.doesNotMatch(p.slice(p.indexOf('## Applications and outcomes the user recorded')), /strong-fit|weak-fit|OLD-RATIONALE|OLD-ACTION|cost_usd/, 'no earlier verdict in the history or the job');
  }
});

test('decode --dry-run --file: the job\'s own old decode block and its own entry never reach the prompt', () => {
  const r = cli('decode', '--dry-run', '--file', '2026-09-20--acme-robotics--fleet-pm.md');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [p] = takePrompts();
  assert.ok(p, 'the model was called');
  const jobPart = p.slice(p.indexOf('## Job file'));
  assert.match(jobPart, /routing software for parcel carriers/);
  for (const old of ['## Decode Result', 'OLD-RATIONALE', 'OLD-ACTION', 'strong-fit', 'cost_usd']) assert.ok(!jobPart.includes(old), old);
  assert.doesNotMatch(history(p), /Fleet PM/, 'its own decode is not "another role"');
  assert.match(fs.readFileSync(path.join(DATA, 'decoded', '2026-09-20--acme-robotics--fleet-pm.md'), 'utf8'), /OLD-RATIONALE-strong-fit/, 'nothing written');
});

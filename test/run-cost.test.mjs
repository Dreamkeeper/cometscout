// What a run's model calls cost: cost_usd in each decode block, the digest's footer line, the run log's cost (decodes,
// packs, total). The model is a fake `claude` that reports a cost; no network. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-run-cost-'));
const DAY = '2026-10-06';
const TEXT = 'The team builds routing software for parcel carriers across Europe. You will own discovery, the roadmap and launches. '.repeat(5);

/** A home with a profile, two jobs in the inbox and a fake claude that answers a long-shot at `cost` per call. */
function home(name, { cost = 0.0125, pack = false } = {}) {
  const h = path.join(tmp, name), data = path.join(h, 'data');
  for (const d of ['profile', 'data/inbox', 'data/state']) fs.mkdirSync(path.join(h, d), { recursive: true });
  fs.writeFileSync(path.join(h, 'profile', 'profile.md'), '# Sam Example (synthetic)\n\nSenior product manager for logistics software, remote in Europe.\n');
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'lint', 'cv-library.json'), path.join(h, 'profile', 'cv-library.json'));
  const fake = path.join(h, 'fake-claude.mjs');
  const answer = { structured_output: { verdict: 'long-shot', confidence: 'high', apply_priority: 3, rationale: 'Synthetic.', fit_signals: ['logistics'], gaps: [], action: 'Hold.', hold_reason: 'Synthetic hold.' }, total_cost_usd: cost };
  fs.writeFileSync(fake, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(answer))}));\n`);
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({ timezone: 'UTC', candidate_name: 'Sam Example', llm: { provider: 'claude', model: 'sonnet', bin: fake },
    schedule: { days: [1, 2, 3, 4, 5, 6, 7], time: '18:00' }, pack: { enabled: pack }, update: { check: false }, backup: { nightly: false } }));
  for (const c of ['Alder', 'Birch']) fs.writeFileSync(path.join(data, 'inbox', `${DAY}--${c.toLowerCase()}--pm.md`), `---\ncompany: "${c}"\nrole: "PM"\nurl: "https://jobs.example/${c}"\nlocation: "Remote, Europe"\nfound: ${DAY}\n---\n\n# ${c} - PM\n\n${TEXT}\n`);
  const env = { ...process.env, COMETSCOUT_HOME: h, COMETSCOUT_DATA: data, COMETSCOUT_SETTINGS: path.join(h, 'settings.json'), COMETSCOUT_RUN_DATE: DAY };
  for (const k of ['COMETSCOUT_LLM_FAKE', 'COMETSCOUT_EVENING', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) delete env[k];
  return { h, data, env };
}
const runCli = (x, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { encoding: 'utf8', env: x.env, timeout: 120000 });
const lastRun = x => JSON.parse(fs.readFileSync(path.join(x.data, 'state', 'runs.jsonl'), 'utf8').trim().split('\n').at(-1));

// this process reads its own home (for the unit test of runCost and costLine)
const unit = home('unit', { cost: 0 });
Object.assign(process.env, { COMETSCOUT_HOME: unit.h, COMETSCOUT_DATA: unit.data, COMETSCOUT_SETTINGS: path.join(unit.h, 'settings.json'), COMETSCOUT_RUN_DATE: DAY });
const { runCost, queueSnapshot } = await import('../lib/run-log.mjs');
const { costLine } = await import('../decoder/digest.mjs');
const { parseResult } = await import('../lib/queue.mjs');

test('decode: cost_usd in each decode block and one footer line in the digest (decodes, packs, total)', () => {
  const x = home('decode');
  const r = runCli(x, 'decode', '--no-telegram');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const files = fs.readdirSync(path.join(x.data, 'decoded'));
  assert.equal(files.length, 2);
  for (const f of files) {
    const t = fs.readFileSync(path.join(x.data, 'decoded', f), 'utf8');
    assert.match(t, /^cost_usd: 0\.0125$/m); assert.equal(parseResult(t).cost_usd, 0.0125);
  }
  const digest = fs.readFileSync(path.join(x.data, 'digests', `${DAY}.md`), 'utf8');
  assert.match(digest, /\n\nCost of this run: decodes 2 \(USD 0\.03\), packs 0 \(USD 0\.00\), total USD 0\.03\.\n$/, digest);
});

test('run: the run log sums the cost; with packs on, the digest says packs come next and the run adds the full line', () => {
  const off = home('run-no-packs');
  const a = runCli(off, 'run');
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.deepEqual(lastRun(off).cost, { decodes: 2, decodes_usd: 0.025, packs: 0, packs_usd: 0, total_usd: 0.025 });
  const d1 = fs.readFileSync(path.join(off.data, 'digests', `${DAY}.md`), 'utf8');
  assert.equal(d1.match(/Cost of this run/g).length, 1, 'packs off: the decoder\'s line is the whole line');

  const on = home('run-packs', { pack: true });
  const b = runCli(on, 'run');
  assert.equal(b.status, 0, b.stdout + b.stderr);   // long-shot verdicts: no picks, so the pack step builds nothing
  const d2 = fs.readFileSync(path.join(on.data, 'digests', `${DAY}.md`), 'utf8');
  assert.match(d2, /Cost so far: decodes 2 \(USD 0\.03\)\. Packs are built next; the run total is added to this digest in data\/digests\./);
  assert.match(d2, /\nCost of this run: decodes 2 \(USD 0\.03\), packs 0 \(USD 0\.00\), total USD 0\.03\.\n$/, 'the run adds the full line at the end');
  assert.deepEqual(lastRun(on).cost, { decodes: 2, decodes_usd: 0.025, packs: 0, packs_usd: 0, total_usd: 0.025 });
});

test('run cost counts the packs built or refused since the pack step started; no line when nothing reported a cost', () => {
  const before = queueSnapshot();
  fs.mkdirSync(path.join(unit.data, 'decoded'), { recursive: true });
  fs.writeFileSync(path.join(unit.data, 'decoded', `${DAY}--cedar--pm.md`), `---\ncompany: "Cedar"\n---\n\n## Decode Result\nDecoded ${DAY} by CometScout (claude/sonnet).\nverdict: strong-fit\ncost_usd: 0.0200\n`);
  fs.writeFileSync(path.join(unit.data, 'state', 'packs.json'), JSON.stringify({
    old: { built: '2026-10-05', dir: 'x', at: '2026-10-05T18:00:00.000Z', cost_usd: 9 },
    built: { built: DAY, dir: 'y', at: `${DAY}T18:10:00.000Z`, cost_usd: 0.4 },
    refused: { refused: ['big-team'], date: DAY, at: `${DAY}T18:11:00.000Z`, cost_usd: 0.35 },
    legacy: { built: DAY, dir: 'z' },
  }));
  const c = runCost(before, `${DAY}T18:05:00.000Z`);
  assert.deepEqual(c, { decodes: 1, decodes_usd: 0.02, packs: 2, packs_usd: 0.75, total_usd: 0.77 });
  assert.equal(costLine(c), 'Cost of this run: decodes 1 (USD 0.02), packs 2 (USD 0.75), total USD 0.77.');
  assert.equal(costLine({ decodes: 3, decodes_usd: 0, packs: 0 }), null, 'Codex reports no cost: no line');
  assert.match(costLine({ decodes: 3, decodes_usd: 0.1, packs: null }), /^Cost so far: decodes 3 \(USD 0\.10\)\./);
});

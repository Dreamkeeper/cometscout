// Pack eval: a blind A/B judge for application packs built for the same jobs by two systems (two prompts, two models,
// or another pipeline's packs copied into the same layout).
//   node cli.mjs evals pack --a <dir> --b <dir> [--judge-model <model>] [--seed N]
// Packs pair by folder name without the date. For each pair the judge sees the job, the user's profile and the two
// packs as "first" and "second" in a random order, then again with the order swapped; a pair counts only when both
// orders pick the same pack (or both say tie), else it is inconsistent. A pack whose CV, cover letter or answers
// break a banned lint rule (lib/lint.mjs) loses without a judge call; when both break one, the judge still decides.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, PROFILE, SETTINGS, today } from '../lib/config.mjs';
import { callJson } from '../lib/llm.mjs';
import { profileRules } from '../lib/lint.mjs';
import { listPacks, readPack, lintPack, packJob, packText } from './packs.mjs';
import { rng } from './stats.mjs';

export const JUDGE_SCHEMA = { type: 'object', required: ['winner', 'reason'], properties: {
  winner: { type: 'string', enum: ['first', 'second', 'tie'] }, reason: { type: 'string', maxLength: 600 } } };

export function judgePrompt({ profile, job, first, second }) {
  return ['You judge two application packs (a tailored CV, maybe a cover letter, and form answers) written for the same job and the same candidate.',
    'Pick the one that gives this candidate the better chance with this employer: relevant evidence first, accurate to the profile (no claim the profile does not support), specific, plain and readable.',
    'Length, formatting and the order you see them in do not count. Answer "tie" when neither is clearly better. Give one or two sentences as the reason.',
    '', '## Candidate profile', profile || '(no profile)', '', '## Job', job || '(no job text found: judge on the profile alone)', '',
    '## First pack', first, '', '## Second pack', second].join('\n');
}

/**
 * Judge one pair twice. aFirst: whether A is shown first in the first call. Returns { outcome: "a" | "b" | "tie" |
 * "inconsistent", calls: [{ order, winner, reason }] }; a malformed answer throws.
 */
export async function judgePair({ a, b, profile, job, aFirst, call = callJson, model }) {
  const calls = [];
  for (const swap of [false, true]) {
    const aIsFirst = swap ? !aFirst : aFirst;
    const [first, second] = aIsFirst ? [a, b] : [b, a];
    const { value } = await call({ prompt: judgePrompt({ profile, job, first: packText(first), second: packText(second) }), schema: JUDGE_SCHEMA, model });
    if (!['first', 'second', 'tie'].includes(value?.winner)) throw new Error(`the judge answered no winner (${JSON.stringify(value).slice(0, 120)})`);
    const side = value.winner === 'tie' ? 'tie' : (value.winner === 'first') === aIsFirst ? 'a' : 'b';
    calls.push({ order: aIsFirst ? 'A first' : 'B first', winner: side, reason: String(value.reason || '') });
  }
  return { outcome: calls[0].winner === calls[1].winner ? calls[0].winner : 'inconsistent', calls };
}

/** The whole eval. Returns the report object; writes data/evals/pack-report-<date>.md and .json unless write is false. */
export async function packEval({ a, b, judgeModel = null, seed = 1, call = callJson, date = today(), write = true, log = () => {} }) {
  const A = listPacks(a), B = listPacks(b), bByKey = new Map(B.map(p => [p.key, p]));
  const pairs = A.filter(p => bByKey.has(p.key)).map(p => ({ key: p.key, a: p, b: bByKey.get(p.key) }));
  if (!pairs.length) throw new Error(`no pack in ${a} has a partner in ${b} (packs pair by folder name without the date)`);
  const rules = profileRules(), rand = rng(seed), model = judgeModel || SETTINGS.llm.pack_model || SETTINGS.llm.model;
  const counts = { a: 0, b: 0, tie: 0, inconsistent: 0, lint_a: 0, lint_b: 0, error: 0 }, rows = [];
  for (const p of pairs) {
    const pa = readPack(p.a.dir), pb = readPack(p.b.dir), la = lintPack(pa, rules), lb = lintPack(pb, rules);
    const job = packJob(p.a.name) || packJob(p.b.name);
    const row = { key: p.key, title: pa.title, job: job?.file || null, a: p.a.name, b: p.b.name, lint: { a: la.errors, b: lb.errors }, outcome: null, by: 'judge', calls: [] };
    const aFirst = rand() < 0.5;   // drawn for every pair, so a lint loser does not shift the order of the others
    if (la.errors.length && !lb.errors.length) { row.outcome = 'b'; row.by = 'lint'; counts.lint_a++; }
    else if (lb.errors.length && !la.errors.length) { row.outcome = 'a'; row.by = 'lint'; counts.lint_b++; }
    else {
      try { const r = await judgePair({ a: pa, b: pb, profile: PROFILE.facts, job: job?.text || '', aFirst, call, model }); row.outcome = r.outcome; row.calls = r.calls; }
      catch (e) { row.outcome = 'error'; row.error = e.message; }
    }
    counts[row.outcome]++;   // a lint loss counts as the other side's win too
    rows.push(row); log(`${p.key}: ${row.outcome}${row.by === 'lint' ? ' (lint)' : ''}`);
  }
  const report = { date, a, b, model, seed, pairs: rows.length, unpaired: { a: A.filter(p => !bByKey.has(p.key)).map(p => p.name), b: B.filter(p => !A.some(x => x.key === p.key)).map(p => p.name) }, counts, rows };
  if (write) {
    const base = path.join(DATA, 'evals', `pack-report-${date}`); fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(`${base}.md`, packReportMd(report), 'utf8'); fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 1) + '\n', 'utf8');
    Object.assign(report, { md: `${base}.md`, json: `${base}.json` });
  }
  return report;
}

const cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
export function packReportMd(r) {
  const c = r.counts, name = o => ({ a: 'A', b: 'B', tie: 'tie', inconsistent: 'inconsistent', error: 'error' }[o] || o);
  const lintRows = r.rows.filter(x => x.lint.a.length || x.lint.b.length);
  return [`# Pack eval: A against B`, '', `${r.date}. A: ${r.a}. B: ${r.b}. Judge model: ${r.model || 'default'}; seed ${r.seed}. ${r.pairs} pairs.`,
    'Each pair was judged twice with the order swapped; a pair counts only when both orders agree.', '',
    `| | Pairs |`, `|---|---|`, `| A wins | ${c.a} |`, `| B wins | ${c.b} |`, `| Ties | ${c.tie} |`, `| Inconsistent (the order decided) | ${c.inconsistent} |`, `| Errors | ${c.error} |`, '',
    `Of the wins, by lint: A lost ${c.lint_a}, B lost ${c.lint_b} (a pack that breaks a banned lint rule loses).`, '',
    '## Pairs', '', '| Job | Result | Reasons |', '|---|---|---|',
    ...r.rows.map(x => `| ${cell(x.title)} | ${name(x.outcome)}${x.by === 'lint' ? ' (lint)' : ''} | ${cell(x.error || x.calls.map(k => `${k.order}: ${name(k.winner)}, ${k.reason}`).join(' / ') || (x.by === 'lint' ? 'the other pack breaks a banned lint rule' : ''))} |`), '',
    '## Lint failures', '', lintRows.length ? lintRows.flatMap(x => [...x.lint.a.map(h => `- A, ${cell(x.title)}: ${h.id} in ${h.where} ("${cell(h.match)}")`), ...x.lint.b.map(h => `- B, ${cell(x.title)}: ${h.id} in ${h.where} ("${cell(h.match)}")`)]).join('\n') : 'None.', '',
    ...(r.unpaired.a.length || r.unpaired.b.length ? ['## Without a partner', '', ...r.unpaired.a.map(n => `- A only: ${n}`), ...r.unpaired.b.map(n => `- B only: ${n}`), ''] : [])].join('\n');
}

// node cli.mjs evals <sample|decode|pack|voice|sets>: argument parsing and printing for the evals in this folder.
// Evals never touch the queue, picks or applications: they read them and write under data/evals only.
import path from 'node:path';
import { createSet, listSets, STRATA } from './sets.mjs';

export const USAGE = [
  'Usage:',
  '  node cli.mjs evals sample --set <name> [--size 70] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--seed N] [--include <queue file>]...',
  '  node cli.mjs evals sets                  # every label set and how far its labelling got',
  '  node cli.mjs evals decode --set <name> [--system queue|replay|file:<path>] [--compare <system>] [--no-context]',
  '  node cli.mjs evals pack --a <dir> --b <dir> [--judge-model <model>] [--seed N]',
  '  node cli.mjs evals voice --dir <packs> [--judge-model <model>]',
  'Label a set in the workspace: node cli.mjs serve, then open /label?set=<name>.',
].join('\n');

/** --name value; '' when the flag is last or followed by another flag; undefined when absent. */
const opt = (rest, n) => { const i = rest.indexOf(`--${n}`); if (i < 0) return undefined; const v = rest[i + 1]; return v === undefined || v.startsWith('--') ? '' : v; };
const multi = (rest, n) => rest.flatMap((a, i) => (a === `--${n}` && rest[i + 1] && !rest[i + 1].startsWith('--') ? [rest[i + 1]] : []));
const need = (rest, n) => { const v = opt(rest, n); if (!v) throw new Error(`--${n} is required${v === '' ? ' and needs a value' : ''}`); return v; };

/** Run one evals subcommand; returns the exit code. deps.call replaces the model (tests). */
export async function evalsCommand(rest, { print = console.log, call } = {}) {
  const [sub, ...args] = rest;
  try {
    if (sub === 'sample') {
      const set = need(args, 'set');
      const r = createSet(set, { size: opt(args, 'size') ?? 70, from: opt(args, 'from') || null, to: opt(args, 'to') || null, seed: opt(args, 'seed') ?? 1, include: multi(args, 'include') });
      print(`evals: set "${set}": ${r.count} jobs sampled from ${r.available} (${STRATA.filter(s => r.strata[s]).map(s => `${s} ${r.strata[s]}`).join(', ')})`);
      print(`Label it in one focused sitting: node cli.mjs serve, then open /label?set=${encodeURIComponent(set)}. Written to ${r.file}`);
      return 0;
    }
    if (sub === 'sets') {
      const sets = listSets();
      if (!sets.length) print('evals: no label sets yet (node cli.mjs evals sample --set <name>)');
      for (const s of sets) print(`${s.name}: ${s.labelled} of ${s.total} labelled`);
      return 0;
    }
    if (sub === 'decode') {
      const { decodeEval } = await import('./decode.mjs');
      const set = need(args, 'set'), system = opt(args, 'system') || 'queue', compare = opt(args, 'compare');
      if (compare === '') throw new Error('--compare needs a system: queue, replay or file:<path>');
      const r = await decodeEval({ set, system, compare: compare || null, call, log: l => print(`  ${l}`), noContext: args.includes('--no-context') });
      const line = (name, e) => `${name}: precision ${e.precision.value == null ? 'n/a' : e.precision.value.toFixed(2)} (${e.precision.num} of ${e.precision.den}), recall ${e.recall.value == null ? 'n/a' : e.recall.value.toFixed(2)} (${e.recall.num} of ${e.recall.den}); ${e.missed.length} missed, ${e.noise.length} noise, ${e.unsure} unsure, ${e.unlabelled} not labelled`;
      print(line(system, r.report.result));
      if (r.report.compare) { const p = r.report.compare.paired; print(line(compare, r.report.other_result)); print(`paired: ${p.a_only} only ${system} right, ${p.b_only} only ${compare} right, McNemar p = ${r.report.compare.mcnemar_p.toFixed(4)}`); }
      print(`report: ${r.md}`);
      return 0;
    }
    if (sub === 'pack') {
      const { packEval } = await import('./pack.mjs');
      const seed = Number(opt(args, 'seed') ?? 1); if (!Number.isInteger(seed)) throw new Error('--seed must be a whole number');
      const r = await packEval({ a: path.resolve(need(args, 'a')), b: path.resolve(need(args, 'b')), judgeModel: opt(args, 'judge-model') || null, seed, call, log: l => print(`  ${l}`) });
      const c = r.counts;
      print(`pack eval: ${r.pairs} pairs; A ${c.a}, B ${c.b}, tie ${c.tie}, inconsistent ${c.inconsistent}${c.error ? `, errors ${c.error}` : ''} (lint losses: A ${c.lint_a}, B ${c.lint_b})`);
      print(`report: ${r.md}`);
      return 0;
    }
    if (sub === 'voice') {
      const { voiceEval } = await import('./voice.mjs');
      const r = await voiceEval({ dir: path.resolve(need(args, 'dir')), judgeModel: opt(args, 'judge-model') || null, call, log: l => print(`  ${l}`) });
      print(`voice eval: ${r.scored} texts, mean ${r.mean == null ? 'n/a' : r.mean.toFixed(2)} of 5${r.errors ? `, ${r.errors} errors` : ''}`);
      print(`report: ${r.md}`);
      return 0;
    }
    print(USAGE); return sub && !['help', '--help'].includes(sub) ? 1 : 0;
  } catch (e) { print(`evals ${sub}: ${e.message}`); return 1; }
}

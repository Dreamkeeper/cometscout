// Decode eval: a system's verdicts on a label set against the user's labels.
//   node cli.mjs evals decode --set <name> [--system queue|replay|file:<path>] [--compare <system>]
// Systems: queue (the verdicts already in the queue files), replay (the sampled jobs decoded again now with the current
// decoder and prompt, history cut at each job's own date; written to replay-<date>.json, nothing else), file:<path>
// ({ file: verdict } or { file: { verdict, gate?, fact_flags? } } from any other pipeline; a replay file works too).
// "Surfaced" means strong-fit or investable-stretch. Unsure labels stay out of the rates and are counted.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, read, today } from '../lib/config.mjs';
import { frontMatter, parseResult } from '../lib/queue.mjs';
import { queueEntry } from '../lib/applications.mjs';
import { APPLY_WORTHY } from '../decoder/digest.mjs';
import { readSample, readLabels, setDir, jobText, jobDate } from './sets.mjs';
import { rate, rateText, mcnemarExact } from './stats.mjs';

export const surfaced = v => APPLY_WORTHY.includes(v);
const one = v => (v == null ? null : typeof v === 'string' ? { verdict: v } : typeof v === 'object' && typeof v.verdict === 'string' ? v : null);
/** A short name for a system spec in file names and reports: queue, replay, file-<base name>. */
export const systemName = spec => (spec.startsWith('file:') ? `file-${path.basename(spec.slice(5)).replace(/\.json$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-')}` : spec);

/** The queue's verdicts for the sampled files: { file: { verdict, gate, fact_flags } | null } (null: the file is gone). */
export function queueVerdicts(sample) {
  const out = {};
  for (const { file } of sample.jobs) {
    const q = queueEntry(file, ['decoded', 'rejected']);
    if (!q) { out[file] = null; continue; }
    const v = parseResult(read(path.join(DIRS[q.dir], file)));
    out[file] = v.verdict ? { verdict: v.verdict, gate: v.gate || null, fact_flags: v.fact_flag_ids } : null;
  }
  return out;
}
/** file:<path>: { file: verdict | { verdict, ... } }. */
export function fileVerdicts(p, sample) {
  if (!fs.existsSync(p)) throw new Error(`${p} not found`);
  let j; try { j = JSON.parse(read(p)); } catch (e) { throw new Error(`${p} is not valid JSON (${e.message})`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${p} must be a JSON object { "<queue file>": "<verdict>" }`);
  return Object.fromEntries(sample.jobs.map(({ file }) => [file, one(j[file])]));
}
/**
 * replay: every sampled job decoded again now (dry run) with its history cut at its own date, so no later outcome or
 * decode reaches the prompt. The results go to data/evals/<set>/replay-<date>.json only.
 */
export async function replayVerdicts(sample, { set, call, date = today(), log = () => {} } = {}) {
  const { decodeText, buildPrompt, contextBlock } = await import('../decoder/decoder.mjs');
  const prompt = buildPrompt() + contextBlock(), out = {};
  for (const { file, text } of sample.jobs) {
    const t = jobText(text), fm = frontMatter(t);
    const job = { file, fm, text: t, body: t.replace(/^---\n[\s\S]*?\n---\n?/, '').trim() };
    try {
      const v = await decodeText(job, prompt, { before: jobDate(file, fm) || null, excludeFile: file, ...(call ? { call } : {}) });
      out[file] = { verdict: v.verdict, gate: v.gate || null, confidence: v.confidence || null, fact_flags: (v.fact_flags || []).map(f => f.id) };
      log(`${file}: ${v.verdict}`);
    } catch (e) { out[file] = { verdict: null, error: e.message }; log(`${file}: FAILED ${e.message}`); }
  }
  if (set) fs.writeFileSync(path.join(setDir(set), `replay-${date}.json`), JSON.stringify(out, null, 1) + '\n', 'utf8');
  return out;
}
/** Verdicts for a system spec: queue, replay or file:<path>. */
export async function systemVerdicts(spec, sample, opts = {}) {
  if (spec === 'queue') return queueVerdicts(sample);
  if (spec === 'replay') return replayVerdicts(sample, opts);
  if (spec.startsWith('file:') && spec.length > 5) return fileVerdicts(path.resolve(spec.slice(5)), sample);
  throw new Error(`unknown system "${spec}" (use queue, replay or file:<path>)`);
}

/**
 * One system against the labels. Returns { confusion: { tp, fp, fn, tn }, precision, recall, judged, unsure,
 * unlabelled, no_verdict, missed, noise, gate, by_verdict, fact_flags }. Missed: labelled yes, not surfaced. Noise:
 * labelled no, surfaced. Gate: gate rejects the user labelled yes.
 */
export function evaluate(sample, labels, verdicts) {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 }, missed = [], noise = [], gateYes = [], noVerdict = [], byVerdict = {}, flags = {};
  let unsure = 0, unlabelled = 0, gates = 0;
  for (const { file } of sample.jobs) {
    const l = labels.get(file), v = one(verdicts[file]);
    for (const id of v?.fact_flags || []) flags[id] = (flags[id] || 0) + 1;
    if (!l) { unlabelled++; continue; }
    if (v?.verdict) { const b = byVerdict[v.verdict] ||= { yes: 0, no: 0, unsure: 0 }; b[l.surface]++; }
    if (l.surface === 'unsure') { unsure++; continue; }
    if (!v?.verdict) { noVerdict.push({ file, label: l.surface, reason: l.reason || '' }); continue; }
    const s = surfaced(v.verdict), yes = l.surface === 'yes';
    const row = { file, verdict: v.verdict, gate: v.gate || null, reason: l.reason || '', failure_mode: l.failure_mode || null };
    if (v.verdict === 'gate-reject') { gates++; if (yes) gateYes.push(row); }
    if (yes && s) c.tp++; else if (yes) { c.fn++; missed.push(row); } else if (s) { c.fp++; noise.push(row); } else c.tn++;
  }
  return { confusion: c, precision: rate(c.tp, c.tp + c.fp), recall: rate(c.tp, c.tp + c.fn), judged: c.tp + c.fp + c.fn + c.tn, unsure, unlabelled,
    no_verdict: noVerdict, missed, noise, gate: { judged: gates, labelled_yes: gateYes }, by_verdict: byVerdict, fact_flags: flags };
}

/**
 * Two systems on the same jobs (labelled yes or no, a verdict from both). A system is right when it surfaced a yes
 * or held back a no. paired: both right, only A right, only B right, both wrong; p is the exact McNemar p-value on
 * the two discordant counts. disagreements: the jobs where they differ and which one the label agreed with.
 */
export function compareSystems(sample, labels, A, B) {
  const paired = { both_right: 0, a_only: 0, b_only: 0, both_wrong: 0 }, disagreements = [];
  for (const { file } of sample.jobs) {
    const l = labels.get(file), a = one(A[file]), b = one(B[file]);
    if (!l || l.surface === 'unsure' || !a?.verdict || !b?.verdict) continue;
    const yes = l.surface === 'yes', ra = surfaced(a.verdict) === yes, rb = surfaced(b.verdict) === yes;
    paired[ra && rb ? 'both_right' : ra ? 'a_only' : rb ? 'b_only' : 'both_wrong']++;
    if (ra !== rb) disagreements.push({ file, label: l.surface, a: a.verdict, b: b.verdict, agreed: ra ? 'a' : 'b', reason: l.reason || '' });
  }
  return { paired, n: Object.values(paired).reduce((x, y) => x + y, 0), disagreements, mcnemar_p: mcnemarExact(paired.a_only, paired.b_only) };
}

// ---------- the report ----------
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(x => String(x ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n');
const listRows = rows => (rows.length ? table(['Job', 'Verdict', 'Your reason'], rows.map(r => [r.file, `${r.verdict}${r.gate ? ` (${r.gate})` : ''}`, `${r.reason || ''}${r.failure_mode ? ` [${r.failure_mode}]` : ''}`])) : 'None.');
function systemSection(name, e) {
  const c = e.confusion;
  return [`## ${name}`, '',
    table(['', 'Labelled yes', 'Labelled no'], [['Surfaced', c.tp, c.fp], ['Not surfaced', c.fn, c.tn]]), '',
    `- Surfaced precision: ${rateText(e.precision)}`, `- Surfaced recall: ${rateText(e.recall)}`,
    `- Judged: ${e.judged}; unsure (left out of the rates): ${e.unsure}; not labelled yet: ${e.unlabelled}; no verdict from this system: ${e.no_verdict.length}`,
    `- Gate rejects judged: ${e.gate.judged}; labelled yes: ${e.gate.labelled_yes.length}`, '',
    `### Missed good roles (labelled yes, not surfaced): ${e.missed.length}`, '', listRows(e.missed), '',
    `### Noise (labelled no, surfaced): ${e.noise.length}`, '', listRows(e.noise), '',
    `### Gate rejects you labelled yes: ${e.gate.labelled_yes.length}`, '', listRows(e.gate.labelled_yes), '',
    '### Labels by verdict', '', Object.keys(e.by_verdict).length ? table(['Verdict', 'Yes', 'No', 'Unsure'], Object.entries(e.by_verdict).sort().map(([v, b]) => [v, b.yes, b.no, b.unsure])) : 'None.', '',
    '### Fact flags', '', Object.keys(e.fact_flags).length ? table(['Rule', 'Jobs'], Object.entries(e.fact_flags).sort((x, y) => y[1] - x[1]).map(([k, n]) => [k, n])) : 'None.', ''].join('\n');
}
export function reportMd(r) {
  const out = [`# Decode eval: ${r.set}`, '', `${r.date}. ${r.total} sampled jobs, ${r.labelled} labelled (${r.label_lines} label lines${r.bad_lines ? `, ${r.bad_lines} unreadable` : ''}).`,
    'Surfaced means strong-fit or investable-stretch. The sample is stratified by verdict, so these rates describe the sample, not your whole queue.',
    'Do not tune the prompt on the labels you report on: keep a second, held-out set for the numbers you quote.', '', systemSection(`System: ${r.system}`, r.result)];
  if (r.compare) {
    const p = r.compare.paired;
    out.push(systemSection(`System: ${r.other}`, r.other_result), `## ${r.system} against ${r.other}`, '',
      `On ${r.compare.n} jobs labelled yes or no with a verdict from both:`, '',
      table(['', `${r.other} right`, `${r.other} wrong`], [[`${r.system} right`, p.both_right, p.a_only], [`${r.system} wrong`, p.b_only, p.both_wrong]]), '',
      `- Exact McNemar p-value: ${r.compare.mcnemar_p.toFixed(4)} (${p.a_only} vs ${p.b_only} discordant)`, '',
      `### Where they disagree: ${r.compare.disagreements.length}`, '',
      r.compare.disagreements.length ? table(['Job', 'Label', r.system, r.other, 'Label agreed with', 'Your reason'], r.compare.disagreements.map(d => [d.file, d.label, d.a, d.b, d.agreed === 'a' ? r.system : r.other, d.reason])) : 'None.', '');
  }
  return out.join('\n');
}

/** The whole eval: reads the set, gets the verdicts, writes report-<date>-<system>[-vs-<other>].md and .json. */
export async function decodeEval({ set, system = 'queue', compare = null, call, date = today(), log = () => {} }) {
  const sample = readSample(set); if (!sample) throw new Error(`no set "${set}" (make one with node cli.mjs evals sample --set ${set})`);
  const labels = readLabels(set);
  if (compare && compare === system) throw new Error('--compare names the same system as --system');
  const A = await systemVerdicts(system, sample, { set, call, date, log });
  const B = compare ? await systemVerdicts(compare, sample, { set, call, date, log }) : null;
  const r = { set, date, system, other: compare, total: sample.jobs.length, labelled: labels.latest.size, label_lines: labels.lines, bad_lines: labels.bad,
    result: evaluate(sample, labels.latest, A), ...(B ? { other_result: evaluate(sample, labels.latest, B), compare: compareSystems(sample, labels.latest, A, B) } : {}) };
  const base = path.join(setDir(set), `report-${date}-${systemName(system)}${compare ? `-vs-${systemName(compare)}` : ''}`);
  fs.writeFileSync(`${base}.md`, reportMd(r), 'utf8');
  fs.writeFileSync(`${base}.json`, JSON.stringify(r, null, 1) + '\n', 'utf8');
  return { report: r, md: `${base}.md`, json: `${base}.json` };
}

// The run log (data/state/runs.jsonl): one line per evening run, written by cli.mjs run at its end, so the MCP server
// can say when the last run was, how it went and what it found without reading the journal. The newest 60 are kept.
// A line: { date, started, finished, seconds, exit, off_day, sources: [{ source, exit }], decoder_exit, pack_exit,
//   refused: [{ file, company, role, rules }], counts: { new_jobs, decoded, worth_applying, picks },
//   cost: { decodes, decodes_usd, packs, packs_usd, total_usd }, result }
// result says how the run ended: "finished" (with the failed sources and refused packs), "skipped: ..." (no profile/
// yet) or "stopped: ..." (a broken applications.json); a run that stopped early has counts null and no sources.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, STATE, read, readJson } from './config.mjs';
import { parseResult } from './queue.mjs';
import { APPLY_WORTHY } from '../decoder/digest.mjs';

export const RUNS_FILE = () => STATE('runs.jsonl');
const KEEP = 60;
const QUEUE = ['inbox', 'decoded', 'rejected'];
const mdFiles = dir => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; } };

/** The queue files before a run: { inbox: Set, decoded: Set, rejected: Set }. */
export const queueSnapshot = () => Object.fromEntries(QUEUE.map(d => [d, new Set(mdFiles(DIRS[d]))]));

/** What a run added, against the snapshot taken before it: new jobs, decodes, apply-worthy decodes, picks recorded for `date`. */
export function runCounts(before, date) {
  const was = new Set(QUEUE.flatMap(d => [...(before?.[d] || [])]));
  const wasDecoded = new Set([...(before?.decoded || []), ...(before?.rejected || [])]);
  const now = Object.fromEntries(QUEUE.map(d => [d, mdFiles(DIRS[d])]));
  const decodedNow = ['decoded', 'rejected'].flatMap(d => now[d].map(f => [d, f])).filter(([, f]) => !wasDecoded.has(f));
  const worth = decodedNow.filter(([d, f]) => d === 'decoded' && APPLY_WORTHY.includes(parseResult(read(path.join(DIRS[d], f))).verdict)).length;
  const picks = Object.values(readJson(STATE('picks.json'), {}) || {}).filter(p => p?.last === date).length;
  return { new_jobs: QUEUE.flatMap(d => now[d]).filter(f => !was.has(f)).length, decoded: decodedNow.length, worth_applying: worth, picks };
}

const money = n => Math.round(n * 1e4) / 1e4;
/**
 * What a run's model calls cost, in USD as the model CLI reports it (Codex reports none, so 0): the decodes it made
 * with a verdict (cost_usd in each new decode block; a job given up on is left out) and the packs built or refused
 * since packStart (cost_usd in packs.json).
 * { decodes, decodes_usd, packs, packs_usd, total_usd }
 */
export function runCost(before, packStart) {
  const wasDecoded = new Set([...(before?.decoded || []), ...(before?.rejected || [])]);
  // a job the decoder gave up on (verdict failed) is no decode: the digest's own line does not count it either
  const decodes = ['decoded', 'rejected'].flatMap(d => mdFiles(DIRS[d]).filter(f => !wasDecoded.has(f)).map(f => parseResult(read(path.join(DIRS[d], f))))
    .filter(v => v.verdict && v.verdict !== 'failed').map(v => v.cost_usd || 0));
  const packs = packStart ? Object.values(readJson(STATE('packs.json'), {}) || {}).filter(p => p && String(p.at || '') >= packStart).map(p => Number(p.cost_usd) > 0 ? Number(p.cost_usd) : 0) : [];
  const sum = list => money(list.reduce((s, x) => s + x, 0));
  return { decodes: decodes.length, decodes_usd: sum(decodes), packs: packs.length, packs_usd: sum(packs), total_usd: money(sum(decodes) + sum(packs)) };
}

/** Append one run, keeping the newest KEEP lines. */
export function recordRun(entry, file = RUNS_FILE()) {
  const lines = read(file).split('\n').filter(Boolean).slice(-(KEEP - 1));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, [...lines, JSON.stringify(entry)].join('\n') + '\n');
  fs.renameSync(tmp, file);
}

/** The newest n runs, newest first. A line that is not JSON is skipped. */
export function lastRuns(n = 1, file = RUNS_FILE()) {
  const out = [];
  for (const l of read(file).split('\n').filter(Boolean).reverse()) {
    try { const r = JSON.parse(l); if (r && typeof r === 'object') out.push(r); } catch { /* a torn line */ }
    if (out.length >= n) break;
  }
  return out;
}

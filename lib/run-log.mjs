// The run log (data/state/runs.jsonl): one line per evening run, written by cli.mjs run at its end, so the MCP server
// can say when the last run was, how it went and what it found without reading the journal. The newest 60 are kept.
// A line: { date, started, finished, seconds, exit, off_day, sources: [{ source, exit }], decoder_exit, pack_exit,
//   refused: [{ file, company, role, rules }], counts: { new_jobs, decoded, worth_applying, picks } }
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

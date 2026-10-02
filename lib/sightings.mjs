// Sightings: one line per writeJob call in data/state/sightings.jsonl, duplicates included, so the source scorecard
// can tell a job only one source found from one that two sources found.
//   { date, source, company, role, url, result: "written" | "duplicate", where }
// writeJob only appends. Lines older than KEEP_DAYS are dropped by cli.mjs run, once, before any source starts, so the
// rewrite never races with a writer.
import fs from 'node:fs';
import { STATE, read, today, log } from './config.mjs';

export const KEEP_DAYS = 120;
export const SIGHTINGS_FILE = () => STATE('sightings.jsonl');
const minus = (date, days) => new Date(Date.parse(date) - days * 864e5).toISOString().slice(0, 10);

/** Every sighting, oldest first; broken lines are skipped. */
export function readSightings(file = SIGHTINGS_FILE()) {
  const out = [];
  for (const l of read(file).split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* a half-written line */ } }
  return out;
}

/** Drop lines older than KEEP_DAYS. Only cli.mjs run calls it, before the sources start. Returns the lines dropped. */
export function trimSightings({ date = today() } = {}) {
  const file = SIGHTINGS_FILE();
  if (!fs.existsSync(file)) return 0;
  const cutoff = minus(date, KEEP_DAYS), all = readSightings(file), keep = all.filter(s => String(s.date || '') >= cutoff);
  if (keep.length === all.length) return 0;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, keep.map(s => JSON.stringify(s)).join('\n') + (keep.length ? '\n' : ''), 'utf8'); fs.renameSync(tmp, file);
  return all.length - keep.length;
}

/** Append one sighting. Never throws: a report must not stop a source. */
export function recordSighting(job, result, where) {
  try {
    const s = { date: today(), source: job.source || null, company: job.company || null, role: job.role || null, url: job.url || null, result, where: where || null };
    fs.appendFileSync(SIGHTINGS_FILE(), JSON.stringify(s) + '\n', 'utf8');
  } catch (e) { log(`sightings: could not record (${e.message})`); }
}

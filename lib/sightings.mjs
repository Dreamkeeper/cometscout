// Sightings: one line per writeJob call in data/state/sightings.jsonl, duplicates included, so the source scorecard
// can tell a job only one source found from one that two sources found.
//   { date, source, company, role, url, result: "written" | "duplicate", where }
// Lines older than KEEP_DAYS are dropped, at most once a day (data/state/sightings-trim.json remembers the day).
import fs from 'node:fs';
import { STATE, read, readJson, today, log } from './config.mjs';

export const KEEP_DAYS = 120;
export const SIGHTINGS_FILE = () => STATE('sightings.jsonl');
const TRIM_FILE = () => STATE('sightings-trim.json');
const minus = (date, days) => new Date(Date.parse(date) - days * 864e5).toISOString().slice(0, 10);

/** Every sighting, oldest first; broken lines are skipped. */
export function readSightings(file = SIGHTINGS_FILE()) {
  const out = [];
  for (const l of read(file).split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* a half-written line */ } }
  return out;
}

/** Drop lines older than KEEP_DAYS; runs once a day unless force. */
export function trimSightings({ date = today(), force = false } = {}) {
  const file = SIGHTINGS_FILE();
  if (!force && readJson(TRIM_FILE(), {}).date === date) return false;
  const cutoff = minus(date, KEEP_DAYS);
  if (fs.existsSync(file)) {
    const keep = readSightings(file).filter(s => String(s.date || '') >= cutoff);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keep.map(s => JSON.stringify(s)).join('\n') + (keep.length ? '\n' : ''), 'utf8'); fs.renameSync(tmp, file);
  }
  fs.writeFileSync(TRIM_FILE(), JSON.stringify({ date }));
  return true;
}

/** Append one sighting. Never throws: a report must not stop a source. */
export function recordSighting(job, result, where) {
  try {
    trimSightings();
    const s = { date: today(), source: job.source || null, company: job.company || null, role: job.role || null, url: job.url || null, result, where: where || null };
    fs.appendFileSync(SIGHTINGS_FILE(), JSON.stringify(s) + '\n', 'utf8');
  } catch (e) { log(`sightings: could not record (${e.message})`); }
}

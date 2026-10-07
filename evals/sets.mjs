// Label sets: data/evals/<set>/sample.json (the sampled jobs' text, frozen when sampled) and labels.jsonl (one line
// per label; a changed label appends a new line and the latest line per file wins, so a crash never loses earlier
// labels and two files can be merged by concatenation). The verdict is never stored in the sample: evals read it from
// the queue at eval time, and the labelling screen (lib/workspace.mjs) never serves it.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, DIRS, PROFILE, SETTINGS, read, today } from '../lib/config.mjs';
import { frontMatter, parseResult } from '../lib/queue.mjs';
import { rng, shuffle } from './stats.mjs';

export const EVALS_DIR = () => path.join(DATA, 'evals');
export const SURFACES = ['yes', 'no', 'unsure'];
// The main reason behind a label (optional), the same ids as the workspace's skip reasons where they overlap.
export const FAILURE_MODES = ['too_senior', 'too_junior', 'wrong_domain', 'location', 'language', 'company', 'missing_info', 'other'];
export const REASON_MAX = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A set name: letters, digits, dot, dash and underscore, starting with a letter or digit (it is a folder name). */
export const validSetName = n => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n) && !n.includes('..');
export function setDir(name) {
  if (!validSetName(name)) throw new Error(`"${name}" is not a valid set name (letters, digits, ".", "-" and "_", up to 64)`);
  return path.join(EVALS_DIR(), name);
}
export const sampleFile = name => path.join(setDir(name), 'sample.json');
export const labelsFile = name => path.join(setDir(name), 'labels.jsonl');

// ---------- strata ----------
// Verdict groups the sample draws from evenly, so rare verdicts (unreadable, held) are represented.
export const STRATA = ['worth', 'held', 'weak', 'gate', 'unreadable', 'other'];
export const stratumOf = v => ({ 'strong-fit': 'worth', 'investable-stretch': 'worth', 'long-shot': 'held', 'weak-fit': 'weak', 'gate-reject': 'gate', unreadable: 'unreadable' }[v] || 'other');
/** The job's text as the decoder saw it: everything before the first "## Decode Result". */
export const jobText = t => { const i = String(t).indexOf('## Decode Result'); return (i >= 0 ? String(t).slice(0, i) : String(t)).trimEnd() + '\n'; };
/** A queue file's date: front matter "found", else the file name's date. */
export const jobDate = (file, fm = {}) => (DATE.test(fm.found || '') ? fm.found : DATE.test(String(file).slice(0, 10)) ? String(file).slice(0, 10) : '');

/** Every decoded and rejected job: [{ file, dir, date, stratum, text }], sorted by file name. */
export function queueJobs() {
  const out = [];
  for (const dir of ['decoded', 'rejected']) for (const f of fs.readdirSync(DIRS[dir]).filter(x => x.endsWith('.md')).sort()) {
    const t = read(path.join(DIRS[dir], f));
    out.push({ file: f, dir, date: jobDate(f, frontMatter(t)), stratum: stratumOf(parseResult(t).verdict), text: jobText(t) });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.dir < b.dir ? -1 : 1));
}

/**
 * A stratified sample: forced files first, then one job from each stratum in turn (each stratum shuffled by the
 * seed) until `size` is reached, then the whole sample shuffled so the order says nothing about the verdict.
 * Same jobs and seed, same sample. Returns { jobs: [{ file, date, text }], strata: { stratum: n }, available }.
 */
export function drawSample(all, { size = 70, from = null, to = null, seed = 1, include = [] } = {}) {
  const rand = rng(seed);
  const inRange = j => (!from || (j.date && j.date >= from)) && (!to || (j.date && j.date <= to));
  const byFile = new Map(all.map(j => [j.file, j]));
  const missing = include.filter(f => !byFile.has(f));
  if (missing.length) throw new Error(`not in data/decoded or data/rejected: ${missing.join(', ')}`);
  const chosen = [...new Set(include)].map(f => byFile.get(f));
  const taken = new Set(chosen.map(j => j.file));
  const pools = Object.fromEntries(STRATA.map(s => [s, shuffle(all.filter(j => j.stratum === s && inRange(j) && !taken.has(j.file)), rand)]));
  const available = chosen.length + Object.values(pools).reduce((n, p) => n + p.length, 0);
  while (chosen.length < size && STRATA.some(s => pools[s].length)) {
    for (const s of STRATA) { if (chosen.length >= size) break; const j = pools[s].shift(); if (j) chosen.push(j); }
  }
  const strata = {}; for (const j of chosen) strata[j.stratum] = (strata[j.stratum] || 0) + 1;
  return { jobs: shuffle(chosen, rand).map(j => ({ file: j.file, date: j.date, text: j.text })), strata, available };
}

/** evals sample: writes data/evals/<set>/sample.json; refuses to overwrite a set (its labels would point nowhere). */
export function createSet(name, opts = {}) {
  const file = sampleFile(name);
  if (fs.existsSync(file)) throw new Error(`set "${name}" exists already (${file}); choose another name`);
  for (const k of ['from', 'to']) if (opts[k] && !DATE.test(opts[k])) throw new Error(`--${k} must be YYYY-MM-DD`);
  const size = Number(opts.size ?? 70), seed = Number(opts.seed ?? 1);
  if (!Number.isInteger(size) || size < 1 || size > 2000) throw new Error('--size must be a whole number from 1 to 2000');
  if (!Number.isInteger(seed)) throw new Error('--seed must be a whole number');
  const s = drawSample(queueJobs(), { ...opts, size, seed, include: opts.include || [] });
  if (!s.jobs.length) throw new Error('no decoded or rejected jobs in that range');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { set: name, created: today(), seed, size, from: opts.from || null, to: opts.to || null, include: opts.include || [], jobs: s.jobs };
  fs.writeFileSync(file, JSON.stringify(body, null, 1) + '\n', 'utf8');
  return { file, count: s.jobs.length, strata: s.strata, available: s.available };
}

/** The sample, or null when the set does not exist. */
export function readSample(name) {
  const f = sampleFile(name); if (!fs.existsSync(f)) return null;
  const s = JSON.parse(read(f)); if (!Array.isArray(s?.jobs)) throw new Error(`${f} has no jobs list`);
  return s;
}
/** Every set under data/evals: [{ name, total, labelled }]. */
export function listSets() {
  const dir = EVALS_DIR(); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => validSetName(n) && fs.existsSync(path.join(dir, n, 'sample.json'))).sort().map(name => {
    let total = 0; try { total = readSample(name).jobs.length; } catch { /* reported when opened */ }
    return { name, total, labelled: readLabels(name).latest.size };
  });
}

// ---------- labels ----------
/** labels.jsonl: { latest: Map(file -> label), lines, bad }. A line that does not parse (a crash mid-write) is skipped and counted. */
export function readLabels(name) {
  const latest = new Map(); let lines = 0, bad = 0;
  for (const l of read(labelsFile(name)).split('\n')) {
    if (!l.trim()) continue; lines++;
    let x; try { x = JSON.parse(l); } catch { bad++; continue; }
    if (!x || typeof x.file !== 'string' || !SURFACES.includes(x.surface)) { bad++; continue; }
    latest.set(x.file, x);
  }
  return { latest, lines, bad };
}
/** Check one label against the set; returns the line to append. Throws an Error with a user-facing message. */
export function labelLine(sample, { file, surface, reason = '', failure_mode = null, labeler = null } = {}) {
  if (typeof file !== 'string' || !sample.jobs.some(j => j.file === file)) throw new Error('that job is not in this set');
  if (!SURFACES.includes(surface)) throw new Error('surface must be yes, no or unsure');
  if (reason != null && typeof reason !== 'string') throw new Error('reason must be text');
  const r = String(reason || '').replace(/\s+/g, ' ').trim();
  if (r.length > REASON_MAX) throw new Error(`reason is longer than ${REASON_MAX} characters`);
  if (surface === 'unsure' && !r) throw new Error('an Unsure label needs a reason: which fact is missing');
  if (failure_mode != null && failure_mode !== '' && !FAILURE_MODES.includes(failure_mode)) throw new Error(`failure_mode must be one of ${FAILURE_MODES.join(', ')}`);
  if (labeler != null && (typeof labeler !== 'string' || labeler.length > 60)) throw new Error('labeler must be text up to 60 characters');
  return { file, surface, reason: r, ...(failure_mode ? { failure_mode } : {}), labeler: labeler || SETTINGS.candidate_name || 'user', labelled_at: new Date().toISOString() };
}
/** Append a label (lib/workspace.mjs POST /api/label). A file whose last line was cut short gets a newline first. */
export function appendLabel(name, input) {
  const sample = readSample(name); if (!sample) throw new Error(`no set "${name}"`);
  const line = labelLine(sample, input), f = labelsFile(name);
  let prefix = '';
  try { const st = fs.statSync(f); if (st.size) { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd); if (b[0] !== 0x0a) prefix = '\n'; } } catch { /* no labels yet */ }
  fs.appendFileSync(f, prefix + JSON.stringify(line) + '\n', 'utf8');
  return line;
}

// ---------- what the labelling screen may show ----------
// Only these front-matter fields reach the screen: no verdict, gate, decoder note or source notes.
const SHOWN = ['company', 'role', 'location', 'salary', 'url'];
/** One sampled job for labelling: { file, company, role, location, salary, url, text } with the heading and front matter removed. */
export function labelJob(entry) {
  const t = jobText(entry.text), fm = frontMatter(t);
  const body = t.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\s*#[^\n]*\n+/, '').trim();
  return { file: entry.file, ...Object.fromEntries(SHOWN.map(k => [k, fm[k] || ''])), text: body };
}
/** profile/eval-rubric.md (the user's own criteria for "worth applying"), or null. */
export const rubric = () => read(path.join(PROFILE.dir, 'eval-rubric.md')).trim() || null;

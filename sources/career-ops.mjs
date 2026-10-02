#!/usr/bin/env node
// Source: career-ops (https://github.com/career-ops-hq/career-ops, MIT), a separate tool that scans company boards
// and keeps a pipeline file. jobpilot only reads its files and never writes into its folder.
// settings.sources.career_ops = { enabled: true, path: "/home/youruser/career-ops", include_evaluated: false, max_per_run: 30,
//   pipeline_file: "data/pipeline.md", scan_history_file: "data/scan-history.tsv" }
// path is the career-ops checkout ("~/" and paths relative to jobpilot's folder work too). The two file names are
// optional; a relative one is relative to path. Formats as career-ops writes them (modes/pipeline.md, scan.mjs):
//   pipeline.md (required). Positional cells, then optional labeled segments on any row shape:
//     - [ ] <url> [| <company> | <title> [| <location> [| <compensation>]]] [| posted: YYYY-MM-DD] [| trust: 60 flag,flag]
//           [| note: text] [| rank: 4.1/5 ...]                          a candidate
//     - [!] <url> ... Error: <reason>                                  skipped (career-ops could not read it)
//     - [x] #NNN | <url> | <company> | <role> | <score> | PDF ...       evaluated by career-ops: a candidate only with
//                                                                      include_evaluated; number and score go into notes
//     - [x] #-- | <url> | skipped (pre-screen mismatch: ...)           skipped (any [x] whose first cell is "skipped...")
//     - [x] ~~<url> | <company> | <role>~~ ... posting expired          skipped
//     A labeled segment (posted:, trust:, note:, rank:) is never read as a company, role or location; all of them go
//     into notes, posted: also into the job's posted date, and trust: also becomes a flag. A row with another mark
//     ("[~]") is reported in the log and not queued. When one link has several rows, any skip wins over [ ].
//   scan-history.tsv (optional). Header row and 12 columns: url, first_seen, portal, title, company, status, location,
//     fingerprint, posted_at, trust_score, trust_flags, normalized_company. Older files may have no header or only
//     the first 7 columns (or fewer: a row without a status column reads as "added", as career-ops itself reads it).
//     The last row per link wins. A link whose last row is "added" and that is not in the pipeline is a candidate;
//     skipped_expired, skipped_location and every other status are not.
// Before any fetch: a link already in data/state/applications.json (same link, or the same company and role) is
// skipped ("applied-elsewhere"), and the shared gates (settings.gates) run on the company, role and location
// career-ops wrote. Then the full text comes from fetchDetail (lib/fetch-detail.mjs), and the applications check and
// the gates run again on what the posting says. A closed posting (404/410, "no longer accepting") is skipped. A job
// is queued with source "career-ops", career-ops' location and compensation (salary), and the fetched location
// when the posting gives one.
// The company is the one career-ops wrote, else what the fetch says (an ATS's organisation name, JSON-LD), else the
// board slug of an ATS link. It is never guessed from the title's punctuation; without one the job is queued as
// "Unknown" with a flag. A missing role falls back to the fetched title the same way.
// max_per_run caps the candidates handled per run, shared out one per company in turn (the company as written, else
// the board in the link, else the host) so a company with many finds does not starve the others.
// State (data/state/career-ops.json) keeps every handled link with its outcome. A link that could not be fetched
// (429, 5xx, DNS, timeout) is tried again on the next run, up to 3 runs; 401/403/451 and refused links are final at
// once. A link given up on is still queued, without text, when its company and role are known; otherwise it is
// reported as unreadable. A candidate that fails for another reason (a disk error) gets the same 3 tries; it never
// stops the run, and state is saved after every candidate. A gate reject is remembered; one made before the fetch is
// checked again on every run (no network), so a settings change frees it. Entries are pruned 120 days after their
// link left the career-ops files.
// Usage: node sources/career-ops.mjs [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS, STATE, ROOT, DIRS, read, log, num, isMain } from '../lib/config.mjs';
import { writeJob, norm, normUrl, frontMatter } from '../lib/queue.mjs';
import { fetchDetail as realFetchDetail, companyFromUrl, isListingPage } from '../lib/fetch-detail.mjs';
import { checkGates, fromText, gateTally, settle } from '../lib/gates.mjs';

export const SOURCE = 'career-ops';
export const MAX_ATTEMPTS = 3;          // runs a link is tried before it is given up (as in drop-dir)
export const MAX_PER_RUN = 30;
const PAGE_DELAY_MS = 1500;             // between page fetches; ATS APIs are not throttled
const PRUNE_DAYS = 120;
const now = () => new Date().toISOString();
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));
const URL_RE = /https?:\/\/[^\s|<>"]+/i;
// The four labels career-ops writes (scan.mjs PIPELINE_LABELED_SEGMENT_RE). An allow-list: "Remote: EMEA" is a location.
const LABEL_RE = /^(posted|trust|note|rank):\s/i;
const SCORE_RE = /^\d+(?:[.,]\d+)?\s*\/\s*\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const unescapeMd = s => String(s ?? '').replace(/\\([\\[\]])/g, '$1');   // career-ops escapes \ [ ] in cells
// a field career-ops left empty or filled with a placeholder says nothing
const field = s => { const t = unescapeMd(s).replace(/^\*\*|\*\*$/g, '').trim(); return /^(|-|–|—|\?|n\/a|none|null|unknown)$/i.test(t) ? '' : t; };
const expandHome = p => p.replace(/^~(?=$|[/\\])/, os.homedir());

/** A link as a state and comparison key: no fragment, no trailing slash, lower-case host. The query is kept (?gh_jid=). */
export function urlKey(url) {
  const s = String(url || '').trim();
  try { const u = new URL(s); u.hash = ''; return u.href.replace(/\/+$/, ''); } catch { return s.replace(/#.*$/, '').replace(/\/+$/, ''); }
}

/** The career-ops folder from settings: "~/" is the home folder, a relative path is relative to jobpilot's folder. */
export function careerOpsDir(cfg = SETTINGS.sources.career_ops || {}) {
  const p = String(cfg.path || '').trim();
  if (!p) return '';
  return path.resolve(ROOT, expandHome(p));
}
/** { dir, pipeline, history, pipelineName }: the two files, from pipeline_file / scan_history_file or the defaults. */
export function careerOpsFiles(cfg = SETTINGS.sources.career_ops || {}) {
  const dir = careerOpsDir(cfg);
  const pick = (v, d) => String(v || '').trim() || d;
  const pipelineName = pick(cfg.pipeline_file, 'data/pipeline.md');
  return { dir, pipelineName, pipeline: path.resolve(dir, expandHome(pipelineName)), history: path.resolve(dir, expandHome(pick(cfg.scan_history_file, 'data/scan-history.tsv'))) };
}

/** What doctor prints for this source: { good, text, fix }. Read-only. */
export function checkSetup(cfg = SETTINGS.sources.career_ops || {}) {
  const { dir, pipeline, pipelineName } = careerOpsFiles(cfg);
  if (!dir) return { good: false, text: 'career-ops folder: not set', fix: 'set sources.career_ops.path in settings.json to your career-ops checkout' };
  if (!fs.existsSync(dir)) return { good: false, text: `career-ops folder: ${dir}`, fix: `${dir} does not exist; fix sources.career_ops.path in settings.json` };
  try { fs.accessSync(pipeline, fs.constants.R_OK); fs.readFileSync(pipeline); } catch (e) {
    return { good: false, text: `career-ops folder: ${dir}`, fix: e.code === 'ENOENT' ? `no ${pipelineName} in ${dir}; run a career-ops scan first or fix the path` : `cannot read ${pipeline} (${e.code || e.message})` };
  }
  return { good: true, text: `career-ops folder: ${dir}`, fix: '' };
}

/**
 * parsePipeline(markdown) -> { items: [{ mark, url, company, role, location, compensation, labels, number?, score?, rest? }], odd: [line] }
 * mark: "open" ([ ]), "skip" ([!]), "evaluated" ([x] #NNN), "discarded" ([x] whose first cell after the link starts
 * with "skipped", or #--), "expired" (~~struck through~~) or "other" (any other mark). labels: { posted, trust, note,
 * rank } as written. odd lists checkbox lines without a link. Lines without a checkbox (headings, prose) are ignored.
 */
export function parsePipeline(md) {
  const items = [], odd = [];
  for (const raw of String(md || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*+]\s*\[(.?)\]\s*(.*)$/);
    if (!m) continue;
    // ~~...~~ is read at the start of the entry only: a note may carry its own strikethrough
    let body = m[2], expired = false;
    if (body.startsWith('~~')) { expired = true; const closed = body.match(/^~~([\s\S]*?)~~/); body = closed ? closed[1] : body.slice(2); }
    const cells = body.split('|').map(s => s.trim());
    const i = cells.findIndex(f => URL_RE.test(unescapeMd(f)));
    if (i < 0) { odd.push(raw.trim()); continue; }
    let url = unescapeMd(cells[i]).match(URL_RE)[0].replace(/[.,;]+$/, '');
    if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);   // a markdown link "[x](url)"
    const after = cells.slice(i + 1);
    const positional = after.filter(f => !LABEL_RE.test(f));
    const labels = {};
    for (const f of after) { const l = f.match(LABEL_RE); if (l && !(l[1].toLowerCase() in labels)) labels[l[1].toLowerCase()] = unescapeMd(f.slice(l[0].length)).trim(); }
    const c = m[1].toLowerCase();
    let mark = c === ' ' || c === '' ? 'open' : c === '!' ? 'skip' : c === 'x' ? 'evaluated' : 'other';
    if (expired) mark = 'expired';
    else if (mark === 'evaluated' && (cells.slice(0, i).some(f => /^#\s*--/.test(f)) || /^skipped\b/i.test(positional[0] || ''))) mark = 'discarded';
    const item = { mark, url, company: field(positional[0]), role: field(positional[1]), location: '', compensation: '', labels, raw: raw.trim() };
    // location and compensation are columns 4 and 5 of the link-first shape only; a report-led [x] row puts the score there
    if (i === 0 && (mark === 'open' || mark === 'other')) { item.location = field(positional[2]); item.compensation = field(positional[3]); }
    if (mark === 'other') item.char = m[1];
    if (mark === 'evaluated') {
      const n = cells.slice(0, i).map(f => f.match(/#\s*(\d+)/)).find(Boolean);
      if (n) item.number = n[1];
      const tail = positional.slice(2).filter(Boolean);
      const score = tail.find(f => SCORE_RE.test(f.replace(/\*/g, '').trim()));
      if (score) item.score = score.replace(/\*/g, '').replace(/\s+/g, '');
      const rest = tail.filter(f => f !== score);
      if (rest.length) item.rest = rest.join(' | ');
    }
    items.push(item);
  }
  return { items, odd };
}

const HISTORY_COLUMNS = ['url', 'first_seen', 'portal', 'title', 'company', 'status', 'location', 'fingerprint', 'posted_at', 'trust_score', 'trust_flags', 'normalized_company'];
/**
 * parseScanHistory(tsv) -> { rows: [{ url, first_seen, portal, title, company, status, location, posted_at, trust_score, trust_flags }], odd }
 * One row per link: the last one in the file wins. Columns are found by the header row (any order, any case);
 * without a header career-ops' order is assumed. A row too short to have a status column reads as "added" (what
 * career-ops does with its oldest rows); a status cell that is there but empty is not "added". odd counts rows without a link.
 */
export function parseScanHistory(tsv) {
  const lines = String(tsv || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const cells = l => l.split('\t').map(c => c.trim().replace(/^"(.*)"$/, '$1').trim());
  let cols = HISTORY_COLUMNS;
  if (lines.length && cells(lines[0]).some(c => c.toLowerCase() === 'url') && !URL_RE.test(cells(lines[0])[0] || '')) {
    cols = cells(lines.shift()).map(c => c.toLowerCase().replace(/\s+/g, '_'));
  }
  const statusAt = cols.indexOf('status');
  const byKey = new Map(); let odd = 0;
  for (const l of lines) {
    const c = cells(l), row = {};
    cols.forEach((k, i) => { row[k] = c[i] ?? ''; });
    const url = (String(row.url || '').match(URL_RE) || [])[0];
    if (!url) { odd++; continue; }
    const status = statusAt < 0 || c.length <= statusAt ? 'added' : String(row.status || '').trim().toLowerCase();
    const key = urlKey(url);
    byKey.delete(key);   // the last row wins, at its own place in the order
    byKey.set(key, { url, first_seen: field(row.first_seen), portal: field(row.portal), title: field(row.title), company: field(row.company), status,
      location: field(row.location), posted_at: field(row.posted_at), trust_score: field(row.trust_score), trust_flags: field(row.trust_flags) });
  }
  return { rows: [...byKey.values()], odd };
}

/** "career-ops trust score 60: missing_apply_url, suspicious_domain" from a trust: segment or the two scan columns. */
function trustFlag(score, flags) {
  const s = String(score || '').trim(); if (!s) return '';
  const f = String(flags || '').split(',').map(x => x.trim()).filter(Boolean);
  return `career-ops trust score ${s}${f.length ? `: ${f.join(', ')}` : ''}`;
}
const labelNotes = labels => Object.entries(labels).map(([k, v]) => `${k}: ${v}`);

/**
 * Candidates from both files, one per link, in file order (pipeline first).
 * -> { candidates: [{ url, key, company, role, location, compensation, posted, notes, flags, from }], counts }
 */
export function collectCandidates(pipeline, history, { includeEvaluated = false } = {}) {
  const counts = { open: 0, evaluated: 0, evaluated_skipped: 0, skip: 0, discarded: 0, expired: 0, other: 0, history_added: 0, history_skipped: 0, history_in_pipeline: 0 };
  const rank = { evaluated: 3, skip: 3, discarded: 3, expired: 3, other: 2, open: 1 };
  const byKey = new Map();
  for (const it of pipeline.items) {   // per link, the row that says the most wins: any skip or [x] over [~] over [ ]
    const k = urlKey(it.url), had = byKey.get(k);
    if (!had || rank[it.mark] > rank[had.mark]) byKey.set(k, it);
  }
  const candidates = [], inPipeline = new Set(byKey.keys());
  for (const [key, it] of byKey) {
    counts[it.mark]++;
    const base = { url: it.url, key, company: it.company, role: it.role, location: it.location, compensation: it.compensation,
      posted: DATE_RE.test(it.labels.posted || '') ? it.labels.posted : '', from: 'pipeline' };
    const trust = it.labels.trust ? (it.labels.trust.match(/^(\d+)\s*(.*)$/) || []) : [];
    const flags = [trustFlag(trust[1], trust[2])].filter(Boolean);
    if (it.mark === 'open') candidates.push({ ...base, notes: ['career-ops pipeline', ...labelNotes(it.labels)].join('; '), flags });
    else if (it.mark === 'evaluated') {
      if (!includeEvaluated) { counts.evaluated_skipped++; continue; }
      const what = [it.number ? `#${it.number}` : '', it.score ? `score ${it.score}` : 'no score given'].filter(Boolean).join(', ');
      candidates.push({ ...base, notes: [`career-ops evaluated ${what}${it.rest ? ` (${it.rest})` : ''}`, ...labelNotes(it.labels)].join('; '), flags });
    }
  }
  for (const r of history.rows) {
    const key = urlKey(r.url);
    if (inPipeline.has(key)) { counts.history_in_pipeline++; continue; }
    if (r.status !== 'added') { counts.history_skipped++; continue; }
    counts.history_added++;
    const when = [r.portal, r.first_seen ? `first seen ${r.first_seen}` : ''].filter(Boolean).join(', ');
    const trust = r.trust_score ? [`trust: ${[r.trust_score, r.trust_flags].filter(Boolean).join(' ')}`] : [];
    candidates.push({ url: r.url, key, company: r.company, role: r.title, location: r.location, compensation: '', posted: DATE_RE.test(r.posted_at) ? r.posted_at : '',
      notes: [`career-ops scan history${when ? ` (${when})` : ''}`, ...trust].join('; '), flags: [trustFlag(r.trust_score, r.trust_flags)].filter(Boolean), from: 'history' });
  }
  return { candidates, counts };
}

/** The company a candidate belongs to, for sharing out: as written, else the board in an ATS link, else the host. */
function companyKey(c) {
  let host = ''; try { host = new URL(c.url).hostname; } catch { /* keep '' */ }
  return norm(c.company) || norm(companyFromUrl(c.url) || '') || `host:${host}`;
}
/** At most `max` candidates, one per company in turn. */
export function fairShare(candidates, max) {
  const groups = new Map();
  for (const c of candidates) {
    const k = companyKey(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const take = [], lists = [...groups.values()];
  for (let round = 0; take.length < max; round++) {
    let any = false;
    for (const l of lists) if (take.length < max && l[round]) { take.push(l[round]); any = true; }
    if (!any) break;
  }
  return take;
}

/**
 * What the user already applied to (data/state/applications.json): { urls, roles }. A record's link is its own url,
 * else the url of the queue file it is keyed by. Missing file -> empty; broken JSON throws (the caller stops).
 */
export function loadApplied(file = STATE('applications.json')) {
  const urls = new Set(), roles = new Set();
  const txt = read(file);
  if (!txt.trim()) return { urls, roles };
  const apps = JSON.parse(txt);
  for (const [key, a] of Object.entries(apps && typeof apps === 'object' ? apps : {})) {
    if (!a || typeof a !== 'object') continue;
    const links = [a.url];
    if (/\.md$/.test(key) && !key.includes('/') && !key.includes('\\')) {
      for (const d of ['decoded', 'rejected', 'inbox']) { const p = path.join(DIRS[d], key); if (fs.existsSync(p)) { links.push(frontMatter(read(p)).url); break; } }
    }
    for (const u of links) if (u) urls.add(normUrl(u));
    const c = norm(a.company), r = norm(a.role);
    if (c && c !== 'unknown' && r) roles.add(`${c}|${r}`);
  }
  return { urls, roles };
}
const appliedTo = (applied, url, company, role) => applied.urls.has(normUrl(url))
  || (!!norm(company) && norm(company) !== 'unknown' && !!norm(role) && applied.roles.has(`${norm(company)}|${norm(role)}`));

/** State file: never silently replaced. A broken one is kept aside under another name; a dry run leaves it alone. */
function loadState(stateFile, dryRun) {
  const txt = read(stateFile);
  let state = { seen: {} }, note = '';
  if (txt.trim()) {
    try { state = JSON.parse(txt); } catch (e) {
      if (dryRun) note = `${stateFile} is not valid JSON (${e.message}); dry run: starting from an empty state in memory, the file is left as it is`;
      else {
        const aside = `${stateFile}.broken-${Date.now()}`;
        fs.renameSync(stateFile, aside);
        note = `${stateFile} was not valid JSON (${e.message}); kept as ${aside}, starting a fresh state`;
      }
      state = {};
    }
  }
  if (!state || typeof state !== 'object') state = {};
  if (!state.seen || typeof state.seen !== 'object') state.seen = {};
  return { state, note };
}
function saveState(stateFile, state) {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, stateFile);   // atomic: a crash mid-write never leaves half a state file
}

/** Read a career-ops file. ENOENT -> null; any other error is thrown (an unreadable file must not look empty). */
function readSource(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** The gates on what career-ops wrote: no text, no network. */
const preGate = c => checkGates(fromText({ company: c.company, title: c.role, text: '', location: c.location }));

/**
 * One pass. Tests inject `fetch` (handed to fetchDetail) or `fetchDetail` itself; no network then.
 * -> { ran, written, held, unknown, report, counts }
 */
export async function run({ fetch: fetchFn, fetchDetail = realFetchDetail, dryRun = false, pageDelayMs = PAGE_DELAY_MS, sleep = defaultSleep } = {}) {
  const cfg = SETTINGS.sources.career_ops || {};
  const none = { ran: false, written: 0, report: [] };
  if (!cfg.enabled) { log('career-ops: disabled in settings.json'); return none; }
  const files = careerOpsFiles(cfg);
  if (!files.dir) { log('career-ops: enabled but no "path" set in settings.json (sources.career_ops.path)'); return none; }
  let pipeText, histText;
  try {
    pipeText = readSource(files.pipeline);
    histText = readSource(files.history);
  } catch (e) {
    log(`career-ops: cannot read the career-ops files in ${files.dir} (${e.code || e.message}); nothing done, nothing marked`);
    return none;
  }
  if (pipeText == null) {   // without the pipeline, a scan row cannot be checked against it: do nothing rather than guess
    log(`career-ops: ${files.pipeline} not found; check sources.career_ops.path (node cli.mjs doctor)`);
    return none;
  }
  let applied;
  try { applied = loadApplied(); } catch (e) {
    log(`career-ops: ${STATE('applications.json')} is not valid JSON (${e.message}); nothing done, nothing marked. Fix the file and run again.`);
    return none;
  }
  const pipeline = parsePipeline(pipeText);
  const history = parseScanHistory(histText ?? '');
  const includeEvaluated = cfg.include_evaluated === true || cfg.include_evaluated === 'true';
  const { candidates, counts } = collectCandidates(pipeline, history, { includeEvaluated });
  const max = num(cfg.max_per_run, MAX_PER_RUN, 1);

  const stateFile = STATE('career-ops.json');
  const { state, note } = loadState(stateFile, dryRun);
  const report = note ? [note] : [];
  // prune links that left the career-ops files long ago; a link still listed stays, so it is never fetched twice
  const listed = new Set([...pipeline.items.map(i => urlKey(i.url)), ...history.rows.map(r => urlKey(r.url))]);
  const cutoff = Date.now() - PRUNE_DAYS * 864e5;
  for (const [k, e] of Object.entries(state.seen)) {
    if (listed.has(k)) { if (e && typeof e === 'object') e.listed_at = now(); continue; }
    if (!(Date.parse(e?.listed_at || e?.at) >= cutoff)) delete state.seen[k];
  }
  const save = () => { if (!dryRun) saveState(stateFile, state); };
  const mark = (key, entry) => { if (!dryRun) state.seen[key] = { at: now(), listed_at: now(), ...entry }; };

  const gated = gateTally(), unreadable = [];
  let written = 0, noText = 0, unavailable = 0, listing = 0, duplicate = 0, retrying = 0, failed = 0, unknownCompany = 0, appliedSkips = 0, freed = 0, lastPage = 0;
  // open: new, to retry, or rejected by a gate before its fetch and passing the gates now (a settings change)
  const open = candidates.filter(c => {
    const p = state.seen[c.key];
    if (!p || p.outcome === 'retry') return true;
    if (p.outcome === 'gated' && p.stage === 'pre-fetch' && preGate(c).decision !== 'reject') { freed++; return true; }
    return false;
  });
  const take = fairShare(open, max);
  const held = open.length - take.length;

  try {
    for (const c of take) {
      const prev = state.seen[c.key];
      const meta = { source: SOURCE, company: c.company || null, role: c.role || null, url: c.url };
      try {
        // 1. before any fetch: applied already, the gates on what career-ops wrote, a listing page
        if (appliedTo(applied, c.url, c.company, c.role)) { mark(c.key, { outcome: 'applied-elsewhere' }); appliedSkips++; continue; }
        const g0 = preGate(c);
        const s0 = settle(g0, meta, { dry: dryRun });
        if (!s0.queue) { gated.add(g0); if (s0.markSeen) mark(c.key, { outcome: 'gated', stage: 'pre-fetch', gate: g0.gate, reason: g0.reason }); continue; }
        if (isListingPage(c.url, '')) { mark(c.key, { outcome: 'listing-page' }); listing++; continue; }   // the link only: a role named "Jobs in ..." is still a job

        // 2. full text
        const isAts = !!companyFromUrl(c.url);
        if (!isAts && pageDelayMs > 0 && lastPage) { const wait = lastPage + pageDelayMs - Date.now(); if (wait > 0) await sleep(wait); }
        const detail = await fetchDetail(c.url, { fetch: fetchFn });
        if (!isAts) lastPage = Date.now();
        const company = c.company || detail.companyHint || companyFromUrl(c.url) || '';
        const role = c.role || String(detail.title || '').trim();
        const common = { url: c.url, source: SOURCE, salary: c.compensation || undefined, posted: c.posted || undefined, notes: c.notes };

        if (detail.via === 'error') {
          const attempts = (prev?.attempts || 0) + 1;
          if (!detail.terminal && attempts < MAX_ATTEMPTS) { mark(c.key, { outcome: 'retry', attempts, last_error: detail.error }); retrying++; continue; }
          if (company && role) {   // given up: keep the link, without text, since career-ops said whose job it is
            const extra = c.flags.length ? { source_flags: c.flags.join('; ') } : {};
            const r = dryRun ? { written: true } : writeJob({ ...common, company, role, location: c.location, text: '', extra });
            mark(c.key, { outcome: r.written ? 'written-no-text' : 'duplicate', attempts, last_error: detail.error });
            if (r.written) { written++; noText++; } else duplicate++;
          } else {
            mark(c.key, { outcome: 'unreadable', attempts, last_error: detail.error });
            unreadable.push(`${c.url} (${detail.error})`);
          }
          continue;
        }
        if (detail.unavailable) { mark(c.key, { outcome: 'unavailable', reason: detail.unavailable }); unavailable++; continue; }

        // 3. what the posting says: applied already under this name, then the gates on the full text and location
        if (appliedTo(applied, c.url, company, role)) { mark(c.key, { outcome: 'applied-elsewhere' }); appliedSkips++; continue; }
        const location = detail.location || c.location || '';
        const g = checkGates(fromText({ company, title: role, text: detail.text || '', location }));
        const s = settle(g, { ...meta, company: company || null, role: role || null }, { dry: dryRun });
        if (!s.queue) { gated.add(g); if (s.markSeen) mark(c.key, { outcome: 'gated', stage: 'post-fetch', gate: g.gate, reason: g.reason }); continue; }

        // a field career-ops left out is flagged, never a reason to drop the job
        const flags = [...c.flags];
        if (!company) flags.push('company unknown: not in career-ops data, the posting or the link');
        else if (!c.company) flags.push('company not in career-ops data; taken from the posting or the link');
        if (!role) flags.push('role unknown: not in career-ops data or the posting');
        else if (!c.role) flags.push('role not in career-ops data; taken from the posting');
        const extra = {};
        if (g.flags.length) extra.gate_flags = g.flags.join('; ');
        if (flags.length) extra.source_flags = flags.join('; ');
        const r = dryRun ? { written: true } : writeJob({ ...common, company: company || 'Unknown', role: role || 'Unknown role', location, text: detail.text || '', extra });
        mark(c.key, { outcome: r.written ? 'written' : 'duplicate' });
        if (r.written) { written++; if (!company) unknownCompany++; } else duplicate++;
      } catch (err) {
        // one bad candidate never stops the run; it gets the same number of tries as a failed fetch
        const msg = err.code ? `${err.code}: ${err.message}` : err.message;
        const attempts = (prev?.attempts || 0) + 1;
        if (attempts < MAX_ATTEMPTS) { mark(c.key, { outcome: 'retry', attempts, last_error: msg }); report.push(`${c.url}: failed (${msg}), will retry next run`); }
        else { mark(c.key, { outcome: 'failed', attempts, last_error: msg }); report.push(`${c.url}: failed ${attempts} runs in a row (${msg}), given up`); }
        failed++;
      } finally {
        save();   // after every candidate: a crash later in the run loses nothing already done
      }
    }
  } finally {
    save();
  }

  const found = [`pipeline: ${counts.open} open`, `${counts.evaluated} evaluated${counts.evaluated_skipped ? ' (skipped, include_evaluated is off)' : ''}`,
    `${counts.skip} marked [!]`, `${counts.discarded} skipped by the career-ops pre-screen`, `${counts.expired} expired`];
  if (counts.other) found.push(`${counts.other} with another mark (not queued)`);
  if (histText == null) found.push('no scan history file');
  else found.push(`scan history: ${counts.history_added} added and not in the pipeline, ${counts.history_in_pipeline} already in the pipeline, ${counts.history_skipped} with another status`);
  if (pipeline.odd.length) report.push(`${pipeline.odd.length} pipeline line(s) with a checkbox but no link were ignored`);
  if (history.odd) report.push(`${history.odd} scan-history row(s) without a link were ignored`);
  const done = [`${written} new`];
  if (noText) done.push(`${noText} queued without text (could not be fetched)`);
  if (unknownCompany) done.push(`${unknownCompany} queued as "Unknown" company (flagged)`);
  if (duplicate) done.push(`${duplicate} already queued`);
  if (appliedSkips) done.push(`${appliedSkips} already applied to (applications.json)`);
  if (unavailable) done.push(`${unavailable} closed`);
  if (listing) done.push(`${listing} search or listing page(s) skipped`);
  if (gated.total) done.push(String(gated));
  if (freed) done.push(`${freed} earlier gate reject(s) re-checked after a settings change`);
  if (retrying) done.push(`${retrying} could not be fetched (will retry)`);
  if (failed) done.push(`${failed} failed`);
  if (unreadable.length) done.push(`unreadable: ${unreadable.join(', ')}`);
  if (held) done.push(`max_per_run ${max} reached, ${held} more held for the next run`);
  log(`career-ops: ${done.join(', ')}${dryRun ? ' (dry run)' : ''}\n  ${[found.join(', '), ...report].join('\n  ')}`);
  return { ran: true, written, held, unknown: unknownCompany, report, counts };
}

if (isMain(import.meta.url)) await run({ dryRun: process.argv.includes('--dry-run') });

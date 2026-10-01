#!/usr/bin/env node
// Source: career-ops (https://github.com/career-ops-hq/career-ops, MIT), a separate tool that scans company boards
// and keeps a pipeline file. jobpilot only reads its files and never writes into its folder.
// settings.sources.career_ops = { enabled: true, path: "/home/youruser/career-ops", include_evaluated: false, max_per_run: 30 }
// path is the career-ops checkout ("~/" and paths relative to jobpilot's folder work too). Two files are read:
//   <path>/data/pipeline.md (required):
//     - [ ] <url> | <company> | <role>                           a candidate
//     - [!] <url> | <company> | <role> ... SKIP: <reason>        skipped
//     - [x] #NNN | <url> | <company> | <role> | <score> | ...   already evaluated by career-ops: a candidate only with
//                                                                include_evaluated, with the score in notes
//     A line with another mark ("[~]") is reported in the log and not queued. When one link has several lines,
//     [!] and [x] win over [ ].
//   <path>/data/scan-history.tsv (optional; columns url, first_seen, portal, title, company, status, found by the
//     header row): a row with status "added" whose link is not in the pipeline (under any mark) is a candidate;
//     "filtered" and every other status are skipped.
// For each candidate the shared gates (settings.gates) run on what the files say before anything is fetched, then
// the full text comes from fetchDetail (lib/fetch-detail.mjs) and the gates run again on it. A closed posting
// (404/410, "no longer accepting") is skipped. A job is queued with source "career-ops".
// The company is the one career-ops wrote, else what the fetch says (an ATS's organisation name, JSON-LD), else the
// board slug of an ATS link. It is never guessed from the title's punctuation; without one the job is queued as
// "Unknown" with a flag. A missing role falls back to the fetched title the same way.
// max_per_run caps the candidates handled per run, shared out one per company in turn so a company with many finds
// does not starve the others; the rest wait for the next run.
// State (data/state/career-ops.json) keeps every handled link with its outcome. A link that could not be fetched
// (429, 5xx, DNS, timeout) is tried again on the next run, up to 3 runs; 401/403/451 and refused links are final at
// once. A link given up on is still queued, without text, when its company and role are known; otherwise it is
// reported as unreadable. A candidate that fails for another reason (a disk error) gets the same 3 tries; it never
// stops the run, and state is saved after every candidate. A gate reject is remembered like any other outcome (a
// demote is not, per lib/gates.mjs settle()). Entries are pruned 120 days after their link left the career-ops files.
// Usage: node sources/career-ops.mjs [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, STATE, ROOT, read, log, num } from '../lib/config.mjs';
import { writeJob, norm } from '../lib/queue.mjs';
import { fetchDetail as realFetchDetail, companyFromUrl, isListingPage } from '../lib/fetch-detail.mjs';
import { checkGates, fromText, gateTally, settle } from '../lib/gates.mjs';

export const SOURCE = 'career-ops';
export const MAX_ATTEMPTS = 3;          // runs a link is tried before it is given up (as in drop-dir)
export const MAX_PER_RUN = 30;
const PAGE_DELAY_MS = 1500;             // between page fetches; ATS APIs are not throttled
const PRUNE_DAYS = 120;
const now = () => new Date().toISOString();
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));
const URL_RE = /https?:\/\/[^\s|<>()[\]"']+/i;
// a field career-ops left empty or filled with a placeholder says nothing
const field = s => { const t = String(s ?? '').replace(/^\*\*|\*\*$/g, '').trim(); return /^(|-|–|—|\?|n\/a|none|null|unknown)$/i.test(t) ? '' : t; };

/** A link as a state and comparison key: no fragment, no trailing slash, lower-case host. The query is kept (?gh_jid=). */
export function urlKey(url) {
  const s = String(url || '').trim();
  try { const u = new URL(s); u.hash = ''; return u.href.replace(/\/+$/, ''); } catch { return s.replace(/#.*$/, '').replace(/\/+$/, ''); }
}

/** The career-ops folder from settings: "~/" is the home folder, a relative path is relative to jobpilot's folder. */
export function careerOpsDir(cfg = SETTINGS.sources.career_ops || {}) {
  const p = String(cfg.path || '').trim();
  if (!p) return '';
  return path.resolve(ROOT, p.replace(/^~(?=$|[/\\])/, os.homedir()));
}

/** What doctor prints for this source: { good, text, fix }. Read-only. */
export function checkSetup(cfg = SETTINGS.sources.career_ops || {}) {
  const dir = careerOpsDir(cfg);
  if (!dir) return { good: false, text: 'career-ops folder: not set', fix: 'set sources.career_ops.path in settings.json to your career-ops checkout' };
  const pipe = path.join(dir, 'data', 'pipeline.md');
  if (!fs.existsSync(dir)) return { good: false, text: `career-ops folder: ${dir}`, fix: `${dir} does not exist; fix sources.career_ops.path in settings.json` };
  try { fs.accessSync(pipe, fs.constants.R_OK); fs.readFileSync(pipe); } catch (e) {
    return { good: false, text: `career-ops folder: ${dir}`, fix: e.code === 'ENOENT' ? `no data/pipeline.md in ${dir}; run a career-ops scan first or fix the path` : `cannot read ${pipe} (${e.code || e.message})` };
  }
  return { good: true, text: `career-ops folder: ${dir}`, fix: '' };
}

/**
 * parsePipeline(markdown) -> { items: [{ mark, url, company, role, number?, score?, rest? }], odd: [line] }
 * mark is "open" ([ ]), "skip" ([!]), "evaluated" ([x]) or "other" (any other mark). odd lists checkbox lines
 * without a link. Lines without a checkbox (headings, prose) are ignored.
 */
export function parsePipeline(md) {
  const items = [], odd = [];
  for (const raw of String(md || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*+]\s*\[(.?)\]\s*(.*)$/);
    if (!m) continue;
    const c = m[1].toLowerCase();
    const mark = c === ' ' || c === '' ? 'open' : c === '!' ? 'skip' : c === 'x' ? 'evaluated' : 'other';
    const fields = m[2].split('|').map(s => s.trim());
    const i = fields.findIndex(f => URL_RE.test(f));
    if (i < 0) { odd.push(raw.trim()); continue; }
    const url = fields[i].match(URL_RE)[0].replace(/[.,;]+$/, '');
    const item = { mark, url, company: field(fields[i + 1]), role: field(fields[i + 2]), raw: raw.trim() };
    if (mark === 'other') item.char = m[1];
    if (mark === 'evaluated') {
      const num = fields.slice(0, i).map(f => f.match(/#\s*(\d+)/)).find(Boolean);
      if (num) item.number = num[1];
      const after = fields.slice(i + 3).filter(Boolean);
      const score = after.find(f => /^\d+(?:[.,]\d+)?\s*\/\s*\d+$/.test(f));
      if (score) item.score = score.replace(/\s+/g, '');
      const rest = after.filter(f => f !== score);
      if (rest.length) item.rest = rest.join(' | ');
    }
    items.push(item);
  }
  return { items, odd };
}

/**
 * parseScanHistory(tsv) -> { rows: [{ url, first_seen, portal, title, company, status }], odd: number }
 * Columns are found by the header row (any order, any case); without a header the documented order is assumed.
 * Rows without a link are counted in odd.
 */
export function parseScanHistory(tsv) {
  const lines = String(tsv || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const DEFAULT = ['url', 'first_seen', 'portal', 'title', 'company', 'status'];
  const cells = l => l.split('\t').map(c => c.trim().replace(/^"(.*)"$/, '$1').trim());
  let cols = DEFAULT;
  if (lines.length && !URL_RE.test(cells(lines[0])[0] || '') && cells(lines[0]).some(c => c.toLowerCase() === 'url')) {
    cols = cells(lines.shift()).map(c => c.toLowerCase().replace(/\s+/g, '_'));
  }
  const rows = []; let odd = 0;
  for (const l of lines) {
    const c = cells(l), row = {};
    cols.forEach((k, i) => { row[k] = c[i] ?? ''; });
    const url = (String(row.url || '').match(URL_RE) || [])[0];
    if (!url) { odd++; continue; }
    rows.push({ url, first_seen: field(row.first_seen), portal: field(row.portal), title: field(row.title), company: field(row.company), status: String(row.status || '').trim().toLowerCase() });
  }
  return { rows, odd };
}

/**
 * Candidates from both files, one per link, in file order (pipeline first).
 * -> { candidates: [{ url, key, company, role, notes, from }], counts }
 */
export function collectCandidates(pipeline, history, { includeEvaluated = false } = {}) {
  const counts = { open: 0, evaluated: 0, evaluated_skipped: 0, skip: 0, other: 0, history_added: 0, history_skipped: 0, history_in_pipeline: 0 };
  const rank = { evaluated: 3, skip: 3, other: 2, open: 1 };
  const byKey = new Map();
  for (const it of pipeline.items) {   // per link, the line that says the most wins: [!]/[x] over [~] over [ ]
    const k = urlKey(it.url), had = byKey.get(k);
    if (!had || rank[it.mark] > rank[had.mark]) byKey.set(k, it);
  }
  const candidates = [], inPipeline = new Set(byKey.keys());
  for (const [key, it] of byKey) {
    counts[it.mark]++;
    if (it.mark === 'open') candidates.push({ url: it.url, key, company: it.company, role: it.role, notes: 'career-ops pipeline', from: 'pipeline' });
    else if (it.mark === 'evaluated') {
      if (!includeEvaluated) { counts.evaluated_skipped++; continue; }
      const what = [it.number ? `#${it.number}` : '', it.score ? `score ${it.score}` : 'no score given'].filter(Boolean).join(', ');
      candidates.push({ url: it.url, key, company: it.company, role: it.role, notes: `career-ops evaluated ${what}${it.rest ? ` (${it.rest})` : ''}`, from: 'pipeline' });
    }
  }
  const seenHere = new Set();
  for (const r of history.rows) {
    const key = urlKey(r.url);
    if (inPipeline.has(key)) { counts.history_in_pipeline++; continue; }
    if (r.status !== 'added') { counts.history_skipped++; continue; }
    if (seenHere.has(key)) continue;
    seenHere.add(key); counts.history_added++;
    const when = [r.portal, r.first_seen ? `first seen ${r.first_seen}` : ''].filter(Boolean).join(', ');
    candidates.push({ url: r.url, key, company: r.company, role: r.title, notes: `career-ops scan history${when ? ` (${when})` : ''}`, from: 'history' });
  }
  return { candidates, counts };
}

/** At most `max` candidates, one per company in turn (company as written, else the link's host). */
export function fairShare(candidates, max) {
  const groups = new Map();
  for (const c of candidates) {
    let host = ''; try { host = new URL(c.url).hostname; } catch { /* keep '' */ }
    const k = norm(c.company) || `host:${host}`;
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

/** State file: never silently replaced. A broken one is kept aside under another name and reported. */
function loadState(stateFile) {
  const txt = read(stateFile);
  let state = { seen: {} };
  if (txt.trim()) {
    try { state = JSON.parse(txt); } catch (e) {
      const aside = `${stateFile}.broken-${Date.now()}`;
      fs.renameSync(stateFile, aside);
      log(`career-ops: ${stateFile} was not valid JSON (${e.message}); kept as ${aside}, starting a fresh state`);
      state = {};
    }
  }
  if (!state || typeof state !== 'object') state = {};
  if (!state.seen || typeof state.seen !== 'object') state.seen = {};
  return state;
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

/**
 * One pass. Tests inject `fetch` (handed to fetchDetail) or `fetchDetail` itself; no network then.
 * -> { ran, written, report, counts }
 */
export async function run({ fetch: fetchFn, fetchDetail = realFetchDetail, dryRun = false, pageDelayMs = PAGE_DELAY_MS, sleep = defaultSleep } = {}) {
  const cfg = SETTINGS.sources.career_ops || {};
  const none = { ran: false, written: 0, report: [] };
  if (!cfg.enabled) { log('career-ops: disabled in settings.json'); return none; }
  const dir = careerOpsDir(cfg);
  if (!dir) { log('career-ops: enabled but no "path" set in settings.json (sources.career_ops.path)'); return none; }
  let pipeText, histText;
  try {
    pipeText = readSource(path.join(dir, 'data', 'pipeline.md'));
    histText = readSource(path.join(dir, 'data', 'scan-history.tsv'));
  } catch (e) {
    log(`career-ops: cannot read the career-ops files in ${dir} (${e.code || e.message}); nothing done, nothing marked`);
    return none;
  }
  if (pipeText == null) {   // without the pipeline, a scan row cannot be checked against it: do nothing rather than guess
    log(`career-ops: ${path.join(dir, 'data', 'pipeline.md')} not found; check sources.career_ops.path (node cli.mjs doctor)`);
    return none;
  }
  const pipeline = parsePipeline(pipeText);
  const history = parseScanHistory(histText ?? '');
  const includeEvaluated = cfg.include_evaluated === true || cfg.include_evaluated === 'true';
  const { candidates, counts } = collectCandidates(pipeline, history, { includeEvaluated });
  const max = num(cfg.max_per_run, MAX_PER_RUN, 1);

  const stateFile = STATE('career-ops.json');
  const state = loadState(stateFile);
  // prune links that left the career-ops files long ago; a link still listed stays, so it is never fetched twice
  const listed = new Set([...pipeline.items.map(i => urlKey(i.url)), ...history.rows.map(r => urlKey(r.url))]);
  const cutoff = Date.now() - PRUNE_DAYS * 864e5;
  for (const [k, e] of Object.entries(state.seen)) {
    if (listed.has(k)) { if (e && typeof e === 'object') e.listed_at = now(); continue; }
    if (!(Date.parse(e?.listed_at || e?.at) >= cutoff)) delete state.seen[k];
  }
  const save = () => { if (!dryRun) saveState(stateFile, state); };
  const mark = (key, entry) => { if (!dryRun) state.seen[key] = { at: now(), listed_at: now(), ...entry }; };

  const report = [], gated = gateTally(), unreadable = [];
  let written = 0, noText = 0, unavailable = 0, listing = 0, duplicate = 0, retrying = 0, failed = 0, unknownCompany = 0, lastPage = 0;
  const open = candidates.filter(c => { const p = state.seen[c.key]; return !p || p.outcome === 'retry'; });
  const take = fairShare(open, max);
  const held = open.length - take.length;

  try {
    for (const c of take) {
      const prev = state.seen[c.key];
      const meta = { source: SOURCE, company: c.company || null, role: c.role || null, url: c.url };
      try {
        // 1. gates on what career-ops wrote, before any fetch (company and industry can decide here)
        const g0 = checkGates(fromText({ company: c.company, title: c.role, text: '', location: '' }));
        const s0 = settle(g0, meta, { dry: dryRun });
        if (!s0.queue) { gated.add(g0); if (s0.markSeen) mark(c.key, { outcome: 'gated', gate: g0.gate, reason: g0.reason }); continue; }
        if (isListingPage(c.url, '')) { mark(c.key, { outcome: 'listing-page' }); listing++; continue; }   // the link only: a role named "Jobs in ..." is still a job

        // 2. full text
        const isAts = !!companyFromUrl(c.url);
        if (!isAts && pageDelayMs > 0 && lastPage) { const wait = lastPage + pageDelayMs - Date.now(); if (wait > 0) await sleep(wait); }
        const detail = await fetchDetail(c.url, { fetch: fetchFn });
        if (!isAts) lastPage = Date.now();
        const company = c.company || detail.companyHint || companyFromUrl(c.url) || '';
        const role = c.role || String(detail.title || '').trim();

        if (detail.via === 'error') {
          const attempts = (prev?.attempts || 0) + 1;
          if (!detail.terminal && attempts < MAX_ATTEMPTS) { mark(c.key, { outcome: 'retry', attempts, last_error: detail.error }); retrying++; continue; }
          if (company && role) {   // given up: keep the link, without text, since career-ops said whose job it is
            const r = dryRun ? { written: true } : writeJob({ company, role, url: c.url, source: SOURCE, notes: c.notes, text: '' });
            mark(c.key, { outcome: r.written ? 'written-no-text' : 'duplicate', attempts, last_error: detail.error });
            if (r.written) { written++; noText++; } else duplicate++;
          } else {
            mark(c.key, { outcome: 'unreadable', attempts, last_error: detail.error });
            unreadable.push(`${c.url} (${detail.error})`);
          }
          continue;
        }
        if (detail.unavailable) { mark(c.key, { outcome: 'unavailable', reason: detail.unavailable }); unavailable++; continue; }

        // 3. gates again on the full text and location
        const location = detail.location || '';
        const g = checkGates(fromText({ company, title: role, text: detail.text || '', location }));
        const s = settle(g, { ...meta, company: company || null, role: role || null }, { dry: dryRun });
        if (!s.queue) { gated.add(g); if (s.markSeen) mark(c.key, { outcome: 'gated', gate: g.gate, reason: g.reason }); continue; }

        // a field career-ops left out is flagged, never a reason to drop the job
        const flags = [];
        if (!company) { flags.push('company unknown: not in career-ops data, the posting or the link'); unknownCompany++; }
        else if (!c.company) flags.push('company not in career-ops data; taken from the posting or the link');
        if (!role) flags.push('role unknown: not in career-ops data or the posting');
        else if (!c.role) flags.push('role not in career-ops data; taken from the posting');
        const extra = {};
        if (g.flags.length) extra.gate_flags = g.flags.join('; ');
        if (flags.length) extra.source_flags = flags.join('; ');
        const r = dryRun ? { written: true } : writeJob({ company: company || 'Unknown', role: role || 'Unknown role', url: c.url, source: SOURCE,
          location, notes: c.notes, text: detail.text || '', extra });
        mark(c.key, { outcome: r.written ? 'written' : 'duplicate' });
        if (r.written) written++; else duplicate++;
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

  const found = [`pipeline: ${counts.open} open`, `${counts.evaluated} evaluated${counts.evaluated_skipped ? ' (skipped, include_evaluated is off)' : ''}`, `${counts.skip} marked [!]`];
  if (counts.other) found.push(`${counts.other} with another mark (not queued)`);
  if (histText == null) found.push('no scan-history.tsv');
  else found.push(`scan history: ${counts.history_added} added and not in the pipeline, ${counts.history_in_pipeline} already in the pipeline, ${counts.history_skipped} not "added"`);
  if (pipeline.odd.length) report.push(`${pipeline.odd.length} pipeline line(s) with a checkbox but no link were ignored`);
  if (history.odd) report.push(`${history.odd} scan-history row(s) without a link were ignored`);
  const done = [`${written} new`];
  if (noText) done.push(`${noText} queued without text (could not be fetched)`);
  if (unknownCompany) done.push(`${unknownCompany} queued as "Unknown" company (flagged)`);
  if (duplicate) done.push(`${duplicate} already queued`);
  if (unavailable) done.push(`${unavailable} closed`);
  if (listing) done.push(`${listing} search or listing page(s) skipped`);
  if (gated.total) done.push(String(gated));
  if (retrying) done.push(`${retrying} could not be fetched (will retry)`);
  if (failed) done.push(`${failed} failed`);
  if (unreadable.length) done.push(`unreadable: ${unreadable.join(', ')}`);
  if (held) done.push(`max_per_run ${max} reached, ${held} more held for the next run`);
  log(`career-ops: ${done.join(', ')}${dryRun ? ' (dry run)' : ''}\n  ${[found.join(', '), ...report].join('\n  ')}`);
  return { ran: true, written, held, report, counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run({ dryRun: process.argv.includes('--dry-run') });

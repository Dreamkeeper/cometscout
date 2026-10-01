#!/usr/bin/env node
// Source: an external tool (an OpenClaw agent, a career-ops scan, a script someone writes) drops files into a
// folder; jobpilot picks them up. Two kinds of file in settings.sources.drop_dir.dir:
//   1. A job file in jobpilot's own format (*.md): front matter (company, role, url, source, location, ...) + body.
//      Validated and queued with writeJob (its own dedupe applies), then moved to processed/.
//   2. A "*.queue.json" file: { candidates: [{ title, url, company?, location?, source_key? }] }. Each candidate's
//      full text is fetched from its ATS (or the page itself) with fetchDetail. The company is the one given, else
//      a site-specific page-title format, else a hint from the fetch, else the board slug of an ATS link, else a
//      punctuation guess from the title ("Co - Title", "Co: Title"), else "Unknown". Listing pages (search
//      results, not one job), closed postings and jobs with neither a company nor any text are skipped.
// settings.sources.drop_dir = { enabled: true, dir: "/path/to/drop", settle_sec: 60, move_processed_to: "<dir>/processed",
//   max_fetches_per_run: 40 }
// max_fetches_per_run caps the job pages fetched in one run (calls to a known ATS API do not count). Candidates past
// the cap are not touched: their file stays and they are fetched on the next run.
// Only *.md and *.queue.json are read; dotfiles and anything else (desktop.ini, editor swap files, sync clients'
// temp files) are ignored. A file younger than settle_sec is left for the next run: another program may still be
// writing it (a modification time in the future counts as settled, so a skewed clock cannot pin a file).
// A file that fails validation (bad JSON, no candidates list, a job file without company/role) is moved to
// <dir>/failed/ with a "<name>.reason.txt" beside it. A file that keeps failing for another reason (permissions,
// a sync client holding it) is retried on the next run and moved to failed/ after 3 runs.
// State (data/state/drop-dir.json) keeps every candidate URL with its outcome, so nothing is fetched or queued
// twice. A URL that could not be fetched keeps its queue file in place and is tried again next run, up to 3 runs
// (429, 5xx, DNS, timeouts); 401/403/451 and refused links are final at once. A URL that ends up unreadable is
// still queued, without text, when its company and role are known (the decoder sees full_text: "missing" and
// the link); otherwise it is reported as unreadable. A company guessed from title punctuation alone does not count
// as known here. Entries older than 120 days are pruned.
// Usage: node sources/drop-dir.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, STATE, read, log, num } from '../lib/config.mjs';
import { writeJob, frontMatter, norm } from '../lib/queue.mjs';
import { fetchDetail, parseSearchTitleRule, HEURISTIC_RULES, companyFromUrl, isListingPage } from '../lib/fetch-detail.mjs';

export const MAX_ATTEMPTS = 3;          // runs a URL (or a whole file) is tried before it is given up
export const MAX_FETCHES_PER_RUN = 40;  // default page fetches per run (settings.sources.drop_dir.max_fetches_per_run)
const PAGE_DELAY_MS = 1500;             // between page fetches; ATS APIs are not throttled
const PRUNE_DAYS = 120;
const isSameText = (a, b) => !!a && !!b && norm(a) === norm(b);
const isQueueFile = name => /\.queue\.json$/i.test(name);
const isJobFile = name => /\.md$/i.test(name);
const now = () => new Date().toISOString();
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));
const readText = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');   // Windows tools often write a BOM

/** Move a file into `dir` without overwriting anything there; falls back to copy + delete across volumes (EXDEV). */
export function moveInto(file, dir, { rename = fs.renameSync, unlink = fs.unlinkSync } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = isQueueFile(file) ? '.queue.json' : path.extname(file);
  const stem = path.basename(file).slice(0, path.basename(file).length - ext.length);
  let dest = path.join(dir, path.basename(file));
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${stem}--${i}${ext}`);
  try { rename(file, dest); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
    try { unlink(file); } catch (e2) {
      fs.rmSync(dest, { force: true });   // the source stays; a retry must not leave a second copy behind
      throw e2;
    }
  }
  return dest;
}
/** Move a file that cannot be used to failed/, with the reason in a text file beside it. */
function moveToFailed(file, failedDir, reason) {
  const dest = moveInto(file, failedDir);
  fs.writeFileSync(`${dest}.reason.txt`, `${reason}\n`);
  return dest;
}

/** A job file in jobpilot's own format: front matter + body. */
export function handleJobFile(file, { processedDir, failedDir = path.join(path.dirname(file), 'failed'), dryRun = false } = {}) {
  processedDir ||= path.join(path.dirname(file), 'processed');
  const txt = readText(file).replace(/\r\n/g, '\n');
  const fm = frontMatter(txt);
  if (!fm.company?.trim() || !fm.role?.trim()) {
    const reason = 'missing company/role in front matter';
    if (!dryRun) moveToFailed(file, failedDir, reason);
    return { ok: false, message: `${reason}, moved to failed/` };
  }
  const body = txt.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^#[^\n]*\n+/, '').trim();
  const r = dryRun ? { written: true } : writeJob({ company: fm.company, role: fm.role, url: fm.url, source: fm.source || `drop:${path.basename(file)}`,
    location: fm.location, headcount: fm.headcount, salary: fm.salary, posted: fm.posted, notes: fm.notes, text: body });
  if (!dryRun) moveInto(file, processedDir);
  return { ok: true, written: r.written, message: r.written ? 'queued' : r.reason };
}

/**
 * A "*.queue.json" file of external finds. `seen` is the cross-run URL map ({ at, outcome, attempts?, last_error? });
 * it is mutated in place. `tried` holds the URLs already fetched (and failed) in this run, so a URL listed twice is
 * not retried twice in one run. `pageDelayMs` and `sleep` space out page fetches (tests set them). `pages` counts
 * page fetches against the per-run cap ({ fetched, max, deferred }); run() shares one across all files.
 */
export async function handleQueueFile(file, { processedDir, failedDir = path.join(path.dirname(file), 'failed'), dryRun = false, fetch: fetchFn,
  seen = {}, tried = new Set(), pageDelayMs = PAGE_DELAY_MS, sleep = defaultSleep, clock = { lastPage: 0 },
  pages = { fetched: 0, max: MAX_FETCHES_PER_RUN, deferred: 0 } } = {}) {
  processedDir ||= path.join(path.dirname(file), 'processed');
  let data;
  try { data = JSON.parse(readText(file)); } catch (e) {
    if (e.code) throw e;   // a read error (EACCES, EBUSY) is not the file's fault: the caller retries it next run
    const reason = `not valid JSON (${e.message})`;
    if (!dryRun) moveToFailed(file, failedDir, reason);
    return { ok: false, message: `${reason}, moved to failed/` };
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.candidates)) {
    const reason = 'no "candidates" list';
    if (!dryRun) moveToFailed(file, failedDir, reason);
    return { ok: false, message: `${reason}, moved to failed/` };
  }
  const base = path.basename(file).replace(/\.queue\.json$/i, '');
  const mark = (url, entry) => { if (!dryRun) seen[url] = { at: now(), ...entry }; };
  let allDone = true, retrying = false, written = 0, skipped = 0, noText = 0, deferred = 0;
  const unreadable = [];
  for (const cand of data.candidates) {
    if (!cand || typeof cand !== 'object') { skipped++; continue; }
    const url = typeof cand.url === 'string' ? cand.url.trim() : '';
    if (!url) { skipped++; continue; }
    const prev = seen[url];
    if (prev && prev.outcome !== 'retry') { skipped++; continue; }
    if (tried.has(url)) { allDone = false; retrying = true; skipped++; continue; }   // failed once already this run
    const candTitle = String(cand.title || '');
    if (isListingPage(url, candTitle)) { mark(url, { outcome: 'listing-page' }); skipped++; continue; }

    const isAts = !!companyFromUrl(url);
    if (!isAts && pages.fetched >= pages.max) { allDone = false; deferred++; pages.deferred = (pages.deferred || 0) + 1; continue; }   // next run
    if (!isAts) pages.fetched++;
    if (!isAts && pageDelayMs > 0) {
      const wait = clock.lastPage + pageDelayMs - Date.now();
      if (clock.lastPage && wait > 0) await sleep(wait);
    }
    const detail = await fetchDetail(url, { fetch: fetchFn });
    if (!isAts) clock.lastPage = Date.now();

    const source = `drop:${cand.source_key || base}`;
    if (detail.via === 'error') {
      tried.add(url);
      const attempts = (prev?.attempts || 0) + 1;
      if (!detail.terminal && attempts < MAX_ATTEMPTS) {          // worth another run
        mark(url, { outcome: 'retry', attempts, last_error: detail.error });
        allDone = false; retrying = true; skipped++; continue;
      }
      // Given up: queue it without text when we know whose job it is, so the link is not lost. A company guessed from
      // title punctuation ("Co - Title") is not known: with no text to check it against, it would be made up.
      const p = parseSearchTitleRule(candTitle);
      const company = String(cand.company || '').trim() || (!HEURISTIC_RULES.has(p.rule) && p.company) || detail.companyHint || companyFromUrl(url);
      const role = p.title || candTitle.trim();
      if (company && role) {
        const r = dryRun ? { written: true } : writeJob({ company, role, url, source, location: cand.location || p.location || '', text: '' });
        mark(url, { outcome: r.written ? 'written-no-text' : 'duplicate', attempts, last_error: detail.error });
        if (r.written) { written++; noText++; } else skipped++;
      } else {
        mark(url, { outcome: 'unreadable', attempts, last_error: detail.error });
        unreadable.push(`${url} (${detail.error})`); skipped++;
      }
      continue;
    }
    if (detail.unavailable) { mark(url, { outcome: 'unavailable', reason: detail.unavailable }); skipped++; continue; }

    const isTitle = s => isSameText(s, detail.title);
    const p = parseSearchTitleRule(candTitle, isTitle);
    const guess = HEURISTIC_RULES.has(p.rule);
    // Evidence first: what the producer said, a site-specific title format, the fetched data, the ATS slug; a
    // punctuation guess from the title only when nothing better exists.
    const company = String(cand.company || '').trim() || (!guess && p.company) || detail.companyHint || companyFromUrl(url) || p.company || '';
    const text = detail.text || '';
    if (!company && !text) { mark(url, { outcome: 'unidentifiable' }); skipped++; continue; }
    const role = String((detail.title && detail.via !== 'page' ? detail.title : '') || p.title || candTitle).trim();
    if (!role) { mark(url, { outcome: 'no-role' }); skipped++; continue; }
    const location = cand.location || p.location || detail.location || '';
    const r = dryRun ? { written: true } : writeJob({ company: company || 'Unknown', role, url, source, location, text });
    mark(url, { outcome: r.written ? 'written' : 'duplicate' });
    if (r.written) written++; else skipped++;
  }
  if (allDone && !dryRun) moveInto(file, processedDir);
  const parts = [`${written} new`, `${skipped} skipped`];
  if (noText) parts.push(`${noText} queued without text (could not be fetched)`);
  if (deferred) parts.push(`${deferred} left for the next run (page fetch limit of ${pages.max} reached)`);
  if (unreadable.length) parts.push(`unreadable: ${unreadable.join(', ')}`);
  const kept = allDone ? '' : retrying ? ' (some pages could not be fetched; file kept for the next run)' : ' (file kept for the next run)';
  return { ok: true, written, skipped, deferred, allDone, unreadable, message: `${parts.join(', ')}${kept}` };
}

/** State file: never silently replaced. A broken one is kept aside under another name and reported. */
function loadState(stateFile) {
  const txt = read(stateFile);
  let state = { seen: {}, files: {} };
  if (txt.trim()) {
    try { state = JSON.parse(txt); } catch (e) {
      const aside = `${stateFile}.broken-${Date.now()}`;
      fs.renameSync(stateFile, aside);
      log(`drop-dir: ${stateFile} was not valid JSON (${e.message}); kept as ${aside}, starting a fresh state`);
      state = {};
    }
  }
  if (!state.seen || typeof state.seen !== 'object') state.seen = {};
  if (!state.files || typeof state.files !== 'object') state.files = {};
  return state;
}
function saveState(stateFile, state) {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, stateFile);   // atomic: a crash mid-write never leaves half a state file
}

/** Run one pass over settings.sources.drop_dir.dir. `fetch` lets tests inject a fake fetch (no network in tests). */
export async function run({ fetch: fetchFn, dryRun = false, pageDelayMs = PAGE_DELAY_MS, sleep = defaultSleep } = {}) {
  const cfg = SETTINGS.sources.drop_dir || {};
  if (!cfg.enabled) { log('drop-dir: disabled in settings.json'); return { ran: false, report: [] }; }
  if (!cfg.dir) { log('drop-dir: enabled but no "dir" set in settings.json'); return { ran: false, report: [] }; }
  if (!fs.existsSync(cfg.dir)) { log(`drop-dir: the folder ${cfg.dir} does not exist; create it or fix sources.drop_dir.dir in settings.json`); return { ran: false, report: [] }; }
  const settleMs = num(cfg.settle_sec, 60, 0) * 1000;
  const pages = { fetched: 0, max: num(cfg.max_fetches_per_run, MAX_FETCHES_PER_RUN, 1), deferred: 0 };
  const processedDir = cfg.move_processed_to || path.join(cfg.dir, 'processed');
  const failedDir = path.join(cfg.dir, 'failed');
  const stateFile = STATE('drop-dir.json');
  const state = loadState(stateFile);
  const cutoff = Date.now() - PRUNE_DAYS * 864e5;
  for (const [url, e] of Object.entries(state.seen)) if (!(Date.parse(e?.at) >= cutoff)) delete state.seen[url];

  const files = fs.readdirSync(cfg.dir, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.startsWith('.') && (isQueueFile(e.name) || isJobFile(e.name)));
  const report = [], tried = new Set(), clock = { lastPage: 0 };
  const save = () => { if (!dryRun) saveState(stateFile, state); };
  try {
    for (const e of files) {
      const file = path.join(cfg.dir, e.name);
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if (age >= 0 && age < settleMs) { report.push(`${e.name}: too new, left for the next run`); continue; }
        const r = isQueueFile(e.name)
          ? await handleQueueFile(file, { processedDir, failedDir, dryRun, fetch: fetchFn, seen: state.seen, tried, pageDelayMs, sleep, clock, pages })
          : handleJobFile(file, { processedDir, failedDir, dryRun });
        delete state.files[e.name];
        report.push(`${e.name}: ${r.message}`);
      } catch (err) {
        const msg = err.code ? `${err.code}: ${err.message}` : err.message;
        if (dryRun) { report.push(`${e.name}: failed (${msg})`); continue; }
        const f = state.files[e.name] = { attempts: (state.files[e.name]?.attempts || 0) + 1, last_error: msg, at: now() };
        let line = `${e.name}: failed (${msg})`;
        if (f.attempts >= MAX_ATTEMPTS && fs.existsSync(file)) {
          try { moveToFailed(file, failedDir, `failed ${f.attempts} runs in a row; last error: ${msg}`); delete state.files[e.name]; line += `, moved to failed/ after ${f.attempts} runs`; }
          catch (err2) { line += `; could not move it to failed/ either (${err2.message})`; }
        } else line += ', will retry next run';
        report.push(line);
      } finally {
        save();   // after every file: a crash later in the run loses nothing already done
      }
    }
    for (const name of Object.keys(state.files)) if (!fs.existsSync(path.join(cfg.dir, name))) delete state.files[name];
    if (pages.deferred) report.push(`page fetch limit reached (${pages.max} per run, sources.drop_dir.max_fetches_per_run): ${pages.deferred} job(s) left for the next run`);
  } finally {
    save();
  }
  log(`drop-dir: ${files.length} file(s) seen${dryRun ? ' (dry run)' : ''}${report.length ? `\n  ${report.join('\n  ')}` : ''}`);
  return { ran: true, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run({ dryRun: process.argv.includes('--dry-run') });

#!/usr/bin/env node
// Source: an external tool (an OpenClaw agent, a career-ops scan, a script someone writes) drops files into a
// folder; jobpilot picks them up. Two kinds of file in settings.sources.drop_dir.dir:
//   1. A job file in jobpilot's own format: front matter (company, role, url, source, location, ...) + body text.
//      Validated and queued with writeJob (its own dedupe applies), then moved to processed/.
//   2. A "*.queue.json" file: { candidates: [{ title, url, company?, location?, source_key? }] }. Each candidate's
//      full text is fetched from its ATS (or the page itself) with fetchDetail; the company is the one given, else
//      parsed from the title, else a hint from the fetch, else the board/company slug of the URL. Listing pages
//      (search results, not one job) and jobs with neither a company nor any text are skipped.
// settings.sources.drop_dir = { enabled: true, dir: "/path/to/drop", settle_sec: 60, move_processed_to: "<dir>/processed" }
// A file younger than settle_sec is left for the next run: another program may still be writing it. A candidate
// whose page could not be fetched (network error) is never marked seen, and its queue file is kept for the next
// run so it gets another try; a candidate that is a listing page, gone, or has neither a company nor text is
// marked seen so it is not refetched every run.
// Usage: node sources/drop-dir.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, STATE, readJson, log, num } from '../lib/config.mjs';
import { writeJob, frontMatter } from '../lib/queue.mjs';
import { fetchDetail, parseSearchTitle, companyFromUrl, isListingPage } from '../lib/fetch-detail.mjs';

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const isSameText = (a, b) => !!a && !!b && norm(a) === norm(b);

function moveToProcessed(file, processedDir, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(processedDir, { recursive: true });
  let dest = path.join(processedDir, path.basename(file));
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(processedDir, `${path.basename(file, path.extname(file))}--${i}${path.extname(file)}`);
  fs.renameSync(file, dest);
}

/** A job file in jobpilot's own format: front matter + body. */
export function handleJobFile(file, { processedDir, dryRun = false } = {}) {
  const txt = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const fm = frontMatter(txt);
  if (!fm.company || !fm.role) return { ok: false, message: 'missing company/role in front matter, left in place' };
  const body = txt.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^#[^\n]*\n+/, '').trim();
  const r = dryRun ? { written: true } : writeJob({ company: fm.company, role: fm.role, url: fm.url, source: fm.source || `drop:${path.basename(file)}`,
    location: fm.location, headcount: fm.headcount, salary: fm.salary, posted: fm.posted, notes: fm.notes, text: body });
  moveToProcessed(file, processedDir, dryRun);
  return { ok: true, written: r.written, message: r.written ? 'queued' : r.reason };
}

/** A "*.queue.json" file of external finds. `seen` is the cross-run seen-URL map; it is mutated in place. */
export async function handleQueueFile(file, { processedDir, dryRun = false, fetch: fetchFn, seen = {} } = {}) {
  let data; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, message: `not valid JSON (${e.message}), left in place` }; }
  const base = path.basename(file).replace(/\.queue\.json$/i, '');
  let allDone = true, written = 0, skipped = 0;
  for (const cand of data.candidates || []) {
    const url = cand.url; if (!url) { skipped++; continue; }
    if (seen[url]) { skipped++; continue; }
    if (isListingPage(url, cand.title)) { if (!dryRun) seen[url] = { at: new Date().toISOString(), outcome: 'listing-page' }; skipped++; continue; }
    const detail = await fetchDetail(url, { fetch: fetchFn });
    if (detail.via === 'error') { allDone = false; skipped++; continue; }   // could not be read: never marked seen, retried next run
    if (detail.unavailable) { if (!dryRun) seen[url] = { at: new Date().toISOString(), outcome: 'unavailable' }; skipped++; continue; }
    const isTitle = s => isSameText(s, detail.title);
    const parsed = parseSearchTitle(cand.title, isTitle);
    const company = cand.company || parsed.company || detail.companyHint || companyFromUrl(url) || '';
    const text = detail.text || '';
    if (!company && !text) { if (!dryRun) seen[url] = { at: new Date().toISOString(), outcome: 'unidentifiable' }; skipped++; continue; }
    const role = detail.title && detail.via !== 'page' ? detail.title : (parsed.title || cand.title || '');
    const location = cand.location || parsed.location || detail.location || '';
    const r = dryRun ? { written: true } : writeJob({ company, role, url, source: `drop:${cand.source_key || base}`, location, text });
    if (!dryRun) seen[url] = { at: new Date().toISOString(), outcome: r.written ? 'written' : 'duplicate' };
    if (r.written) written++; else skipped++;
  }
  if (allDone) moveToProcessed(file, processedDir, dryRun);
  return { ok: true, written, skipped, allDone, message: `${written} new, ${skipped} skipped${allDone ? '' : ' (some pages could not be fetched; file kept for the next run)'}` };
}

/** Run one pass over settings.sources.drop_dir.dir. `fetch` lets tests inject a fake fetch (no network in tests). */
export async function run({ fetch: fetchFn, dryRun = false } = {}) {
  const cfg = SETTINGS.sources.drop_dir || {};
  if (!cfg.enabled) { log('drop-dir: disabled in settings.json'); return { ran: false }; }
  if (!cfg.dir) { log('drop-dir: enabled but no "dir" set in settings.json'); return { ran: false }; }
  const settleMs = num(cfg.settle_sec, 60, 0) * 1000;
  const processedDir = cfg.move_processed_to || path.join(cfg.dir, 'processed');
  const stateFile = STATE('drop-dir.json');
  const state = readJson(stateFile, { seen: {} });
  const files = (fs.existsSync(cfg.dir) ? fs.readdirSync(cfg.dir, { withFileTypes: true }) : []).filter(e => e.isFile());
  const report = [];
  for (const e of files) {
    const file = path.join(cfg.dir, e.name);
    if (Date.now() - fs.statSync(file).mtimeMs < settleMs) { report.push(`${e.name}: too new, left for the next run`); continue; }
    const r = e.name.endsWith('.queue.json') ? await handleQueueFile(file, { processedDir, dryRun, fetch: fetchFn, seen: state.seen }) : handleJobFile(file, { processedDir, dryRun });
    report.push(`${e.name}: ${r.message}`);
  }
  if (!dryRun) fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  log(`drop-dir: ${files.length} file(s) seen${dryRun ? ' (dry run)' : ''}${report.length ? `\n  ${report.join('\n  ')}` : ''}`);
  return { ran: true, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run({ dryRun: process.argv.includes('--dry-run') });

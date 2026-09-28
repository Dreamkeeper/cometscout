#!/usr/bin/env node
// Source: public job boards of target companies (Greenhouse, Ashby, Lever). No login, no API key.
// settings.sources.ats_boards = {
//   enabled: true,
//   companies: [{ name: "Acme", ats: "greenhouse" | "ashby" | "lever", board: "<board slug from the careers URL>" }],
//   title_include: ["product manager", "product owner"],   // any of these in the title (case-insensitive)
//   title_exclude: ["intern", "associate"],
//   location_include: ["remote", "spain", "europe"],       // any of these in location/workplace; empty = all
//   max_per_run: 30
// }
// Usage: node sources/ats-boards.mjs [--dry-run]
import { SETTINGS, STATE, readJson, log } from '../lib/config.mjs';
import { writeJob, htmlText } from '../lib/queue.mjs';
import fs from 'node:fs';

const cfg = SETTINGS.sources.ats_boards || {};
const DRY = process.argv.includes('--dry-run');
const has = (hay, list) => !list || !list.length || list.some(x => String(hay || '').toLowerCase().includes(String(x).toLowerCase()));
const hasNot = (hay, list) => !(list || []).some(x => String(hay || '').toLowerCase().includes(String(x).toLowerCase()));
const get = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'jobpilot/0.1' } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

const FETCH = {
  async greenhouse(board) {
    const j = await get(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`);
    return (j.jobs || []).map(x => ({ role: x.title, url: x.absolute_url, location: x.location?.name || '', posted: x.updated_at, text: htmlText(String(x.content || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')) }));
  },
  async ashby(board) {
    const j = await get(`https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`);
    return (j.jobs || []).map(x => ({ role: x.title, url: x.jobUrl, location: [x.location, x.workplaceType, x.isRemote ? 'remote' : ''].filter(Boolean).join('; '), posted: x.publishedAt,
      salary: x.compensation?.compensationTierSummary || '', text: x.descriptionPlain || htmlText(x.descriptionHtml) }));
  },
  async lever(board) {
    const j = await get(`https://api.lever.co/v0/postings/${board}?mode=json`);
    return (Array.isArray(j) ? j : []).map(x => ({ role: x.text, url: x.hostedUrl, location: [x.categories?.location, x.workplaceType].filter(Boolean).join('; '), posted: x.createdAt ? new Date(x.createdAt).toISOString() : '',
      text: [x.descriptionPlain, ...(x.lists || []).map(l => `${l.text}\n${htmlText(l.content)}`), x.additionalPlain].filter(Boolean).join('\n\n') }));
  },
};

if (!cfg.enabled) { log('ats-boards: disabled in settings.json'); process.exit(0); }
const seenFile = STATE('ats-boards-seen.json'); const seen = readJson(seenFile, {});
let written = 0; const report = [];
for (const c of cfg.companies || []) {
  if (written >= (cfg.max_per_run || 30)) break;
  let jobs; try { jobs = await FETCH[c.ats](c.board); } catch (e) { report.push(`${c.name}: fetch failed (${e.message})`); continue; }
  const fits = jobs.filter(j => has(j.role, cfg.title_include) && hasNot(j.role, cfg.title_exclude) && has(j.location, cfg.location_include));
  let n = 0;
  for (const j of fits) {
    if (seen[j.url] || written >= (cfg.max_per_run || 30)) continue;
    const job = { company: c.name, source: `ats:${c.ats}`, ...j };
    const r = DRY ? { written: true, file: '(dry run)' } : writeJob(job);
    if (!DRY) seen[j.url] = new Date().toISOString();
    if (r.written) { written++; n++; }
  }
  report.push(`${c.name} (${c.ats}): ${jobs.length} open, ${fits.length} match, ${n} new`);
}
if (!DRY) fs.writeFileSync(seenFile, JSON.stringify(seen, null, 1));
log(`ats-boards: ${written} new job(s)${DRY ? ' (dry run)' : ''}\n  ${report.join('\n  ')}`);

#!/usr/bin/env node
// Source: public job boards of target companies (Greenhouse, Ashby, Lever). No login, no API key.
// settings.sources.ats_boards = {
//   enabled: true,
//   companies: [{ name: "Acme", ats: "greenhouse" | "ashby" | "lever", board: "<board slug from the careers URL>" }],
//   title_include: ["product manager", "product owner"],   // any of these in the title
//   title_exclude: ["intern", "associate"],
//   location_include: ["remote", "spain", "europe"],       // any of these in location/workplace; empty = all
//   max_per_run: 30
// }
// Filters match whole words, case-insensitive ("soc" does not match "Associate"); end a term with * to match
// word prefixes ("engineer*" matches "engineering"). Every company is checked on every run; when more new jobs
// match than max_per_run, they are shared out one per company in turn, and the rest wait for the next run
// (not marked seen) with a log line saying how many.
// settings.gates (lib/gates.mjs) applies to every matching job; a gated job is not marked seen, so lowering a gate
// brings it back on the next run. The log counts a job the first time it is gated (data/state/ats-boards-gated.json
// remembers which were gated before); a demoted job is also appended to data/state/demoted.jsonl.
// Usage: node sources/ats-boards.mjs [--dry-run]
import { SETTINGS, STATE, readJson, log, today } from '../lib/config.mjs';
import { writeJob, htmlText, matchesAny } from '../lib/queue.mjs';
import { checkGates, fromText, gateTally, settle } from '../lib/gates.mjs';
import fs from 'node:fs';

const cfg = SETTINGS.sources.ats_boards || {};
const DRY = process.argv.includes('--dry-run');
const has = (hay, list) => !list || !list.length || matchesAny(hay, list);
const hasNot = (hay, list) => !matchesAny(hay, list);
const get = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'jobpilot/0.1' } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

const FETCH = {
  async greenhouse(board) {
    const j = await get(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`);
    return (j.jobs || []).map(x => ({ role: x.title, url: x.absolute_url, location: x.location?.name || '', posted: x.updated_at, text: htmlText(String(x.content || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')) }));
  },
  async ashby(board) {
    const j = await get(`https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`);
    // primary and secondary locations, each with its address country when the name does not already say it
    const place = (name, address) => { const n = String(name || '').trim(), c = String(address?.postalAddress?.addressCountry || '').trim();
      return c && !n.toLowerCase().includes(c.toLowerCase()) ? [n, c].filter(Boolean).join(', ') : n; };
    return (j.jobs || []).map(x => {
      const work = [x.workplaceType, x.isRemote ? 'remote' : ''].filter(Boolean).join('; ');
      const places = [place(x.location, x.address), ...(Array.isArray(x.secondaryLocations) ? x.secondaryLocations : []).map(l => place(l?.location, l?.address))].filter(Boolean);
      return { role: x.title, url: x.jobUrl, location: [places.join(' | '), work].filter(Boolean).join('; '), places: places.map(p => [p, work].filter(Boolean).join('; ')),
        posted: x.publishedAt, salary: x.compensation?.compensationTierSummary || '', text: x.descriptionPlain || htmlText(x.descriptionHtml) };
    });
  },
  async lever(board) {
    const j = await get(`https://api.lever.co/v0/postings/${board}?mode=json`);
    return (Array.isArray(j) ? j : []).map(x => ({ role: x.text, url: x.hostedUrl, location: [x.categories?.location, x.workplaceType].filter(Boolean).join('; '), posted: x.createdAt ? new Date(x.createdAt).toISOString() : '',
      text: [x.descriptionPlain, ...(x.lists || []).map(l => `${l.text}\n${htmlText(l.content)}`), x.additionalPlain].filter(Boolean).join('\n\n') }));
  },
};

if (!cfg.enabled) { log('ats-boards: disabled in settings.json'); process.exit(0); }
const seenFile = STATE('ats-boards-seen.json'); const seen = readJson(seenFile, {});
const gatedFile = STATE('ats-boards-gated.json'); const gatedBefore = readJson(gatedFile, {});   // url -> { date, gate }
const MAX = cfg.max_per_run || 30;
// 1. check every company
const perCompany = [], report = []; const gated = gateTally(); const flagsOf = new Map();
for (const c of cfg.companies || []) {
  let jobs; try { jobs = await FETCH[c.ats](c.board); } catch (e) { report.push(`${c.name}: fetch failed (${e.message})`); continue; }
  const fits = jobs.filter(j => has(j.role, cfg.title_include) && hasNot(j.role, cfg.title_exclude) && has(j.location, cfg.location_include));
  const fresh = fits.filter(j => !seen[j.url]).filter(j => {
    const g = checkGates(fromText({ company: c.name, title: j.role, text: j.text, location: j.places?.length ? j.places : j.location }));
    if (!settle(g, { source: `ats:${c.ats}`, company: c.name, role: j.role, url: j.url }, { dry: DRY }).queue) {
      gated.add(g, gatedBefore[j.url]?.gate === g.gate);
      if (!DRY) gatedBefore[j.url] = { date: today(), gate: g.gate };
      return false;
    }
    delete gatedBefore[j.url];
    if (g.flags.length) flagsOf.set(j, g.flags.join('; '));
    return true;
  });
  perCompany.push({ c, fresh, stat: `${jobs.length} open, ${fits.length} match` });
}
// 2. share max_per_run out one job per company in turn, so no company is starved by an earlier one
const take = new Map(perCompany.map(p => [p, []])); let budget = MAX;
for (let round = 0; budget > 0; round++) {
  let any = false;
  for (const p of perCompany) if (budget > 0 && p.fresh[round]) { take.get(p).push(p.fresh[round]); budget--; any = true; }
  if (!any) break;
}
// 3. write
let written = 0, held = 0;
for (const p of perCompany) {
  let n = 0;
  for (const j of take.get(p)) {
    const { places, ...fields } = j;
    const r = DRY ? { written: true } : writeJob({ company: p.c.name, source: `ats:${p.c.ats}`, ...fields, ...(flagsOf.has(j) ? { extra: { gate_flags: flagsOf.get(j) } } : {}) });
    if (!DRY) seen[j.url] = new Date().toISOString();
    if (r.written) { written++; n++; }
  }
  const wait = p.fresh.length - take.get(p).length; held += wait;
  report.push(`${p.c.name} (${p.c.ats}): ${p.stat}, ${n} new${wait ? `, ${wait} held for the next run` : ''}`);
}
if (!DRY) {
  fs.writeFileSync(seenFile, JSON.stringify(seen, null, 1));
  // a gated job that left its board is forgotten after 120 days
  const cutoff = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(gatedBefore)) if (!(v?.date >= cutoff)) delete gatedBefore[k];
  fs.writeFileSync(gatedFile, JSON.stringify(gatedBefore, null, 1));
}
log(`ats-boards: ${written} new job(s)${gated.total ? `, ${gated}` : ''}${DRY ? ' (dry run)' : ''}${held ? `; max_per_run ${MAX} reached, ${held} more held for the next run (raise max_per_run to take them now)` : ''}\n  ${report.join('\n  ')}`);

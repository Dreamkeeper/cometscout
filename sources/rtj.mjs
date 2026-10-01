#!/usr/bin/env node
// Source: RealtimeJobs API (rtj.app, closed beta). Needs the user's own API token; the token's saved
// subscription settings decide which roles come back, so this file only adds light client-side filters.
// settings.sources.rtj = { enabled: true, token_env: "RTJ_API_TOKEN", hours: 24, overlap_hours: 6,
//                          page_size: 100, max_pages: 3, title_exclude: [], max_headcount: null }
// settings.gates (lib/gates.mjs) applies on top: rejects and demotes are not queued and are counted per gate in the log.
// Usage: node sources/rtj.mjs [--dry-run] [--hours 72]
import fs from 'node:fs';
import { SETTINGS, STATE, readJson, secret, log, num } from '../lib/config.mjs';
import { writeJob, matchesAny } from '../lib/queue.mjs';
import { checkGates, fromRtj, gateTally } from '../lib/gates.mjs';

const cfg = SETTINGS.sources.rtj || {};
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const HOURS = num((i => i >= 0 ? args[i + 1] : null)(args.indexOf('--hours')) ?? cfg.hours, 24, 1);
const MAX_BACK = num(cfg.max_lookback_hours, 168, HOURS);   // after missed days, catch up at most this far back
if (!cfg.enabled) { log('rtj: disabled in settings.json'); process.exit(0); }
const token = secret(cfg.token_env || 'RTJ_API_TOKEN');
if (!token) { log(`rtj: ${cfg.token_env || 'RTJ_API_TOKEN'} is not set in .env`); process.exit(2); }

const stateFile = STATE('rtj-state.json'); const state = readJson(stateFile, { last_before: null });
const before = new Date();
// Start from the last successful run (minus overlap), so a missed day is caught up instead of skipped; never less
// than HOURS back and never more than max_lookback_hours back.
let after = new Date(before - HOURS * 3600e3);
if (state.last_before) { const resume = new Date(new Date(state.last_before) - num(cfg.overlap_hours, 6, 0) * 3600e3); if (resume < after) after = resume; }
if (after < new Date(before - MAX_BACK * 3600e3)) after = new Date(before - MAX_BACK * 3600e3);

async function page(body) {
  const r = await fetch('https://rtj.app/api/jobs/search', { method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) throw new Error(`RTJ ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
const items = []; let cursor; const PAGES = num(cfg.max_pages, 3, 1), SIZE = num(cfg.page_size, 100, 1, 500);
for (let i = 0; i < PAGES; i++) {
  const p = await page({ after: after.toISOString(), before: before.toISOString(), pageSize: SIZE, ...(cursor ? { cursor } : {}) });
  items.push(...(p.positions || [])); cursor = p.nextCursor; if (!cursor) break;
}
if (cursor) log(`rtj: max_pages ${PAGES} x page_size ${SIZE} reached; more positions exist in this window (raise max_pages to take them)`);

const place = l => [l.city, l.country].filter(Boolean).join(', ') + (l.attendance?.length ? ` (${l.attendance.join('/')})` : '');
let written = 0, skipped = 0; const gated = gateTally();
for (const it of items) {
  const pos = it.position || {}, emp = it.employer || {};
  if (matchesAny(pos.title, cfg.title_exclude)) { skipped++; continue; }
  const hc = emp.headcount ? `${emp.headcount.min ?? '?'}-${emp.headcount.max && emp.headcount.max < 1e7 ? emp.headcount.max : '+'}` : 'unknown';
  if (cfg.max_headcount && emp.headcount?.min > cfg.max_headcount) { skipped++; continue; }
  const g = checkGates(fromRtj(it));
  if (g.decision !== 'pass') { gated.add(g); continue; }
  // visa_sponsorship_availability is often AMBIGUOUS even when the text says "without sponsorship"; the reliable
  // signal is objective_criteria (class LEGAL_AUTHORIZATION), so mandatory criteria go into a block of their own
  // with the legal ones first, and the decoder prompt tells the model to check each one.
  const crit = (pos.objective_criteria || []).filter(c => c?.criteria);
  const legal = c => /^LEGAL/.test(c.class || '');
  const mandatory = crit.filter(c => c.is_mandatory).sort((a, b) => legal(b) - legal(a));
  const header = [
    `Remote scope: ${pos.remote_scope || 'unknown'}${pos.allowed_regions?.length ? ` (${pos.allowed_regions.join(', ')})` : ''}`,
    `Visa sponsorship (RTJ field, often AMBIGUOUS; the mandatory criteria below win): ${pos.visa_sponsorship_availability || 'unknown'}${pos.visa_sponsorship?.length ? ` (${pos.visa_sponsorship.join(', ')})` : ''}`,
    pos.required_citizenships?.length ? `Required citizenships: ${pos.required_citizenships.join(', ')}` : '',
    pos.forbidden_citizenships?.length ? `Forbidden citizenships: ${pos.forbidden_citizenships.join(', ')}` : '',
    pos.relocation_support_availability && pos.relocation_support_availability !== 'NOT_MENTIONED' ? `Relocation support: ${pos.relocation_support_availability}` : '',
    pos.timezone_requirements ? `Time zone requirements: ${typeof pos.timezone_requirements === 'string' ? pos.timezone_requirements : JSON.stringify(pos.timezone_requirements)}` : '',
    `Languages: ${(pos.languages || []).join(', ') || 'unknown'}`,
    `Employer: ${emp.name}; ${emp.tagline || ''}; industries: ${(emp.industries || []).join(', ')}; headcount ${hc}; ${emp.stage || ''}`,
    mandatory.length ? `\nMANDATORY CRITERIA (from the employer's text; check every one against the profile):\n${mandatory.map(c => `- [${c.class || 'OTHER'}] ${c.criteria}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  const job = { company: emp.name || 'Unknown', role: pos.title || 'Unknown role', url: pos.apply_url, source: 'rtj',
    location: [(pos.locations || []).map(place).join(' | '), pos.remote_scope && pos.remote_scope !== 'none' ? `remote: ${pos.remote_scope}` : ''].filter(Boolean).join('; '),
    headcount: hc, salary: pos.salary?.min ? `${pos.salary.min}-${pos.salary.max} ${pos.salary.currency}` : '', posted: pos.metadata?.computed_posted_at,
    text: pos.raw_job_description ? `${header}\n\n${pos.raw_job_description}` : '', extra: g.flags.length ? { gate_flags: g.flags.join('; ') } : undefined };
  const r = DRY ? { written: true } : writeJob(job);
  if (r.written) written++; else skipped++;
}
if (!DRY) fs.writeFileSync(stateFile, JSON.stringify({ last_before: before.toISOString() }, null, 1));
log(`rtj: ${items.length} fetched, ${written} new, ${skipped} skipped${gated.total ? `, ${gated}` : ''}${DRY ? ' (dry run)' : ''}`);

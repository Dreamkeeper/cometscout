#!/usr/bin/env node
// Source: LinkedIn job-alert emails. Reads the alert emails from Gmail (read-only), extracts the job ids,
// fetches each job's public guest page (no LinkedIn login) for the full description, and queues new jobs.
// Set up alerts on LinkedIn (Jobs -> search -> "Set alert", daily, by email), then run tools/gmail-auth.mjs once.
// settings.sources.linkedin_alerts = {
//   enabled: true, sender: "jobalerts-noreply@linkedin.com",
//   first_run_hours: 48, overlap_hours: 24,
//   max_fetch: 40, delay_ms: 3000,          // stay slow: LinkedIn's terms forbid automated access; keep volume small
//   title_exclude: ["intern"], location_exclude_regex: ""
// }
// settings.gates (lib/gates.mjs) applies to every fetched job; rejects and demotes are counted under skipped.
// Usage: node sources/linkedin-alerts.mjs [--dry-run] [--hours 96] [--max-fetch 10]
import fs from 'node:fs';
import { SETTINGS, STATE, readJson, log, num } from '../lib/config.mjs';
import { writeJob, alreadyQueued, htmlText, matchesAny } from '../lib/queue.mjs';
import { Gmail, messageText } from '../lib/gmail.mjs';
import { checkGates, fromText } from '../lib/gates.mjs';

const cfg = { sender: 'jobalerts-noreply@linkedin.com', first_run_hours: 48, overlap_hours: 24, max_fetch: 40, delay_ms: 3000, title_exclude: [], location_exclude_regex: '', ...(SETTINGS.sources.linkedin_alerts || {}) };
const args = process.argv.slice(2);
const opt = n => (i => (i >= 0 ? args[i + 1] : null))(args.indexOf(`--${n}`));
const DRY = args.includes('--dry-run');
const MAX = num(opt('max-fetch') ?? cfg.max_fetch, 40, 0), DELAY = Math.max(2000, num(cfg.delay_ms, 3000, 0));   // a typo never removes the limit or the delay
if (!SETTINGS.sources.linkedin_alerts?.enabled) { log('linkedin-alerts: disabled in settings.json'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = STATE('linkedin-alerts.json');
const state = readJson(stateFile, { last_run: null, seen: {} });

// 1. alert emails -> job ids (with the alert name that found each one)
async function readAlerts() {
  const g = new Gmail();
  const hours = Number(opt('hours')) || (state.last_run ? Math.ceil((Date.now() - Date.parse(state.last_run)) / 3.6e6) + cfg.overlap_hours : cfg.first_run_hours);
  const after = Math.floor((Date.now() - hours * 3.6e6) / 1000);
  const list = await g.list(`from:${cfg.sender} after:${after}`, 100);
  const jobs = new Map();
  for (const { id } of list) {
    const t = messageText((await g.get(id)).payload);
    let alert = ((t.match(/Your job alert for (.+)/) || [])[1] || 'alert').trim();
    for (const raw of t.split('\n')) {
      const l = raw.trim();
      const sec = l.match(/^<strong[^>]*>(.+?)<\/strong>\s*jobs in (.+)$/); if (sec) { alert = `${sec[1]} in ${sec[2]}`; continue; }
      for (const m of l.matchAll(/jobs\/view\/(\d{6,})/g)) if (!jobs.has(m[1])) jobs.set(m[1], { id: m[1], alert });
    }
  }
  return { hours, emails: list.length, jobs: [...jobs.values()] };
}

// 2. public guest page -> full job
class Throttled extends Error {}
class Unparsed extends Error {}   // a 200 page we could not read: likely a LinkedIn layout change, not a closed job
async function fetchJob(id) {
  const r = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, { signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } });
  if ([403, 429, 999].includes(r.status)) throw new Throttled(`HTTP ${r.status}`);
  if (r.status === 404 || r.status === 410) return null;                 // closed or removed
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const h = await r.text();
  const grab = re => { const m = h.match(re); return m ? htmlText(m[1]).replace(/\s+/g, ' ').trim() : ''; };
  const title = grab(/class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h\d>/);
  const company = grab(/class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/) || grab(/class="[^"]*topcard__flavor"[^>]*>([\s\S]*?)<\/span>/);
  const location = grab(/class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/);
  const posted = grab(/class="[^"]*posted-time-ago__text[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  const criteria = [...h.matchAll(/job-criteria-subheader"[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => `${htmlText(m[1])}: ${htmlText(m[2]).replace(/\s+/g, ' ')}`);
  const desc = (h.match(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
  if (!title || !desc) { if (/No longer accepting applications|job is no longer available/i.test(h)) return null; throw new Unparsed('page fetched but title/description not found'); }
  return { title, company: company || 'Unknown', location, posted, text: [...criteria, '', htmlText(desc)].join('\n').trim() };
}

// 3. run
const { hours, emails, jobs } = await readAlerts();
const excludeLoc = cfg.location_exclude_regex ? new RegExp(cfg.location_exclude_regex, 'i') : null;
let fetched = 0, written = 0, unparsedRow = 0; const skipped = {}; const skip = why => (skipped[why] = (skipped[why] || 0) + 1);
for (const j of jobs) {
  if (state.seen[j.id]) { skip('seen before'); continue; }
  if (fetched >= MAX) { skip('over max_fetch (next run)'); continue; }
  let job;
  try { job = await fetchJob(j.id); fetched++; } catch (e) {
    if (e instanceof Throttled) { log(`linkedin-alerts: LinkedIn is throttling (${e.message}); stopping this run`); break; }
    if (e instanceof Unparsed) {   // not marked seen, so it is retried once the parser is fixed
      skip('page not parsed (will retry)'); fetched++;
      if (++unparsedRow >= 3) { log('linkedin-alerts: 3 job pages in a row could not be parsed; LinkedIn may have changed its page layout. Stopping; nothing is marked seen.'); break; }
      continue;
    }
    skip(`fetch error`); continue;
  } finally { await sleep(DELAY); }
  unparsedRow = 0;
  if (!DRY) state.seen[j.id] = new Date().toISOString().slice(0, 10);
  if (!job) { skip('closed or removed'); continue; }
  if (matchesAny(job.title, cfg.title_exclude)) { skip('title excluded'); continue; }
  if (excludeLoc && excludeLoc.test(job.location)) { skip('location excluded'); continue; }
  const g = checkGates(fromText({ company: job.company, title: job.title, text: job.text, location: job.location }));
  if (g.decision === 'reject') { skip(`gate: ${g.gate}`); continue; }
  if (g.decision === 'demote') { skip('demoted'); continue; }
  if (alreadyQueued(job.company, job.title, `https://www.linkedin.com/jobs/view/${j.id}/`, job.location)) { skip('already queued'); continue; }
  const r = DRY ? { written: true } : writeJob({ company: job.company, role: job.title, url: `https://www.linkedin.com/jobs/view/${j.id}/`, source: 'linkedin',
    location: job.location, posted: job.posted, notes: `LinkedIn alert: ${j.alert}`, text: job.text, extra: g.flags.length ? { gate_flags: g.flags.join('; ') } : undefined });
  if (r.written) written++; else skip('duplicate');
}
// seen ids older than 120 days are dropped: alerts do not resend them, and the list must not grow forever
const cutoff = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
for (const [k, d] of Object.entries(state.seen)) if (d < cutoff) delete state.seen[k];
if (!DRY) { state.last_run = new Date().toISOString(); fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); }
log(`linkedin-alerts: ${emails} email(s) in ${hours}h, ${jobs.length} job id(s), ${fetched} page(s) fetched, ${written} new${DRY ? ' (dry run)' : ''}; skipped ${JSON.stringify(skipped)}`);

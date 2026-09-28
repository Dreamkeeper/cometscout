#!/usr/bin/env node
// Decoder: judge each new job in data/inbox against the candidate profile, move it to decoded/ or rejected/,
// choose today's "Apply today" picks, write a digest and send it to Telegram.
// Usage: node decoder/decoder.mjs [--dry-run] [--no-telegram] [--picks] [--cap 30]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, PROFILE, DIRS, STATE, read, readJson, today, log, num } from '../lib/config.mjs';
import { loadJob, parseResult, frontMatter, norm } from '../lib/queue.mjs';
import { callJson } from '../lib/llm.mjs';
import { sendText } from '../lib/telegram.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const DRY = flag('dry-run'), NO_TG = flag('no-telegram') || DRY, PICKS_ONLY = flag('picks');
const CAP = num((i => (i >= 0 ? args[i + 1] : null))(args.indexOf('--cap')) ?? SETTINGS.decoder?.cap, 30, 1);
const MAX_TRIES = num(SETTINGS.decoder?.max_tries, 3, 1);
const MIN_TEXT = 300;
const SCHEMA = JSON.parse(read(path.join(HERE, 'verdict.schema.json')));
// Replacement functions, not strings: "$$" or "$&" inside the profile must reach the model unchanged.
const PROMPT = read(path.join(HERE, 'prompt.md')).replace('{{NAME}}', () => SETTINGS.candidate_name).replace('{{PROFILE}}', () => PROFILE.facts || '(no profile yet: run onboarding)');
export const APPLY_WORTHY = ['strong-fit', 'investable-stretch'];
const label = v => ({ 'strong-fit': 'Strong fit', 'investable-stretch': 'Investable stretch', 'long-shot': 'Long shot', 'weak-fit': 'Weak fit', 'gate-reject': 'Gate', unreadable: 'No job text' }[v] || v);

// ---------- applications (the user's own record of what happened) ----------
export const APPS_FILE = STATE('applications.json');
export const apps = () => readJson(APPS_FILE, {});
// What the candidate recorded (applied, rejected, offer ...) always reaches the model, newest first; past decodes,
// newest first, fill the remaining lines. A long history must never drop "they already rejected me".
function history(company) {
  const c = norm(company); const recorded = [], decodes = [];
  for (const a of Object.values(apps())) if (norm(a.company) === c) recorded.push({ d: a.updated || '', line: `- ${a.updated}: ${a.role}: ${a.status}${a.note ? ` (${a.note})` : ''} [recorded by the candidate]` });
  for (const dir of ['decoded', 'rejected']) for (const f of fs.readdirSync(DIRS[dir])) {
    if (!f.endsWith('.md')) continue; const t = read(path.join(DIRS[dir], f)); const fm = frontMatter(t);
    if (norm(fm.company) === c) { const v = parseResult(t); const d = v.decoded_on || f.slice(0, 10); decodes.push({ d, line: `- ${d}: decoded "${fm.role}": ${v.verdict}` }); }
  }
  const newest = list => list.sort((x, y) => (x.d < y.d ? 1 : x.d > y.d ? -1 : 0)).map(x => x.line);
  const lines = [...newest(recorded).slice(0, 20), ...newest(decodes).slice(0, Math.max(5, 15 - recorded.length))];
  return lines.length ? lines.join('\n') : '(nothing before with this company)';
}

// ---------- fact check: regex guards from profile/fact-rules.json ----------
function factFlags(v) {
  const text = [v.rationale, ...(v.fit_signals || []), v.action].join(' \n ');
  return PROFILE.factRules.filter(r => r.re.test(text)).map(r => ({ id: r.id, why: r.why }));
}

async function decodeOne(file) {
  const job = loadJob(file);
  if (job.fm.full_text === 'missing' || job.body.replace(/^#.*$/m, '').trim().length < MIN_TEXT) {
    return { verdict: 'unreadable', confidence: 'low', rationale: 'No readable job text; open the link and judge by hand.', fit_signals: [], gaps: [], action: 'Open the link and decide manually.' };
  }
  const input = `${PROMPT}\n\n## History with ${job.fm.company}\n${history(job.fm.company)}\n\n## Job file\n\n${job.text.slice(0, 16000)}\n`;
  const { value } = await callJson({ prompt: input, schema: SCHEMA, model: SETTINGS.llm.model });
  if (!value.verdict) throw new Error('no verdict');
  value.fact_flags = factFlags(value);
  return value;
}
function resultBlock(v) {
  return ['', '## Decode Result', `Decoded ${today()} by jobpilot (${SETTINGS.llm.provider}${SETTINGS.llm.model ? `/${SETTINGS.llm.model}` : ''}).`,
    `verdict: ${v.verdict}${v.gate ? ` (${v.gate})` : ''}`, `confidence: ${v.confidence}`, v.apply_priority ? `apply_priority: ${v.apply_priority}` : null,
    `rationale: ${v.rationale}`, `fit_signals: ${(v.fit_signals || []).join('; ')}`, `gaps: ${(v.gaps || []).join('; ') || 'none'}`, `action: ${v.action}`,
    v.hold_reason ? `hold_reason: ${v.hold_reason}` : null, v.fact_flags?.length ? `fact_flags: ${v.fact_flags.map(f => f.id).join(', ')}` : null].filter(x => x !== null).join('\n') + '\n';
}

// ---------- picks ----------
const PICKS_FILE = STATE('picks.json');
const shapeRank = loc => { const l = norm(loc); const remote = /\bremote\b|udalen|удален/.test(l), onsite = /\bhybrid\b|\bonsite\b|on site|\boffice\b|гибрид/.test(l); return remote && !onsite ? 0 : remote ? 1.5 : 2; };
// A closed posting must not become a pick. Greenhouse and Lever answer 404; Ashby pages are an app shell that
// answers 200 for any id, so Ashby is asked through its public GraphQL (null posting = closed); LinkedIn and
// other boards are checked for "no longer accepting" style text. Network errors count as alive (never drop on doubt).
const DEAD_TEXT = /No longer accepting applications|This job is no longer available|job (?:posting )?(?:has been )?closed|This vacancy is archived|Вакансия в архиве|Эта вакансия в архиве/i;
async function linkAlive(url) {
  if (!/^https?:/.test(url || '')) return true;
  try {
    const ash = String(url).match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
    if (ash) {
      const r = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12000),
        body: JSON.stringify({ operationName: 'ApiJobPosting', variables: { o: ash[1], j: ash[2] }, query: 'query ApiJobPosting($o: String!, $j: String!) { jobPosting(organizationHostedJobsPageName: $o, jobPostingId: $j) { id } }' }) });
      if (r.ok) return !!(await r.json()).data?.jobPosting;
      return true;
    }
    const li = String(url).match(/linkedin\.com\/jobs\/view\/(\d+)/);
    const target = li ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${li[1]}` : url;
    const r = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' } });
    if (r.status === 404 || r.status === 410 || /[?&]error=true/.test(r.url)) return false;
    if (r.ok && DEAD_TEXT.test(await r.text())) return false;
    return true;
  } catch { return true; }
}
const CLOSED = /applied|rejected|withdrawn|closed|skipped|offer|interview/;
export async function buildPicks(extra = []) {
  const P = { ...SETTINGS.picks, per_day: num(SETTINGS.picks.per_day, 2, 0, 10), window_days: num(SETTINGS.picks.window_days, 14, 1), max_shown: num(SETTINGS.picks.max_shown, 3, 1) };
  const since = Date.now() - P.window_days * 86400000, state = readJson(PICKS_FILE, {}), A = apps();
  const excludeLoc = P.exclude_location_regex ? new RegExp(P.exclude_location_regex, 'i') : null;
  const pool = [];
  for (const f of fs.readdirSync(DIRS.decoded).filter(x => x.endsWith('.md'))) {
    const t = read(path.join(DIRS.decoded, f)); const v = parseResult(t);
    if (!APPLY_WORTHY.includes(v.verdict) || Date.parse(v.decoded_on || f.slice(0, 10)) < since) continue;
    pool.push({ file: f, fm: frontMatter(t), v });
  }
  for (const d of extra) if (APPLY_WORTHY.includes(d.v.verdict) && !pool.some(p => p.file === d.file)) pool.push(d);
  const closedCo = Object.values(A).filter(a => CLOSED.test(a.status)).map(a => `${norm(a.company)}|${norm(a.role)}`);
  const open = pool.filter(c => !(A[c.file] && CLOSED.test(A[c.file].status)) && !closedCo.includes(`${norm(c.fm.company)}|${norm(c.fm.role)}`)
    && (state[c.file]?.shown || 0) < P.max_shown && !(excludeLoc && excludeLoc.test(c.fm.location || '')));
  const score = c => (c.v.apply_priority || 5) * 10 + shapeRank(c.fm.location) * 4 + Math.min((Date.now() - Date.parse(c.v.decoded_on || today())) / 86400000, 10) * 0.3 + (state[c.file]?.shown || 0) * 2;
  open.sort((a, b) => score(a) - score(b));
  const picks = [];
  for (const c of open) {
    if (picks.length >= P.per_day) break;
    if (picks.some(p => norm(p.fm.company) === norm(c.fm.company))) continue;
    if (await linkAlive(c.fm.url)) picks.push(c); else log(`pick skipped, dead link: ${c.file}`);
  }
  return { picks, open: open.length };
}
export function recordPicks(picks) { const s = readJson(PICKS_FILE, {}); for (const p of picks) s[p.file] = { shown: (s[p.file]?.shown || 0) + 1, last: today() }; fs.writeFileSync(PICKS_FILE, JSON.stringify(s, null, 1)); }
const picksText = ({ picks, open }) => picks.length ? [`🎯 Apply today (${picks.length}; ${open} open in the pipeline)`,
  ...picks.flatMap((p, i) => [`${i + 1}. ${p.fm.company}: ${p.fm.role} [${String(p.fm.location || '').slice(0, 60)}] ${label(p.v.verdict)}, p${p.v.apply_priority}, via ${p.fm.source}`, `   How: ${p.v.action}`, `   ${p.fm.url || ''}`]), ''] : [];

// ---------- main ----------
if (PICKS_ONLY) { const pk = await buildPicks(); console.log(picksText(pk).join('\n') || `no picks (${pk.open} open)`); process.exit(0); }
// jobpilot's own sources finish before decode starts, so no settle time is needed. If an outside producer writes
// into data/inbox on its own schedule, set decoder.settle_sec (e.g. 60) so half-written files are left for later.
const SETTLE_MS = Number(SETTINGS.decoder?.settle_sec || 0) * 1000;
// Order: one job per company in turn (companies with the oldest waiting job first), oldest first within a company.
// Plain name order would let the cap spend itself on companies early in the alphabet and starve the rest.
const waiting = fs.readdirSync(DIRS.inbox).filter(f => f.endsWith('.md') && Date.now() - fs.statSync(path.join(DIRS.inbox, f)).mtimeMs >= SETTLE_MS).sort();
const byCompany = new Map();
for (const f of waiting) { const k = norm(frontMatter(read(path.join(DIRS.inbox, f))).company || f.split('--')[1] || f); if (!byCompany.has(k)) byCompany.set(k, []); byCompany.get(k).push(f); }
const fair = []; for (let round = 0; fair.length < waiting.length; round++) for (const list of byCompany.values()) if (list[round]) fair.push(list[round]);
const files = fair.slice(0, CAP);
const LEFT = waiting.length - files.length;
if (LEFT) log(`decoder.cap ${CAP} reached: ${LEFT} job(s) stay in the inbox for the next run (raise decoder.cap to take them now)`);
if (files.length && PROFILE.facts.trim().length < 50) { log('decoder: profile/profile.md is missing or empty; not decoding (every verdict would ignore you). Run the onboarding first.'); process.exit(2); }
// A job whose decode keeps failing (model refusal, timeout) is retried decoder.max_tries times, then moved to
// rejected/ as "failed" and named in the digest, so it cannot take a cap slot every evening forever.
const TRIES_FILE = STATE('decode-failures.json'); const tries = readJson(TRIES_FILE, {});
const done = [], failed = [], gaveUp = [];
for (const f of files) {
  try {
    const v = await decodeOne(f); const job = loadJob(f);
    const dest = ['gate-reject', 'weak-fit'].includes(v.verdict) ? DIRS.rejected : DIRS.decoded;
    if (!DRY) { fs.writeFileSync(path.join(dest, f), job.text.trimEnd() + '\n' + resultBlock(v), 'utf8'); fs.rmSync(job.path); delete tries[f]; }
    done.push({ file: f, fm: job.fm, v }); log(`${f}: ${v.verdict}`);
  } catch (e) {
    log(`${f}: FAILED ${e.message}`);
    if (DRY) { failed.push({ file: f, error: e.message }); continue; }
    tries[f] = (tries[f] || 0) + 1;
    if (tries[f] >= MAX_TRIES) {
      try { const job = loadJob(f); fs.writeFileSync(path.join(DIRS.rejected, f), job.text.trimEnd() + `\n\n## Decode Result\nDecoded ${today()} by jobpilot: gave up after ${tries[f]} failed attempts.\nverdict: failed\nrationale: ${e.message.replace(/\s+/g, ' ').slice(0, 300)}\n`, 'utf8'); fs.rmSync(job.path); } catch { /* leave it */ }
      delete tries[f]; gaveUp.push({ file: f, error: e.message });
    } else failed.push({ file: f, error: e.message });
  }
}
if (!DRY) fs.writeFileSync(TRIES_FILE, JSON.stringify(tries, null, 1));
const pk = await buildPicks(DRY ? done : []);
if (!DRY) recordPicks(pk.picks);
if (!done.length && !failed.length && !gaveUp.length && !pk.picks.length) { log(`nothing new and no picks${LEFT ? ` (${LEFT} waiting in the inbox)` : ''}`); process.exit(0); }
const worth = done.filter(d => APPLY_WORTHY.includes(d.v.verdict)), held = done.filter(d => ['long-shot', 'unreadable'].includes(d.v.verdict)), rej = done.filter(d => ['gate-reject', 'weak-fit'].includes(d.v.verdict));
const L = [...picksText(pk), `${SETTINGS.candidate_name}: ${done.length} decoded ${today()}${DRY ? ' (dry run)' : ''}`, ''];
if (worth.length) L.push(`Worth applying (${worth.length})`, ...worth.flatMap((d, i) => [`${i + 1}. ${d.fm.company}: ${d.fm.role} [${String(d.fm.location || '').slice(0, 60)}] ${label(d.v.verdict)}, p${d.v.apply_priority}`, `   ${d.v.action}`, ...(d.v.fact_flags?.length ? [`   Fact check: ${d.v.fact_flags.map(x => x.why).join(' ')}`] : []), `   ${d.fm.url || ''}`]), '');
if (held.length) L.push(`Held (${held.length})`, ...held.flatMap(d => [`- ${d.fm.company}: ${d.fm.role}`, `   Why held: ${d.v.hold_reason || d.v.rationale}`, `   ${d.fm.url || ''}`]), '');
if (rej.length) L.push(`Rejected (${rej.length})`, ...rej.map(d => `- ${d.fm.company}: ${d.v.gate || 'weak fit'}`), '');
if (failed.length) L.push(`Failed (${failed.length}), will retry: ${failed.map(f => f.file).join(', ')}`);
if (gaveUp.length) L.push(`Gave up after ${MAX_TRIES} failed tries (${gaveUp.length}), moved to rejected/: ${gaveUp.map(f => f.file).join(', ')}`);
if (LEFT) L.push(`Waiting (${LEFT}): decoder.cap ${CAP} reached, the rest are decoded next run.`);
const text = L.join('\n');
// A dry run never touches the digest; a second real run on the same day is appended, not written over the first.
if (!DRY) { const dg = path.join(DIRS.digests, `${today()}.md`); fs.existsSync(dg) ? fs.appendFileSync(dg, `\n---\n\n${text}\n`, 'utf8') : fs.writeFileSync(dg, text + '\n', 'utf8'); }
console.log('\n' + text);
if (!NO_TG) { try { await sendText(text); } catch (e) { log(`telegram failed: ${e.message}`); process.exitCode = 3; } }
if (failed.length) process.exitCode = process.exitCode || 1;

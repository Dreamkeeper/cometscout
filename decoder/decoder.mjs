#!/usr/bin/env node
// Decoder: judge each new job in data/inbox against the candidate profile, move it to decoded/ or rejected/,
// choose today's "Apply today" picks, write a digest and send it to Telegram.
// Usage: node decoder/decoder.mjs [--dry-run] [--no-telegram] [--picks] [--cap 30]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, PROFILE, DIRS, STATE, read, readJson, today, log, num, isMain } from '../lib/config.mjs';
import { envVar } from '../lib/legacy-names.mjs';
import { loadJob, parseResult, frontMatter, norm, readApplications, laterOnly } from '../lib/queue.mjs';
import { callJson } from '../lib/llm.mjs';
import { sendText } from '../lib/telegram.mjs';
import { runHook } from '../lib/hooks.mjs';
import { aliasFamilies, companyMatch, sameRole } from '../lib/companies.mjs';
import { laterUntil } from '../lib/applications.mjs';
import { APPLY_WORTHY, picksText, digestText, prepLines } from './digest.mjs';
import { offDay, nowTime, prepState, prepOf, prepQualifies } from '../lib/schedule.mjs';
import { translator } from '../lib/i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const DRY = flag('dry-run'), NO_TG = flag('no-telegram') || DRY, PICKS_ONLY = flag('picks');
const CAP = num((i => (i >= 0 ? args[i + 1] : null))(args.indexOf('--cap')) ?? SETTINGS.decoder?.cap, 30, 1);
const MAX_TRIES = num(SETTINGS.decoder?.max_tries, 3, 1);
const MIN_TEXT = 300;
const SCHEMA = JSON.parse(read(path.join(HERE, 'verdict.schema.json')));
export const DEFAULT_PROMPT_FILE = path.join(HERE, 'prompt.md');
// decoder.prompt_file: the user's own prompt (absolute, or relative to the profile folder) instead of decoder/prompt.md,
// with the same {{NAME}} and {{PROFILE}} placeholders.
export function promptFile() {
  const f = SETTINGS.decoder?.prompt_file;
  if (!f) return DEFAULT_PROMPT_FILE;
  return path.isAbsolute(f) ? f : path.join(PROFILE.dir, f);
}
/** The decode prompt with the placeholders filled in; throws when decoder.prompt_file names a missing file. */
export function buildPrompt(file = promptFile()) {
  if (!fs.existsSync(file)) throw new Error(`decoder.prompt_file not found: ${file}`);
  // Replacement functions, not strings: "$$" or "$&" inside the profile must reach the model unchanged.
  return read(file).replaceAll('{{NAME}}', () => SETTINGS.candidate_name).replaceAll('{{PROFILE}}', () => PROFILE.facts || '(no profile yet: run onboarding)');
}
// decoder.context_files: extra files from the profile folder (or absolute paths) added after the profile, e.g. notes on
// targeting or a CV analysis kept up to date by a hook. "dir/*.md" takes every .md file in that folder. Total size is
// capped by decoder.context_max_chars (default 40000); the profile itself stays the authority.
export function contextBlock() {
  const max = num(SETTINGS.decoder?.context_max_chars, 40000, 1000);
  const files = [];
  for (const entry of SETTINGS.decoder?.context_files || []) {
    const abs = path.isAbsolute(entry) ? entry : path.join(PROFILE.dir, entry);
    if (/\*\.md$/.test(abs)) { const dir = path.dirname(abs); if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md')).sort()) files.push(path.join(dir, f)); }
    else if (fs.existsSync(abs)) files.push(abs);
    else log(`decoder: context file not found: ${entry}`);
  }
  let out = '', used = 0;
  for (const f of files) {
    const t = read(f).trim(); if (!t) continue;
    const room = max - used; if (room < 200) { log(`decoder: context_max_chars reached, skipped ${path.basename(f)} and later files`); break; }
    const part = `### ${path.basename(f, '.md')}\n${t.length > room ? t.slice(0, room) + '\n[... truncated]' : t}\n\n`;
    out += part; used += part.length;
  }
  return out ? `\n\n## Further context from the candidate's own files (may lag the profile above; the profile wins)\n\n${out.trim()}` : '';
}
export { APPLY_WORTHY };

// ---------- applications (the user's own record of what happened) ----------
export const APPS_FILE = STATE('applications.json');
// Strict, like the sources: a broken file throws instead of reading as "no applications", which would bring back
// roles already applied to as picks. main() checks it before anything else.
export const apps = () => readApplications(APPS_FILE);
// What the candidate recorded (applied, rejected, offer ...) always reaches the model, newest first; past decodes,
// newest first, fill the remaining lines. A long history must never drop "they already rejected me".
// The company matches through alias families (lib/companies.mjs), so "Acme" also finds "Acme Robotics".
// before (YYYY-MM-DD) shows the world as it was on that day (evals use it so a job's own outcome cannot leak into its
// decode): an application counts when it was updated or has an event before that day; when it changed later, its
// status is the one its last earlier event set, dated by that event, and the later note is left out. Decodes count
// when made before that day. excludeFile leaves out that job's own application entry and decode.
const EVENT_STATUS = { rejection: 'rejected', interview: 'interview', test_task: 'interview', offer: 'offer', application_received: 'applied' };
const STATUS_WORDS = new Set(['applied', 'screen', 'interview', 'offer', 'accepted', 'rejected', 'skipped', 'closed', 'withdrawn']);
const statusOfEvent = e => EVENT_STATUS[e.type] || (STATUS_WORDS.has(e.type) ? e.type : null);
const byDate = (x, y) => (String(x.date || '') < String(y.date || '') ? -1 : String(x.date || '') > String(y.date || '') ? 1 : 0);
/** One application as the history shows it on a given day: { date, status, note, events } or null when it did not exist yet. */
export function asOf(a, before = null) {
  const all = Array.isArray(a.events) ? a.events.filter(e => e && typeof e === 'object') : [];
  if (!before) return { date: a.updated, status: a.status, note: a.note, events: all };
  const events = all.filter(e => e.date && String(e.date) < before).sort(byDate);
  if (a.updated && String(a.updated) < before) return { date: a.updated, status: a.status, note: a.note, events };
  if (!events.length) return null;
  // the last event that set a status; an email never moves an accepted application (sources/outcomes.mjs USER_ONLY)
  let set = null;
  for (const e of events) if (statusOfEvent(e) && !(set && statusOfEvent(set) === 'accepted' && e.source === 'gmail')) set = e;
  set = set || events[events.length - 1];
  return { date: set.date, status: statusOfEvent(set) || set.type || 'applied', note: null, events };
}
export function history(company, { before = null, excludeFile = null } = {}) {
  const fams = aliasFamilies(); const recorded = [], decodes = [];
  for (const [key, a] of Object.entries(apps())) {
    if (!a || key === excludeFile || laterOnly(a) || !companyMatch(a.company, company, fams)) continue;
    const s = asOf(a, before); if (!s) continue;
    // "later" (the workspace's "not now") says nothing about the employer
    const ev = s.events.filter(e => e.type !== 'later').slice(-3).map(e => `${e.date || '?'} ${e.type || ''}${e.note ? ` (${String(e.note).slice(0, 120)})` : ''}`).join('; ');
    recorded.push({ d: s.date || '', line: `- ${s.date}: ${a.role}: ${s.status}${s.note ? ` (${s.note})` : ''}${ev ? ` [events: ${ev}]` : ''} [recorded by the candidate]` });
  }
  for (const dir of ['decoded', 'rejected']) for (const f of fs.readdirSync(DIRS[dir])) {
    if (!f.endsWith('.md') || f === excludeFile) continue; const t = read(path.join(DIRS[dir], f)); const fm = frontMatter(t);
    if (!companyMatch(fm.company, company, fams)) continue;
    const v = parseResult(t); const d = v.decoded_on || f.slice(0, 10);
    if (!before || d < before) decodes.push({ d, line: `- ${d}: decoded "${fm.role}": ${v.verdict}` });
  }
  const newest = list => list.sort((x, y) => (x.d < y.d ? 1 : x.d > y.d ? -1 : 0)).map(x => x.line);
  const lines = [...newest(recorded).slice(0, 20), ...newest(decodes).slice(0, Math.max(5, 15 - recorded.length))];
  return lines.length ? lines.join('\n') : '(nothing before with this company)';
}

// ---------- fact check: regex guards from profile/fact-rules.json ----------
// A rule with "guard": true ignores a match the candidate denies ("was never the first PM") or that names the
// employer's opening ("the first PM hire"): a negation word in the 50 characters before it, or an employer word
// right after it.
const NEGATION = /(?<![\p{L}\p{N}'’])(?:never|not|no|nor|without|wasn['’]t|isn['’]t)(?![\p{L}\p{N}'’])/giu;
// A prefix match, as in the original ("hired by", "roles", "requisition" count too), plus "hiring", which does not
// start with "hire".
const EMPLOYER_WORD = /^\s*(hire|hiring|mandate|role|req|seat|:)/i;
function denied(text, at, len) {
  for (const m of text.slice(0, at).matchAll(NEGATION)) if (m.index >= at - 50) return true;
  return EMPLOYER_WORD.test(text.slice(at + len, at + len + 12));
}
/** Fact-rule hits in a verdict: [{ id, why, excerpt }], at most one per rule (its first counted match). */
export function factFlags(v, rules = PROFILE.factRules) {
  const text = [v.rationale, v.action, v.hold_reason, ...(v.fit_signals || []), ...(v.gaps || [])].filter(x => x != null && x !== '').join(' \n ');
  const out = [];
  for (const r of rules) {
    let re; try { re = new RegExp(r.pattern ?? r.re.source, 'gi'); } catch { continue; }   // doctor reports broken rules
    for (const m of text.matchAll(re)) {
      if (!m[0] || (r.guard && denied(text, m.index, m[0].length))) continue;
      out.push({ id: r.id, why: r.why, excerpt: m[0].slice(0, 80) }); break;
    }
  }
  return out;
}

async function decodeOne(file, prompt) {
  const job = loadJob(file);
  if (job.fm.full_text === 'missing' || job.body.replace(/^#.*$/m, '').trim().length < MIN_TEXT) {
    return { verdict: 'unreadable', confidence: 'low', rationale: 'No readable job text; open the link and judge by hand.', fit_signals: [], gaps: [], action: 'Open the link and decide manually.' };
  }
  const input = `${prompt}\n\n## History with ${job.fm.company}\n${history(job.fm.company)}\n\n## Job file\n\n${job.text.slice(0, 16000)}\n`;
  const { value } = await callJson({ prompt: input, schema: SCHEMA, model: SETTINGS.llm.model });
  if (!value.verdict) throw new Error('no verdict');
  value.fact_flags = factFlags(value);
  return value;
}
function resultBlock(v) {
  return ['', '## Decode Result', `Decoded ${today()} by CometScout (${SETTINGS.llm.provider}${SETTINGS.llm.model ? `/${SETTINGS.llm.model}` : ''}).`,
    `verdict: ${v.verdict}${v.gate ? ` (${v.gate})` : ''}`, `confidence: ${v.confidence}`, v.apply_priority ? `apply_priority: ${v.apply_priority}` : null,
    `rationale: ${v.rationale}`, `fit_signals: ${(v.fit_signals || []).join('; ')}`, `gaps: ${(v.gaps || []).join('; ') || 'none'}`, `action: ${v.action}`,
    v.hold_reason ? `hold_reason: ${v.hold_reason}` : null, v.fact_flags?.length ? `fact_flags: ${v.fact_flags.map(f => f.id).join(', ')}` : null].filter(x => x !== null).join('\n') + '\n';
}

// ---------- picks ----------
const PICKS_FILE = STATE('picks.json');
// Work-shape words are matched on the location as written (lowercase, Latin accents dropped), as whole words where
// "_" is part of a word: "Lisbon, PT (remote_scope: none)" names no remote work. ё and е are one letter here.
const shapeText = loc => String(loc || '').toLowerCase().normalize('NFKD').replace(/([a-z])\p{M}+/gu, '$1').normalize('NFC').replace(/ё/g, 'е');
const W = words => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words})(?![\\p{L}\\p{N}_])`, 'u');
const REMOTE = W('remote|remoto|anywhere|worldwide'), ONSITE = W('hybrid|onsite|on[\\s-]+site|office');
// Queue files imported from the original pipeline carry "(remote_scope: <value>)": any value but "none" (geo_restricted,
// country, worldwide ...) is remote work, as there.
const REMOTE_SCOPE = /(?<![\p{L}\p{N}_])remote_scope\s*:\s*([\p{L}\p{N}_-]+)/u;
const remoteShape = loc => {
  const l = shapeText(loc), scope = (l.match(REMOTE_SCOPE) || [])[1];
  return { remote: REMOTE.test(l) || /udalen|удален/.test(l) || (!!scope && scope !== 'none'), onsite: ONSITE.test(l) || /гибрид/.test(l) };
};
const fullyRemote = loc => { const { remote, onsite } = remoteShape(loc); return remote && !onsite; };
// A user-edited regex: a typo stops the run with the setting's name instead of silently matching nothing.
const settingRegex = (v, key) => { if (!v) return null; try { return new RegExp(v, 'i'); } catch (e) { throw new Error(`picks.${key} is not a valid regex (${e.message})`); } };
// Location regexes from settings match the location as written or normalised ("espana" matches "España").
const locMatches = (re, loc) => !!re && (re.test(String(loc || '')) || re.test(norm(loc)));
/**
 * 0 fully remote, 1.5 remote with office days, 2 on-site; lower is better. picks.shape_bonus
 * ([{ location_regex, rank }]): the first entry whose regex matches the location sets the rank of a job that is not
 * fully remote (a city you would happily commute to).
 */
export function shapeRank(loc, bonus = SETTINGS.picks?.shape_bonus) {
  const { remote, onsite } = remoteShape(loc);
  if (remote && !onsite) return 0;
  for (const [i, b] of (Array.isArray(bonus) ? bonus : []).entries()) {
    if (locMatches(settingRegex(b?.location_regex, `shape_bonus[${i}].location_regex`), loc)) return num(b.rank, remote ? 1.5 : 2, 0, 10);
  }
  return remote ? 1.5 : 2;
}
// A closed posting must not become a pick. Greenhouse and Lever answer 404; Ashby pages are an app shell that
// answers 200 for any id, so Ashby is asked through its public GraphQL (null posting = closed); LinkedIn and
// other boards are checked for "no longer accepting" style text; hh.ru and Hirify mark archived vacancies on the page.
// Network errors, 403 and 429 count as alive (never drop on doubt).
const DEAD_TEXT = /No longer accepting applications|This job is no longer available|job (?:posting )?(?:has been )?closed|This vacancy is archived|Вакансия в архиве|Эта вакансия в архиве/i;
// hh.ru: only markers of the vacancy itself. The page's embedded state also lists other vacancies, which may be archived.
const HH_PAGE = /(^|[/.])hh\.ru\/vacancy\//i, HH_DEAD = /data-qa="vacancy-title-archived-text"|В архиве с|Вакансия в архиве|vacancy-archived/;
const HIRIFY_PAGE = /(^|[/.])hirify\.me\/jobs\//i, HIRIFY_DEAD = /Эта вакансия в архиве|This vacancy is archived/i;
export async function linkAlive(url, { fetch = globalThis.fetch } = {}) {
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
    if (r.status === 404 || r.status === 410 || /[?&]error=true/.test(r.url || '')) return false;
    if (r.ok) {
      const page = await r.text();
      if (DEAD_TEXT.test(page) || (HH_PAGE.test(url) && HH_DEAD.test(page)) || (HIRIFY_PAGE.test(url) && HIRIFY_DEAD.test(page))) return false;
    }
    return true;
  } catch { return true; }
}
// Statuses that mean the user already acted on a role; any recorded event counts too.
export const CLOSED_STATUSES = new Set(['applied', 'screen', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn', 'closed', 'skipped']);
const knownCompany = c => !!norm(c) && norm(c) !== 'unknown';
/**
 * A pool job is closed when its own file is an application, or an application the user acted on (a closed status or
 * any event) is at the same employer (alias families) for the same role (sameRole: half the words shared, no
 * stoplist; a role with no readable words on either side is taken as the same process).
 */
export function closedRole(job, A, fams = aliasFamilies()) {
  if (A[job.file] && !laterOnly(A[job.file])) return true;
  return Object.values(A).some(a => a && !laterOnly(a) && (CLOSED_STATUSES.has(a.status) || (a.events || []).length) && companyMatch(a.company, job.fm.company, fams) && sameRole(a.role, job.fm.role));
}
// The board's band (1 best to 4), when a source gives one; unknown counts as the middle.
const band = fm => { const b = Number(fm.band); return fm.band !== undefined && fm.band !== '' && b >= 1 && b <= 4 ? b : 2.5; };
const picksSettings = () => ({ ...SETTINGS.picks, per_day: num(SETTINGS.picks.per_day, 2, 0, 10), window_days: num(SETTINGS.picks.window_days, 14, 1), max_shown: num(SETTINGS.picks.max_shown, 3, 1) });
/**
 * The jobs picks choose from, best first, with no network call: every apply-worthy decode in picks.window_days that
 * is not closed for picks (a known company, no application for the role, shown fewer than picks.max_shown times,
 * not excluded by location). extra: decodes not yet written (a dry run). Returns { open, state, A, fams }.
 * The workspace's pool (lib/workspace.mjs) is this list.
 */
export function picksPool(extra = []) {
  const P = picksSettings();
  const since = Date.now() - P.window_days * 86400000, state = readJson(PICKS_FILE, {}), A = apps(), fams = aliasFamilies();
  const excludeLoc = settingRegex(P.exclude_location_regex, 'exclude_location_regex');
  const excludeOnsite = settingRegex(P.exclude_onsite_location_regex, 'exclude_onsite_location_regex');
  const pool = [];
  for (const f of fs.readdirSync(DIRS.decoded).filter(x => x.endsWith('.md'))) {
    const t = read(path.join(DIRS.decoded, f)); const v = parseResult(t);
    if (!APPLY_WORTHY.includes(v.verdict) || Date.parse(v.decoded_on || f.slice(0, 10)) < since) continue;
    pool.push({ file: f, fm: frontMatter(t), v });
  }
  for (const d of extra) if (APPLY_WORTHY.includes(d.v.verdict) && !pool.some(p => p.file === d.file)) pool.push(d);
  const open = pool.filter(c => knownCompany(c.fm.company) && !closedRole(c, A, fams) && (state[c.file]?.shown || 0) < P.max_shown
    && !locMatches(excludeLoc, c.fm.location) && !(locMatches(excludeOnsite, c.fm.location) && !fullyRemote(c.fm.location)));
  const score = c => (c.v.apply_priority || 5) * 10 + shapeRank(c.fm.location, P.shape_bonus) * 4 + band(c.fm) + Math.min((Date.now() - Date.parse(c.v.decoded_on || today())) / 86400000, 10) * 0.3 + (state[c.file]?.shown || 0) * 2;
  open.sort((a, b) => score(a) - score(b));
  return { open, state, A, fams };
}
/** Today's picks: { picks, open }. max (default picks.per_day) and only (a filter) narrow them; prep mode uses both. */
export async function buildPicks(extra = [], { fetch = globalThis.fetch, max = null, only = null } = {}) {
  const P = picksSettings(), limit = max ?? P.per_day;
  const { open, A, fams } = picksPool(extra);
  const picks = [];
  for (const c of open) {
    if (picks.length >= limit) break;
    if (only && !only(c)) continue;
    if ((laterUntil(A[c.file]) || '') > today()) continue;   // "later" in the workspace: not a pick before that day
    if (picks.some(p => companyMatch(p.fm.company, c.fm.company, fams))) continue;
    if (await linkAlive(c.fm.url, { fetch })) picks.push(c); else log(`pick skipped, dead link: ${c.file}`);
  }
  return { picks, open: open.length };
}
/**
 * Picks with interview prep mode (lib/schedule.mjs): before an interview only roles that qualify, at most
 * picks.prep.max. Returns { picks, open, prep } where prep is null or { interview, days, step, wait } (wait: the
 * open roles not shown, which keep their showings).
 */
export async function choosePicks(extra = [], { fetch = globalThis.fetch, date = today(), time = nowTime(), A = apps() } = {}) {
  const prep = prepState({ apps: A, day: date, time });
  if (!prep) return { ...(await buildPicks(extra, { fetch })), prep: null };
  const P = prepOf();
  const pk = await buildPicks(extra, { fetch, max: P.max, only: c => prepQualifies(c, date, P) });
  return { ...pk, prep: { ...prep, wait: Math.max(0, pk.open - pk.picks.length) } };
}
export function recordPicks(picks, day = today()) { const s = readJson(PICKS_FILE, {}); for (const p of picks) s[p.file] = { shown: (s[p.file]?.shown || 0) + 1, last: day }; fs.writeFileSync(PICKS_FILE, JSON.stringify(s, null, 1)); }

// ---------- after decoding: off days, prep mode, the digest ----------
// data/state/digest-days.json { held: [{ date, decoded, worth }] }: off days whose digest was held back (cli.mjs run
// only); the next digest names them in one line and clears the list.
const DIGEST_DAYS_FILE = STATE('digest-days.json');
/**
 * Picks, the digest, its file and Telegram, after the decode step. evening: called from cli.mjs run, where an off
 * day (not in schedule.days) writes the digest with an off-day line, sends nothing, shows and counts no picks.
 * send, fetch, date and time are injected by tests. Returns { text, pk, off, sendError }.
 */
export async function finishRun({ done = [], failed = [], gaveUp = [], left = 0, cap = CAP, dry = false, noTg = false, evening = false, date = today(), time = nowTime(), send = sendText, fetch = globalThis.fetch } = {}) {
  const off = evening && offDay(date);
  const days = readJson(DIGEST_DAYS_FILE, {}); const held = Array.isArray(days.held) ? days.held : [];
  const extra = dry ? done : [];
  const pk = off ? { picks: [], open: picksPool(extra).open.length, prep: null } : await choosePicks(extra, { fetch, date, time });
  if (!dry && !off) { recordPicks(pk.picks, date); if (pk.picks.length) runHook('picks', { date, picks: pk.picks.map(p => ({ file: p.file, company: p.fm.company, role: p.fm.role, url: p.fm.url || null, verdict: p.v.verdict, apply_priority: p.v.apply_priority ?? null })) }); }
  const back = off ? [] : held.filter(h => h.date < date);
  if (!off && !done.length && !failed.length && !gaveUp.length && !pk.picks.length && !pk.prep && !back.length) { log(`nothing new and no picks${left ? ` (${left} waiting in the inbox)` : ''}`); return { text: null, pk, off, sendError: null }; }
  const text = digestText({ name: SETTINGS.candidate_name, date, dry, done, failed, gaveUp, pk, left, cap, maxTries: MAX_TRIES, off: off ? date : null, held: back });
  // A dry run never touches the digest; a second real run on the same day is appended, not written over the first.
  if (!dry) {
    const dg = path.join(DIRS.digests, `${date}.md`); fs.existsSync(dg) ? fs.appendFileSync(dg, `\n---\n\n${text}\n`, 'utf8') : fs.writeFileSync(dg, text + '\n', 'utf8');
    const worth = done.filter(d => APPLY_WORTHY.includes(d.v.verdict)).length;
    if (off) {
      const same = held.find(h => h.date === date);
      if (same) { same.decoded = (same.decoded || 0) + done.length; same.worth = (same.worth || 0) + worth; } else held.push({ date, decoded: done.length, worth });
      fs.writeFileSync(DIGEST_DAYS_FILE, JSON.stringify({ ...days, held }, null, 1));
    } else if (back.length) fs.writeFileSync(DIGEST_DAYS_FILE, JSON.stringify({ ...days, held: held.filter(h => h.date >= date) }, null, 1));
  }
  console.log('\n' + text);
  let sendError = null;
  if (!noTg && !off) { try { await send(text); } catch (e) { log(`telegram failed: ${e.message}`); sendError = e; } }
  if (off) log(`off day (${date} is not in schedule.days): digest written to data/digests, not sent; no picks shown`);
  return { text, pk, off, sendError };
}

// ---------- main ----------
async function main() {
  try { apps(); } catch (e) { log(`decoder: ${e.message}; nothing decoded, no picks.`); process.exit(2); }
  if (PICKS_ONLY) {
    const pk = await choosePicks(), t = translator();
    console.log([...prepLines(pk.prep, t), ...(pk.prep && !pk.picks.length ? [t('prep.wait', { n: pk.prep.wait })] : []), ...picksText(pk)].join('\n') || t('picks.none', { open: pk.open }));
    process.exit(0);
  }
  // CometScout's own sources finish before decode starts, so no settle time is needed. If an outside producer writes
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
  let prompt = '';
  if (files.length) { try { prompt = buildPrompt() + contextBlock(); } catch (e) { log(`decoder: ${e.message}; not decoding (fix decoder.prompt_file in settings.json)`); process.exit(2); } }
  // A job whose decode keeps failing (model refusal, timeout) is retried decoder.max_tries times, then moved to
  // rejected/ as "failed" and named in the digest, so it cannot take a cap slot every evening forever.
  const TRIES_FILE = STATE('decode-failures.json'); const tries = readJson(TRIES_FILE, {});
  const done = [], failed = [], gaveUp = [];
  for (const f of files) {
    try {
      const v = await decodeOne(f, prompt); const job = loadJob(f);
      const dest = ['gate-reject', 'weak-fit'].includes(v.verdict) ? DIRS.rejected : DIRS.decoded;
      if (!DRY) { fs.writeFileSync(path.join(dest, f), job.text.trimEnd() + '\n' + resultBlock(v), 'utf8'); fs.rmSync(job.path); delete tries[f]; }
      done.push({ file: f, fm: job.fm, v }); log(`${f}: ${v.verdict}`);
      if (!DRY) runHook('decoded', { file: f, dir: path.basename(dest), company: job.fm.company, role: job.fm.role, url: job.fm.url || null, source: job.fm.source || null,
        verdict: v.verdict, gate: v.gate || null, confidence: v.confidence || null, apply_priority: v.apply_priority ?? null, action: v.action || null, fact_flags: v.fact_flags || [] });
    } catch (e) {
      log(`${f}: FAILED ${e.message}`);
      if (DRY) { failed.push({ file: f, error: e.message }); continue; }
      tries[f] = (tries[f] || 0) + 1;
      if (tries[f] >= MAX_TRIES) {
        try { const job = loadJob(f); fs.writeFileSync(path.join(DIRS.rejected, f), job.text.trimEnd() + `\n\n## Decode Result\nDecoded ${today()} by CometScout: gave up after ${tries[f]} failed attempts.\nverdict: failed\nrationale: ${e.message.replace(/\s+/g, ' ').slice(0, 300)}\n`, 'utf8'); fs.rmSync(job.path); } catch { /* leave it */ }
        delete tries[f]; gaveUp.push({ file: f, error: e.message });
      } else failed.push({ file: f, error: e.message });
    }
  }
  if (!DRY) fs.writeFileSync(TRIES_FILE, JSON.stringify(tries, null, 1));
  // COMETSCOUT_EVENING is set by cli.mjs run: off days (schedule.days) apply to the evening run only
  const r = await finishRun({ done, failed, gaveUp, left: LEFT, dry: DRY, noTg: NO_TG, evening: envVar('EVENING') === '1' });
  if (r.sendError) process.exitCode = 3;
  if (failed.length) process.exitCode = process.exitCode || 1;
}
// Imported by tests and cli.mjs for its exports; run as a script, it decodes.
if (isMain(import.meta.url)) await main();

#!/usr/bin/env node
// Source: Hirify (hirify.me), remote and relocation jobs with structured fields (work format, allowed and excluded
// locations, language requirements). The API needs the user's logged-in session cookie.
// settings.sources.hirify = { enabled: true, cookie_env: "HIRIFY_COOKIE", filters: [{ name, query }],
//   max_pages_per_filter: 3, max_age_days: 14, delay_ms: 1500, title_exclude: [] }
// query is the query string of a saved filter on the site (the part after "?" in the address bar; a whole address
// works too). The cookie lives only in .env; cookies the server refreshes (set-cookie) are kept in
// data/state/hirify-cookies.json (mode 600) and used on the next run, until the .env value changes.
// Requests carry a normal browser User-Agent with Origin and Referer set to hirify.me, as the site itself sends;
// without them the edge can answer 403, which would look like an expired session.
// Session check first: /auth/user must return a user as JSON, and page 1 of the first filter must not hide every
// company (5 or more items, all masked as "***", "•••" or "%...%"). Otherwise, or on a 401/403/419 (or a redirect)
// at any point, or an HTML page (a login page) instead of JSON on /auth/user, the source prints
// "refresh HIRIFY_COOKIE", sends a Telegram alert when delivery is on, and exits 3, which cli.mjs reports as a
// failed run. It never returns zero jobs quietly.
// A 429 stops the run at once (exit 4): state is kept and the vacancy in hand is not marked seen. A Retry-After of
// up to 2 minutes is waited out and the request tried once more; a longer one is kept in the state file
// (blocked_until), and runs before that time make no request and exit 4.
// Per vacancy: scams (is_scam, is_potential_scam) are counted under gate "scam", archived ones as unavailable, both
// straight from the list when it says so (no detail call), else from the detail call. A company that stays masked
// with a working session is queued as "Confidential (Hirify)" with a flag; a masked apply_url is replaced by the
// Hirify link, with a flag. settings.gates (lib/gates.mjs) applies to the rest; demotes go to
// data/state/demoted.jsonl. Remote with no allowed locations, with only worldwide words (anywhere, worldwide,
// global, everywhere), or with remote_type "global" is worldwide; snake_case names ("united_kingdom") are read as
// words.
// State data/state/hirify.json: { seen: { id: { first_seen, status } }, demoted: { id: first_seen }, blocked_until? }.
// Demoted and unreadable vacancies are not marked seen; entries older than 120 days are pruned.
// Usage: node sources/hirify.mjs [--dry-run] [--no-telegram]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SETTINGS, STATE, read, log, num, today, isMain } from '../lib/config.mjs';
import { writeJob, matchesAny, htmlText, applications } from '../lib/queue.mjs';
import { checkGates, countriesIn, gateTally, settle } from '../lib/gates.mjs';
import { secretEnvName } from '../lib/env-names.mjs';

export const API = 'https://api.hirify.me';
export const SITE = 'https://hirify.me';
export const EXIT_SESSION = 3;            // the user must act (expired or missing session); cli.mjs reports the run as failed
export const EXIT_RATE_LIMITED = 4;       // Hirify answered 429; nothing lost, the next run tries again
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const RETRY_WAIT_MAX_MS = 120e3;          // a Retry-After up to this long is waited out once; a longer one stops the run
const SESSION_STATUS = new Set([401, 403, 419]);
export const CONFIDENTIAL = 'Confidential (Hirify)';
const PRUNE_DAYS = 120;
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- small readers: every field may be missing or written oddly, so none of them throws ----------
const str = v => (v == null ? '' : typeof v === 'object' ? String(v.name ?? v.title ?? v.value ?? v.country ?? '') : String(v)).trim();
const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(str).filter(Boolean);
/** A field Hirify hides: only "*", "•" (and spaces) or nothing, or a placeholder wrapped in percent signs ("%...%"). */
export const isMasked = name => { const s = String(name ?? '').trim(); return /^[*•\s]*$/.test(s) || /^%.*%$/.test(s); };
const WORLDWIDE = /^(anywhere|worldwide|global|everywhere)$/i;
/** A location as words: "united_kingdom" -> "united kingdom". */
const places = v => list(v).map(x => x.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);

// Language names (English and Russian, from the runtime's ICU data) -> ISO 639-1, so "German" and "Немецкий" both
// read as "de". A name that cannot be read is flagged, never passed to the gates as a requirement.
let LANG_NAMES = null;
function langCode(v) {
  const s = str(v).toLowerCase(); if (!s) return null;
  if (/^[a-z]{2}([-_][a-z0-9]+)?$/.test(s)) return s.slice(0, 2);
  if (!LANG_NAMES) {
    LANG_NAMES = new Map();
    for (const loc of ['en', 'ru']) {
      let d; try { d = new Intl.DisplayNames([loc], { type: 'language' }); } catch { continue; }
      for (let a = 97; a <= 122; a++) for (let b = 97; b <= 122; b++) {
        const code = String.fromCharCode(a, b); let name; try { name = d.of(code); } catch { continue; }
        if (name && name.toLowerCase() !== code && !LANG_NAMES.has(name.toLowerCase())) LANG_NAMES.set(name.toLowerCase(), code);
      }
    }
  }
  return LANG_NAMES.get(s) || null;
}
const LEVEL = /^(a1|a2|b1|b2|c1|c2|native|fluent)$/i;
/** language_requirements: [{ language, level }] or strings like "German C1". Unreadable entries come back as notes. */
function readRequirements(v) {
  const out = [], notes = [];
  for (const r of Array.isArray(v) ? v : v == null ? [] : [v]) {
    let name = '', level = '';
    if (r && typeof r === 'object') { name = str(r.language ?? r.lang ?? r.name); level = str(r.level); }
    else { const parts = str(r).split(/\s+/); if (parts.length > 1 && LEVEL.test(parts[parts.length - 1])) level = parts.pop(); name = parts.join(' '); }
    const lang = langCode(name);
    if (lang) out.push({ lang, level: level.toLowerCase() });
    else if (name) notes.push(`language: "${name}${level ? ` ${level}` : ''}" wanted, not recognised`);
  }
  return { out, notes };
}
/** A location name (or ISO code) as ISO country codes; [] when it names no country plainly. */
const countryCodes = name => (/^[a-z]{2}$/i.test(name) ? [name.toUpperCase()] : countriesIn(name));
const ATTENDANCE = { remote: 'remote', hybrid: 'hybrid', office: 'office', onsite: 'office', 'on-site': 'office', on_site: 'office', relocation: 'office' };
const SPONSOR = v => (v === true || /^(yes|true|available|provided)$/i.test(str(v)) ? 'AVAILABLE'
  : v === false || /^(no|false|not_available|not available|none)$/i.test(str(v)) ? 'NOT_AVAILABLE' : null);

/** Normalised gates job from a Hirify vacancy, plus notes (fields that could not be read; they become flags). */
export function fromHirify(v) {
  const notes = [];
  const formats = list(v?.work_format);
  const attendance = [...new Set(formats.map(f => ATTENDANCE[f.toLowerCase()]).filter(Boolean))];
  for (const f of formats) if (!ATTENDANCE[f.toLowerCase()]) notes.push(`work format "${f}" not recognised`);
  const offices = places(v?.office_locations), countries = [];
  for (const o of offices) { const c = countryCodes(o); if (c.length) countries.push(...c); else notes.push(`office location "${o}" not recognised`); }
  const allowed = places(v?.allowed_locations), excluded = [];
  for (const x of places(v?.excluded_locations)) {
    const c = countryCodes(x);
    if (c.length) excluded.push(...c); else { excluded.push(x); notes.push(`remote: excludes "${x}", check it`); }
  }
  const isRemote = attendance.includes('remote');
  // only worldwide words, or remote_type "global": worldwide, not a region limit named "anywhere"
  const worldwide = isRemote && (!allowed.length || allowed.every(a => WORLDWIDE.test(a)) || str(v?.remote_type).toLowerCase() === 'global');
  const posting = langCode(v?.vacancy_language);
  if (str(v?.vacancy_language) && !posting) notes.push(`posting language "${str(v.vacancy_language)}" not recognised`);
  const req = readRequirements(v?.language_requirements); notes.push(...req.notes);
  const sponsorship = SPONSOR(v?.visa_sponsorship);
  if (v?.visa_sponsorship != null && v.visa_sponsorship !== '' && !sponsorship) notes.push(`visa sponsorship "${str(v.visa_sponsorship)}" not recognised`);
  const title = str(v?.title);
  const domain = (title.match(/\(([^()]+)\)\s*$/) || [])[1];
  const uniq = a => [...new Set(a)];
  return {
    company: isMasked(v?.company_title) ? null : str(v.company_title), title: title || null,
    text: str(v?.clear_text) || htmlText(v?.text), languages: posting ? [posting] : [], required_languages: req.out,
    attendance, countries: uniq(countries),
    locations: uniq(countries).map(country => ({ country, attendance: attendance.filter(a => a !== 'remote') })),
    remote_scope: isRemote ? (worldwide ? 'worldwide' : 'geo_restricted') : null,
    allowed_regions: worldwide ? [] : allowed, excluded_countries: uniq(excluded),
    required_citizenships: [], forbidden_citizenships: [], sponsorship, mandatory: [], headcount: null,
    industries: uniq([...list((Array.isArray(v?.tags) ? v.tags : []).map(t => (t && typeof t === 'object' ? t.name : t))), ...(domain ? [domain.trim()] : [])]),
    notes,
  };
}

/** The vacancy page. Real slugs already start with the id ("1191142-technical-product-manager"); add it only when not. */
function hirifyUrl(v) {
  const id = str(v.id), slug = str(v.slug);
  return `${SITE}/jobs/${!slug ? id : slug === id || slug.startsWith(`${id}-`) ? slug : `${id}-${slug}`}`;
}
function salaryOf(s) {
  if (!s || typeof s !== 'object') return '';
  const from = num(s.from, null, 0), to = num(s.to, null, 0), cur = str(s.currency);
  if (from && to) return `${from}-${to} ${cur}`.trim();
  if (from) return `from ${from} ${cur}`.trim();
  if (to) return `up to ${to} ${cur}`.trim();
  return '';
}
/** The later of created_at and reopened_at, or null when neither is a date. */
function postedAt(v) {
  const t = [v?.created_at, v?.reopened_at].map(d => Date.parse(d)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)) : null;
}
function locationOf(v, job) {
  const parts = [];
  if (job.attendance.includes('remote')) {
    const excluded = places(v.excluded_locations);
    parts.push(`Remote: ${job.allowed_regions.length ? job.allowed_regions.join(', ') : 'worldwide'}${excluded.length ? ` (except ${excluded.join(', ')})` : ''}`);
  }
  const onsite = job.attendance.filter(a => a !== 'remote');
  if (onsite.length || places(v.office_locations).length) parts.push(`${onsite.length ? onsite.join('/') : 'office'}: ${places(v.office_locations).join(', ') || 'location not given'}`);
  return parts.join('; ');
}
/** Structured fields above the text, so the decoder sees what Hirify knows. */
function header(v, job) {
  const yesNo = { AVAILABLE: 'yes', NOT_AVAILABLE: 'no' };
  const reqs = (Array.isArray(v.language_requirements) ? v.language_requirements : []).map(r => (r && typeof r === 'object' ? `${str(r.language)} ${str(r.level)}`.trim() : str(r))).filter(Boolean);
  return [
    `Hirify: ${hirifyUrl(v)}`,
    `Work format: ${list(v.work_format).join(', ') || 'unknown'}${str(v.remote_type) ? ` (remote type: ${str(v.remote_type)})` : ''}`,
    job.attendance.includes('remote') ? `Remote from: ${job.allowed_regions.join(', ') || `anywhere${places(v.allowed_locations).length ? ` (Hirify: ${places(v.allowed_locations).join(', ')})` : ''}`}` : '',
    places(v.excluded_locations).length ? `Excluded locations: ${places(v.excluded_locations).join(', ')}` : '',
    places(v.office_locations).length ? `Office locations: ${places(v.office_locations).join(', ')}` : '',
    `Posting language: ${str(v.vacancy_language) || 'unknown'}; English level: ${str(v.english_level) || 'not given'}`,
    reqs.length ? `Language requirements: ${reqs.join(', ')}` : '',
    `Visa sponsorship: ${yesNo[job.sponsorship] || 'not given'}`,
    str(v.company_type) ? `Company type: ${str(v.company_type)}` : '',
    job.industries.length ? `Tags: ${job.industries.join(', ')}` : '',
    str(v.tldr) ? `Summary: ${str(v.tldr)}` : '',
  ].filter(Boolean).join('\n');
}

// ---------- cookies ----------
/** "a=1; b=2" (a leading "Cookie:" is allowed) -> Map. */
export function parseCookieHeader(s) {
  const m = new Map();
  for (const part of String(s || '').replace(/^\s*cookie:\s*/i, '').split(';')) {
    const i = part.indexOf('='); if (i <= 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim(); if (k) m.set(k, v);
  }
  return m;
}
function setCookies(res) {
  const h = res?.headers; if (!h) return [];
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const one = typeof h.get === 'function' ? h.get('set-cookie') : null;
  return one ? one.split(/,\s*(?=[^;,=\s]+=)/) : [];
}
const fingerprint = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
export const COOKIE_FILE = () => STATE('hirify-cookies.json');
/** Cookies the server set on earlier runs, used only while .env still holds the same cookie they grew from. */
function loadJar(envCookie, file) {
  const saved = (() => { try { return JSON.parse(read(file)); } catch { return null; } })();
  return saved && saved.env === fingerprint(envCookie) && saved.cookies && typeof saved.cookies === 'object' ? { ...saved.cookies } : {};
}
function saveJar(envCookie, jar, file) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ env: fingerprint(envCookie), updated: new Date().toISOString(), cookies: jar }, null, 1), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file);
}

// ---------- state ----------
function loadState(file, say) {
  const txt = read(file); let s = {};
  if (txt.trim()) {
    try { s = JSON.parse(txt); } catch (e) {
      const aside = `${file}.broken-${Date.now()}`; fs.renameSync(file, aside);
      say(`hirify: ${file} was not valid JSON (${e.message}); kept as ${aside}, starting a fresh state`);
    }
  }
  if (!s.seen || typeof s.seen !== 'object') s.seen = {};
  if (!s.demoted || typeof s.demoted !== 'object') s.demoted = {};
  return s;
}
function saveState(file, s) { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s, null, 1)); fs.renameSync(tmp, file); }

/** A saved filter's query (with or without "?", or a whole address) with page=N. */
export function pageQuery(query, page) {
  let q = String(query || '').trim();
  if (/^https?:\/\//i.test(q)) { try { q = new URL(q).search; } catch { /* use as given */ } }
  const p = new URLSearchParams(q.replace(/^\?/, '')); p.delete('page'); p.set('page', String(page));
  return p.toString();
}

class HttpError extends Error {
  constructor(status, message, session = SESSION_STATUS.has(status) || (status >= 300 && status < 400)) { super(message); this.status = status; this.session = session; }
}
class RateLimited extends Error {
  constructor(until) { super('HTTP 429'); this.rate = true; this.until = until; }
}
/** Retry-After in seconds or as an HTTP date -> milliseconds from now, or null. */
function retryAfterMs(h, now) {
  const v = String(h ?? '').trim(); if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v); return Number.isFinite(t) ? Math.max(0, t - now.getTime()) : null;
}

/**
 * One run. fetch, sleep, send (Telegram text) and check (the gates function) are injected so tests need no network.
 * Returns { code, written, ... }; code 3 means the session needs the user.
 */
export async function run({ fetch: fetchFn = globalThis.fetch, sleep = defaultSleep, send = null, dryRun = false, now = new Date(),
  cfg = SETTINGS.sources.hirify || {}, gates = SETTINGS.gates, check = checkGates, env = process.env } = {}) {
  // the checked name: never a refused variable or another feature's secret (lib/env-names.mjs); '' reads nothing
  const cookieEnv = secretEnvName(cfg.cookie_env, 'HIRIFY_COOKIE'), envName = cookieEnv.name || 'HIRIFY_COOKIE';
  const envCookie = cookieEnv.name ? String(env[cookieEnv.name] || '').trim() : '';
  const jarFile = COOKIE_FILE(), stateFile = STATE('hirify.json');
  const jar = envCookie ? loadJar(envCookie, jarFile) : {};
  let jarChanged = false;
  // every value that could be part of the session is cut out of anything this source prints
  const hidden = () => [envCookie, ...parseCookieHeader(envCookie).values(), ...Object.values(jar)].map(String).filter(s => s.length >= 8).sort((a, b) => b.length - a.length);
  const redact = s => hidden().reduce((t, h) => t.split(h).join('[hidden]'), String(s));
  const out = []; const say = m => { const line = redact(m); out.push(line); log(line); };
  const result = (code, extra = {}) => ({ code, messages: out, ...extra });

  if (!cfg.enabled) { say('hirify: disabled in settings.json'); return result(0); }
  applications();   // a broken applications.json stops the source before it marks anything seen
  const filters = (Array.isArray(cfg.filters) ? cfg.filters : []).filter(f => f && str(f.query));
  if (!filters.length) { say('hirify: no filters in settings.json (sources.hirify.filters: [{ "name": "...", "query": "..." }])'); return result(2); }

  async function needsUser(reason) {
    say(`hirify: ${reason}; refresh ${envName} in .env (copy it from your browser, see README: Hirify)`);
    if (send && !dryRun) {
      try { await send(`cometscout: the Hirify source stopped. ${reason[0].toUpperCase()}${reason.slice(1)}. Copy a fresh session cookie from your browser into ${envName} in .env; Hirify jobs are not fetched until then.`); }
      catch (e) { say(`hirify: Telegram alert failed: ${e.message}`); }
    }
    return result(EXIT_SESSION);
  }
  if (cookieEnv.problem) { say(`hirify: sources.hirify.cookie_env: ${cookieEnv.problem}`); return result(2); }
  if (!envCookie) return needsUser(`${envName} is not set in .env`);

  const DELAY = num(cfg.delay_ms, 1500, 0), MAX_PAGES = num(cfg.max_pages_per_filter, 3, 1), MAX_AGE = num(cfg.max_age_days, 14, 0);
  let last = 0;
  const cookieHeader = () => { const m = parseCookieHeader(envCookie); for (const [k, v] of Object.entries(jar)) m.set(k, v); return [...m].map(([k, v]) => `${k}=${v}`).join('; '); };
  // auth: the session check, where an HTML page or a body that is not JSON means a login page, not a broken API
  async function call(p, { auth = false, retried = false } = {}) {
    if (last && DELAY > 0) { const wait = last + DELAY - Date.now(); if (wait > 0) await sleep(wait); }
    last = Date.now();
    const res = await fetchFn(`${API}${p}`, { redirect: 'manual', signal: AbortSignal.timeout(60000),
      headers: { Cookie: cookieHeader(), Accept: 'application/json', 'User-Agent': BROWSER_UA, Origin: SITE, Referer: `${SITE}/` } });
    for (const sc of setCookies(res)) {
      const [pair, ...attrs] = sc.split(';'); const i = pair.indexOf('='); if (i <= 0) continue;
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      const gone = !v || attrs.some(a => /^\s*max-age\s*=\s*(-\d+|0)\s*$/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=').slice(1).join('=')) < now.getTime()));
      if (gone ? k in jar : jar[k] !== v) { if (gone) delete jar[k]; else jar[k] = v; jarChanged = true; }
    }
    const status = res.status ?? 0, where = p.split('?')[0];
    if (status === 429) {
      const ms = retryAfterMs(res.headers?.get?.('retry-after'), now);
      if (ms != null && ms <= RETRY_WAIT_MAX_MS && !retried) { await sleep(ms); return call(p, { auth, retried: true }); }
      throw new RateLimited(ms != null ? new Date(now.getTime() + ms) : null);
    }
    if (status < 200 || status >= 300) throw new HttpError(status, `HTTP ${status} for ${where}`);
    const html = /text\/html/i.test(res.headers?.get?.('content-type') || '');
    const t = await res.text();
    if (auth && html) throw new HttpError(status, `an HTML page instead of JSON from ${where}`, true);
    try { return JSON.parse(t); } catch { throw new HttpError(status, `a reply that is not JSON from ${where}`, auth); }
  }

  const state = loadState(stateFile, say);
  const cutoff = new Date(now.getTime() - PRUNE_DAYS * 864e5).toISOString().slice(0, 10);
  for (const [k, e] of Object.entries(state.seen)) if (!(String(e?.first_seen || '') >= cutoff)) delete state.seen[k];
  for (const [k, d] of Object.entries(state.demoted)) if (!(String(d || '') >= cutoff)) delete state.demoted[k];
  if (state.blocked_until) {
    if (Date.parse(state.blocked_until) > now.getTime()) {
      say(`hirify: Hirify asked to wait until ${state.blocked_until} (HTTP 429); not calling it before then`);
      return result(EXIT_RATE_LIMITED);
    }
    delete state.blocked_until;
  }
  const mark = (id, status) => { if (!dryRun) state.seen[id] = { first_seen: state.seen[id]?.first_seen || today(), status }; };
  const save = () => {
    if (dryRun) return;
    saveState(stateFile, state);
    if (jarChanged) { saveJar(envCookie, jar, jarFile); jarChanged = false; }
  };

  const gated = gateTally(), failed = [], done = new Set();
  const n = { listed: 0, written: 0, duplicate: 0, seen: 0, excluded: 0, old: 0, scam: 0, unavailable: 0, pagesOk: 0, pagesFailed: 0 };

  // scam or archived: final, and the list often says so already, which saves the detail call
  const closed = (v, id) => {
    if (v.is_scam || v.is_potential_scam) { n.scam++; gated.add({ decision: 'reject', gate: 'scam' }); mark(id, 'scam'); return true; }
    if (v.is_archived) { n.unavailable++; mark(id, 'unavailable'); return true; }
    return false;
  };
  async function vacancy(item, filterName) {
    const id = str(item?.id); if (!id) { failed.push(redact(`a vacancy without an id in "${filterName}"`)); return; }
    if (state.seen[id] || done.has(id)) { n.seen++; return; }
    done.add(id);
    if (closed(item, id)) return;
    if (matchesAny(str(item.title), cfg.title_exclude)) { n.excluded++; return; }
    const listedAt = postedAt(item);
    if (listedAt && (now - listedAt) / 864e5 > MAX_AGE) { n.old++; return; }
    let v;
    try {
      const d = await call(`/api/vacancies/${encodeURIComponent(id)}`);
      const detail = d && typeof d.data === 'object' && d.data && !Array.isArray(d.data) ? d.data : d;
      v = { ...item, ...(detail && typeof detail === 'object' ? detail : {}), id: item.id };
    } catch (e) { if (e.session || e.rate) throw e; failed.push(redact(`${id} (${e.message})`)); return; }   // not marked seen: retried next run
    if (closed(v, id)) return;
    const job = fromHirify(v), masked = isMasked(v.company_title);
    const company = masked ? CONFIDENTIAL : str(v.company_title), role = str(v.title) || 'Unknown role';
    // no apply_url is common (apply on Hirify); a masked one ("%apply_url%", "***") is flagged
    const apply = str(v.apply_url), applyMasked = apply !== '' && isMasked(apply);
    const url = apply && !applyMasked ? apply : hirifyUrl(v);
    const g = check(job, gates);
    const repeat = !!state.demoted[id];
    if (!settle(g, { source: 'hirify', company, role, url }, { dry: dryRun }).queue) {
      gated.add(g, repeat && g.decision === 'demote');
      if (g.decision === 'demote') { if (!dryRun && !repeat) state.demoted[id] = today(); }
      else { mark(id, `gated: ${g.gate}`); if (!dryRun) delete state.demoted[id]; }
      return;
    }
    const posted = postedAt(v);
    const flags = [...(masked ? ['company: hidden by Hirify'] : []), ...(applyMasked ? ['apply link: hidden by Hirify, the Hirify page is used'] : []), ...job.notes, ...(posted ? [] : ['posting date unknown']), ...g.flags];
    const visa = { AVAILABLE: 'yes', NOT_AVAILABLE: 'no' }[job.sponsorship];
    const r = dryRun ? { written: true } : writeJob({ company, role, url, source: 'hirify', location: locationOf(v, job), salary: salaryOf(v.salary),
      posted: posted ? posted.toISOString().slice(0, 10) : '', text: [header(v, job), job.text].filter(Boolean).join('\n\n'),
      extra: { hirify_url: hirifyUrl(v), english_level: str(v.english_level), posting_language: str(v.vacancy_language), visa, gate_flags: flags.join('; ') } },
    { titleDedupe: !masked });
    if (r.written) n.written++; else n.duplicate++;
    mark(id, r.written ? 'written' : 'duplicate');
    if (!dryRun) delete state.demoted[id];
  }

  let checked = false;
  try {
    const user = await call('/auth/user', { auth: true });
    if (!user || typeof user !== 'object' || !(user.id || user.data)) return needsUser('Hirify does not see a logged-in user (the session has expired)');
    for (const f of filters) {
      const name = str(f.name) || str(f.query).slice(0, 40);
      for (let page = 1; page <= MAX_PAGES; page++) {
        let res;
        try { res = await call(`/api/vacancies?${pageQuery(f.query, page)}`); }
        catch (e) { if (e.session || e.rate) throw e; n.pagesFailed++; say(`hirify: filter "${name}" page ${page} could not be read (${e.message})`); break; }
        n.pagesOk++;
        const items = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        if (!checked) {
          checked = true;
          // a page without the field at all says nothing about the session; only names written as masks count
          if (items.length >= 5 && items.every(it => typeof it?.company_title === 'string' && isMasked(it.company_title))) return needsUser('every company on the first page is hidden, so the session is not taking effect');
        }
        n.listed += items.length;
        for (const it of items) {
          try { await vacancy(it, name); } catch (e) { if (e.session || e.rate) throw e; failed.push(redact(`${str(it?.id) || '?'} (${e.message})`)); }
          save();
        }
        const lastPage = num(res?.meta?.last_page, null, 1);
        if (!items.length || (lastPage != null && page >= lastPage)) break;
        if (page === MAX_PAGES && lastPage != null && lastPage > page) say(`hirify: filter "${name}" has ${lastPage} pages; max_pages_per_filter (${MAX_PAGES}) reached`);
      }
    }
  } catch (e) {
    if (e.session) return needsUser(`Hirify answered ${e.message.replace(/ (for|from) \/.*/, '')}, so the session has expired`);
    if (e.rate) {
      if (e.until && !dryRun) state.blocked_until = e.until.toISOString();
      say(`hirify: Hirify is limiting requests (HTTP 429); stopped, state kept, the vacancy in hand not marked seen${e.until ? `; it asked to wait until ${e.until.toISOString()}` : ''}. The next run tries again.`);
      return result(EXIT_RATE_LIMITED, { ...n, failed });
    }
    say(`hirify: stopped (${e.message})`);
    return result(1, { ...n });
  } finally {
    save();
  }
  if (failed.length) say(`hirify: ${failed.length} vacancy(ies) could not be read and will be tried next run: ${failed.slice(0, 10).join(', ')}${failed.length > 10 ? ', ...' : ''}`);
  say(`hirify: ${n.listed} listed, ${n.written} new, ${n.seen} seen before, ${n.duplicate} already queued, ${n.excluded} title excluded, ${n.old} older than ${MAX_AGE} days, ${n.unavailable} archived${gated.total ? `, ${gated}` : ''}${dryRun ? ' (dry run)' : ''}`);
  // every list page failing is a broken run (network, API change), not an empty day
  return result(n.pagesOk === 0 && n.pagesFailed > 0 ? 1 : 0, { ...n, failed });
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const { sendText } = await import('../lib/telegram.mjs');
  const r = await run({ dryRun: args.includes('--dry-run'), send: args.includes('--no-telegram') ? null : sendText });
  process.exitCode = r.code;
}

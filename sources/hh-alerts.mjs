#!/usr/bin/env node
// Source: hh.ru alert emails. Reads the saved-search ("Вакансии по подписке") and resume-match ("Подходящие вакансии")
// emails from Gmail (read-only), takes the vacancy ids from them, fetches each public vacancy page (no hh.ru login)
// for the full text, and queues new jobs. Run tools/gmail-auth.mjs once; the Gmail access is the same as for LinkedIn alerts.
// settings.sources.hh_alerts = {
//   enabled: true, sender: "noreply@hh.ru",
//   first_run_hours: 72, overlap_hours: 24, max_lookback_hours: 168,
//   max_fetch: 40, delay_ms: 3000,            // pages are fetched one at a time, never less than 2 seconds apart
//   title_include: [], title_exclude: [],     // Russian and English terms, whole words, "*" for word prefixes
//   must_reside_phrases: [],                  // remote job + one of these ("находиться на территории РФ") -> rejected (geo-remote)
//   abroad_signals: [],                       // phrases that suggest working from abroad is fine ("из любой страны"); a remote job
//                                             // gets a flag either way: the signals found, or "confirm working from your country"
//   tax_residency_phrases: [],                // "налоговый резидент РФ" and the like -> flag
//   city_countries: {}                        // extra city -> ISO country code pairs, e.g. { "Лимасол": "CY" }
// }
// Emailed links carry login keys (key=...). They are never followed, logged or stored: only the vacancy id is kept
// and only https://hh.ru/vacancy/<id> is fetched, without following redirects.
// A 403 alone means the vacancy is hidden from logged-out visitors (marked seen). Two 403s in a row or any 429 mean
// hh.ru is throttling: the run stops and the rest is kept for the next run. Archived and removed vacancies are marked
// seen. A page without a title or description is not marked seen but kept for a later run; three in a row mean the
// page layout probably changed, so the run stops. Ids that could not be handled (throttling, max_fetch, a network
// error, a blank page) are kept in the state file under "pending" and tried first on the next run (an error or a
// blank page at most 3 times, any pending id at most 14 days).
// The search window starts at the last run in which every email could be read, minus overlap_hours (never further
// back than max_lookback_hours); the first run looks back first_run_hours.
// settings.gates (lib/gates.mjs) applies after the checks above; rejects are counted per gate in the log, demotes
// are appended to data/state/demoted.jsonl and not marked seen.
// State: data/state/hh-alerts.json = { last_run, seen: { id: date }, pending: { id: { since, alerts, tries } } };
// seen ids older than 120 days are dropped.
// --ids only looks: it fetches and checks the given vacancies and prints the result, without reading Gmail, writing
// job files or touching the state file.
// Usage: node sources/hh-alerts.mjs [--dry-run] [--hours 96] [--max-fetch 10] [--ids 123456789,987654321]
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, STATE, read, log, num, isMain } from '../lib/config.mjs';
import { writeJob, htmlText, matchesAny, decodeEntities, applications } from '../lib/queue.mjs';
import { checkGates, countriesIn, gateTally, settle } from '../lib/gates.mjs';

export const MIN_DELAY_MS = 2000;
const PRUNE_DAYS = 120, PENDING_DAYS = 14, MAX_TRIES = 3, MAX_EMAILS = 100, UNPARSED_STOP = 3;
const DEFAULTS = { sender: 'noreply@hh.ru', first_run_hours: 72, overlap_hours: 24, max_lookback_hours: 168, max_fetch: 40, delay_ms: 3000,
  title_include: [], title_exclude: [], must_reside_phrases: [], abroad_signals: [], tax_residency_phrases: [], city_countries: {} };
const settings = () => ({ ...DEFAULTS, ...(SETTINGS.sources.hh_alerts || {}) });
const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(x => String(x ?? '').trim()).filter(Boolean);
const day = d => new Date(d).toISOString().slice(0, 10);
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// ---------- 1. alert emails ----------
export const SUBJECTS = ['Вакансии по подписке', 'Подходящие вакансии'];
export function searchQuery(sender, afterEpoch) {
  return `from:${sender} (${SUBJECTS.map(s => `subject:"${s}"`).join(' OR ')}) after:${afterEpoch}`;
}
/** "Вакансии по подписке: X" -> "подписка: X"; "Подходящие вакансии для резюме: X" -> "резюме: X". */
export function alertName(subject) {
  const s = String(subject || '').replace(/\s+/g, ' ').trim();
  const rest = (m, prefix) => { const r = s.slice(m[0].length).replace(/^[\s:«"'“„-]+|[\s»"'”.]+$/g, '').trim(); return r ? `${prefix}: ${r}` : prefix; };
  let m = s.match(/^вакансии по (?:вашей )?подписке/i); if (m) return rest(m, 'подписка');
  m = s.match(/^подходящие вакансии(?: (?:для вас|(?:для|по) (?:вашему )?резюме))?/i); if (m) return rest(m, 'резюме');
  return s || 'hh alert';
}
/** Vacancy ids in an email, in order, once each. Only the digits are kept: the links themselves carry login keys. */
export function vacancyIds(html) {
  const ids = [];
  for (const m of String(html || '').matchAll(/hh\.ru(?:\/|%2F)vacancy(?:\/|%2F)(\d{6,})/gi)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}
const header = (msg, name) => String((msg?.payload?.headers || []).find(h => String(h.name).toLowerCase() === name)?.value || '');

// ---------- 2. the vacancy page ----------
export const vacancyUrl = id => `https://hh.ru/vacancy/${id}`;
const openTag = name => new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bdata-qa="(?:[^"]*\\s)?${name}(?:\\s[^"]*)?"[^>]*>`, 'i');
/** Where the first element with this data-qa marker is: { start, inner, innerEnd, end } (same-tag nesting counted), or null. */
function bounds(html, name) {
  const m = openTag(name).exec(html); if (!m) return null;
  const inner = m.index + m[0].length, re = new RegExp(`<(/?)${m[1]}\\b[^>]*>`, 'gi');
  re.lastIndex = inner; let depth = 1, t;
  while ((t = re.exec(html))) { if (t[1]) { if (--depth === 0) return { start: m.index, inner, innerEnd: t.index, end: t.index + t[0].length }; } else if (!t[0].endsWith('/>')) depth++; }
  return { start: m.index, inner, innerEnd: html.length, end: html.length };
}
/** Inner HTML of the first element with this data-qa marker, or null. */
const element = (html, name) => { const b = bounds(html, name); return b ? html.slice(b.inner, b.innerEnd) : null; };
const oneLine = h => htmlText(h || '').replace(/\s+/g, ' ').trim();
const field = (html, name) => oneLine(element(html, name));
// the description ends at the first of these markers, or at the "Ключевые навыки" heading that comes before the skills
const DESC_END = /data-qa="(?:[^"]*\s)?(?:skills-element|vacancy-skills|vacancy-address|vacancy-contacts|vacancy-response-link-bottom|bloko-tag-list)[\s"]|Ключевые\s+навыки/i;
function description(html) {
  const m = openTag('vacancy-description').exec(html); if (!m) return '';
  const rest = html.slice(m.index + m[0].length), end = DESC_END.exec(rest);
  return htmlText(end ? rest.slice(0, rest.lastIndexOf('<', end.index)) : element(html, 'vacancy-description')).split('\n').map(l => l.trim()).join('\n').trim();
}
// The page state is JSON with HTML-escaped quotes (archived&#34;:true); plain and &quot; quotes are read too.
const Q = '(?:"|&#34;|&quot;)';
const ARCHIVED_JSON = new RegExp(`archived${Q}\\s*:\\s*true`);
const AREA = new RegExp(`${Q}area${Q}\\s*:\\s*\\{([^{}]*)\\}`, 'g');
/** City and country of the vacancy from the page state: the first "area" object that has countryIsoCode. */
export function pageArea(html) {
  for (const m of String(html || '').matchAll(AREA)) {
    const obj = decodeEntities(m[1]), iso = obj.match(/"countryIsoCode"\s*:\s*"([A-Za-z]{2})"/);
    if (!iso) continue;
    const name = (obj.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || '';
    let city = name; try { city = JSON.parse(`"${name}"`); } catch { /* keep it as written */ }
    return { country: iso[1].toUpperCase(), city: String(city).trim() };
  }
  return { country: null, city: '' };
}
// "(в архиве)" or the label text "В архиве с 28 сентября"; a role like "Специалист по работе в архиве" is not archived
const ARCHIVED_TITLE = /\(\s*в\s+архиве\s*\)|в\s+архиве\s+с\s+\d/i;
/** Fields of a public vacancy page, read by data-qa markers and the page state. Anything missing is '' (country null). */
export function parseVacancy(html) {
  const h = String(html || ''), titleHtml = element(h, 'vacancy-title') || '';
  // the archive label ("В архиве с 28 сентября") sits inside the title element; it is not part of the role
  const label = bounds(titleHtml, 'vacancy-title-archived-text');
  const area = pageArea(h);
  const place = field(h, 'vacancy-address-with-map') || field(h, 'vacancy-view-raw-address') || field(h, 'vacancy-view-location');
  return {
    title: oneLine(label ? `${titleHtml.slice(0, label.start)} ${titleHtml.slice(label.end)}` : titleHtml),
    archived: !!label || ARCHIVED_TITLE.test(oneLine(titleHtml)) || ARCHIVED_JSON.test(h),
    company: field(h, 'vacancy-company-name'),
    city: area.city || place.split(',')[0].trim(),
    country: area.country,
    formats: field(h, 'work-formats-text').replace(/^формат(?:ы)?\s+работы\s*:?\s*/i, '').trim(),
    salary: field(h, 'vacancy-salary'),
    experience: field(h, 'vacancy-experience'),
    employment: field(h, 'common-employment-text'),
    description: description(h),
  };
}

// ---------- 3. what the page says about place, remote work and language ----------
const REMOTE = /(?<!\p{L})(?:удал[её]нно|удал[её]нн(?:ая|ой|ую)|remote)(?!\p{L})/iu;   // "удалённая работа", "полностью удаленная"
export const isRemote = (title, formats) => REMOTE.test(`${title || ''}\n${formats || ''}`);
/** Attendance words gates understands, from the work formats (and a title that says remote). */
export function attendanceOf(formats, title) {
  const f = String(formats || ''), a = [];
  if (isRemote(title, f)) a.push('remote');
  if (/гибрид|hybrid/i.test(f)) a.push('hybrid');
  if (/на\s+месте\s+работодателя|(?<!\p{L})(?:в\s+)?офис(?:е)?(?!\p{L})|on-?site|office/iu.test(f)) a.push('office');
  return a;
}
// Major cities (Russian and English names) and a few country names, for cities hh.ru users often see. Extend or
// override with settings.sources.hh_alerts.city_countries.
const CITY_COUNTRY = {
  RU: ['Москва', 'Moscow', 'Санкт-Петербург', 'Saint Petersburg', 'St Petersburg', 'Новосибирск', 'Novosibirsk', 'Екатеринбург', 'Yekaterinburg',
    'Казань', 'Kazan', 'Нижний Новгород', 'Nizhny Novgorod', 'Челябинск', 'Самара', 'Омск', 'Ростов-на-Дону', 'Уфа', 'Красноярск', 'Воронеж',
    'Пермь', 'Волгоград', 'Краснодар', 'Тюмень', 'Сочи', 'Калининград', 'Владивосток', 'Иркутск', 'Томск', 'Ярославль', 'Россия'],
  BY: ['Минск', 'Minsk', 'Беларусь'], KZ: ['Алматы', 'Almaty', 'Астана', 'Astana', 'Казахстан'], UZ: ['Ташкент', 'Tashkent', 'Узбекистан'],
  KG: ['Бишкек', 'Bishkek', 'Киргизия'], AM: ['Ереван', 'Yerevan', 'Армения'], GE: ['Тбилиси', 'Tbilisi', 'Батуми', 'Batumi', 'Грузия'],
  AZ: ['Баку', 'Baku', 'Азербайджан'], CY: ['Лимасол', 'Limassol', 'Никосия', 'Nicosia', 'Ларнака', 'Larnaca', 'Пафос', 'Paphos', 'Кипр'],
  RS: ['Белград', 'Belgrade', 'Нови-Сад', 'Novi Sad', 'Сербия'], ME: ['Подгорица', 'Podgorica', 'Черногория'], TR: ['Стамбул', 'Istanbul', 'Анталья', 'Antalya', 'Турция'],
  AE: ['Дубай', 'Dubai', 'Абу-Даби', 'Abu Dhabi', 'ОАЭ'], PL: ['Варшава', 'Warsaw', 'Польша'], DE: ['Берлин', 'Berlin', 'Мюнхен', 'Германия'],
  PT: ['Лиссабон', 'Lisbon', 'Португалия'], ES: ['Мадрид', 'Барселона', 'Испания'], NL: ['Амстердам', 'Нидерланды'], GB: ['Лондон', 'Великобритания'],
  CZ: ['Прага', 'Чехия'], LT: ['Вильнюс', 'Литва'], LV: ['Рига', 'Латвия'], EE: ['Таллин', 'Эстония'], IL: ['Тель-Авив', 'Израиль'], TH: ['Бангкок', 'Пхукет', 'Таиланд'],
};
const cityKey = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\bst\.?\s/g, 'saint ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** ISO country code for a city ("Москва" -> RU), or null when unknown. */
export function cityCountry(city, extra = {}) {
  const k = cityKey(city); if (!k) return null;
  for (const [name, code] of Object.entries(extra || {})) if (cityKey(name) === k && /^[a-z]{2}$/i.test(String(code))) return String(code).toUpperCase();
  for (const [code, names] of Object.entries(CITY_COUNTRY)) if (names.some(n => cityKey(n) === k)) return code;
  return countriesIn(city)[0] || null;
}
/** 'ru' when most letters are Cyrillic, else null (unknown: the language gate then does not apply). */
export function postingLanguage(text) {
  const cyr = (String(text).match(/\p{Script=Cyrillic}/gu) || []).length, lat = (String(text).match(/\p{Script=Latin}/gu) || []).length;
  return cyr > 0 && cyr >= 0.3 * (cyr + lat) ? 'ru' : null;
}
/** The normalised job lib/gates.mjs checks. Nothing guessed: an unknown city or format leaves the field empty. */
export function gatesJob(v, cfg = settings()) {
  const attendance = attendanceOf(v.formats, v.title), country = v.country || cityCountry(v.city, cfg.city_countries);
  const text = `${v.title}\n${v.description}`, lang = postingLanguage(text);
  return { company: v.company || null, title: v.title || null, text, languages: lang ? [lang] : [], required_languages: [],
    attendance, countries: country ? [country] : [], locations: country ? [{ country, attendance }] : [],
    remote_scope: null, allowed_regions: [], excluded_countries: [], required_citizenships: [], forbidden_citizenships: [],
    sponsorship: null, mandatory: [], headcount: null, industries: [] };
}
/** The hh-specific checks, run before the shared gates: { skip, reject, flags }. */
export function sourceChecks(v, cfg = settings()) {
  const flags = [], text = `${v.title}\n${v.description}`, remote = isRemote(v.title, v.formats);
  const hits = phrases => list(phrases).filter(p => matchesAny(text, [p]));
  if (list(cfg.title_include).length && !matchesAny(v.title, cfg.title_include)) return { skip: 'title not included', flags };
  if (matchesAny(v.title, cfg.title_exclude)) return { skip: 'title excluded', flags };
  if (remote) {
    const reside = hits(cfg.must_reside_phrases)[0];
    if (reside) return { reject: { gate: 'geo-remote', reason: `text says "${reside}"` }, flags };
    if (list(cfg.abroad_signals).length) {
      const abroad = hits(cfg.abroad_signals);
      flags.push(abroad.length ? `abroad: text suggests working from abroad is fine (${abroad.join(', ')})` : 'abroad: confirm working from your country is allowed');
    }
  }
  const tax = hits(cfg.tax_residency_phrases);
  if (tax.length) flags.push(`tax residency: text says "${tax.join('", "')}"`);
  return { flags };
}

// ---------- 4. fetching ----------
/** One page: { status, html? }. Only https://hh.ru/vacancy/<id>; redirects are never followed (status 3xx comes back). */
async function getPage(id, fetchFn) {
  if (!/^\d{6,}$/.test(id)) return { status: 0, error: 'not a vacancy id' };
  const r = await fetchFn(vacancyUrl(id), { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' } });
  return r.status === 200 ? { status: 200, html: await r.text() } : { status: r.status };
}

/** State file: a broken one is kept aside under another name and reported, never silently replaced. */
function loadState(file) {
  const txt = read(file); let s = {};
  if (txt.trim()) {
    try { s = JSON.parse(txt); } catch (e) {
      const aside = `${file}.broken-${Date.now()}`; fs.renameSync(file, aside);
      log(`hh-alerts: ${file} was not valid JSON (${e.message}); kept as ${aside}, starting a fresh state`);
    }
  }
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return { last_run: typeof s?.last_run === 'string' ? s.last_run : null, seen: obj(s?.seen), pending: obj(s?.pending) };
}
function saveState(file, state) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  fs.renameSync(`${file}.tmp`, file);   // atomic: a crash mid-write never leaves half a state file
}

// ---------- 5. run ----------
/**
 * One pass. Tests inject gmail ({ list(q, max), get(id) }), messageHtml, fetch, sleep, now and check (the gates function).
 * ids: vacancy ids to look at without reading Gmail: they skip the seen list, and nothing is written (no job files,
 * no state, no demoted.jsonl), as with dryRun.
 * hours: the search window instead of the one from the state file. Returns what happened to every id in `results`.
 */
export async function run({ gmail, messageHtml, fetch: fetchFn = globalThis.fetch, sleep = defaultSleep, now = new Date(), dryRun = false,
  ids = null, hours = null, maxFetch = null, check = checkGates } = {}) {
  const cfg = settings();
  if (!cfg.enabled) { log('hh-alerts: disabled in settings.json'); return { ran: false }; }
  applications();   // a broken applications.json stops the source before it marks anything seen
  const look = dryRun || !!ids;   // --dry-run and --ids write nothing
  const MAX = num(maxFetch ?? cfg.max_fetch, 40, 0), DELAY = Math.max(MIN_DELAY_MS, num(cfg.delay_ms, 3000, 0));   // a typo never removes the limit or the delay
  const stateFile = STATE('hh-alerts.json'), state = loadState(stateFile), nowMs = now.getTime(), today = day(now);
  const pendingCutoff = day(nowMs - PENDING_DAYS * 864e5);
  for (const [k, p] of Object.entries(state.pending)) if (!(String(p?.since) >= pendingCutoff)) delete state.pending[k];
  const found = new Map();   // id -> Set of alert names, in the order they are handled
  const add = (id, name) => { if (!found.has(id)) found.set(id, new Set()); if (name) found.get(id).add(name); };
  let emails = 0, emailErrors = 0, searchFailed = false, windowHours = null;

  if (ids) for (const id of ids) add(String(id).trim(), '--ids');
  else {
    const firstRun = num(cfg.first_run_hours, 72, 1), last = Date.parse(state.last_run);
    const sinceLast = Number.isFinite(last) ? Math.min((nowMs - last) / 3.6e6 + num(cfg.overlap_hours, 24, 0), num(cfg.max_lookback_hours, 168, 1)) : firstRun;
    windowHours = Math.ceil(hours != null ? num(hours, sinceLast, 1) : sinceLast);
    // ids kept from earlier runs go first, oldest first
    for (const [id, p] of Object.entries(state.pending).sort((a, b) => String(a[1]?.since).localeCompare(String(b[1]?.since)))) {
      add(id); for (const n of list(p?.alerts)) add(id, n);
    }
    try {
      if (!gmail || !messageHtml) { const g = await import('../lib/gmail.mjs'); gmail ||= new g.Gmail(); messageHtml ||= g.messageHtml; }
      const msgs = await gmail.list(searchQuery(cfg.sender, Math.floor((nowMs - windowHours * 3.6e6) / 1000)), MAX_EMAILS);
      for (const { id } of msgs) {
        try {
          const msg = await gmail.get(id), name = alertName(header(msg, 'subject'));
          for (const v of vacancyIds(messageHtml(msg.payload))) add(v, name);
          emails++;
        } catch (e) { emailErrors++; log(`hh-alerts: could not read email ${id}: ${e.message}`); }
      }
    } catch (e) {
      log(`hh-alerts: could not search Gmail (${e.message}); only ids kept from earlier runs are tried`);
      searchFailed = true;
    }
  }

  const results = [], skipped = {}, gated = gateTally(), seenThisRun = new Set();
  const count = (why, n = 1) => { if (!why) return; skipped[why] = (skipped[why] || 0) + n; if (!skipped[why]) delete skipped[why]; };
  const result = (id, outcome, extra = {}) => { const r = { id, outcome, ...extra }; results.push(r); return r; };
  const markSeen = id => { if (look) return; state.seen[id] = today; seenThisRun.add(id); delete state.pending[id]; };
  const unmarkSeen = id => { if (seenThisRun.has(id)) { delete state.seen[id]; seenThisRun.delete(id); } };
  // kept for the next run; countTry for errors that may never go away, so an id cannot stay pending for ever
  const defer = (id, countTry = false) => {
    if (look) return;
    const p = state.pending[id] || { since: today, alerts: [], tries: 0 };
    p.alerts = [...new Set([...list(p.alerts), ...(found.get(id) || [])])];
    if (countTry) p.tries = (Number(p.tries) || 0) + 1;
    if (p.tries >= MAX_TRIES) { delete state.pending[id]; log(`hh-alerts: vacancy ${id} failed ${p.tries} runs; dropped (it comes back if an alert lists it again)`); }
    else state.pending[id] = p;
  };
  let fetched = 0, written = 0, stopped = null, last403 = null, unparsed = [];
  const stop = (why, which) => {
    stopped = why;
    for (const u of which) { unmarkSeen(u); defer(u); const r = results.find(x => x.id === u); if (r) { count(r.counted, -1); Object.assign(r, { outcome: 'deferred', reason: why }); } }
    log(`hh-alerts: ${why}; stopping this run, the rest is kept for the next run`);
  };

  // what one fetched page means; returns { outcome, reason, counted } for the result list
  async function handle(id, alerts, page) {
    if (page.status === 403) { last403 = id; markSeen(id); return { outcome: 'unavailable', reason: 'hidden from logged-out visitors (403)', counted: 'hidden (403)' }; }
    last403 = null;
    if (page.status === 404 || page.status === 410) { markSeen(id); return { outcome: 'unavailable', reason: `removed (HTTP ${page.status})`, counted: 'removed' }; }
    if (page.status !== 200) {
      const why = page.error || (page.status >= 300 && page.status < 400 ? `redirected (HTTP ${page.status}), not followed` : `HTTP ${page.status}`);
      defer(id, true); log(`hh-alerts: vacancy ${id}: ${why}`);
      return { outcome: 'error', reason: why, counted: 'fetch error (next run)' };
    }
    const v = parseVacancy(page.html);
    if (v.archived) { markSeen(id); return { outcome: 'unavailable', reason: 'archived', counted: 'archived' }; }
    if (!v.title || !v.description) {   // not seen: kept for a later run, at most MAX_TRIES times
      defer(id, true);
      return { outcome: 'deferred', reason: 'no title or description', counted: 'no title or description (next run)', unparsed: true };
    }

    const url = vacancyUrl(id), company = v.company || 'Unknown', role = v.title;
    const sc = sourceChecks(v, cfg);
    if (sc.skip) { markSeen(id); return { outcome: 'skipped', reason: sc.skip, counted: sc.skip }; }
    const g = sc.reject ? { decision: 'reject', gate: sc.reject.gate, reason: sc.reject.reason, flags: [] } : check(gatesJob(v, cfg));
    const s = settle(g, { source: 'hh', company, role, url }, { dry: look });
    if (s.markSeen) markSeen(id); else if (!look) delete state.pending[id];   // a demoted job stays unseen, so it comes back once the bar is lowered
    if (!s.queue) { gated.add(g); return { outcome: g.decision === 'demote' ? 'demoted' : 'rejected', gate: g.gate, reason: g.reason }; }
    const flags = [...sc.flags, ...(g.flags || [])], lang = postingLanguage(`${v.title}\n${v.description}`);
    const head = [v.city && `Город: ${v.city}`, v.formats && `Формат работы: ${v.formats}`, v.experience && `Опыт: ${v.experience}`,
      v.employment && `Занятость: ${v.employment}`, v.salary && `Зарплата: ${v.salary}`].filter(Boolean).join('\n');
    const r = look ? { written: true } : writeJob({ company, role, url, source: 'hh', location: [v.city, v.formats].filter(Boolean).join('; '), salary: v.salary,
      text: `${head}${head ? '\n\n' : ''}${v.description}`, notes: `hh alert: ${[...alerts].join(', ') || 'earlier alert'}`,
      extra: { experience: v.experience, employment: v.employment, posting_language: lang, gate_flags: flags.join('; ') } });
    if (r.written) written++;
    return r.written ? { outcome: 'written', flags } : { outcome: 'duplicate', reason: r.reason, counted: 'duplicate' };
  }

  try {
    for (const [id, alerts] of found) {
      if (!ids && state.seen[id]) { if (!look) delete state.pending[id]; count('seen before'); result(id, 'seen'); continue; }
      if (stopped) { defer(id); result(id, 'deferred', { reason: stopped }); continue; }
      if (fetched >= MAX) { defer(id); count('over max_fetch (next run)'); result(id, 'deferred', { reason: 'max_fetch' }); continue; }
      if (fetched > 0) await sleep(DELAY);
      fetched++;
      try {
        const page = await getPage(id, fetchFn);
        if (page.status === 429 || (page.status === 403 && last403)) {
          result(id, 'deferred');
          stop(page.status === 429 ? 'hh.ru is throttling (HTTP 429)' : 'hh.ru is throttling (two 403s in a row)', page.status === 403 ? [last403, id] : [id]);
          continue;
        }
        const r = await handle(id, alerts, page);
        result(id, r.outcome, r); if (r.counted) count(r.counted);
        if (!r.unparsed) unparsed = [];
        else if (unparsed.push(id) >= UNPARSED_STOP) {
          stopped = `${UNPARSED_STOP} pages in a row without a title or description (the page layout probably changed)`;
          log(`hh-alerts: ${stopped}; stopping this run, the rest is kept for the next run`);
        }
      } catch (e) {   // one broken vacancy never stops the run
        last403 = null; unparsed = []; unmarkSeen(id); defer(id, true); count('fetch error (next run)');
        result(id, 'error', { reason: e.message }); log(`hh-alerts: vacancy ${id}: ${e.message}`);
      }
    }
  } finally {
    if (!look) {
      const cutoff = day(nowMs - PRUNE_DAYS * 864e5);
      for (const [k, d] of Object.entries(state.seen)) if (!(String(d) >= cutoff)) delete state.seen[k];
      // the next window starts here only when every email was read; ids left behind are in pending
      if (!ids && !searchFailed && !emailErrors && results.length === found.size) state.last_run = now.toISOString();
      saveState(stateFile, state);
    }
  }
  for (const r of results) { delete r.counted; delete r.unparsed; }
  const pend = Object.keys(state.pending).length;
  log(`hh-alerts: ${ids ? `${found.size} id(s) given` : `${searchFailed ? 'Gmail search failed' : `${emails} email(s) in ${windowHours}h`}${emailErrors ? ` (${emailErrors} could not be read)` : ''}, ${found.size} vacancy id(s)`}, ${fetched} page(s) fetched, ${written} new${ids ? ' (look only, nothing written)' : dryRun ? ' (dry run)' : ''}` +
    `${gated.total ? `, ${gated}` : ''}; skipped ${JSON.stringify(skipped)}${pend && !look ? `; ${pend} kept for the next run` : ''}${stopped ? `; stopped: ${stopped}` : ''}`);
  return { ran: true, emails, emailErrors, searchFailed, windowHours, fetched, written, stopped, results, skipped };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2), opt = n => (i => (i >= 0 ? args[i + 1] : null))(args.indexOf(`--${n}`));
  const ids = opt('ids') ? opt('ids').split(',').map(s => s.trim()).filter(Boolean) : null;
  if (ids && (!ids.length || ids.some(id => !/^\d{6,}$/.test(id)))) { log('hh-alerts: --ids takes vacancy numbers, e.g. --ids 123456789,987654321'); process.exit(1); }
  try {
    const r = await run({ dryRun: args.includes('--dry-run'), ids, hours: opt('hours'), maxFetch: opt('max-fetch') });
    if (ids) for (const x of r.results || []) log(`hh-alerts: ${x.id}: ${x.outcome}${x.gate ? ` (${x.gate})` : ''}${x.reason ? `: ${x.reason}` : ''}${x.flags?.length ? `; flags: ${x.flags.join('; ')}` : ''}`);
  } catch (e) { log(`hh-alerts: ${e.message}`); process.exit(2); }
}

// Shared gates: the hard rules every source applies before a job reaches the queue (and before any model call).
// Rules come from settings.gates; every key is optional and an absent key means no check. With no settings.gates
// at all, checkGates() always passes, so sources behave exactly as before.
//
// checkGates(job, gates) -> { decision: 'pass' | 'reject' | 'demote', gate, reason, flags: [] }
// job is a normalised description each source builds from its own fields (fromRtj, fromText below). Missing
// fields are null or empty and never cause a reject on their own.
// Order: company, industry, language, legal, geo, remote, headcount. The first reject wins; flags accumulate.
// demote means: do not queue now; the source counts it as demoted and appends it to data/state/demoted.jsonl
// (settle() below), so lowering the bar in settings can bring it back.
// The governing rule: a field that is missing or written in an unexpected form never rejects; at most it flags.
import fs from 'node:fs';
import { SETTINGS, STATE, read, today } from './config.mjs';
import { matchesAny } from './queue.mjs';

export const GATE_KEYS = ['user', 'languages', 'onsite_countries', 'remote', 'sponsorship_refusal_phrases', 'must_reside_phrases', 'headcount', 'companies', 'industries'];
const HIGH_LEVELS = new Set(['b2', 'c1', 'c2', 'native', 'fluent']);
const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(x => String(x ?? '').trim()).filter(Boolean);
const codes = v => list(v).map(x => x.toUpperCase());
const lower = v => list(v).map(x => x.toLowerCase());
// language names and 3-letter codes some sources write instead of ISO 639-1
const LANG_ALIASES = { english: 'en', eng: 'en', spanish: 'es', spa: 'es', russian: 'ru', rus: 'ru', german: 'de', deu: 'de', ger: 'de', french: 'fr', fra: 'fr', fre: 'fr' };
const langs = v => lower(v).map(x => x.split(/[-_]/)[0]).map(x => LANG_ALIASES[x] || x);   // primary subtag: en-US, en_GB -> en
// region text that carves something out ("Europe except Spain"): flagged for a look, never a reject by itself
const EXCLUSION = /(?<!\p{L})(?:except|exclud(?:e|es|ed|ing)|excl\.?|outside|not\s+in|кроме|за\s+исключением)(?!\p{L})/iu;
const finite = v => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// industries.exclude_combos: [["gaming", "mobile"]] rejects only when every term of one combo matches an industry tag
// (a mobile-gaming studio), so neither tag alone rejects.
const combosOf = g => (Array.isArray(g?.industries?.exclude_combos) ? g.industries.exclude_combos : []).map(list).filter(c => c.length > 1);

/** Which gates a settings.gates block turns on, and which of its keys are unknown (doctor prints both). */
export function describeGates(gates) {
  if (!gates || typeof gates !== 'object') return { active: [], unknown: [] };
  const g = gates, u = g.user || {}, hc = g.headcount || {};
  const active = [
    (list(g.companies?.exclude).length || list(g.companies?.agencies).length) && 'company',
    (list(g.industries?.exclude).length || combosOf(g).length) && 'industry',
    list(g.languages).length && 'language',
    (list(u.citizenships).length || list(u.work_authorization).length) && 'legal',
    (list(g.onsite_countries).length || list(u.work_authorization).length) && 'geo',
    (g.remote || list(g.must_reside_phrases).length) && 'remote',
    (finite(hc.demote_over) != null || finite(hc.reject_over) != null || list(hc.reject_keywords_over?.keywords).length) && 'headcount',
  ].filter(Boolean);
  return { active, unknown: Object.keys(g).filter(k => !GATE_KEYS.includes(k) && !k.startsWith('_')) };
}

export function checkGates(job, gates = SETTINGS.gates) {
  const flags = [];
  const out = (decision, gate = null, reason = '') => ({ decision, gate, reason, flags });
  if (!gates || typeof gates !== 'object') return out('pass');
  const j = job || {};
  const user = gates.user || {};
  const myCit = codes(user.citizenships), myAuth = codes(user.work_authorization), onsiteOk = codes(gates.onsite_countries);
  const myLangs = langs(gates.languages);
  const attendance = lower(j.attendance);
  const countries = codes(j.countries);
  // per-location pairs (country + that location's own attendance); a job built without them pairs every country
  // with the job's attendance, which is all a caller that only knows the two lists can say
  const locations = Array.isArray(j.locations) && j.locations.length
    ? j.locations.map(l => ({ country: String(l?.country || '').trim().toUpperCase(), attendance: lower(l?.attendance) })).filter(l => l.country)
    : countries.map(country => ({ country, attendance }));
  const scope = j.remote_scope || null;
  const sponsorship = String(j.sponsorship || '').trim().toUpperCase() || null;   // "available" is AVAILABLE
  const isRemote = attendance.includes('remote') || scope === 'worldwide' || scope === 'geo_restricted';
  const onsiteOnly = !isRemote && (attendance.includes('office') || attendance.includes('hybrid'));
  const text = String(j.text || '');
  const titleCo = `${j.company || ''} \n ${j.title || ''}`;

  // 1. company
  const co = gates.companies || {};
  if (j.company && matchesAny(j.company, co.exclude)) return out('reject', 'company', `${j.company} is excluded`);
  if (j.company && matchesAny(j.company, co.agencies)) return out('reject', 'company', `${j.company} is an agency`);

  // 2. industry
  const badInd = list(gates.industries?.exclude);
  if (badInd.length) {
    const hit = list(j.industries).find(i => matchesAny(i, badInd)) || (matchesAny(titleCo, badInd) ? 'company or title' : null);
    if (hit) return out('reject', 'industry', `excluded industry (${hit})`);
  }
  const combo = combosOf(gates).find(c => c.every(w => list(j.industries).some(i => matchesAny(i, [w]))));
  if (combo) return out('reject', 'industry', `excluded industry combination (${combo.join(' + ')})`);

  // 3. language
  if (myLangs.length) {
    const posting = langs(j.languages);
    if (posting.length && !posting.some(l => myLangs.includes(l))) return out('reject', 'language', `posting language ${posting.join(', ')}`);
    for (const r of j.required_languages || []) {
      const lang = langs(r?.lang)[0]; if (!lang || myLangs.includes(lang)) continue;
      const level = String(r.level || '').toLowerCase();
      if (HIGH_LEVELS.has(level)) return out('reject', 'language', `requires ${lang} at ${level}`);
      flags.push(`language: ${lang}${level ? ` ${level}` : ''} wanted`);
    }
  }

  // 4. legal
  const forbidden = codes(j.forbidden_citizenships).filter(c => myCit.includes(c));
  if (forbidden.length) return out('reject', 'legal', `citizenship ${forbidden.join(', ')} not accepted`);
  const required = codes(j.required_citizenships);
  if (required.length && myCit.length && !required.some(c => myCit.includes(c))) return out('reject', 'legal', `requires citizenship ${required.join(', ')}`);
  const outsideAuth = myAuth.length > 0 && countries.length > 0 && !countries.some(c => myAuth.includes(c));
  const legalLine = (j.mandatory || []).find(m => m?.class === 'LEGAL_AUTHORIZATION');
  const refusal = list(gates.sponsorship_refusal_phrases).find(p => matchesAny(text, [p]));
  const noSponsor = sponsorship === 'NOT_AVAILABLE';
  if (legalLine || refusal || noSponsor) {
    const why = legalLine ? `work authorization required: ${String(legalLine.text || '').slice(0, 120)}` : refusal ? `text says "${refusal}"` : 'no visa sponsorship';
    // sponsorship the source says is available wins over boilerplate like "must be authorized to work in": flag only
    if (onsiteOnly && outsideAuth && sponsorship !== 'AVAILABLE') return out('reject', 'legal', `on-site in ${countries.join(', ')}; ${why}`);
    // no flag only for an on-site job in a country the user may work in; unknown attendance or countries get one
    if (!(onsiteOnly && countries.some(c => myAuth.includes(c)))) flags.push(`legal: ${why}${sponsorship === 'AVAILABLE' ? ' (sponsorship available)' : ''}`);
  }

  // 5. geo
  if (onsiteOnly && onsiteOk.length && countries.length && !countries.some(c => onsiteOk.includes(c))) return out('reject', 'geo', `on-site in ${countries.join(', ')}`);
  const excludedMine = codes(j.excluded_countries).filter(c => myAuth.includes(c));
  if (excludedMine.length) return out('reject', 'geo-remote', `excludes ${excludedMine.join(', ')}`);

  // 6. remote
  const rem = gates.remote || {}, acceptRegions = list(rem.accept_regions), regions = list(j.allowed_regions);
  const mine = [...myAuth, ...onsiteOk];
  // a region is accepted when it matches accept_regions, or names (in words or ISO codes) a country the user may
  // work in or would go on-site in: "Spain", "Germany, Spain", "ES, PT". Countries named in a region with an
  // exclusion may be the excluded ones, so they are not read there.
  const regionAccepted = r => matchesAny(r, acceptRegions) || (!EXCLUSION.test(r)
    && [...countriesIn(r), ...r.split(/[,;|/()]/).map(s => s.trim()).filter(s => /^[a-z]{2}$/i.test(s)).map(s => s.toUpperCase())].some(c => mine.includes(c)));
  const regionOk = scope === 'geo_restricted' && regions.some(regionAccepted);
  if (isRemote) {
    // a remote option that does not fit still leaves an on-site option in an accepted country, counted where that
    // location itself is office or hybrid; a location with no attendance listed counts too, flagged (a remote-only
    // location in an accepted country is not one)
    const accepted = locations.filter(l => mine.includes(l.country));
    const onsiteOption = [...new Set(accepted.filter(l => l.attendance.includes('office') || l.attendance.includes('hybrid')).map(l => l.country))];
    const unknownOption = [...new Set(accepted.filter(l => !l.attendance.length).map(l => l.country))];
    const fallback = onsiteOption.length ? `on-site option in ${onsiteOption.join(', ')}`
      : unknownOption.length ? `on-site option in ${unknownOption.join(', ')}, attendance unknown` : '';
    if (regions.some(r => EXCLUSION.test(r))) flags.push('remote: region text has an exclusion, check it');
    if (gates.remote && scope === 'geo_restricted') {
      if (!regions.length) flags.push('remote: region-restricted, regions not listed');
      else if (regionOk) flags.push(`remote: limited to ${regions.join(', ')}`);
      else if (fallback) flags.push(`remote: limited to ${regions.join(', ')}; ${fallback}`);
      else if (!acceptRegions.length) flags.push(`remote: limited to ${regions.join(', ')} (no remote.accept_regions in settings)`);
      else if (regions.some(r => EXCLUSION.test(r))) flags.push(`remote: limited to ${regions.join(', ')}`);
      else return out('reject', 'geo-remote', `remote only in ${regions.join(', ')}`);
    }
    if (gates.remote && scope === 'worldwide' && rem.accept_worldwide === false) {
      if (!fallback) return out('reject', 'geo-remote', 'remote worldwide is turned off in settings');
      if (!onsiteOption.length) flags.push(`remote: worldwide; ${fallback}`);
    }
    const reside = list(gates.must_reside_phrases).find(p => matchesAny(text, [p]));
    if (reside) return out('reject', 'geo-remote', `text says "${reside}"`);
  }

  // 7. headcount
  const hc = gates.headcount || {}, min = finite(j.headcount?.min);
  if (min != null) {
    const rejectOver = finite(hc.reject_over), demoteOver = finite(hc.demote_over);
    if (rejectOver != null && min > rejectOver) return out('reject', 'headcount', `${min}+ people (limit ${rejectOver})`);
    const kw = hc.reject_keywords_over || {}, kwMin = finite(kw.min);
    if (kwMin != null && min >= kwMin) {
      const hit = list(kw.keywords).find(k => list(j.industries).some(i => matchesAny(i, [k])) || matchesAny(j.title, [k]));
      if (hit) return out('reject', 'headcount', `${min}+ people and "${hit}"`);
    }
    if (demoteOver != null && min > demoteOver) {
      const unless = list(hc.demote_unless);
      const saved = (unless.includes('remote_worldwide') && isRemote && scope === 'worldwide')
        || (unless.includes('remote_region') && regionOk)
        || (unless.includes('sponsorship') && sponsorship === 'AVAILABLE');
      if (!saved) return out('demote', 'headcount', `${min}+ people (over ${demoteOver})`);
      flags.push(`headcount: ${min}+ people`);
    }
  }
  return out('pass');
}

/** Normalised job from a RealtimeJobs item ({ position, employer }). */
export function fromRtj(item) {
  const pos = item?.position || {}, emp = item?.employer || {};
  const locs = (Array.isArray(pos.locations) ? pos.locations : []).filter(Boolean);
  return {
    company: emp.name || null, title: pos.title || null, text: pos.raw_job_description || '',
    languages: pos.languages || [], required_languages: [],
    attendance: [...new Set(locs.flatMap(l => l.attendance || []))],
    countries: [...new Set(locs.map(l => l.country).filter(Boolean))],
    locations: locs.filter(l => l.country).map(l => ({ country: l.country, attendance: l.attendance || [] })),
    remote_scope: pos.remote_scope || null, allowed_regions: pos.allowed_regions || [], excluded_countries: pos.excluded_countries || [],
    required_citizenships: pos.required_citizenships || [], forbidden_citizenships: pos.forbidden_citizenships || [],
    sponsorship: pos.visa_sponsorship_availability || null,
    mandatory: (pos.objective_criteria || []).filter(c => c?.is_mandatory).map(c => ({ class: c.class || null, text: c.criteria || '' })),
    headcount: emp.headcount || null, industries: emp.industries || [],
  };
}

// Country names (English, from the runtime's own ICU data, plus common aliases and native names) -> ISO codes.
// A location segment must be exactly a country name, so "New Mexico" is not Mexico; Georgia is left out (a US state
// as often as a country). Keys are lower case without accents or punctuation: "España" and "Espana" are one key.
const nameKey = s => String(s || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^the /, '');
const COUNTRY_ALIASES = {
  US: ['usa', 'us', 'u.s.', 'u.s.a.', 'united states of america'],
  GB: ['uk', 'u.k.', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  CZ: ['czech republic', 'czechia'], TR: ['turkey', 'türkiye'], RU: ['russia', 'russian federation'],
  KR: ['south korea', 'korea', 'republic of korea'], NL: ['netherlands', 'holland', 'nederland'],
  ES: ['españa'], DE: ['deutschland'], FR: ['france'], IT: ['italia'], PL: ['polska'], PT: ['portugal'],
  CH: ['schweiz', 'suisse', 'svizzera'], AT: ['österreich'],
};
let NAMES = null;
function countryNames() {
  if (NAMES) return NAMES;
  NAMES = new Map();
  const add = (name, code) => { const k = nameKey(name); if (k && !NAMES.has(k)) NAMES.set(k, code); };   // first wins
  for (const [code, names] of Object.entries(COUNTRY_ALIASES)) for (const n of names) add(n, code);
  try {
    const d = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const raw = String.fromCharCode(a, b), name = d.of(raw);
      if (!name || name === raw || name === 'Unknown Region' || raw === 'GE') continue;
      // a deprecated code (SU, DD, YU) names the same country as its current one: keep the current code
      let code = raw; try { code = Intl.getCanonicalLocales(`und-${raw}`)[0].slice(4) || raw; } catch { /* keep raw */ }
      add(name, code);
    }
  } catch { /* no ICU data: only the aliases above */ }
  return NAMES;
}
/** ISO codes of countries named plainly in a location string ("Berlin, Germany", "Remote - Spain"). */
export function countriesIn(location) {
  const names = countryNames(), found = new Set();
  for (const seg of String(location || '').split(/[,;|/()]|\s[-–]\s|\n/)) {
    const k = nameKey(seg);
    if (names.has(k)) found.add(names.get(k));
  }
  return [...found];
}
/** Attendance words in a location or workplace string. */
export function attendanceIn(location) {
  const s = String(location || ''), a = [];
  if (/\bremote\b/i.test(s)) a.push('remote');
  if (/\bhybrid\b/i.test(s)) a.push('hybrid');
  if (/\bon-?\s?site\b|\bin[- ]office\b/i.test(s)) a.push('office');
  return a;
}
/** Normalised job for sources that only have text (ATS boards, LinkedIn): what can be read plainly, nothing guessed.
 * location is one string or a list (one string per location, so each country keeps its own attendance). */
export function fromText({ company, title, text, location }) {
  const parts = (Array.isArray(location) ? location : [location]).map(s => String(s ?? '')).filter(Boolean);
  const uniq = a => [...new Set(a)];
  return { company: company || null, title: title || null, text: text || '', languages: [], required_languages: [],
    attendance: uniq(parts.flatMap(attendanceIn)), countries: uniq(parts.flatMap(countriesIn)),
    locations: parts.flatMap(p => countriesIn(p).map(country => ({ country, attendance: attendanceIn(p) }))),
    remote_scope: null, allowed_regions: [], excluded_countries: [],
    required_citizenships: [], forbidden_citizenships: [], sponsorship: null, mandatory: [], headcount: null, industries: [] };
}

// Demoted jobs are kept, not dropped: one JSON line each in data/state/demoted.jsonl, once per job (url, else
// company + role), so a source that sees the same job every run does not repeat it.
const demoteKey = d => d?.url || `${d?.company || ''}|${d?.role || ''}`;
const demoteSeen = new Map();
export const DEMOTED_FILE = () => STATE('demoted.jsonl');
export function recordDemote({ source, company, role, url }, g, file = DEMOTED_FILE()) {
  if (!demoteSeen.has(file)) demoteSeen.set(file, new Set(read(file).split('\n').filter(Boolean).map(l => { try { return demoteKey(JSON.parse(l)); } catch { return null; } })));
  const seen = demoteSeen.get(file), entry = { date: today(), source: source || null, company: company || null, role: role || null, url: url || null, gate: g?.gate || null, reason: g?.reason || '' };
  if (seen.has(demoteKey(entry))) return false;
  fs.appendFileSync(file, JSON.stringify(entry) + '\n'); seen.add(demoteKey(entry));
  return true;
}
/** What a source does with a gate result. queue: write the job. markSeen: false for a demote, so the job comes back
 * once the bar is lowered (a reject or a pass is final). A demote is recorded unless dry. */
export function settle(g, meta, { dry = false } = {}) {
  if (g.decision === 'demote' && !dry) recordDemote(meta, g);
  return { queue: g.decision === 'pass', markSeen: g.decision !== 'demote' };
}

/** Counter for a source's log line: "gated 3 (legal 2, geo 1), demoted 1". A source that sees the same gated job on
 * every run passes repeat = true for one it gated before: it is counted apart ("4 still gated from earlier runs"). */
export function gateTally() {
  const by = {}; let demoted = 0, again = 0;
  return {
    add(r, repeat = false) {
      if (r.decision !== 'demote' && r.decision !== 'reject') return;
      if (repeat) again++; else if (r.decision === 'demote') demoted++; else by[r.gate] = (by[r.gate] || 0) + 1;
    },
    get total() { return again + demoted + Object.values(by).reduce((a, b) => a + b, 0); },
    toString() {
      const n = Object.values(by).reduce((a, b) => a + b, 0);
      return [n ? `gated ${n} (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')})` : '', demoted ? `demoted ${demoted}` : '',
        again ? `${again} still gated from earlier runs` : ''].filter(Boolean).join(', ');
    },
  };
}

// Shared gates: the hard rules every source applies before a job reaches the queue (and before any model call).
// Rules come from settings.gates; every key is optional and an absent key means no check. With no settings.gates
// at all, checkGates() always passes, so sources behave exactly as before.
//
// checkGates(job, gates) -> { decision: 'pass' | 'reject' | 'demote', gate, reason, flags: [] }
// job is a normalised description each source builds from its own fields (fromRtj, fromText below). Missing
// fields are null or empty and never cause a reject on their own.
// Order: company, industry, language, legal, geo, remote, headcount. The first reject wins; flags accumulate.
// demote means: do not queue now; the source counts it as demoted (lower the bar in settings to take it later).
import { SETTINGS } from './config.mjs';
import { matchesAny } from './queue.mjs';

export const GATE_KEYS = ['user', 'languages', 'onsite_countries', 'remote', 'sponsorship_refusal_phrases', 'must_reside_phrases', 'headcount', 'companies', 'industries'];
const HIGH_LEVELS = new Set(['b2', 'c1', 'c2', 'native', 'fluent']);
const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(x => String(x ?? '').trim()).filter(Boolean);
const codes = v => list(v).map(x => x.toUpperCase());
const langs = v => list(v).map(x => x.toLowerCase());
const finite = v => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Which gates a settings.gates block turns on, and which of its keys are unknown (doctor prints both). */
export function describeGates(gates) {
  if (!gates || typeof gates !== 'object') return { active: [], unknown: [] };
  const g = gates, u = g.user || {}, hc = g.headcount || {};
  const active = [
    (list(g.companies?.exclude).length || list(g.companies?.agencies).length) && 'company',
    list(g.industries?.exclude).length && 'industry',
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
  const attendance = langs(j.attendance);
  const countries = codes(j.countries);
  const scope = j.remote_scope || null;
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

  // 3. language
  if (myLangs.length) {
    const posting = langs(j.languages);
    if (posting.length && !posting.some(l => myLangs.includes(l))) return out('reject', 'language', `posting language ${posting.join(', ')}`);
    for (const r of j.required_languages || []) {
      const lang = String(r?.lang || '').toLowerCase(); if (!lang || myLangs.includes(lang)) continue;
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
  const noSponsor = j.sponsorship === 'NOT_AVAILABLE';
  if (legalLine || refusal || noSponsor) {
    const why = legalLine ? `work authorization required: ${String(legalLine.text || '').slice(0, 120)}` : refusal ? `text says "${refusal}"` : 'no visa sponsorship';
    if (onsiteOnly && outsideAuth) return out('reject', 'legal', `on-site in ${countries.join(', ')}; ${why}`);
    if (isRemote) flags.push(`legal: ${why}`);
  }

  // 5. geo
  if (onsiteOnly && onsiteOk.length && countries.length && !countries.some(c => onsiteOk.includes(c))) return out('reject', 'geo', `on-site in ${countries.join(', ')}`);
  const excludedMine = codes(j.excluded_countries).filter(c => myAuth.includes(c));
  if (excludedMine.length) return out('reject', 'geo-remote', `excludes ${excludedMine.join(', ')}`);

  // 6. remote
  const rem = gates.remote || {};
  const regionOk = scope === 'geo_restricted' && list(j.allowed_regions).some(r =>
    matchesAny(r, rem.accept_regions) || (/^[a-z]{2}$/i.test(r) && [...myAuth, ...onsiteOk].includes(r.toUpperCase())));
  if (isRemote) {
    // a remote option that does not fit still leaves an on-site option in an accepted country
    const onsiteFallback = (attendance.includes('office') || attendance.includes('hybrid')) && countries.some(c => onsiteOk.includes(c) || myAuth.includes(c));
    if (gates.remote && scope === 'geo_restricted') {
      if (regionOk) flags.push(`remote: limited to ${list(j.allowed_regions).join(', ')}`);
      else if (onsiteFallback) flags.push(`remote: limited to ${list(j.allowed_regions).join(', ') || 'unknown regions'}; on-site option in ${countries.join(', ')}`);
      else return out('reject', 'geo-remote', `remote only in ${list(j.allowed_regions).join(', ') || 'unlisted regions'}`);
    }
    if (gates.remote && scope === 'worldwide' && rem.accept_worldwide === false && !onsiteFallback) return out('reject', 'geo-remote', 'remote worldwide is turned off in settings');
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
        || (unless.includes('sponsorship') && j.sponsorship === 'AVAILABLE');
      if (!saved) return out('demote', 'headcount', `${min}+ people (over ${demoteOver})`);
      flags.push(`headcount: ${min}+ people`);
    }
  }
  return out('pass');
}

/** Normalised job from a RealtimeJobs item ({ position, employer }). */
export function fromRtj(item) {
  const pos = item?.position || {}, emp = item?.employer || {};
  const locs = pos.locations || [];
  return {
    company: emp.name || null, title: pos.title || null, text: pos.raw_job_description || '',
    languages: pos.languages || [], required_languages: [],
    attendance: [...new Set(locs.flatMap(l => l.attendance || []))],
    countries: [...new Set(locs.map(l => l.country).filter(Boolean))],
    remote_scope: pos.remote_scope || null, allowed_regions: pos.allowed_regions || [], excluded_countries: pos.excluded_countries || [],
    required_citizenships: pos.required_citizenships || [], forbidden_citizenships: pos.forbidden_citizenships || [],
    sponsorship: pos.visa_sponsorship_availability || null,
    mandatory: (pos.objective_criteria || []).filter(c => c?.is_mandatory).map(c => ({ class: c.class || null, text: c.criteria || '' })),
    headcount: emp.headcount || null, industries: emp.industries || [],
  };
}

// Country names (English, from the runtime's own ICU data) -> ISO codes. A location segment must be exactly a
// country name, so "New Mexico" is not Mexico; Georgia is left out (a US state as often as a country).
let NAMES = null;
function countryNames() {
  if (NAMES) return NAMES;
  NAMES = new Map([['usa', 'US'], ['us', 'US'], ['u s', 'US'], ['uk', 'GB'], ['england', 'GB'], ['scotland', 'GB'], ['wales', 'GB']]);
  try {
    const d = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b), name = d.of(code);
      if (name && name !== code && name !== 'Unknown Region' && code !== 'GE') NAMES.set(name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(), code);
    }
  } catch { /* no ICU data: only the aliases above */ }
  return NAMES;
}
/** ISO codes of countries named plainly in a location string ("Berlin, Germany", "Remote - Spain"). */
export function countriesIn(location) {
  const names = countryNames(), found = new Set();
  for (const seg of String(location || '').split(/[,;|/()]|\s[-–]\s|\n/)) {
    const k = seg.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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
/** Normalised job for sources that only have text (ATS boards, LinkedIn): what can be read plainly, nothing guessed. */
export function fromText({ company, title, text, location }) {
  return { company: company || null, title: title || null, text: text || '', languages: [], required_languages: [],
    attendance: attendanceIn(location), countries: countriesIn(location), remote_scope: null, allowed_regions: [], excluded_countries: [],
    required_citizenships: [], forbidden_citizenships: [], sponsorship: null, mandatory: [], headcount: null, industries: [] };
}

/** Counter for a source's log line: "gated 3 (legal 2, geo 1), demoted 1". */
export function gateTally() {
  const by = {}; let demoted = 0;
  return {
    add(r) { if (r.decision === 'demote') demoted++; else if (r.decision === 'reject') by[r.gate] = (by[r.gate] || 0) + 1; },
    get total() { return demoted + Object.values(by).reduce((a, b) => a + b, 0); },
    toString() {
      const n = Object.values(by).reduce((a, b) => a + b, 0);
      return [n ? `gated ${n} (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')})` : '', demoted ? `demoted ${demoted}` : ''].filter(Boolean).join(', ');
    },
  };
}

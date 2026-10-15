// The transcription glossary (task 20): the user's own words (employers, products, technologies, acronyms), built before
// each job from data CometScout already has, so the speech engines spell them right. Never sent anywhere: it is built
// and used on this server only.
//   - company names (and their aliases from settings.queue.aliases) from data/state/applications.json and the queue files
//     (data/inbox, data/decoded) found in the last 90 days;
//   - product and technology names from profile/cv-library.json (titles, skills, bullets) and profile/profile.md:
//     capitalised names inside a sentence, Latin-script terms in Russian text, acronyms, mixed forms (SaaS, B2B, E27);
//   - profile/glossary.txt: one term per line, "term = spoken form" for a term said differently ("KPI = кейпиай"),
//     "#" starts a comment; and settings.modules.transcribe.glossary (a list in the same form).
// Terms the user wrote (glossary.txt, settings) come first; the rest are ordered by how often they occur, then how
// recently, and the list is capped (200). Whisper gets the first 50 as hotwords; after the merge, a GigaAM word or
// two-word span that sounds like a term (applyGlossary, the whole list) is replaced with the term's spelling and listed as
// a change from "glossary". Russian words in free text (profile.md, CV bullets) are often inflected ("в Лунабанке"): such
// a form joins its base form when the text has that too ("Лунабанк"), a form with no ending is a base form, and any other
// stays a hint for Whisper only (match: false), never a spelling forced on GigaAM's words. A Cyrillic term never replaces
// a word that differs from it only in the ending.
// Automatic terms (task 23) are names, not vocabulary: a term found in the user's data (not glossary.txt or the settings)
// is kept only when it looks like a name (a brand or product, a Latin-script word, capitals or digits, a multi-word name)
// and is not a common word of either language (lib/transcribe-words.mjs), so "Products" from a CV is never a term. Such a
// term (auto: true) needs a strong sound match on a whole word (never one part of a hyphenated word such as
// "продакт-менеджер"), and never replaces a common word, a Russian loanword or a word that sounds like a common English
// word. Terms the user wrote match as before. The same match (glossaryMatcher) decides the merge's disagreements: the
// variant that is a glossary term wins (lib/transcribe-merge.mjs), and a Whisper word the merge put in is matched too,
// on its own spelling and on what GigaAM heard there ("Takara" where GigaAM heard the term "Aqara" becomes "Aqara").
import fs from 'node:fs';
import path from 'node:path';
import { squash, dratio, core, hasCyr, hasLat, joinWords, endingOnly, KEEP_CYRILLIC, LETTER_RU, COMMON_RU } from './transcribe-merge.mjs';
import { COMMON_EN as COMMON_EN_WORDS, commonEnglish, RU_LOANWORDS } from './transcribe-words.mjs';

export { COMMON_RU };

export const GLOSSARY_MAX = 200;
export const GLOSSARY_DAYS = 90;
export const GLOSSARY_FILE = 'glossary.txt';
export const HOTWORDS_MAX = 50;   // Whisper's hint words share its prompt: the most important terms only

// English words a profile capitalises without being names.
const COMMON_EN = new Set(`i the a an and or but if in on at to of for with from by as is are was were be been this that these those it
its my our your their we you he she they me us them not no yes all any some each every one two three four five also only just more
most less very can will would should could may might must do does did done have has had what when where which who why how
january february march april may june july august september october november december monday tuesday wednesday thursday friday
saturday sunday english spanish german french dutch russian italian portuguese chinese europe european eu usa uk`.split(/\s+/).filter(Boolean));

const lowRu = w => String(w).toLowerCase().replace(/ё/g, 'е');
const RU_COMMON_LIST = [...new Set([...COMMON_RU, ...RU_LOANWORDS, ...KEEP_CYRILLIC].map(lowRu))];
const RU_COMMON = new Set(RU_COMMON_LIST);
/** True for an ordinary word of either language: a frequent English word, a common Russian word or loanword, or one of their case forms. */
export function commonWord(word) {
  const w = core(word);
  if (!w) return false;
  const l = lowRu(w);
  if (commonEnglish(l) || RU_COMMON.has(l)) return true;
  // a case form of a Russian word on the lists ("менеджерами", "продактов")
  return hasCyr(l) && l.length >= 5 && RU_COMMON_LIST.some(b => b.length >= 4 && l.startsWith(b.slice(0, 4)) && endingOnly(b, l));
}
// sound keys of the common English words of 5 letters or more, for loanwords written in Cyrillic ("продакт" is "product")
const EN_KEYS = [...COMMON_EN_WORDS].filter(w => w.length >= 5).flatMap(w => [squash(w), squash(`${w}s`)]);
/** True for a word that sounds like a common English word: a Russian loanword such as "продакт" (product). */
export function soundsCommonEnglish(word) {
  const k = squash(core(word));
  if (k.length < 5) return false;
  return EN_KEYS.some(e => e[0] === k[0] && Math.abs(e.length - k.length) <= 2 && dratio(e, k) <= 0.15);
}
/**
 * Whether a term found in the user's data looks like a name: one word that is not a common word (a Cyrillic one with a
 * capital), or words that each start with a capital or a digit (or carry an inner capital: iPhone), not all of them
 * common ("Philips Hue" and "Claude Code" yes, "Product Manager" and "asking about working" no).
 */
export function nameLike(term) {
  const toks = String(term || '').split(/\s+/).filter(t => /[\p{L}\p{N}]/u.test(t));
  if (!toks.length) return false;
  if (toks.length === 1) { const t = core(toks[0]) || toks[0]; return !commonWord(t) && (!hasCyr(t) || hasLat(t) || /[\p{Lu}\d]/u.test(t)); }
  if (toks.every(t => commonWord(t))) return false;
  return toks.every(t => /^[\p{Lu}\p{N}]/u.test(t) || /\p{Lu}/u.test(t.slice(1)));
}

const LEGAL = /[\s,]+(inc|llc|ltd|limited|gmbh|ag|sa|s\.?l\.?|s\.?a\.?|b\.?v\.?|plc|oy|ab|as|corp|corporation|co|ооо|ао|пао)\.?$/i;
/** A company name as people say it: no "(fictional)", no "| Madrid", no legal suffix. */
export function companyTerm(name) {
  let n = String(name || '').split('|')[0].replace(/\([^)]*\)/g, ' ').replace(/[\s,]+$/, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2 && LEGAL.test(n); i++) n = n.replace(LEGAL, '').trim();
  return n.replace(/^["'«]+|["'»]+$/g, '').trim();
}

/**
 * Terms worth spelling right in free text: acronyms (KPI, PRDs), mixed forms (SaaS, iPhone, B2B, E27), runs of
 * capitalised words inside a sentence (Philips Hue), and in Cyrillic text any Latin-script word. Sentence starts and
 * common capitalised English words are left out.
 */
export function extractTerms(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    const clean = line.replace(/^\s*(#+|[-*+]|\d+[.)])\s+/, '').replace(/[`*_]/g, ' ');
    const cyrLine = hasCyr(clean);
    for (const sentence of clean.split(/(?<=[.!?;:])\s+|\s*[|()[\]]\s*/)) {
      if (!/\p{Ll}/u.test(sentence)) continue;   // a heading or a label in capitals
      const toks = sentence.split(/\s+/).filter(Boolean);
      let run = [];
      const flush = () => { if (run.length) out.push(run.join(' ')); run = []; };
      toks.forEach((raw, i) => {
        const t = core(raw).replace(/['’]s$/, '');
        const ok = t && t.length >= 2 && !COMMON_EN.has(t.toLowerCase()) && (
          /^[A-Z][A-Z0-9&]{1,6}s?$/.test(t)                              // KPI, PRDs, B2B
          || /^[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*$/.test(t)                  // SaaS, iPhone, PostgreSQL
          || (/\d/.test(t) && /[A-Za-z]/.test(t) && t.length <= 12)       // E27, 5G, H100
          || (cyrLine && /^[A-Za-z][A-Za-z0-9.+#-]*$/.test(t))            // a Latin word in Russian text
          || (i > 0 && /^\p{Lu}[\p{Ll}\p{Lu}0-9.+-]*$/u.test(t) && !/^\p{Lu}+$/u.test(t) && (hasLat(t) || hasCyr(t))));   // a name inside a sentence
        if (ok && !/[,;]$/.test(raw)) run.push(t);
        else if (ok) { run.push(t); flush(); }
        else flush();
        if (run.length >= 3) flush();
      });
      flush();
    }
  }
  return out.filter(t => t.length >= 2 && t.length <= 40);
}

/** glossary.txt (or the settings list): [{ term, spoken: [] }]; "term = spoken form, other form". */
export function parseGlossary(text) {
  const out = [];
  for (const raw of [].concat(text ?? []).flatMap(t => String(t).split('\n'))) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [term, spoken = ''] = line.split(/\s*=\s*/, 2);
    if (term.trim()) out.push({ term: term.trim(), spoken: spoken.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean) });
  }
  return out;
}

const dayOf = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const mtimeDay = f => { try { return fs.statSync(f).mtime.toISOString().slice(0, 10); } catch { return null; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const readJsonFile = f => { try { return JSON.parse(readText(f)); } catch { return null; } };
const frontMatter = txt => { const m = txt.match(/^---\n([\s\S]*?)\n---/); const fm = {}; if (m) for (const l of m[1].split('\n')) { const k = l.match(/^([a-z_]+):\s*(.*)$/i); if (k) fm[k[1]] = k[2].replace(/^"|"$/g, '').replace(/\\"/g, '"'); } return fm; };
const keyOf = t => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const low = t => String(t).toLowerCase().replace(/ё/g, 'е');
// a Russian word that ends in a consonant has no case ending: a base form ("Квазар", not "Квазаре")
const BASE_FORM = /[бвгджзклмнпрстфхцчшщ]$/i;

/** Every string in the CV library worth reading for terms: titles, taglines, summaries, bullets, skills. */
function cvTexts(lib) {
  const out = [];
  const walk = (v, k = '') => {
    if (typeof v === 'string') { if (!/^(_comment|id|key|group|contact|dates|name)$/.test(k)) out.push({ text: v, k }); }
    else if (Array.isArray(v)) v.forEach(x => walk(x, k));
    else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  walk(lib);
  return out;
}

/**
 * The glossary for a job: [{ term, spoken, source, count, last, match }] (match false: a Whisper hint only), the user's own
 * terms first, then by count and recency, at most `max`. data/profile/settings are injected by tests.
 */
export function buildGlossary({ data, profileDir, settings = {}, now = new Date(), days = GLOSSARY_DAYS, max = GLOSSARY_MAX } = {}) {
  const terms = new Map();
  // free: found in free text (profile.md, CV bullets), where a Russian word may be an inflected form
  const add = (term, { source, last = null, spoken = [], curated = false, weight = 1, free = false }) => {
    const t = String(term || '').replace(/\s+/g, ' ').trim(), k = keyOf(t);
    if (!t || k.length < 2 || t.length > 40) return;
    const e = terms.get(k);
    if (e) { e.count += weight; if (last && (!e.last || last > e.last)) e.last = last; e.spoken.push(...spoken.filter(s => !e.spoken.includes(s))); e.curated ||= curated; e.free &&= free; return; }
    terms.set(k, { term: t, spoken: [...spoken], source, count: weight, last, curated, free, order: terms.size });
  };
  const cfg = settings?.modules?.transcribe || {};
  const pdir = profileDir;
  // the user's own lists first
  if (pdir) for (const g of parseGlossary(readText(path.join(pdir, GLOSSARY_FILE)))) add(g.term, { source: 'glossary.txt', spoken: g.spoken, curated: true });
  for (const g of parseGlossary(Array.isArray(cfg.glossary) ? cfg.glossary : [])) add(g.term, { source: 'settings', spoken: g.spoken, curated: true });
  // companies the user applied to or saw recently, with their aliases
  const aliasLists = Array.isArray(settings?.queue?.aliases) ? settings.queue.aliases.filter(Array.isArray)
    : settings?.queue?.aliases && typeof settings.queue.aliases === 'object' ? Object.entries(settings.queue.aliases).map(([k, v]) => [k, ...[].concat(v)]) : [];
  const addCompany = (name, last, source) => {
    const c = companyTerm(name); if (!c || /^(unknown|confidential)$/i.test(c)) return;
    add(c, { source, last, weight: 2 });
    for (const fam of aliasLists) if (fam.some(a => keyOf(companyTerm(a)) === keyOf(c))) for (const a of fam) add(companyTerm(a), { source, last });
  };
  if (data) {
    const apps = readJsonFile(path.join(data, 'state', 'applications.json')) || {};
    for (const a of Object.values(apps)) {
      if (!a || typeof a !== 'object' || !a.company) continue;
      const events = Array.isArray(a.events) ? a.events : [];
      const last = [dayOf(a.updated), ...events.map(e => dayOf(e?.date))].filter(Boolean).sort().at(-1) || null;
      addCompany(a.company, last, 'applications');
    }
    const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
    for (const dir of ['decoded', 'inbox']) {
      let names = []; try { names = fs.readdirSync(path.join(data, dir)).filter(f => f.endsWith('.md')); } catch { /* none */ }
      for (const f of names) {
        const file = path.join(data, dir, f);
        const head = readText(file).slice(0, 4000), fm = frontMatter(head);
        const day = dayOf(fm.found) || dayOf(f) || mtimeDay(file);
        if (!day || day < since || !fm.company) continue;
        addCompany(fm.company, day, 'queue');
      }
    }
  }
  // the CV library and the profile
  if (pdir) {
    const cvFile = path.join(pdir, 'cv-library.json'), lib = readJsonFile(cvFile);
    if (lib) {
      const day = mtimeDay(cvFile);
      for (const exp of Array.isArray(lib.experience) ? lib.experience : []) if (exp?.company) add(companyTerm(exp.company), { source: 'cv-library', last: day, weight: 2 });
      for (const { text, k } of cvTexts(lib)) {
        if (k === 'company') continue;
        for (const t of extractTerms(text)) add(t, { source: 'cv-library', last: day, free: true });
      }
      // skills are lists: every item with a capital letter is a name ("Amplitude", "SQL"), lowercase ones are not
      for (const sk of Array.isArray(lib.skills) ? lib.skills : []) {
        for (const item of String(sk?.text || '').split(/\s*[,;()]\s*/)) {
          const t = item.trim();
          if (t && /\p{Lu}/u.test(t) && t.split(/\s+/).length <= 3 && !COMMON_EN.has(t.toLowerCase())) add(t, { source: 'cv-library', last: day });
        }
      }
    }
    const pf = path.join(pdir, 'profile.md');
    for (const t of extractTerms(readText(pf))) add(t, { source: 'profile.md', last: mtimeDay(pf), free: true });
  }
  // Russian words from free text: an inflected form joins its base form when the data has that ("Лунабанке" into
  // "Лунабанк"); a form with no ending is a base form; any other is a hint for Whisper only, never matched on GigaAM's words
  const russianFree = e => e.free && !e.curated && hasCyr(e.term) && !hasLat(e.term);
  for (const e of [...terms.values()].filter(russianFree).sort((a, b) => b.term.length - a.term.length)) {
    const base = [...terms.values()].find(b => b !== e && hasCyr(b.term) && b.term.length < e.term.length && low(e.term).startsWith(low(b.term)) && endingOnly(low(b.term), low(e.term)));
    if (!base) continue;
    base.count += e.count; if (e.last && (!base.last || e.last > base.last)) base.last = e.last; base.base = true;
    terms.delete(keyOf(e.term));
  }
  for (const e of terms.values()) e.match = !russianFree(e) || !!e.base || BASE_FORM.test(e.term);
  // names, not vocabulary: a term from the data must look like a name and not be a common word of either language
  const list = [...terms.values()].filter(e => e.curated || nameLike(e.term));
  list.sort((a, b) => (b.curated - a.curated) || (a.curated && b.curated ? a.order - b.order : 0) || b.count - a.count || String(b.last || '').localeCompare(String(a.last || '')) || a.term.localeCompare(b.term));
  return list.slice(0, max).map(({ term, spoken, source, count, last, match, curated }) => ({ term, spoken, source, count, last, match, ...(curated ? {} : { auto: true }) }));
}

/** glossary-used.txt: one term per line, "term = spoken forms" where the user gave them; a hint-only term says so. */
export const renderGlossary = terms => `${terms.map(t => `${t.spoken?.length ? `${t.term} = ${t.spoken.join(', ')}` : t.term}${t.match === false ? '  # Whisper hint only' : ''}`).join('\n')}${terms.length ? '\n' : ''}`;
/** How many terms go to Whisper as hotwords. */
export const hotwordCount = (terms, max = HOTWORDS_MAX) => Math.min(terms.length, max);
/** Whisper's hotwords: the first `max` terms, most important first (the GigaAM sound match uses the whole list). */
export const hotwords = (terms, max = HOTWORDS_MAX) => terms.slice(0, max).map(t => t.term).join(', ');
/** Lowercase words of the glossary, for the merge's review list. */
export const knownWords = terms => new Set(terms.flatMap(t => [t.term, ...(t.spoken || [])]).flatMap(t => t.toLowerCase().split(/\s+/)).map(w => core(w)).filter(Boolean));

/** The sound keys of a term: its spelling, its spoken forms, and for an acronym the letters read out in Russian. */
export function termKeys(t) {
  const keys = new Set([squash(t.term), ...(t.spoken || []).map(squash)]);
  const toks = t.term.split(/\s+/);
  if (toks.every(x => /^[A-Z]{2,6}s?$/.test(x))) keys.add(squash(toks.flatMap(x => [...x].map(c => LETTER_RU[c] ?? c)).join('')));
  return [...keys].filter(Boolean);
}
/** How close a sound key must be to a term's, by its length: none under 4, exact at 4 and 5, then 0.15, then 0.2. */
export const glossaryThreshold = len => (len < 4 ? -1 : len <= 5 ? 0 : len <= 8 ? 0.15 : 0.2);
/** The same for an automatic term (one from the user's data): none under 5, exact up to 6, then 0.12, then 0.15. */
export const autoThreshold = len => (len < 5 ? -1 : len <= 6 ? 0 : len <= 9 ? 0.12 : 0.15);

/**
 * The glossary's match: find(text, { part }) -> { term, d, kind } or null, kind "exact" (already spelt as the term),
 * "inflected" (a Cyrillic term with another ending: "диммеры" for "Диммер") or "sound" (a sound match under the
 * threshold for its length, a spoken form included). An automatic term matches by sound only on a whole word (`part`: a
 * piece of a hyphenated word is not one), with the stricter threshold, never on a common word or one that sounds like a
 * common English word, and never on a Russian case form of the name ("Бранденвике" is Russian for "in Brandenvik", a
 * made-up town, not a mishearing of it). Hint-only terms (match: false) are left out.
 */
// Russian case endings as squash() spells them: a Latin name written in Cyrillic with one of these after it is that name
// declined in Russian
const CASE_ENDING = /^(a|i|u|e|om|oi|ei|ah|am|ami|ov|ia|iu)$/;
const caseForm = (key, termKey) => key.length > termKey.length && key.startsWith(termKey) && CASE_ENDING.test(key.slice(termKey.length));

export function glossaryMatcher(terms, { exclude = [] } = {}) {
  const ex = new Set([...KEEP_CYRILLIC, ...exclude].map(lowRu));
  const entries = (terms || []).filter(t => t && t.match !== false).map(t => ({ t, keys: termKeys(t), flat: keyOf(t.term), cyr: hasCyr(t.term), low: lowRu(t.term), auto: t.auto === true }));
  const search = (text, part) => {
    const flatText = keyOf(text), low0 = lowRu(text), cyr = hasCyr(text);
    if (!flatText) return null;
    let hit = null, common = null, key = null;
    const isCommon = () => (common ??= commonWord(text) || (cyr && soundsCommonEnglish(text)));
    for (const e of entries) {
      if (e.flat === flatText) return { term: e.t, d: 0, kind: 'exact' };
      if (e.cyr && cyr && endingOnly(low0, e.low)) { if (!hit || hit.kind !== 'inflected') hit = { term: e.t, d: 0, kind: 'inflected' }; continue; }
      if (hit?.kind === 'inflected') continue;
      if (e.auto && (part || isCommon())) continue;
      key ??= squash(text.replace(/\s+/g, ''));
      if (e.auto && cyr && !e.cyr && e.keys.some(k => caseForm(key, k))) continue;
      for (const k of e.keys) {
        const lim = (e.auto ? autoThreshold : glossaryThreshold)(Math.min(key.length, k.length));
        // lengths that far apart cannot be that close
        if (lim < 0 || Math.abs(key.length - k.length) > lim * Math.max(key.length, k.length)) continue;
        const d = dratio(key, k);
        if (d <= lim && (!hit || d < hit.d)) hit = { term: e.t, d, kind: 'sound' };
      }
    }
    if (hit && ex.has(low0)) return null;
    return hit;
  };
  const cache = new Map();   // the same words come back again and again in an hour of speech
  const find = (text, { part = false } = {}) => {
    const k = `${part ? 1 : 0}${text}`;
    if (!cache.has(k)) cache.set(k, search(String(text), part));
    return cache.get(k);
  };
  return { find, size: entries.length };
}

/**
 * After the merge: words that sound like a glossary term become the term's spelling. GigaAM's words (one word, or two in
 * a row), and the Latin words Whisper put in during the merge, matched on their own spelling and on what GigaAM heard
 * there (`heard`). Returns { words, substitutions } (substitutions with source "glossary"); the input is not changed.
 */
export function applyGlossary(words, terms, { exclude = [] } = {}) {
  const ex = new Set([...COMMON_RU, ...KEEP_CYRILLIC, ...exclude.map(x => String(x).toLowerCase())]);
  const m = glossaryMatcher(terms, { exclude });
  const out = [], substitutions = [];
  const notCommon = w => !ex.has(core(w.text).toLowerCase().replace(/ё/g, 'е')) && !ex.has(core(w.text).toLowerCase());
  // GigaAM's Cyrillic words, and a Cyrillic word Whisper gave where its word was the glossary term (the merge's vote)
  const eligible = w => w && (w.source === 'gigaam' || (w.source === 'whisper' && w.vote)) && hasCyr(core(w.text)) && notCommon(w);
  const fromWhisper = w => w && w.source === 'whisper' && hasLat(core(w.text)) && !hasCyr(core(w.text)) && w.heard != null;
  // a sound or exact match that changes the spelling; an inflected form is never forced on a word
  const best = (span, part) => {
    const text = span.map(w => core(w.text)).join(' ');
    const h = m.find(text, { part });
    return h && h.kind === 'sound' ? h : null;
  };
  const partOf = (i, n) => !!(words[i]?.hy || words[i + n]?.hy);   // a piece of a hyphenated word ("продакт-менеджер")
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let hit = null, n = 1;
    if (eligible(w)) {
      // two words only when both are real words (a preposition is never eaten) and the second alone is not the term
      const long = x => core(x.text).length >= 3;
      let two = eligible(words[i + 1]) && !words[i + 1].hy && !/[.!?,;:]$/.test(w.text) && long(w) && long(words[i + 1]) ? best([w, words[i + 1]], partOf(i, 2)) : null;
      if (two) { const second = best([words[i + 1]], partOf(i + 1, 1)); if (second && second.d <= two.d) two = null; }
      const one = best([w], partOf(i, 1));
      if (two && (!one || two.d < one.d)) { hit = two; n = 2; } else hit = one;
    } else if (fromWhisper(w)) {
      // Whisper's Latin word against the term, and GigaAM's word at that moment: the closer one decides
      const own = m.find(core(w.text), { part: partOf(i, 1) });
      if (!own || own.kind !== 'exact') {
        const heard = hasCyr(core(w.heard)) && notCommon({ text: w.heard }) ? m.find(core(w.heard), { part: partOf(i, 1) }) : null;
        const cands = [own?.kind === 'sound' ? own : null, heard && heard.kind !== 'inflected' ? heard : null].filter(Boolean).sort((a, b) => a.d - b.d);
        hit = cands[0] && keyOf(cands[0].term.term) !== keyOf(core(w.text)) ? cands[0] : null;
      }
    }
    if (!hit) { out.push(w); continue; }
    const span = words.slice(i, i + n), before = joinWords(span.map(x => ({ ...x, t: x.text })));
    const lead = span[0].text.match(/^[^\p{L}\p{N}]*/u)[0], trail = span.at(-1).text.match(/[^\p{L}\p{N}]*$/u)[0];
    const after = lead + hit.term.term + trail;
    substitutions.push({ time: span[0].start, before, after, source: 'glossary', similarity: Math.round((1 - hit.d) * 100) / 100 });
    out.push({ ...span[0], text: after, end: span.at(-1).end, source: 'glossary', ...(span[0].heard == null ? { heard: before } : {}) });
    i += n - 1;
  }
  return { words: out, substitutions };
}

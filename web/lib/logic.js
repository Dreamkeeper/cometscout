// Pure logic for the Today screen: filtering, grouping, ordering, formatting. No DOM, so node --test covers it.

// Verdict groups in the list, best first; an unknown verdict goes last.
export const VERDICT_ORDER = ['strong-fit', 'investable-stretch', 'long-shot', 'unreadable', 'weak-fit', 'gate-reject'];
export const LATER_CHOICES = [1, 3, 7];
// Skip reasons: the label key in the UI, and the note recorded (English, so a later "wrong pick: why?" suggestion
// can count them whatever the locale).
export const SKIP_REASONS = [
  { id: 'too_senior', note: 'too senior' }, { id: 'too_junior', note: 'too junior' }, { id: 'wrong_domain', note: 'wrong domain' },
  { id: 'location', note: 'location or visa' }, { id: 'language', note: 'language' }, { id: 'company', note: 'company' },
  { id: 'in_contact', note: 'already in contact' }, { id: 'other', note: 'other' },
];
/** The note sent with status "skipped": the reason, then the user's own words if any. */
export function skipNote(reasonId, text = '') {
  const r = SKIP_REASONS.find(x => x.id === reasonId) || SKIP_REASONS[SKIP_REASONS.length - 1];
  const extra = String(text || '').replace(/\s+/g, ' ').trim();
  return extra ? `${r.note}: ${extra}` : r.note;
}

/** Lowercase, accents dropped, so "Malaga" finds "Málaga". */
export const fold = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/ё/g, 'е');

/** True while a job is put off: its later_until is after `date` (YYYY-MM-DD). */
export const isLater = (item, date) => !!item?.later_until && String(item.later_until) > String(date || '');

export const DEFAULT_FILTERS = Object.freeze({ q: '', source: '', verdict: '', hasPack: false, hideLater: true });
/** Does one item pass the filters? q: every word must appear in company, role, location or source. */
export function matches(item, f = DEFAULT_FILTERS, date = '') {
  if (f.source && item.source !== f.source) return false;
  if (f.verdict && item.verdict !== f.verdict) return false;
  if (f.hasPack && !item.pack) return false;
  if (f.hideLater && isLater(item, date)) return false;
  const words = fold(f.q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([item.company, item.role, item.location, item.source].join(' '));
  return words.every(w => hay.includes(w));
}

/**
 * The list as the screen shows it: today's picks first (in the run's order), then the pool grouped by verdict
 * (in the server's order, best first inside a group). Empty groups are left out.
 * Returns [{ key, kind: "picks" | "verdict", verdict?, items }].
 */
export function groupItems(today, f = DEFAULT_FILTERS) {
  const date = today?.date || '';
  const picks = (today?.picks || []).filter(i => matches(i, f, date));
  const pool = (today?.pool || []).filter(i => matches(i, f, date));
  const groups = [];
  if (picks.length) groups.push({ key: 'picks', kind: 'picks', items: picks });
  const rank = v => { const i = VERDICT_ORDER.indexOf(v); return i < 0 ? VERDICT_ORDER.length : i; };
  const verdicts = [...new Set(pool.map(i => i.verdict))].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
  for (const v of verdicts) groups.push({ key: `verdict:${v}`, kind: 'verdict', verdict: v, items: pool.filter(i => i.verdict === v) });
  return groups;
}

/** File names in display order. */
export const order = groups => groups.flatMap(g => g.items.map(i => i.file));

/** The file `step` places away from `current` (j: +1, k: -1), staying at the ends; the first one when nothing is selected. */
export function stepFile(list, current, step = 1) {
  if (!list.length) return null;
  const i = list.indexOf(current);
  if (i < 0) return step < 0 ? list[list.length - 1] : list[0];
  return list[Math.max(0, Math.min(list.length - 1, i + step))];
}

/**
 * After an action on `current`: the job that followed it in the old order and is still listed, else the one before
 * it, else the first job; null when the list is empty. Keeps "the next job opens" true even when the acted-on job
 * leaves the list.
 */
export function nextAfterAction(before, current, after) {
  if (!after.length) return null;
  const still = new Set(after);
  const i = before.indexOf(current);
  if (i >= 0) {
    for (let j = i + 1; j < before.length; j++) if (still.has(before[j]) && before[j] !== current) return before[j];
    for (let j = i - 1; j >= 0; j--) if (still.has(before[j]) && before[j] !== current) return before[j];
  }
  return after.find(f => f !== current) || after[0];
}

/** The item for a file, from picks or pool. */
export const findItem = (today, file) => [...(today?.picks || []), ...(today?.pool || [])].find(i => i.file === file) || null;

/** Distinct values of a field for a filter's options, sorted. */
export const optionsOf = (today, key) => [...new Set([...(today?.picks || []), ...(today?.pool || [])].map(i => i[key]).filter(Boolean))].sort();

/** "2 Oct" (en) or "2 окт." (ru) from YYYY-MM-DD; the input itself when it is not a date. */
export function formatDate(iso, locale = 'en') {
  const s = String(iso || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return s;
  try { return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d); } catch { return s.slice(0, 10); }
}

/** Whole days from a to b (YYYY-MM-DD), b - a. */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** The verdict's label ("Strong fit"), or the verdict itself when the table has none. */
export const verdictName = (v, t) => { if (!v) return ''; const k = `verdict.${v}`; const s = t(k); return s === k ? v : s; };
/** A status's label ("Applied"), or the status itself. */
export const statusName = (s, t) => { if (!s) return ''; const k = `ws.status.${s}`; const x = t(k); return x === k ? s : x; };

/** The CSS class suffix for a verdict chip. */
export const verdictTone = v => ({ 'strong-fit': 'good', 'investable-stretch': 'info', 'long-shot': 'warn', 'gate-reject': 'bad', 'weak-fit': 'bad' }[v] || 'muted');

/**
 * Lint hits of a pack.json as one list: [{ kind: "cv" | "cover_letter" | "answer", field, level: "error" | "warn", id, match, why }];
 * field is the form field for an answer.
 */
export function lintHits(pack) {
  const l = pack?.lint || {}, out = [];
  const add = (kind, field, r) => {
    for (const [level, list] of [['error', r?.errors], ['warn', r?.warns]]) for (const h of list || []) out.push({ kind, field, level, id: h.id, match: h.match || '', why: h.why || '' });
  };
  add('cv', '', l.cv); add('cover_letter', '', l.cover_letter);
  for (const a of l.answers || []) add('answer', a.field || '', a);
  return out;
}

/** The job text without its "# Company - Role" first line (the header already shows it). */
export const bodyText = text => String(text || '').replace(/^#[^\n]*\n+/, '').trim();

/** The picks group title: "Today's picks (n)", or "Picks of Oct 1 (n)" when the latest picks are not today's (a run failed). */
export function picksTitle(today, n, t, locale = 'en') {
  const day = today?.picks_date;
  return day && day !== today?.date ? t('ws.picks_of', { date: formatDate(day, locale), n }) : t('ws.picks', { n });
}

// Filters are remembered between visits; the search text is not.
const KEPT = ['source', 'verdict', 'hasPack', 'hideLater'];
/** What to store: the filters without the search text. */
export const filtersToSave = f => Object.fromEntries(KEPT.map(k => [k, (f || {})[k] ?? DEFAULT_FILTERS[k]]));
/** Filters from what was stored: known keys of the right type only, the search always empty. */
export function filtersFromSaved(saved) {
  const out = { ...DEFAULT_FILTERS };
  if (saved && typeof saved === 'object') for (const k of KEPT) if (typeof saved[k] === typeof DEFAULT_FILTERS[k]) out[k] = saved[k];
  return out;
}

/**
 * What to fetch for the selected job: { job, pack } true when it is neither loaded nor loading. After an action the
 * job's decode is dropped from the cache, and when the same job stays selected this asks for it again.
 */
export function toLoad(file, jobs, packs, inflight = new Set()) {
  if (!file) return { job: false, pack: false };
  return { job: !(jobs || {})[file] && !inflight.has(`job:${file}`), pack: !(packs || {})[file] && !inflight.has(`pack:${file}`) };
}

/**
 * The pack pane's content from an /api/pack answer. With pack.json: its flags, lint hits and answers. Without it
 * (an older pack): what answers.md says, and null where answers.md says nothing, so the pane never claims
 * "nothing flagged" or "no lint hits" that no file recorded. Returns null when the job has no pack.
 */
export function packView(pack) {
  if (!pack || !pack.dir) return null;
  const p = pack.pack;
  if (p) return { fromMd: false, flags: p.flags || [], hits: p.lint ? lintHits(p) : null, answers: p.answers || [], positioning: p.raw?.positioning || p.positioning || null, built: p.built || null };
  const md = pack.from_answers || {};
  return { fromMd: true, flags: md.flags ?? null, hits: null, answers: md.answers ?? null, positioning: md.positioning || null, built: null };
}

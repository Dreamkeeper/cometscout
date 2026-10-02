// The queue: one Markdown file per job in data/inbox -> decoded/ or rejected/ (with a "## Decode Result" block appended).
// Sources write files with writeJob(); the decoder reads them with loadJob().
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, SETTINGS, STATE, read, today, num } from './config.mjs';
import { runHook } from './hooks.mjs';
import { aliasFamilies, companyMatch, sameRoleForDedupe, dedupeStopwords } from './companies.mjs';
import { recordSighting } from './sightings.mjs';
import { norm } from './text.mjs';

export { norm };

// File-name part: at most 60 bytes (ext4 allows 255 bytes per name, and Cyrillic takes 2 bytes a letter).
const cutBytes = (s, n) => { while (Buffer.byteLength(s) > n) s = s.slice(0, -1); return s.replace(/-+$/, ''); };
export const slug = s => cutBytes(norm(s).replace(/\s+/g, '-'), 60) || 'unknown';

export function frontMatter(txt) {
  const m = txt.match(/^---\n([\s\S]*?)\n---/); const fm = {};
  if (m) for (const l of m[1].split('\n')) { const k = l.match(/^([a-z_]+):\s*(.*)$/i); if (k) fm[k[1]] = k[2].replace(/^"|"$/g, '').replace(/\\"/g, '"'); }
  return fm;
}
/**
 * Whole-word, case-insensitive match of any term in `list` against `hay` (titles, locations).
 * "soc" matches "SOC Analyst" but not "Associate"; phrases match as a unit ("product manager").
 * A trailing * matches word prefixes: "engineer*" matches "engineering". Works for Cyrillic too.
 */
export function matchesAny(hay, list) {
  const h = String(hay || '');
  return (list || []).some(t => {
    const term = String(t || '').trim(); if (!term) return false;
    const star = term.endsWith('*');
    const body = (star ? term.slice(0, -1) : term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}${star ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu').test(h);
  });
}
const q = v => `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;

// Duplicate index, built once per process from every queue folder and kept up to date by writeJob.
// A job is a duplicate when (1) its URL was queued before, or (2) the same (known) company posted the exact same title
// (after normalising) within queue.dedupe_days (default 60) and the locations overlap or one is unknown: that is
// the same job arriving from two sources. Different titles are never merged ("Product Manager" and "Senior
// Product Manager" at one company are two jobs), and the same title in two different cities is two jobs.
// (3) The user's own applications (data/state/applications.json, any status) are matched more loosely: the same
// employer (alias families, lib/companies.mjs) and roles sharing at least half their words is a role already acted on.
let INDEX = null;
// The query is dropped (tracking), except parameters that name the job: a Greenhouse embed is "/jobs?gh_jid=111".
const JOB_ID_PARAMS = new Set(['gh_jid', 'jobid', 'id']);
export const normUrl = u => {
  const s = String(u || '').trim(), base = s.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  const query = (s.match(/\?([^#]*)/) || [])[1] || '';
  const keep = query.split('&').map(p => p.split('=')).filter(([k, v]) => k && v && JOB_ID_PARAMS.has(k.toLowerCase()))
    .map(([k, v]) => `${k.toLowerCase()}=${v}`).sort();
  return keep.length ? `${base}?${keep.join('&')}` : base;
};
// "Unknown" (or no company) says nothing about who posted the job, so two such jobs never match on the title alone.
const knownCompany = c => !!c && c !== 'unknown';
function index() {
  if (INDEX) return INDEX;
  INDEX = { urls: new Map(), titles: new Map() };   // titles: key -> [{ where, found, loc }]
  for (const dir of ['inbox', 'decoded', 'rejected']) for (const f of fs.readdirSync(DIRS[dir])) {
    if (!f.endsWith('.md')) continue;
    const fm = frontMatter(read(path.join(DIRS[dir], f)));
    remember(fm, `${dir}/${f}`, fm.found || f.slice(0, 10));
  }
  return INDEX;
}
function remember(fm, where, found) {
  if (fm.url) INDEX.urls.set(normUrl(fm.url), where);
  const c = norm(fm.company), r = norm(fm.role);
  if (!knownCompany(c) || !r) return;
  const k = `${c}|${r}`; if (!INDEX.titles.has(k)) INDEX.titles.set(k, []);
  INDEX.titles.get(k).push({ where, found, loc: locWords(fm.location) });
}
const GENERIC = new Set(['remote', 'hybrid', 'onsite', 'on', 'site', 'office', 'full', 'time', 'europe', 'eu', 'emea', 'worldwide', 'global', 'anywhere']);
const locWords = l => new Set(norm(l).split(' ').filter(w => w.length > 1 && !GENERIC.has(w)));
/** applications.json as an object: missing -> {}; broken JSON throws, so nothing is overwritten or marked seen. */
export function readApplications(file = STATE('applications.json')) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(read(file)) || {}; } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}); fix it and run again`); }
}
/**
 * An entry that holds only "later" events (the workspace's "not now" on a job with no status yet). It records no
 * application, so picks, dedupe, history and the exports leave it out.
 */
export const laterOnly = a => !!a && typeof a === 'object' && !a.status && Array.isArray(a.events) && a.events.length > 0 && a.events.every(e => e?.type === 'later');
// applications.json is read once and read again only when the file changes (cli.mjs applied/status write it).
// Every source calls applications() before it marks anything seen, so a broken file stops it first.
let APPS = null;
export function applications() {
  const file = STATE('applications.json');
  let st = null; try { st = fs.statSync(file); } catch { /* no applications yet */ }
  const stamp = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : 'none';
  if (APPS?.stamp === stamp) return APPS.list;
  const list = Object.values(readApplications(file)).filter(a => a && typeof a === 'object' && !laterOnly(a));
  APPS = { stamp, list };
  return list;
}
/** The application this job repeats (same employer, more than half the distinguishing role words shared), or null. */
export function inApplications(company, role) {
  if (!knownCompany(norm(company)) || !norm(role)) return null;
  const fams = aliasFamilies(), stop = dedupeStopwords();
  return applications().find(a => sameRoleForDedupe(a.role, role, stop) && companyMatch(a.company, company, fams)) || null;
}
/** Where this job was queued before, or null. byTitle: false matches by URL only (for a placeholder company name). */
export function alreadyQueued(company, role, url, location, { byTitle = true } = {}) {
  const ix = index();
  if (url && ix.urls.has(normUrl(url))) return ix.urls.get(normUrl(url));
  const c = norm(company), r = norm(role); if (!byTitle || !knownCompany(c) || !r) return null;
  const days = num(SETTINGS.queue?.dedupe_days, 60, 0), mine = locWords(location);
  for (const hit of ix.titles.get(`${c}|${r}`) || []) {
    const age = (Date.parse(today()) - Date.parse(hit.found)) / 864e5;
    if (Number.isFinite(age) && age > days) continue;                        // an old repost of the same title is a new job
    if (mine.size && hit.loc.size && ![...mine].some(w => hit.loc.has(w))) continue;   // same title, another city
    return hit.where;
  }
  const app = inApplications(company, role);
  return app ? `applications: ${app.company}: ${app.role} (${app.status || 'no status'})` : null;
}

/**
 * Write one job to the inbox. job: { company, role, url, source, location, headcount?, salary?, posted?, notes?, text, extra? }
 * `extra` carries source-specific metadata into the front matter (e.g. { band: 2, remote_scope: "europe", lang: "ru" });
 * keys must be lowercase snake_case and cannot overwrite the standard fields.
 * Every call, a duplicate too, is recorded in data/state/sightings.jsonl for the source scorecard.
 * titleDedupe: false when the company is a placeholder ("Confidential"), so two hidden employers with the same
 * title are not taken for one job; the URL still dedupes.
 */
export function writeJob(job, { titleDedupe = true } = {}) {
  const dup = alreadyQueued(job.company, job.role, job.url, job.location, { byTitle: titleDedupe });
  if (dup) { recordSighting(job, 'duplicate', dup); return { written: false, reason: `already in ${dup}` }; }
  const base = `${today()}--${slug(job.company)}--${slug(job.role)}`;
  let file = `${base}.md`;
  for (let i = 2; fs.existsSync(path.join(DIRS.inbox, file)); i++) file = `${base}--${i}.md`;
  const fields = ['company', 'role', 'url', 'source', 'location', 'headcount', 'salary', 'posted', 'notes'];
  const reserved = new Set([...fields, 'found', 'full_text', 'text', 'extra']);
  const extra = Object.entries(job.extra || {}).filter(([k, v]) => /^[a-z][a-z0-9_]*$/.test(k) && !reserved.has(k) && v != null && v !== '')
    .map(([k, v]) => `${k}: ${q(Array.isArray(v) ? v.join(', ') : v)}`);
  const body = ['---', ...fields.filter(f => job[f] != null && job[f] !== '').map(f => `${f}: ${q(job[f])}`), ...extra, `found: ${today()}`, ...(job.text ? [] : ['full_text: "missing"']), '---', '',
    `# ${job.company} - ${job.role}`, '', (job.text || '_No job text could be fetched; open the link._').trim(), ''].join('\n');
  fs.writeFileSync(path.join(DIRS.inbox, file), body, 'utf8');
  index(); remember(job, `inbox/${file}`, today());
  recordSighting(job, 'written', `inbox/${file}`);
  runHook('job_written', { file, company: job.company, role: job.role, url: job.url || null, source: job.source || null });
  return { written: true, file };
}

export function loadJob(file) {
  const p = ['inbox', 'decoded', 'rejected'].map(d => path.join(DIRS[d], file)).find(fs.existsSync);
  if (!p) throw new Error(`queue file not found: ${file}`);
  const txt = read(p); const fm = frontMatter(txt);
  const rest = txt.replace(/^---\n[\s\S]*?\n---\n?/, ''); const cut = rest.lastIndexOf('## Decode Result');
  return { file, path: p, fm, text: txt, body: (cut >= 0 ? rest.slice(0, cut) : rest).trim(), decode: cut >= 0 ? rest.slice(cut) : '' };
}

export function parseResult(txt) {
  const b = txt.slice(txt.lastIndexOf('## Decode Result'));
  const g = k => (b.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1];
  const vm = (g('verdict') || '').match(/^([a-z-]+)(?: \((.*)\))?$/) || [];
  const list = (k, sep) => { const v = (g(k) || '').trim(); return !v || v === 'none' ? [] : v.split(sep).map(x => x.trim()).filter(Boolean); };
  return { verdict: vm[1], gate: vm[2], confidence: g('confidence'), apply_priority: g('apply_priority') ? Number(g('apply_priority')) : undefined,
    rationale: g('rationale') || '', action: g('action') || '', hold_reason: g('hold_reason'), decoded_on: (b.match(/Decoded (\d{4}-\d{2}-\d{2})/) || [])[1],
    fit_signals: list('fit_signals', '; '), gaps: list('gaps', '; '), fact_flag_ids: list('fact_flags', ', ') };
}

// HTML entities: numeric (&#233; &#xE9;) and the common named ones, in one pass so "&amp;lt;" stays "&lt;".
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: '\u00e9', egrave: '\u00e8', aacute: '\u00e1', agrave: '\u00e0',
  iacute: '\u00ed', oacute: '\u00f3', uacute: '\u00fa', ntilde: '\u00f1', ccedil: '\u00e7', auml: '\u00e4', ouml: '\u00f6', uuml: '\u00fc', szlig: '\u00df',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', bull: '\u2022', middot: '\u00b7',
  laquo: '\u00ab', raquo: '\u00bb', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', euro: '\u20ac', pound: '\u00a3' };
export const decodeEntities = s => String(s || '').replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (all, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all;
  }
  return ENTITIES[e] ?? (/^(AMP|LT|GT|QUOT)$/.test(e) ? ENTITIES[e.toLowerCase()] : all);   // case matters: &Eacute; is not &eacute;
});

/** Strip HTML to readable text. */
export const htmlText = h => decodeEntities(String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|li|div|h\d|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, ' ')).replace(/\u00a0/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

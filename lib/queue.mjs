// The queue: one Markdown file per job in data/inbox -> decoded/ or rejected/ (with a "## Decode Result" block appended).
// Sources write files with writeJob(); the decoder reads them with loadJob().
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, SETTINGS, read, today, num } from './config.mjs';

// Letters and digits of any script survive (Japanese, Greek, Hebrew ...), so non-Latin names never collapse to "".
// Accents are dropped from Latin letters only (é -> e); Cyrillic й and Japanese voiced kana keep their marks.
export const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/([a-z])\p{M}+/gu, '$1').normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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
// A job is a duplicate when (1) its URL was queued before, or (2) the same company posted the exact same title
// (after normalising) within queue.dedupe_days (default 60) and the locations overlap or one is unknown: that is
// the same job arriving from two sources. Different titles are never merged ("Product Manager" and "Senior
// Product Manager" at one company are two jobs), and the same title in two different cities is two jobs.
let INDEX = null;
const normUrl = u => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
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
  if (!c || !r) return;
  const k = `${c}|${r}`; if (!INDEX.titles.has(k)) INDEX.titles.set(k, []);
  INDEX.titles.get(k).push({ where, found, loc: locWords(fm.location) });
}
const GENERIC = new Set(['remote', 'hybrid', 'onsite', 'on', 'site', 'office', 'full', 'time', 'europe', 'eu', 'emea', 'worldwide', 'global', 'anywhere']);
const locWords = l => new Set(norm(l).split(' ').filter(w => w.length > 1 && !GENERIC.has(w)));
/** Where this job was queued before, or null. */
export function alreadyQueued(company, role, url, location) {
  const ix = index();
  if (url && ix.urls.has(normUrl(url))) return ix.urls.get(normUrl(url));
  const c = norm(company), r = norm(role); if (!c || !r) return null;
  const days = num(SETTINGS.queue?.dedupe_days, 60, 0), mine = locWords(location);
  for (const hit of ix.titles.get(`${c}|${r}`) || []) {
    const age = (Date.parse(today()) - Date.parse(hit.found)) / 864e5;
    if (Number.isFinite(age) && age > days) continue;                        // an old repost of the same title is a new job
    if (mine.size && hit.loc.size && ![...mine].some(w => hit.loc.has(w))) continue;   // same title, another city
    return hit.where;
  }
  return null;
}

/** Write one job to the inbox. job: { company, role, url, source, location, headcount?, salary?, posted?, notes?, text } */
export function writeJob(job) {
  const dup = alreadyQueued(job.company, job.role, job.url, job.location);
  if (dup) return { written: false, reason: `already in ${dup}` };
  const base = `${today()}--${slug(job.company)}--${slug(job.role)}`;
  let file = `${base}.md`;
  for (let i = 2; fs.existsSync(path.join(DIRS.inbox, file)); i++) file = `${base}--${i}.md`;
  const fields = ['company', 'role', 'url', 'source', 'location', 'headcount', 'salary', 'posted', 'notes'];
  const body = ['---', ...fields.filter(f => job[f] != null && job[f] !== '').map(f => `${f}: ${q(job[f])}`), `found: ${today()}`, ...(job.text ? [] : ['full_text: "missing"']), '---', '',
    `# ${job.company} - ${job.role}`, '', (job.text || '_No job text could be fetched; open the link._').trim(), ''].join('\n');
  fs.writeFileSync(path.join(DIRS.inbox, file), body, 'utf8');
  index(); remember(job, `inbox/${file}`, today());
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
  return { verdict: vm[1], gate: vm[2], confidence: g('confidence'), apply_priority: g('apply_priority') ? Number(g('apply_priority')) : undefined,
    rationale: g('rationale') || '', action: g('action') || '', hold_reason: g('hold_reason'), decoded_on: (b.match(/Decoded (\d{4}-\d{2}-\d{2})/) || [])[1] };
}

/** Strip HTML to readable text. */
export const htmlText = h => String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|li|div|h\d|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

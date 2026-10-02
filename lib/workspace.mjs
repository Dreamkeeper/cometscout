// The workspace's data: what /api/today, /api/job, /api/pack and /api/labels return, and the writes behind
// POST /api/status and /api/later. No network calls: the screen shows what the evening run decided.
// lib/server.mjs turns these into HTTP; everything here takes and returns plain objects, so tests call it directly.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, PROFILE, SETTINGS, STATE, read, readJson, today } from './config.mjs';
import { frontMatter, loadJob, parseResult, readApplications, slug } from './queue.mjs';
import { LABELS, DEFAULT_LOCALE, localeOk } from './i18n.mjs';
import { APPS_FILE, setStatus, addLater, laterUntil, plainQueueName, queueEntry } from './applications.mjs';
import { lockHolder } from './lock.mjs';
import { picksPool, history } from '../decoder/decoder.mjs';

/** An error the server answers with its own status code. */
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// A broken applications.json is answered with 409 and its message; nothing is guessed around it.
const appsOr409 = () => { try { return readApplications(APPS_FILE()); } catch (e) { throw new HttpError(409, e.message); } };

// ---------- packs ----------
// A pack folder is "<date>--<company slug>--<role slug>" directly under data/packs (pack/pack.mjs); packs from the older
// pipeline are "<date>--<company slug>".
const isPackDir = name => !!name && !/[/\\]/.test(name) && name !== '.' && name !== '..' && fs.existsSync(path.join(DIRS.packs, name)) && fs.statSync(path.join(DIRS.packs, name)).isDirectory();
/**
 * The newest pack folder for a queue file: packs.json's entry when it names a folder that exists, else the newest
 * "<date>--<company>--<role>" folder, else the newest "<date>--<company>" folder (older packs, exports without packs.json).
 */
export function packDirFor(file, fm = null, packs = readJson(STATE('packs.json'), {})) {
  const rec = packs?.[file];
  if (rec && !rec.refused && isPackDir(rec.dir)) return rec.dir;
  const meta = fm || frontMatter(read(['decoded', 'rejected', 'inbox'].map(d => path.join(DIRS[d], file)).find(p => fs.existsSync(p)) || ''));
  if (!meta.company && !meta.role) return null;
  const all = fs.readdirSync(DIRS.packs).filter(d => /^\d{4}-\d{2}-\d{2}--/.test(d) && isPackDir(d)).sort();
  const newest = name => all.filter(d => d.slice(12) === name).pop() || null;
  return newest(`${slug(meta.company)}--${slug(meta.role)}`) || (meta.company ? newest(slug(meta.company)) : null);
}
/** The URL a pack file is served at (lib/server.mjs: /files/packs/<dir>/<file>). */
export const packFileUrl = (dir, name) => `/files/packs/${encodeURIComponent(dir)}/${encodeURIComponent(name)}`;

// ---------- /api/today ----------
const item = (file, fm, v, { state, apps, packs }) => {
  const a = apps[file];
  return {
    file, company: fm.company || '', role: fm.role || '', location: fm.location || '', source: fm.source || '', url: fm.url || '',
    verdict: v.verdict || null, apply_priority: v.apply_priority ?? null, band: fm.band !== undefined && fm.band !== '' ? Number(fm.band) : null,
    decoded_on: v.decoded_on || file.slice(0, 10), shown: state[file]?.shown || 0,
    application: a && a.status ? { status: a.status, updated: a.updated || null } : null,
    pack: packDirFor(file, fm, packs), later_until: laterUntil(a),
  };
};
/**
 * Today's picks (the jobs in picks.json whose `last` is its latest date, in the order the run recorded them) and the
 * pool (every other job picks could still choose, best first). A broken applications.json throws.
 */
export function todayPayload() {
  const apps = appsOr409();
  const { open, state } = picksPool();
  const packs = readJson(STATE('packs.json'), {});
  const ctx = { state, apps, packs };
  const latest = Object.values(state).map(s => String(s?.last || '')).filter(Boolean).sort().pop() || null;
  const picks = [];
  for (const [file, s] of Object.entries(state)) {
    if (!latest || s?.last !== latest || !plainQueueName(file)) continue;
    const q = queueEntry(file, ['decoded', 'rejected']); if (!q) continue;
    const t = read(path.join(DIRS[q.dir], file));
    picks.push(item(file, frontMatter(t), parseResult(t), ctx));
  }
  const inPicks = new Set(picks.map(p => p.file));
  const pool = open.filter(c => !inPicks.has(c.file)).map(c => item(c.file, c.fm, c.v, ctx));
  return { date: today(), picks_date: latest, picks, pool };
}

// ---------- /api/job ----------
/** One job: front matter, its text without the decode block, the parsed decode, history with the company, the application entry. */
export function jobPayload(file) {
  const q = queueEntry(file, ['decoded', 'rejected']);
  if (!q) throw new HttpError(404, 'no such job');
  const job = loadJob(file);
  const decode = parseResult(job.text);
  const rules = new Map(PROFILE.factRules.map(r => [r.id, r.why || '']));
  const apps = appsOr409();
  const h = history(job.fm.company, { excludeFile: file });
  return {
    file, dir: q.dir, fm: job.fm, text: job.body, decode: { ...decode, fact_flags: decode.fact_flag_ids.map(id => ({ id, why: rules.get(id) || '' })) },
    history: h.startsWith('(') ? [] : h.split('\n').map(l => l.replace(/^- /, '').replace(/ \[recorded by the candidate\]$/, '')), application: apps[file] || null, later_until: laterUntil(apps[file]),
  };
}

// ---------- /api/pack ----------
/** One "## <title>" section of answers.md (up to the next "## "), or null when it has none. */
export function mdSection(md, title) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex(l => l.trim().toLowerCase() === `## ${title}`.toLowerCase());
  if (i < 0) return null;
  const end = lines.findIndex((l, j) => j > i && /^## /.test(l));
  return lines.slice(i + 1, end < 0 ? undefined : end).join('\n').trim();
}
const coverLetterText = md => mdSection(md, 'Cover letter (paste as text)') || '';
/**
 * What answers.md says, for a pack without pack.json (older packs): the "Check before sending" items as written,
 * the form answers ("### <field>" blocks, "(rewrite in your own words)" and an "_note_" line understood), and
 * whether each section was there at all. Nothing is assumed for a section that is missing.
 */
export function parseAnswersMd(md) {
  const check = mdSection(md, 'Check before sending'), form = mdSection(md, 'Form answers (drafts)');
  const flags = check == null ? null : check.split('\n').filter(l => /^\s*[-*•] /.test(l)).map(l => l.replace(/^\s*[-*•] /, '').trim()).filter(Boolean);
  let answers = null;
  if (form != null) {
    answers = [];
    for (const block of form.split(/^### /m).slice(1)) {
      const [head, ...body] = block.split('\n');
      const own = /\s*\(rewrite in your own words\)\s*$/i.test(head);
      const lines = body.join('\n').trim().split('\n');
      const noteLine = lines.length > 1 && /^_.+_$/.test(lines[lines.length - 1].trim()) ? lines.pop().trim().slice(1, -1) : '';
      answers.push({ field: head.replace(/\s*\(rewrite in your own words\)\s*$/i, '').trim(), answer: lines.join('\n').trim(), own_words: own, ...(noteLine ? { note: noteLine } : {}) });
    }
    if (!answers.length && form) answers.push({ field: '', answer: form });
  }
  const lead = (String(md || '').match(/^\*\*CV leads with:\*\* (.+)$/m) || [])[1] || null;
  return { flags, answers, positioning: lead };
}
/**
 * The newest pack for a job: answers.md, pack.json (null when the pack has none), from_answers (answers.md read as
 * above, when pack.json is missing), the cover letter text when it is pasted as text, and the files.
 * A job without a pack answers { file, dir: null, pack: null }.
 */
export function packPayload(file) {
  const q = queueEntry(file, ['decoded', 'rejected']);
  if (!q) throw new HttpError(404, 'no such job');
  const dir = packDirFor(file);
  if (!dir) return { file, dir: null, pack: null };
  const abs = path.join(DIRS.packs, dir);
  const answers = read(path.join(abs, 'answers.md'));
  const pack = readJson(path.join(abs, 'pack.json'), null);
  const files = fs.readdirSync(abs).filter(f => fs.statSync(path.join(abs, f)).isFile() && FILE_TYPES[path.extname(f).toLowerCase()]).sort()
    .map(name => ({ name, url: packFileUrl(dir, name), type: path.extname(name).slice(1).toLowerCase() }));
  const pdfs = files.filter(f => f.type === 'pdf');
  const cv = pdfs.find(f => / CV - /.test(f.name)) || pdfs.find(f => !/ CL - /.test(f.name)) || null;
  return { file, dir, answers, pack, from_answers: pack ? null : parseAnswersMd(answers), files, cv_pdf: cv ? cv.url : null,
    cover_letter: { mode: pack?.cover_letter || null, text: coverLetterText(answers) } };
}

// ---------- pack files ----------
export const FILE_TYPES = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };
/**
 * The file a /files/packs/ URL names, or null. `rest` is the URL path after "/files/packs/", still percent-encoded.
 * Exactly "<pack dir>/<file>": every segment is decoded once and must be a plain name (no "..", no slash or
 * backslash, no drive letter, no NUL); the real path, symlinks resolved, must stay inside data/packs.
 */
export function resolvePackFile(rest) {
  const parts = String(rest || '').split('/');
  if (parts.length !== 2) return null;
  let names; try { names = parts.map(decodeURIComponent); } catch { return null; }
  if (names.some(n => !n || n === '.' || n === '..' || /[/\\:\0]/.test(n) || path.isAbsolute(n))) return null;
  const type = FILE_TYPES[path.extname(names[1]).toLowerCase()];
  if (!type) return null;
  let root, real;
  try { root = fs.realpathSync(DIRS.packs); real = fs.realpathSync(path.join(DIRS.packs, names[0], names[1])); } catch { return null; }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).length !== 2) return null;
  if (!fs.statSync(real).isFile()) return null;
  return { path: real, name: names[1], type };
}

// ---------- writes ----------
const want = (body, k, type) => { if (typeof body?.[k] !== type) throw new HttpError(400, `${k} is missing`); return body[k]; };
const fail = r => { throw new HttpError(r.broken ? 409 : r.missing ? 404 : 400, r.lines.join('\n')); };
/** Writes wait while the run lock is held (evening run, decode, pack, import, backup, restore). */
export const BUSY = 'jobpilot is busy, try again in a minute';
const notBusy = () => { if (lockHolder()) throw new HttpError(409, BUSY); };
/** POST /api/status { file, status, note? }: the same write as `cli.mjs status` (lib/applications.mjs). */
export function postStatus(body) {
  const file = want(body, 'file', 'string'), status = want(body, 'status', 'string');
  if (body.note != null && typeof body.note !== 'string') throw new HttpError(400, 'note must be text');
  if (!queueEntry(file, ['decoded', 'rejected'])) throw new HttpError(404, 'no such job');   // the jobs the screen shows
  notBusy();
  const r = setStatus({ file, status, note: String(body.note || '').trim(), source: 'workspace' });
  if (r.code) fail(r);
  return { ok: true, file, application: r.entry, message: r.lines.join('\n') };
}
/** POST /api/later { file, days }: an event "later" until today + days (1 to 7); the status does not change. */
export function postLater(body) {
  const file = want(body, 'file', 'string');
  if (!queueEntry(file, ['decoded', 'rejected'])) throw new HttpError(404, 'no such job');   // the jobs the screen shows
  if (typeof body.days !== 'number') throw new HttpError(400, 'days must be a number from 1 to 7');
  notBusy();
  const r = addLater({ file, days: body?.days, source: 'workspace' });
  if (r.code) fail(r);
  return { ok: true, file, later_until: r.until, application: r.entry };
}

// ---------- /api/labels ----------
/** The label table for settings.locale, with English filling any key the locale lacks. */
export function labelsPayload(locale = SETTINGS.locale || DEFAULT_LOCALE) {
  const l = localeOk(locale) && LABELS[locale] ? locale : DEFAULT_LOCALE;
  return { locale: l, labels: { ...LABELS[DEFAULT_LOCALE], ...LABELS[l] } };
}

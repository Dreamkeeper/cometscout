// The user's record of what happened to a role (data/state/applications.json): one function per write, shared by
// cli.mjs (applied, status) and the workspace server (POST /api/status, /api/later), so both write the same entries.
// Every write reads the file strictly first: a broken applications.json is refused, never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, STATE, today } from './config.mjs';
import { frontMatter, norm, readApplications, laterOnly } from './queue.mjs';
import { pickRoleWords } from './companies.mjs';

export { laterOnly };
export const APPS_FILE = () => STATE('applications.json');
// accepted: an offer the user took and now works in. Only the user sets it (cli.mjs status, the workspace); outcomes
// from email never do and never move an accepted application to another status.
export const STATUSES = ['applied', 'screen', 'interview', 'offer', 'accepted', 'rejected', 'skipped', 'closed'];
export const QUEUE_DIRS = ['decoded', 'rejected', 'inbox'];
// One limit for every note, from the command line or the workspace: a longer one is refused, never cut.
export const NOTE_MAX = 500;

/** Queue files at a company (exact name first, so "Ready" never picks "Readymade"), narrowed by role word prefixes. */
export function findRole(company, words) {
  const c = norm(company), w = norm(words || '').split(' ').filter(Boolean);
  const all = [];
  for (const dir of QUEUE_DIRS) for (const f of fs.readdirSync(DIRS[dir])) {
    if (!f.endsWith('.md')) continue; const fm = frontMatter(fs.readFileSync(path.join(DIRS[dir], f), 'utf8').replace(/\r\n/g, '\n'));
    if (norm(fm.company).includes(c)) all.push({ file: f, company: fm.company, role: fm.role });
  }
  const exact = all.filter(h => norm(h.company) === c);
  const atCompany = exact.length ? exact : all;
  const roleWords = h => norm(h.role).split(' ');
  return { atCompany, hits: w.length ? atCompany.filter(h => w.every(x => roleWords(h).some(r => r.startsWith(x)))) : atCompany };
}

/** A queue file name as the API takes it: one plain .md name, no folder. */
export const plainQueueName = f => typeof f === 'string' && /^[^/\\:\0]+\.md$/.test(f) && f !== '.md' && !f.startsWith('.');
/** The queue file's { file, dir, company, role }, or null when it is in none of the queue folders. */
export function queueEntry(file, dirs = QUEUE_DIRS) {
  if (!plainQueueName(file)) return null;
  for (const dir of dirs) {
    const p = path.join(DIRS[dir], file);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) { const fm = frontMatter(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')); return { file, dir, company: fm.company, role: fm.role }; }
  }
  return null;
}

/**
 * Record a status. Either `file` (a queue file, as the workspace sends it) or `company` with role `words` (the
 * command line) names the role; `manual` records a role that is not in the queue. Returns { code, lines, key, entry }:
 * code 0 when written, 1 when nothing was written; lines are what the command line prints, unchanged.
 * `source` goes into the event (cli, workspace).
 */
export function setStatus({ company, status, words = '', note = '', manual = false, file = null, source = 'cli' }) {
  const out = (code, lines, extra = {}) => ({ code, lines, ...extra });
  if (!company && !file) return out(1, ['Say which company: node cli.mjs applied <company> [role words]']);
  if (!STATUSES.includes(status)) return out(1, [`Unknown status "${status ?? ''}". Use one of: ${STATUSES.join(', ')}`]);
  if (String(note || '').length > NOTE_MAX) return out(1, [`The note is ${String(note).length} characters; keep it to ${NOTE_MAX} or fewer. Nothing was recorded.`], { tooLong: true });
  let apps; try { apps = readApplications(APPS_FILE()); } catch (e) { return out(1, [`${e.message}. Nothing was recorded.`], { broken: true }); }
  let atCompany, hits;
  if (file) { const q = queueEntry(file); if (!q) return out(1, [`"${file}" is not in the queue.`], { missing: true }); atCompany = hits = [q]; }
  else ({ atCompany, hits } = findRole(company, words));
  if (hits.length > 1) return out(1, [`Several roles match; add role words:\n${hits.map(h => `  ${h.company}: ${h.role}`).join('\n')}`]);
  if (!hits.length && !manual) {
    return out(1, [atCompany.length ? `No role at "${company}" matches "${words}". Roles there:\n${atCompany.map(h => `  ${h.company}: ${h.role}`).join('\n')}`
      : `"${company}" is not in the queue. Add --manual to record it anyway (it will not affect picks).`]);
  }
  const key = hits[0]?.file || `manual:${norm(company)}|${norm(words)}`;
  // events[] keeps the history (imported outcomes, every status change); the top-level status is the latest
  const prev = apps[key] || {};
  apps[key] = { ...prev, company: hits[0]?.company || prev.company || company, role: hits[0]?.role || prev.role || words || '', status, updated: today(), ...(note ? { note } : {}),
    events: [...(prev.events || []), { date: today(), type: status, ...(note ? { note } : {}), source }] };
  fs.writeFileSync(APPS_FILE(), JSON.stringify(apps, null, 1));
  const lines = [`${apps[key].company}: ${apps[key].role || '(role not given)'} -> ${status}${hits.length ? '' : ' (manual record)'}`];
  if (!pickRoleWords(apps[key].role).size) lines.push(`Note: no role words recorded, so every pick at ${apps[key].company} is now treated as closed. Add role words to record one role only.`);
  return out(0, lines, { key, entry: apps[key] });
}

const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const LATER_DAYS = [1, 7];
/**
 * "Not now": an event { date, type: "later", until, source } on the job's entry; the status stays as it was. A job
 * with no entry yet gets one that holds only these events (laterOnly), which picks, dedupe, history and the
 * exports do not count as an application. Returns { code, lines, key, entry, until }.
 */
export function addLater({ file, days, source = 'workspace' }) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < LATER_DAYS[0] || n > LATER_DAYS[1]) return { code: 1, lines: [`days must be a whole number from ${LATER_DAYS[0]} to ${LATER_DAYS[1]}`] };
  let apps; try { apps = readApplications(APPS_FILE()); } catch (e) { return { code: 1, lines: [`${e.message}. Nothing was recorded.`], broken: true }; }
  const q = queueEntry(file); if (!q) return { code: 1, lines: [`"${file}" is not in the queue.`], missing: true };
  const prev = apps[file] || { company: q.company, role: q.role };
  const until = addDays(today(), n);
  apps[file] = { ...prev, events: [...(prev.events || []), { date: today(), type: 'later', until, source }] };
  fs.writeFileSync(APPS_FILE(), JSON.stringify(apps, null, 1));
  return { code: 0, lines: [`${q.company}: ${q.role} -> later, until ${until}`], key: file, entry: apps[file], until };
}

/** The day a job comes back after "later" (its newest later event's until), or null. */
export function laterUntil(a) {
  const ev = (Array.isArray(a?.events) ? a.events : []).filter(e => e?.type === 'later' && /^\d{4}-\d{2}-\d{2}$/.test(String(e.until || '')));
  return ev.length ? String(ev[ev.length - 1].until) : null;
}

// Export to job-pipeline-tracker (github.com/Dreamkeeper/job-pipeline-tracker): one JSON file the app re-imports
// whenever its exportedAt changes. Rows are the user's applications from data/state/applications.json.
//   node cli.mjs tracker-export [--out <file>] [--dry-run]      // --dry-run prints the rows as JSON and writes nothing
// settings.tracker_export = { enabled: false, out: "tracker/pipeline.json" }   // out: relative to the data folder;
//                                                                               // enabled: cli.mjs run exports at the end
// Optional corrections in data/state/tracker-overrides.json:
//   { "overrides": [ { "company": "Acme", "role": "product", "drop": true },            // leave a row out
//                    { "company": "Acme", "stage": "Interview", "notes": "..." } ] }  // change fields of a row
// "role" is a substring of the role (any case); without it every row at the company matches. An override applies to
// every row it matches. "note" is a comment for you and is never copied into a row.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SETTINGS, DATA, DIRS, STATE, read, readJson, today } from './config.mjs';
import { frontMatter, norm } from './queue.mjs';
import { companyMatch } from './match.mjs';

export const STAGES = ['Applied', 'Screen', 'Interview', 'Offer', 'Rejected', 'Withdrawn'];
export const FURTHEST = ['Applied', 'Screen', 'Interview', 'Offer'];
// The tracker has no hired stage: an accepted offer (a job the user holds) stays at Offer, its note says Accepted.
const STAGE_OF = { applied: 'Applied', screen: 'Screen', interview: 'Interview', offer: 'Offer', accepted: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn', closed: 'Withdrawn', skipped: 'Withdrawn' };
// How far an event or status got; rejections and closes reach nothing new.
const REACHED = { applied: 'Applied', application_received: 'Applied', screen: 'Screen', interview: 'Interview', test_task: 'Interview', offer: 'Offer', accepted: 'Offer' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = v => { const s = String(v || '').slice(0, 10); return DATE.test(s) ? s : ''; };
const later = (a, b) => (a > b ? a : b);

// Statuses that do not say an application was sent: a role skipped, or closed or withdrawn before applying.
const NOT_SENT = new Set(['skipped', 'closed', 'withdrawn']);
const appliedProof = a => (a.events || []).some(e => e.type === 'applied') || !!day(a.applied);
/** An application: an applied event or applied date, or a status that means one was sent (not skipped, closed or withdrawn). */
export const isApplication = a => !!a && (appliedProof(a) || (!!a.status && !NOT_SENT.has(a.status)));
/** The furthest of Applied, Screen, Interview, Offer that the status and events reached. */
export function furthestStage(a) {
  let best = 0;
  for (const t of [a.status, ...(a.events || []).map(e => e.type)]) { const i = FURTHEST.indexOf(REACHED[t]); if (i > best) best = i; }
  return FURTHEST[best];
}
/** Front matter of the queue file an applications.json key names, or {} (manual records, files that are gone). */
export function queueMeta(key) {
  if (!String(key).endsWith('.md') || key.includes('/') || key.includes('\\')) return {};
  for (const d of ['decoded', 'rejected', 'inbox']) { const p = path.join(DIRS[d], key); if (fs.existsSync(p)) return frontMatter(read(p)); }
  return {};
}

/**
 * One tracker row from an applications.json entry. dateApplied: the first applied event, else the applied date, else
 * the earliest dated event, else updated. lastActivity: the latest event or update up to `date` (a booked interview
 * does not count before its day). Both are '' when the entry has no date at all.
 */
export function toRow(key, a, meta = queueMeta(key), date = today()) {
  const events = (a.events || []).filter(e => day(e.date));
  const first = list => list.map(e => day(e.date)).sort()[0];
  const applied = first(events.filter(e => e.type === 'applied'));
  const upTo = d => (d && d <= date ? d : '');
  const lastActivity = events.reduce((m, e) => later(m, upTo(day(e.date))), upTo(day(a.updated)));
  const lastOf = type => events.filter(e => e.type === type).reduce((m, e) => later(m, upTo(day(e.date))), '') || upTo(day(a.updated)) || lastActivity;
  const notes = a.status === 'rejected' ? `Rejected ${lastOf('rejected')}` : a.status === 'accepted' ? `Accepted ${lastOf('accepted')}` : a.status === 'closed' ? `Closed ${lastOf('closed')}` : `Last update ${lastActivity}`;
  return {
    company: String(a.company || meta.company || ''), role: String(a.role || meta.role || ''),
    stage: STAGE_OF[a.status] || (a.status ? `(unknown status "${a.status}")` : 'Applied'), furthestStage: furthestStage(a),
    dateApplied: applied || day(a.applied) || first(events) || day(a.updated), lastActivity, notes,
    source: String(meta.source || a.source || ''), link: String(meta.url || a.url || ''),
  };
}

/** Problems with a row, [] when it is valid. */
export function rowProblems(r) {
  const p = [];
  if (!String(r.company || '').trim()) p.push('company is empty');
  if (!String(r.role || '').trim()) p.push('role is empty');
  if (!STAGES.includes(r.stage)) p.push(`stage "${r.stage}" is not one of ${STAGES.join(', ')}`);
  if (!FURTHEST.includes(r.furthestStage)) p.push(`furthestStage "${r.furthestStage}" is not one of ${FURTHEST.join(', ')}`);
  for (const k of ['dateApplied', 'lastActivity']) if (!DATE.test(r[k] || '')) p.push(`${k} "${r[k] || ''}" is not YYYY-MM-DD`);
  return p;
}

export function readOverrides(file = STATE('tracker-overrides.json')) {
  if (!fs.existsSync(file)) return [];
  let j; try { j = JSON.parse(read(file)); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message})`); }
  if (!Array.isArray(j?.overrides)) throw new Error(`${file} needs { "overrides": [ ... ] }`);
  for (const o of j.overrides) if (!o?.company) throw new Error(`${file}: every override needs "company": ${JSON.stringify(o)}`);
  return j.overrides;
}
const MATCH_KEYS = new Set(['company', 'role', 'drop', 'note']);
/** Apply overrides (each to every row it matches); returns { rows, unused } where unused matched no row. */
export function applyOverrides(rows, overrides) {
  const used = new Set(); const out = [];
  for (const r of rows) {
    let row = r, drop = false;
    overrides.forEach((o, i) => {
      if (!companyMatch(r.company, o.company) || (o.role && !norm(r.role).includes(norm(o.role)))) return;
      used.add(i);
      if (o.drop) { drop = true; return; }
      const set = Object.fromEntries(Object.entries(o).filter(([k]) => !MATCH_KEYS.has(k)));
      row = { ...row, ...set };
      // a stage set by hand that is further than the recorded one moves furthestStage too, unless that is set as well
      if (set.stage && !set.furthestStage && FURTHEST.indexOf(set.stage) > FURTHEST.indexOf(row.furthestStage)) row.furthestStage = set.stage;
    });
    if (!drop) out.push(row);
  }
  return { rows: out, unused: overrides.filter((o, i) => !used.has(i)) };
}

export const contentHash = applications => crypto.createHash('sha256').update(JSON.stringify(applications)).digest('hex').slice(0, 16);
export const stageCounts = rows => STAGES.map(s => [s, rows.filter(r => r.stage === s).length]).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(', ');
/** Where the export goes: tracker_export.out, relative to the data folder (JOBPILOT_DATA); default tracker/pipeline.json. */
export const trackerOutFile = () => path.resolve(DATA, SETTINGS.tracker_export?.out || path.join('tracker', 'pipeline.json'));
/** Lines for the log: overrides that matched nothing, rows left out for having no date. */
export const exportNotes = r => [...r.unused.map(o => `override matched nothing: ${JSON.stringify(o)}`),
  ...r.undated.map(x => `skipped, no date up to today: ${x.company}: ${x.role || '(no role)'}`)];

/**
 * Build the export and write it when its content changed. A row with no date at all is left out and listed in
 * `undated`; any other invalid row (unknown stage, empty role, a date that is not YYYY-MM-DD) or a broken overrides
 * file throws, and nothing is written. Returns { file, written, applications, undated, hash, unused, message }.
 */
export function trackerExport({ out, dryRun = false, now = new Date(), date = today(), apps = readJson(STATE('applications.json'), {}), overrides = readOverrides() } = {}) {
  const file = out ? path.resolve(out) : trackerOutFile();
  const base = Object.entries(apps || {}).filter(([, a]) => isApplication(a)).map(([k, a]) => toRow(k, a, queueMeta(k), date));
  const { rows: all, unused } = applyOverrides(base, overrides);
  const undated = all.filter(r => !r.dateApplied || !r.lastActivity), rows = all.filter(r => !undated.includes(r));
  for (const r of rows) { const p = rowProblems(r); if (p.length) throw new Error(`invalid row (${p.join('; ')}): ${JSON.stringify(r)}`); }
  const applications = rows.sort((a, b) => a.dateApplied.localeCompare(b.dateApplied) || a.company.localeCompare(b.company) || a.role.localeCompare(b.role));
  const hash = contentHash(applications);
  const summary = `${applications.length} applications${applications.length ? `: ${stageCounts(applications)}` : ''}`;
  const unchanged = readJson(file, null)?.contentHash === hash;
  let message;
  if (unchanged) message = `unchanged (${summary})`;
  else if (dryRun) message = `would write ${file} (${summary}; dry run, nothing written)`;
  else {
    const doc = { app: 'job-pipeline-tracker', version: 1, exportedAt: now.toISOString(), contentHash: hash, applications };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n', 'utf8'); fs.renameSync(tmp, file);
    message = `wrote ${file} (${summary})`;
  }
  return { file, written: !unchanged && !dryRun, applications, undated, hash, unused, message };
}

// Backups: v2 export zips (lib/archive.mjs) in backups/ under the jobpilot home.
//   backups/jobpilot-backup-<YYYY-MM-DD>-<HHMMSS>-v<app>[--<label>].zip     (date and time in settings.timezone)
// After each backup, older ones are pruned: the newest of each of the last 7 days, 4 weeks and 6 months that have a
// backup are kept, and the newest three backups of any kind always stay. A labelled backup (pre-update-v0.4.0,
// pre-restore, pre-import) is pruned only when it is more than 90 days old.
// settings.backup = { nightly: true, copy_to: "" }
//   nightly: cli.mjs run makes a backup after the evening run (not on the example profile); a failure is logged and
//            alerted, never fails the run
//   copy_to: after each backup, copy it to a local folder (a Syncthing folder, a mounted disk), or run a command when
//            it contains {file} ("rclone copy {file} remote:jobpilot"); a failure is logged, never fatal
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SETTINGS, PROFILE, log } from './config.mjs';
import { exportArchive, importArchive, APP_VERSION } from './archive.mjs';

export const backupsDir = () => path.join(ROOT, 'backups');
const NAME = /^jobpilot-backup-(\d{4}-\d{2}-\d{2})-(\d{6})-v(.+?)(?:--([a-z0-9][a-z0-9._-]*))?\.zip$/;
export const KEEP = { daily: 7, weekly: 4, monthly: 6, newest: 3, labelled_days: 90 };

/** { date: "YYYY-MM-DD", time: "HHMMSS" } of `now` in settings.timezone (UTC when it is not a valid zone). */
export function stamp(now = new Date(), tz = SETTINGS.timezone || 'UTC') {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now); }
  catch { return stamp(now, 'UTC'); }
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}${g('minute')}${g('second')}` };
}
/** A label as it goes into a file name: lower case letters, digits, ".", "_" and "-". */
export function cleanLabel(label) {
  const l = String(label ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 60);
  if (label != null && !l) throw new Error(`"${label}" cannot be used as a backup label; use letters, digits, ".", "_" or "-"`);
  return l || null;
}
export const backupName = ({ date, time }, label = null, version = APP_VERSION) => `jobpilot-backup-${date}-${time}-v${version}${label ? `--${label}` : ''}.zip`;
/** Parse a backup file name: { name, date, time, version, label } or null. */
export function parseName(name) {
  const m = NAME.exec(name); return m ? { name, date: m[1], time: m[2], version: m[3], label: m[4] || null } : null;
}

/** Backups in `dir`, newest first: [{ name, file, date, time, version, label, bytes }]. */
export function listBackups(dir = backupsDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(parseName).filter(Boolean)
    .map(b => ({ ...b, file: path.join(dir, b.name), bytes: fs.statSync(path.join(dir, b.name)).size }))
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time) || b.name.localeCompare(a.name));
}

const dayMs = 86400000;
const utcDay = d => Date.parse(`${d}T00:00:00Z`);
const mondayOf = d => { const t = new Date(utcDay(d)); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
/**
 * Which backups to keep. list: newest first (listBackups); today: "YYYY-MM-DD". Returns { keep: [names], remove: [names] }.
 */
export function prunePlan(list, today, keep = KEEP) {
  const sorted = [...list].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time) || b.name.localeCompare(a.name));
  const kept = new Set(sorted.slice(0, keep.newest).map(b => b.name));
  const plain = sorted.filter(b => !b.label);
  const newestPer = (key, n) => {
    const seen = new Set();
    for (const b of plain) { const k = key(b.date); if (seen.has(k)) continue; if (seen.size >= n) break; seen.add(k); kept.add(b.name); }
  };
  newestPer(d => d, keep.daily); newestPer(mondayOf, keep.weekly); newestPer(d => d.slice(0, 7), keep.monthly);
  for (const b of sorted) if (b.label && (utcDay(today) - utcDay(b.date)) / dayMs <= keep.labelled_days) kept.add(b.name);
  return { keep: sorted.filter(b => kept.has(b.name)).map(b => b.name), remove: sorted.filter(b => !kept.has(b.name)).map(b => b.name) };
}
/** Delete the backups prunePlan does not keep, and half-written ones older than an hour. Returns the names removed. */
export function prune({ dir = backupsDir(), now = new Date() } = {}) {
  const { remove } = prunePlan(listBackups(dir), stamp(now).date);
  for (const n of remove) fs.rmSync(path.join(dir, n), { force: true });
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f.endsWith('.partial') && now.getTime() - fs.statSync(p).mtimeMs > 3600000) fs.rmSync(p, { force: true });
  }
  return remove;
}

const shellQuote = s => (process.platform === 'win32' ? `"${s}"` : `'${String(s).replace(/'/g, "'\\''")}'`);
/** Copy a backup offsite (settings.backup.copy_to). Returns 'off', 'copied' or 'failed'; never throws. */
export function copyOffsite(file, to = SETTINGS.backup?.copy_to) {
  if (!to) return 'off';
  try {
    if (String(to).includes('{file}')) {
      const r = spawnSync(String(to).split('{file}').join(shellQuote(file)), { shell: true, encoding: 'utf8', timeout: 30 * 60000 });
      if (r.status !== 0) throw new Error(`the copy command exited ${r.status ?? 'without a code'}${r.stderr ? `: ${r.stderr.trim().split('\n').pop().slice(0, 200)}` : ''}`);
    } else {
      const dir = path.resolve(ROOT, String(to)); fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, path.basename(file)), tmp = `${dest}.partial`;
      fs.copyFileSync(file, tmp); fs.renameSync(tmp, dest);
    }
    log(`backup: copied to ${String(to).includes('{file}') ? 'the copy_to command' : to}`);
    return 'copied';
  } catch (e) { log(`backup: offsite copy failed: ${e.message}`); return 'failed'; }
}

function freeName(dir, now, label) {
  for (let t = now.getTime(); ; t += 1000) { const n = backupName(stamp(new Date(t)), label); if (!fs.existsSync(path.join(dir, n))) return n; }
}
/**
 * Back up the whole install (data, profile, settings; never .env). Then prune (unless prune: false) and copy offsite.
 * Returns { file, bytes, files, pruned, copied }.
 */
export async function backup({ label = null, now = new Date(), dir = backupsDir(), prune: doPrune = true, copy = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const l = cleanLabel(label);
  const r = await exportArchive({ out: path.join(dir, freeName(dir, now, l)), extra: l ? { label: l } : {} });
  const pruned = doPrune ? prune({ dir, now }) : [];
  return { file: r.out, bytes: r.bytes, files: r.files, pruned, copied: copy ? copyOffsite(r.out) : 'off' };
}
/** A partial backup of some files ([{ rel, abs }]) before an import replaces them. Returns its path. */
export async function backupFiles(files, label, { now = new Date(), dir = backupsDir() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const l = cleanLabel(label);
  return (await exportArchive({ out: path.join(dir, freeName(dir, now, l)), files, extra: { label: l, partial: true } })).out;
}

/** A backup by file name (in backups/) or by path. */
export function findBackup(ref, dir = backupsDir()) {
  if (!ref) throw new Error('say which backup: node cli.mjs restore <name from node cli.mjs backups>');
  for (const p of [path.resolve(ref), path.join(dir, ref)]) if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  throw new Error(`no backup "${ref}"; node cli.mjs backups lists them`);
}
/**
 * Restore a backup: import with on-conflict "theirs", after a full backup of the current state (label pre-restore).
 * The archive is checked first, so a damaged backup changes nothing. Files that are not in the backup stay.
 * Returns { from, pre, result }.
 */
export async function restore({ ref, dryRun = false, now = new Date(), dir = backupsDir() }) {
  const from = findBackup(ref, dir);
  const check = await importArchive({ from, dryRun: true, onConflict: 'theirs' });
  if (dryRun) return { from, pre: null, result: check };
  const pre = await backup({ label: 'pre-restore', now, dir, prune: false, copy: false });
  const result = await importArchive({ from, onConflict: 'theirs', saveReplaced: false });
  return { from, pre, result };
}

export const fmtBytes = n => (n == null ? '?' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

/** The evening run's backup (not for a trial run on the example profile). A failure is logged and sent through `alert`, and never throws. */
export async function nightlyBackup({ alert = null, now = new Date(), dir = backupsDir() } = {}) {
  if (SETTINGS.backup?.nightly === false || PROFILE.isExample) return null;
  try {
    const r = await backup({ now, dir });
    log(`backup: ${path.basename(r.file)} (${fmtBytes(r.bytes)}, ${r.files} files)${r.pruned.length ? `; ${r.pruned.length} old backup(s) removed` : ''}`);
    return r;
  } catch (e) {
    log(`backup failed: ${e.message}`);
    try { await alert?.(`jobpilot: the nightly backup failed: ${e.message}`); } catch { /* the log line stays */ }
    return null;
  }
}

/** doctor lines: [{ level: 'ok'|'warn'|'todo', text, fix }]. */
export function backupDoctor({ now = new Date(), dir = backupsDir(), statfs = fs.statfsSync } = {}) {
  const nightly = SETTINGS.backup?.nightly !== false; const list = listBackups(dir); const last = list[0];
  const out = [];
  if (!last) out.push({ level: 'ok', text: `backups: none yet (${nightly ? 'the evening run makes one' : 'backup.nightly is off; run node cli.mjs backup'})` });
  else {
    const age = Math.round((utcDay(stamp(now).date) - utcDay(last.date)) / dayMs);
    const text = `last backup: ${last.date} (${age === 0 ? 'today' : `${age} day(s) ago`}, ${fmtBytes(last.bytes)}; ${list.length} in backups/)`;
    out.push(nightly && age > 2 ? { level: 'warn', text, fix: 'the nightly backup has not run for more than 2 days; check journalctl --user -u jobpilot.service, or run node cli.mjs backup' } : { level: 'ok', text });
  }
  try {
    const s = statfs(fs.existsSync(dir) ? dir : ROOT); const free = Number(s.bavail) * Number(s.bsize);
    const need = last ? last.bytes * 3 : 0;
    out.push(free >= need ? { level: 'ok', text: `free disk space: ${fmtBytes(free)}` }
      : { level: 'warn', text: `free disk space: ${fmtBytes(free)}, less than three times the last backup (${fmtBytes(last.bytes)})`, fix: 'free some space or remove old files in backups/' });
  } catch { /* statfs not available here */ }
  return out;
}

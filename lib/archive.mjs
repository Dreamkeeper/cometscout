// Export / import: one archive for downloading your data, nightly backups, moving to a new server and restoring.
// Format "jobpilot-export" version 2, a ZIP (lib/zip.mjs) or a folder laid out the same way:
//   manifest.json   { format: "jobpilot-export", version: 2, app_version, schema_version, exported_at, source_host,
//                     contents: ["data", "profile", "settings"], counts: { dir: n }, files: { "rel/path": sha256 } }
//   data/{inbox,decoded,rejected,digests,packs,state}/...
//   profile/...     (not with --data-only, and never the example profile)
//   settings.json   (not with --data-only)
// Never included: .env, run.lock, backups/, and state files that hold a login session (SECRET_STATE); those go only
// into the encrypted file of `cli.mjs export-secrets` (lib/secrets.mjs).
// Import reads v2 zips and folders, and v1 (format "jobpilot-export-v1": a folder or a .tar.gz, read with the system tar).
// Every file's hash is checked before anything is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { DATA, ROOT, PROFILE, SETTINGS_FILE, today } from './config.mjs';
import { ZipWriter, readZip, readEntry, extractEntry, entryPath, unsafeName } from './zip.mjs';

export const FORMAT = 'jobpilot-export';
export const FORMAT_V1 = 'jobpilot-export-v1';
export const VERSION = 2;
// The data schema this code reads and writes. Task 12 adds data migrations and data/state/schema.json; until then
// every install is schema 1, an archive with a newer schema is refused and an equal one is accepted.
export const SCHEMA_VERSION = 1;
export const APP_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const DATA_DIRS = ['inbox', 'decoded', 'rejected', 'digests', 'packs', 'state'];
// data/state files that hold a login session: the Hirify cookie jar (sources/hirify.mjs). The Gmail token is in .env.
export const SECRET_STATE = ['hirify-cookies.json'];
const isEnvFile = name => /^\.env($|\.)/.test(name);
// rel is relative to data/state for state files (null elsewhere); "<secret>.replaced-<date>" copies stay out too
const isSecretState = rel => rel != null && SECRET_STATE.some(s => rel === s || rel.startsWith(`${s}.`));
const skipped = (name, stateRel) => name === 'run.lock' || isEnvFile(name) || /\.(tmp|part|partial)$/.test(name) || isSecretState(stateRel);

export const sha256File = async f => { const h = crypto.createHash('sha256'); await pipeline(fs.createReadStream(f), h); return h.digest('hex'); };
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}
/** The settings file an export carries (null for the example settings). */
export const settingsSource = () => (fs.existsSync(SETTINGS_FILE) && path.basename(SETTINGS_FILE) !== 'settings.example.json' ? SETTINGS_FILE : null);
/** Where an imported settings.json goes: JOBPILOT_SETTINGS when set, else settings.json in the home. */
export const settingsTarget = () => (process.env.JOBPILOT_SETTINGS ? SETTINGS_FILE : path.join(ROOT, 'settings.json'));

/** What an export of this install holds: { contents, files: [{ rel, abs }] }. rel is always "/"-separated. */
export function collect({ dataOnly = false } = {}) {
  const files = [];
  for (const d of DATA_DIRS) for (const rel of walk(path.join(DATA, d))) if (!skipped(rel.split('/').pop(), d === 'state' ? rel : null)) files.push({ rel: `data/${d}/${rel}`, abs: path.join(DATA, d, ...rel.split('/')) });
  const contents = ['data'];
  if (!dataOnly && !PROFILE.isExample) {
    contents.push('profile');
    for (const rel of walk(PROFILE.dir)) if (!isEnvFile(rel.split('/').pop())) files.push({ rel: `profile/${rel}`, abs: path.join(PROFILE.dir, ...rel.split('/')) });
  }
  const s = settingsSource();
  if (!dataOnly && s) { contents.push('settings'); files.push({ rel: 'settings.json', abs: s }); }
  return { contents, files };
}
const countOf = rels => { const c = {}; for (const r of rels) { const k = r.startsWith('data/') ? r.split('/')[1] : r.split('/')[0]; c[k] = (c[k] || 0) + 1; } return c; };
export const defaultExportName = () => `jobpilot-export-${today()}-v${APP_VERSION}.zip`;

/**
 * Export to `out` (a path ending in .zip, else a folder that must be empty or missing). `files` replaces the collected
 * list (partial backups use it); `extra` goes into the manifest (label, partial). Returns { out, counts, files, bytes, manifest }.
 */
export async function exportArchive({ out, dataOnly = false, files, contents, extra = {} }) {
  if (/\.(tar\.gz|tgz)$/i.test(out)) throw new Error('exports are ZIP files now: use a name ending in .zip, or a folder');
  const c = files ? { files, contents: contents || [...new Set(files.map(f => (f.rel.startsWith('data/') ? 'data' : f.rel.startsWith('profile/') ? 'profile' : 'settings')))] } : collect({ dataOnly });
  const abs = path.resolve(out); const hashes = {};
  const manifest = () => ({ format: FORMAT, version: VERSION, app_version: APP_VERSION, schema_version: SCHEMA_VERSION, exported_at: new Date().toISOString(),
    source_host: os.hostname(), contents: c.contents, ...extra, counts: countOf(Object.keys(hashes)), files: hashes });
  if (/\.zip$/i.test(abs)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.partial`; const z = await ZipWriter.open(tmp);
    try {
      for (const f of c.files) hashes[f.rel] = (await z.addFile(f.rel, f.abs)).sha256;
      const m = manifest(); z.addBuffer('manifest.json', JSON.stringify(m, null, 1) + '\n');
      const r = await z.close(); fs.renameSync(tmp, abs);
      return { out: abs, counts: m.counts, files: c.files.length, bytes: r.bytes, manifest: m };
    } catch (e) { z.abort(); throw e; }
  }
  if (fs.existsSync(abs) && fs.readdirSync(abs).length) throw new Error(`${abs} is not empty`);
  for (const f of c.files) {
    const to = entryPath(abs, f.rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(f.abs, to);
    hashes[f.rel] = await sha256File(to);
  }
  const m = manifest(); fs.writeFileSync(path.join(abs, 'manifest.json'), JSON.stringify(m, null, 1) + '\n');
  return { out: abs, counts: m.counts, files: c.files.length, bytes: null, manifest: m };
}

/** Refuse an archive this install cannot read. Returns the archive's format version. */
export function checkManifest(m) {
  if (!m || typeof m !== 'object' || !m.files || typeof m.files !== 'object') throw new Error('manifest.json has no file list: not a jobpilot export');
  if (m.format === FORMAT_V1) return 1;
  if (m.format !== FORMAT) throw new Error(`unsupported format "${m.format}"`);
  if (!(Number(m.version) >= 1)) throw new Error(`manifest.json has no valid version (${m.version})`);
  if (Number(m.version) > VERSION) throw new Error(`this export was made by a newer jobpilot (format version ${m.version}, this one reads up to ${VERSION}); update jobpilot first`);
  const schema = Number(m.schema_version ?? 1);
  if (schema > SCHEMA_VERSION) throw new Error(`this export has a newer data schema (${schema}; this jobpilot has ${SCHEMA_VERSION}); update jobpilot first, then import`);
  if (schema < SCHEMA_VERSION) throw new Error(`this export has an older data schema (${schema}) and needs a data migration this version cannot run yet`);
  return Number(m.version);
}

const tar = (args, cwd) => { const r = spawnSync('tar', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`tar ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`); };
function kindOf(p) {
  if (fs.statSync(p).isDirectory()) return 'folder';
  const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'tar.gz';
  throw new Error(`${p} is not a zip, a .tar.gz or a folder`);
}

/**
 * Open an archive (v2 zip, v1 tar.gz, or a folder), check its manifest and every file's hash.
 * Returns { dir, manifest, version, kind, bad: [rel], cleanup() }; files are read from `dir`.
 */
export async function openArchive(from) {
  const src = path.resolve(from);
  if (!fs.existsSync(src)) throw new Error(`${src} does not exist`);
  const kind = kindOf(src);
  let dir = src, cleanup = () => {};
  const temp = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-import-')); const d = dir; cleanup = () => fs.rmSync(d, { recursive: true, force: true }); };
  try {
    let manifest;
    if (kind === 'zip') {
      const zip = readZip(src); const byName = new Map(zip.entries.map(e => [e.name, e]));
      if (!byName.has('manifest.json')) throw new Error('no manifest.json: not a jobpilot export');
      manifest = JSON.parse((await readEntry(zip, byName.get('manifest.json'))).toString('utf8'));
      checkManifest(manifest);
      temp();
      for (const rel of Object.keys(manifest.files)) { const e = byName.get(rel); if (e && !e.dir) await extractEntry(zip, e, entryPath(dir, rel)); }
    } else {
      if (kind === 'tar.gz') { temp(); tar(['-xzf', path.basename(src), '-C', dir], path.dirname(src)); }
      const mf = path.join(dir, 'manifest.json');
      if (!fs.existsSync(mf)) throw new Error('no manifest.json: not a jobpilot export');
      manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    }
    const version = checkManifest(manifest);
    for (const rel of Object.keys(manifest.files)) { const why = unsafeName(rel); if (why) throw new Error(`manifest.json lists "${rel}": ${why}`); }
    const bad = [];
    for (const [rel, h] of Object.entries(manifest.files)) { const f = entryPath(dir, rel); if (!fs.existsSync(f) || (await sha256File(f)) !== h) bad.push(rel); }
    return { dir, manifest, version, kind, bad, cleanup };
  } catch (e) { cleanup(); throw e; }
}

const MODES = ['keep', 'theirs', 'both'];
const areaOf = rel => (rel.startsWith('data/') ? 'data' : rel.startsWith('profile/') ? 'profile' : rel === 'settings.json' ? 'settings' : null);
/** "applications.json" -> "applications.imported-2026-10-02.json", with -2, -3 ... when that exists too. */
export function importedName(file, date = today()) {
  const ext = path.extname(file), stem = file.slice(0, file.length - ext.length);
  for (let n = 1; ; n++) { const p = `${stem}.imported-${date}${n > 1 ? `-${n}` : ''}${ext}`; if (!fs.existsSync(p)) return p; }
}

/**
 * Plan (and unless dryRun, apply) an import. onConflict: keep (leave the local file), theirs (replace it; the replaced
 * files are saved first, see saveReplaced), both (write the archive's copy as <name>.imported-<date><ext>). Without
 * onConflict, data conflicts keep the local file and a profile or settings conflict stops the import.
 * saveReplaced: async ([{ rel, abs }]) => backup path, or false to skip (restore makes a full backup itself).
 * Returns { manifest, version, plan: { add, same, conflict: [{ rel, action, as? }], skipped }, needsChoice, dryRun, saved }.
 */
export async function importArchive({ from, dryRun = false, onConflict = null, dataOnly = false, saveReplaced, date = today() }) {
  if (onConflict && !MODES.includes(onConflict)) throw new Error(`--on-conflict must be one of ${MODES.join(', ')}`);
  const a = await openArchive(from);
  try {
    if (a.bad.length) throw new Error(`archive is damaged: ${a.bad.length} file(s) missing or changed (${a.bad.slice(0, 3).join(', ')}); nothing was imported`);
    const target = rel => {
      const area = areaOf(rel); if (!area || (dataOnly && area !== 'data')) return null;
      if (area === 'data') { const rest = rel.slice(5); return rest.split('/').pop() === 'run.lock' ? null : entryPath(DATA, rest); }
      if (area === 'profile') return entryPath(path.join(ROOT, 'profile'), rel.slice(8));
      return settingsTarget();
    };
    const plan = { add: [], same: [], conflict: [], skipped: [] }; const jobs = [];
    for (const [rel, h] of Object.entries(a.manifest.files).sort(([x], [y]) => x.localeCompare(y))) {
      const to = target(rel); if (!to) { plan.skipped.push(rel); continue; }
      const from = entryPath(a.dir, rel);
      if (!fs.existsSync(to)) { plan.add.push(rel); jobs.push({ from, to }); continue; }
      if ((await sha256File(to)) === h) { plan.same.push(rel); continue; }
      const area = areaOf(rel), action = onConflict || (area === 'data' ? 'keep' : 'choose');
      const c = { rel, action, to };
      if (action === 'both') { c.as = importedName(to, date); jobs.push({ from, to: c.as }); }
      if (action === 'theirs') jobs.push({ from, to, replaces: true, rel });
      plan.conflict.push(c);
    }
    const needsChoice = plan.conflict.filter(c => c.action === 'choose').map(c => c.rel);
    const result = { manifest: a.manifest, version: a.version, plan, needsChoice, dryRun, saved: null };
    if (dryRun) return result;
    if (needsChoice.length) throw Object.assign(new Error(`${needsChoice.length} profile or settings file(s) differ from yours (${needsChoice.slice(0, 3).join(', ')}); choose with --on-conflict keep, theirs or both (or add --data-only); nothing was imported`), { result });
    const replaced = jobs.filter(j => j.replaces).map(j => ({ rel: j.rel, abs: j.to }));
    if (replaced.length && saveReplaced !== false) {
      const save = saveReplaced || (async files => (await import('./backup.mjs')).backupFiles(files, 'pre-import'));
      result.saved = await save(replaced);
    }
    for (const j of jobs) {
      fs.mkdirSync(path.dirname(j.to), { recursive: true });
      const tmp = `${j.to}.${process.pid}.tmp`; fs.copyFileSync(j.from, tmp); fs.renameSync(tmp, j.to);
    }
    return result;
  } finally { a.cleanup(); }
}

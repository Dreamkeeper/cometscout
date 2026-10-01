// Export / import: move a jobpilot install's data (and optionally profile and settings) between machines,
// or bring in data converted from another tool. Format "jobpilot-export-v1":
//   <archive>/manifest.json   { format, version, exported_at, counts: { dir: n }, files: { "rel/path": sha256 } }
//   <archive>/data/{inbox,decoded,rejected,digests,packs,state}/...
//   <archive>/profile/...      (only with --with-profile)
//   <archive>/settings.json    (only with --with-settings)
// .env is never exported. An archive is a folder, or a .tar.gz of that folder (made and read with the system tar).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA, ROOT, PROFILE, SETTINGS_FILE } from './config.mjs';

export const FORMAT = 'jobpilot-export-v1';
const DATA_DIRS = ['inbox', 'decoded', 'rejected', 'digests', 'packs', 'state'];
const SKIP = new Set(['run.lock']);

const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile() && !SKIP.has(e.name)) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}
const tar = (args, cwd) => { const r = spawnSync('tar', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`tar ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`); };

/** Write manifest.json for an archive folder laid out as above; returns the manifest. */
export function writeManifest(dir, extra = {}) {
  const files = {}; const counts = {};
  for (const rel of walk(dir)) {
    if (rel === 'manifest.json') continue;
    files[rel] = sha256(path.join(dir, rel));
    const top = rel.startsWith('data/') ? rel.split('/')[1] : rel.split('/')[0];
    counts[top] = (counts[top] || 0) + 1;
  }
  const m = { format: FORMAT, version: 1, exported_at: new Date().toISOString(), ...extra, counts, files };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 1) + '\n');
  return m;
}

/** Export this install. out: a folder path or a path ending in .tar.gz. */
export function exportData({ out, withProfile = false, withSettings = false }) {
  const gz = /\.tar\.gz$|\.tgz$/i.test(out);
  const dir = gz ? fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-export-')) : path.resolve(out);
  if (!gz && fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of DATA_DIRS) {
    const src = path.join(DATA, d);
    for (const rel of walk(src)) { const to = path.join(dir, 'data', d, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(src, rel), to); }
  }
  if (withProfile && !PROFILE.isExample) for (const rel of walk(PROFILE.dir)) { const to = path.join(dir, 'profile', rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(PROFILE.dir, rel), to); }
  if (withSettings && fs.existsSync(SETTINGS_FILE) && path.basename(SETTINGS_FILE) !== 'settings.example.json') fs.copyFileSync(SETTINGS_FILE, path.join(dir, 'settings.json'));
  const m = writeManifest(dir, { source: 'jobpilot' });
  // The archive path is passed relative to its own folder: GNU tar reads "C:\..." as a remote host.
  if (gz) { const abs = path.resolve(out); fs.mkdirSync(path.dirname(abs), { recursive: true }); tar(['-czf', path.basename(abs), '-C', dir, '.'], path.dirname(abs)); fs.rmSync(dir, { recursive: true, force: true }); }
  return { out: path.resolve(out), counts: m.counts, files: Object.keys(m.files).length };
}

/** Read and verify an archive (folder or .tar.gz). Returns { dir, manifest, bad[], cleanup() }. */
export function openArchive(from) {
  let dir = path.resolve(from), cleanup = () => {};
  if (fs.statSync(dir).isFile()) { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-import-')); tar(['-xzf', path.basename(dir), '-C', tmp], path.dirname(dir)); dir = tmp; cleanup = () => fs.rmSync(tmp, { recursive: true, force: true }); }
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) { cleanup(); throw new Error('no manifest.json: not a jobpilot export'); }
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  if (manifest.format !== FORMAT) { cleanup(); throw new Error(`unsupported format ${manifest.format}`); }
  const bad = Object.entries(manifest.files).filter(([rel, h]) => !fs.existsSync(path.join(dir, rel)) || sha256(path.join(dir, rel)) !== h).map(([rel]) => rel);
  return { dir, manifest, bad, cleanup };
}

/**
 * Import an archive into this install. Files that already exist with the same content are skipped; a file that
 * exists with different content is a conflict and stops the import unless force is set. dryRun reports only.
 */
export function importData({ from, dryRun = false, force = false, withProfile = false, withSettings = false }) {
  const a = openArchive(from);
  try {
    if (a.bad.length) throw new Error(`archive is damaged: ${a.bad.length} file(s) missing or changed (${a.bad.slice(0, 3).join(', ')})`);
    const plan = { add: [], same: [], conflict: [], skipped: [] };
    const target = rel => rel.startsWith('data/') ? path.join(DATA, rel.slice(5))
      : rel.startsWith('profile/') ? (withProfile ? path.join(ROOT, rel) : null)
      : rel === 'settings.json' ? (withSettings ? path.join(ROOT, 'settings.json') : null) : null;
    for (const [rel, h] of Object.entries(a.manifest.files)) {
      const to = target(rel); if (!to) { plan.skipped.push(rel); continue; }
      if (!fs.existsSync(to)) plan.add.push(rel); else if (sha256(to) === h) plan.same.push(rel); else plan.conflict.push(rel);
    }
    if (plan.conflict.length && !force && !dryRun) throw Object.assign(new Error(`${plan.conflict.length} conflict(s); rerun with --force to overwrite or --dry-run to list them`), { plan });
    if (!dryRun) for (const rel of [...plan.add, ...(force ? plan.conflict : [])]) { const to = target(rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(a.dir, rel), to); }
    return { manifest: { format: a.manifest.format, exported_at: a.manifest.exported_at, source: a.manifest.source, counts: a.manifest.counts }, plan, dryRun };
  } finally { a.cleanup(); }
}

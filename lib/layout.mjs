// Where the code lives. The CometScout home (settings.json, profile/, .env, data/, backups/) stays put; the code of
// each version is in app/releases/v<version>/ inside the home, and app/current points at the active one (a symlink
// swapped with a rename; a junction on Windows). systemd units run app/current/cli.mjs with COMETSCOUT_HOME set.
// A git clone used as the home (the layout before this one) keeps working; cli.mjs update --adopt moves its code into
// app/releases. Each release folder holds .release-files.json: the sha256 of every file it was installed with, so
// an update can refuse when someone edited the code in place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareVersions, validVersion, bare } from './release.mjs';

export const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE_LIST = '.release-files.json';
const tag = v => `v${bare(v)}`;
export const appDir = root => path.join(root, 'app');
export const releasesDir = root => path.join(root, 'app', 'releases');
export const currentLink = root => path.join(root, 'app', 'current');
export const releaseDir = (root, v) => path.join(releasesDir(root), tag(v));

/**
 * The home for code at `code` when COMETSCOUT_HOME is not set: <home>/app/releases/vX or <home>/app/current gives
 * <home>; any other folder is its own home (a git clone).
 */
export function homeFromCode(code) {
  const parent = path.basename(path.dirname(code)), grand = path.basename(path.dirname(path.dirname(code)));
  if (parent === 'releases' && grand === 'app' && validVersion(path.basename(code))) return path.dirname(path.dirname(path.dirname(code)));
  if (path.basename(code) === 'current' && parent === 'app') return path.dirname(path.dirname(code));
  return code;
}

const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
/** The version app/current points at ("0.2.0"), or null when there is no app layout. */
export function currentVersion(root) {
  const r = real(currentLink(root)); if (!r) return null;
  return bare(path.basename(r));
}
export const hasAppLayout = root => !!currentVersion(root);
/** Installed release folders, newest first: ["0.3.0", "0.2.0"] (half-installed ".partial" folders are not listed). */
export function installedReleases(root) {
  const dir = releasesDir(root); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && /^v/.test(e.name) && validVersion(e.name) && fs.existsSync(path.join(dir, e.name, 'cli.mjs')))
    .map(e => bare(e.name)).sort((a, b) => compareVersions(b, a));
}

/**
 * Point app/current at release `version`: a new link next to it, then a rename over the old one (atomic on Linux).
 * Windows cannot rename over a junction, so there the old one is removed first. Returns the previous version or null.
 */
export function pointCurrent(root, version) {
  const target = releaseDir(root, version);
  if (!fs.existsSync(path.join(target, 'cli.mjs'))) throw new Error(`no release folder ${path.relative(root, target)}`);
  const link = currentLink(root), before = currentVersion(root), tmp = `${link}.new-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  // relative on Linux, so the home can move; a junction needs an absolute path
  fs.symlinkSync(process.platform === 'win32' ? target : path.join('releases', tag(version)), tmp, 'junction');
  try { fs.renameSync(tmp, link); } catch (e) {
    if (!['EPERM', 'EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(e.code)) { fs.unlinkSync(tmp); throw e; }
    if (fs.lstatSync(link, { throwIfNoEntry: false })) {
      if (!fs.lstatSync(link).isSymbolicLink()) { fs.unlinkSync(tmp); throw new Error(`${link} is a real folder, not a link; move it away first`); }
      fs.unlinkSync(link);
    }
    fs.renameSync(tmp, link);
  }
  return before;
}

/** The code path units should run: app/current when this code is one of the home's releases, else the code itself. */
export function unitCode(code, root) {
  const rel = real(releasesDir(root)), c = real(code);
  if (rel && c && hasAppLayout(root) && path.dirname(c) === rel) return currentLink(root);
  return code;
}

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
/** Write .release-files.json for the files of a release folder (rel paths with "/"). */
export function writeFileList(dir, files, version) {
  const hashes = {};
  for (const rel of [...files].sort()) hashes[rel] = sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))));
  fs.writeFileSync(path.join(dir, FILE_LIST), JSON.stringify({ version: bare(version), files: hashes }, null, 1) + '\n');
  return hashes;
}
/**
 * Files of a release that differ from what was installed: [{ rel, why: "changed" | "missing" }]. null when the
 * folder has no list (installed by hand).
 */
export function localEdits(dir) {
  let list; try { list = JSON.parse(fs.readFileSync(path.join(dir, FILE_LIST), 'utf8')); } catch { return null; }
  const out = [];
  for (const [rel, h] of Object.entries(list.files || {})) {
    const p = path.join(dir, ...rel.split('/'));
    if (!fs.existsSync(p)) out.push({ rel, why: 'missing' });
    else if (sha256(fs.readFileSync(p)) !== h) out.push({ rel, why: 'changed' });
  }
  return out;
}

// What is never code when a folder is walked: the home's own files and folders.
const NOT_CODE = new Set(['node_modules', '.git', 'data', 'backups', 'profile', 'app']);
const notCodeFile = name => /^(\.env|settings\.json)/.test(name) || /\.(partial|tmp)$/.test(name) || name === FILE_LIST;
/** The code files of a folder ("/"-separated): git's tracked files in a clone, else a walk without the home's files. */
export function codeFiles(code, { run = spawnSync } = {}) {
  if (fs.existsSync(path.join(code, '.git'))) {
    const r = run('git', ['ls-files', '--cached', '-z'], { cwd: code, encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return r.stdout.split('\0').filter(Boolean).filter(f => fs.existsSync(path.join(code, f)) && fs.statSync(path.join(code, f)).isFile()).sort();
  }
  const out = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(code, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!(rel === '' && NOT_CODE.has(e.name)) && e.name !== 'node_modules' && e.name !== '.git') walk(r); }
      else if (e.isFile() && !notCodeFile(e.name)) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/**
 * npm ci --omit=dev in a release folder (the workspace's preact and htm). Returns true when it worked.
 * --ignore-scripts: no package's install scripts run (preact and htm have none; a hijacked release that adds one
 * does not run it on the user's machine).
 */
export function npmInstall(dir, { run = spawnSync, stdio = 'inherit' } = {}) {
  const r = run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio, shell: process.platform === 'win32' });
  return !r.error && r.status === 0;
}

/**
 * Keep app/current, two releases older than it (the ones in `also` first: the version the update came from, which
 * rollback goes back to), and any newer one (a failed update kept for a look). Returns the versions removed.
 */
export function pruneReleases(root, { keep = 2, also = [] } = {}) {
  const cur = currentVersion(root); if (!cur) return [];
  const older = installedReleases(root).filter(v => compareVersions(v, cur) < 0);
  const kept = new Set(also.map(bare).filter(v => older.includes(v)));
  for (const v of older) { if (kept.size >= keep) break; kept.add(v); }
  const remove = older.filter(v => !kept.has(v));
  for (const v of remove) fs.rmSync(releaseDir(root, v), { recursive: true, force: true });
  return remove;
}

/**
 * The workspace modules of a release folder: npm ci --omit=dev there (install), else a copy of the clone's
 * node_modules. Returns the line to print, or null when they are already there.
 */
function ensureModules(dest, code, install) {
  if (fs.existsSync(path.join(dest, 'node_modules'))) return null;
  if (install(dest)) return 'Installed the workspace modules (npm ci --omit=dev).';
  if (fs.existsSync(path.join(code, 'node_modules'))) { fs.cpSync(path.join(code, 'node_modules'), path.join(dest, 'node_modules'), { recursive: true }); return 'npm ci failed; copied node_modules from the clone instead.'; }
  return `npm ci failed and the clone has no node_modules: the workspace (node cli.mjs serve) needs npm ci --omit=dev in ${dest} (or install npm and run bash deploy/install.sh again).`;
}

// ---------- the home's own copies (a git clone used as the home) ----------
// After --adopt the code runs from app/current, but the clone's files stay in the home, and an update does not change
// them: AGENTS.md (which the onboarding agent reads from the home) and the scripts the docs name would be the first
// install's. refreshHome keeps the user-facing files current and turns those scripts into wrappers; the clone's other
// code (lib/, sources/, decoder/ ...) is left in place, unused: cli.mjs in the home imports it before it hands every
// command to app/current, so moving it would break every command (AGENTS.md and README say it is not used).
/** User-facing files copied from the installed release into the home on every adopt, update and rollback. */
export const HOME_DOCS = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'README-rus.md', 'INSTALL.md', 'settings.example.json'];
/** Folders copied the same way (the example profile the docs point at). */
export const HOME_DOC_DIRS = ['profile.example'];
/** Scripts the docs tell the user or the agent to run from the home: the home's copies become wrappers for app/current's. */
export const HOME_SCRIPTS = ['deploy/install.sh', 'deploy/modules/coach.sh', 'deploy/modules/coach.ps1', 'deploy/modules/transcribe.sh', 'deploy/modules/transcribe.ps1', 'tools/gmail-auth.mjs', 'tools/workspace-demo.mjs'];
export const WRAPPER_MARK = 'CometScout wrapper: runs the installed release\'s copy';
/** The wrapper written over a home script `rel`: it runs app/current/<rel> with COMETSCOUT_HOME set to the home. */
export function wrapperText(rel) {
  const up = rel.split('/').length - 1, note = `${WRAPPER_MARK}, app/current/${rel} (written by node cli.mjs update; the first install's copy: git show HEAD:${rel}).`;
  if (rel.endsWith('.sh')) return `#!/usr/bin/env bash\n# ${note}\nH="$(cd "$(dirname "$0")${'/..'.repeat(up)}" && pwd)"\nCOMETSCOUT_HOME="\${COMETSCOUT_HOME:-$H}" exec bash "$H/app/current/${rel}" "$@"\n`;
  if (rel.endsWith('.ps1')) return `# ${note}\n$h = (Resolve-Path (Join-Path $PSScriptRoot '${Array(up).fill('..').join('\\')}')).Path\nif (-not $env:COMETSCOUT_HOME) { $env:COMETSCOUT_HOME = $h }\n& (Join-Path $h 'app\\current\\${rel.split('/').join('\\')}') @args\nexit $LASTEXITCODE\n`;
  return `#!/usr/bin/env node\n// ${note}\nimport { spawnSync } from 'node:child_process';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n` +
    `const home = path.resolve(path.dirname(fileURLToPath(import.meta.url))${', \'..\''.repeat(up)});\n` +
    `const r = spawnSync(process.execPath, [path.join(home, 'app', 'current', ...${JSON.stringify(rel.split('/'))}), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, COMETSCOUT_HOME: process.env.COMETSCOUT_HOME || home } });\n` +
    'process.exit(r.status ?? 1);\n';
}
const filesUnder = (dir, rel) => { const out = []; const walk = r => { for (const e of fs.readdirSync(path.join(dir, ...r.split('/')), { withFileTypes: true })) { const x = `${r}/${e.name}`; if (e.isDirectory()) walk(x); else if (e.isFile()) out.push(x); } }; if (fs.existsSync(path.join(dir, rel))) walk(rel); return out; };
/**
 * Bring a git-clone home's own copies up to the installed release `release` (a folder in app/releases, or app/current):
 * HOME_DOCS and HOME_DOC_DIRS copied from it, HOME_SCRIPTS replaced by wrappers. A copy that differs from what any
 * installed release shipped (an edit of the user's) is saved first to app/replaced/<time>/; nothing is removed.
 * Files are replaced by a rename, so a script that is running (install.sh calls this) keeps reading its old copy.
 * Does nothing in a home that is not a clone (no cli.mjs) or when release is the home itself. Returns { changed, saved, lines }.
 */
export function refreshHome({ root, release, now = new Date() }) {
  const out = { changed: [], saved: [], lines: [] };
  if (!release || !fs.existsSync(path.join(root, 'cli.mjs')) || real(release) === real(root) || !fs.existsSync(path.join(release, 'cli.mjs'))) return out;
  const shipped = new Map();   // rel -> Set of sha256 any installed release shipped
  for (const v of installedReleases(root)) {
    let list; try { list = JSON.parse(fs.readFileSync(path.join(releaseDir(root, v), FILE_LIST), 'utf8')).files || {}; } catch { continue; }
    for (const [rel, h] of Object.entries(list)) { if (!shipped.has(rel)) shipped.set(rel, new Set()); shipped.get(rel).add(h); }
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19), savedDir = path.join(appDir(root), 'replaced', stamp);
  const put = (rel, buf) => {
    const dst = path.join(root, ...rel.split('/')), old = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
    if (old && old.equals(buf)) return;
    if (old && !shipped.get(rel)?.has(sha256(old)) && !old.toString('utf8').includes(WRAPPER_MARK)) {
      const keep = path.join(savedDir, ...rel.split('/')); fs.mkdirSync(path.dirname(keep), { recursive: true }); fs.writeFileSync(keep, old); out.saved.push(rel);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp-${process.pid}`; fs.writeFileSync(tmp, buf);
    try { fs.chmodSync(tmp, old ? fs.statSync(dst).mode & 0o777 : 0o644); } catch { /* Windows */ }
    fs.renameSync(tmp, dst); out.changed.push(rel);
  };
  for (const rel of [...HOME_DOCS, ...HOME_DOC_DIRS.flatMap(d => filesUnder(release, d))]) { const src = path.join(release, ...rel.split('/')); if (fs.existsSync(src)) put(rel, fs.readFileSync(src)); }
  for (const rel of HOME_SCRIPTS) if (fs.existsSync(path.join(release, ...rel.split('/'))) && fs.existsSync(path.join(root, ...rel.split('/')))) put(rel, Buffer.from(wrapperText(rel)));
  if (out.changed.length) out.lines.push(`Refreshed in the home from the installed release: ${out.changed.join(', ')}.`);
  if (out.saved.length) out.lines.push(`Your edited copies were saved first, in ${path.relative(root, savedDir).split(path.sep).join('/')}: ${out.saved.join(', ')}.`);
  return out;
}
/** The home-relative scripts a doc tells the reader to run (bash x.sh, node x.mjs, -File x.ps1), cli.mjs left out. */
export function scriptsNamedIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:\bbash|\bnode|\bpython3?|-File)\s+((?:\.\/)?[A-Za-z0-9_.\\/-]+\.(?:sh|mjs|js|ps1|py))\b/g)) {
    const p = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p.startsWith('/') && !p.startsWith('app/') && p !== 'cli.mjs') out.add(p);
  }
  return [...out].sort();
}
/** The home's user-facing files that differ from the installed release's (doctor; node cli.mjs update --refresh-home fixes them). */
export function staleHomeFiles(root, release = currentLink(root)) {
  if (!fs.existsSync(path.join(root, 'cli.mjs')) || !hasAppLayout(root) || real(release) === real(root)) return [];
  const same = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return true; } };
  const docs = HOME_DOCS.filter(rel => fs.existsSync(path.join(release, rel)) && !same(path.join(root, rel), path.join(release, rel)));
  const scripts = HOME_SCRIPTS.filter(rel => { const p = path.join(root, ...rel.split('/')); try { return fs.existsSync(p) && !fs.readFileSync(p, 'utf8').includes(WRAPPER_MARK); } catch { return false; } });
  return [...docs, ...scripts];
}

/**
 * cli.mjs update --adopt: copy the code of a git-clone install into app/releases/v<its version>/, install its
 * modules, point app/current at it and regenerate the units. Nothing in data moves. Running it again changes nothing,
 * except that workspace modules missing from the current release (npm was not installed the first time) are installed.
 * install(dir) and units() are injected by tests. Returns { code, version, lines }.
 */
export function adopt({ root, code = CODE, install = dir => npmInstall(dir), units = () => ({ code: 0, lines: [] }), files } = {}) {
  const lines = [];
  const version = JSON.parse(fs.readFileSync(path.join(code, 'package.json'), 'utf8')).version;
  const cur = currentVersion(root);
  if (cur) {
    lines.push(`This install already runs from app/current (v${cur}); nothing to adopt.${cur !== version ? ` The code in ${code} is v${version}; node cli.mjs update moves between versions.` : ''}`);
    // the first install ran without npm (install.sh says: install npm, then run it again): finish that part now
    const m = ensureModules(releaseDir(root, cur), code, install); if (m) lines.push(m);
    lines.push(...refreshHome({ root, release: releaseDir(root, cur) }).lines);
    return { code: 0, version: cur, lines };
  }
  if (real(code) && real(releasesDir(root)) && path.dirname(real(code)) === real(releasesDir(root))) return { code: 1, version, lines: ['Run --adopt from the git clone, not from a release folder.'] };
  // a clone whose scripts are already wrappers (app/ was removed after an earlier adopt) would copy the wrappers as code
  const wrapped = HOME_SCRIPTS.filter(rel => { try { return fs.readFileSync(path.join(code, ...rel.split('/')), 'utf8').includes(WRAPPER_MARK); } catch { return false; } });
  if (wrapped.length) return { code: 1, version, lines: [`${wrapped.join(', ')} in ${code} run app/current, which is gone. Restore them first (git checkout -- ${wrapped.join(' ')}), then run --adopt again.`] };
  const dest = releaseDir(root, version);
  if (!fs.existsSync(path.join(dest, FILE_LIST))) {
    const list = files || codeFiles(code), tmp = `${dest}.partial`;
    if (!list.includes('cli.mjs')) return { code: 1, version, lines: [`${code} does not look like CometScout code (no cli.mjs)`] };
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const rel of list) { const to = path.join(tmp, ...rel.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(code, ...rel.split('/')), to); }
    writeFileList(tmp, list, version);
    fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(tmp, dest);
    lines.push(`Copied ${list.length} code files to ${path.relative(root, dest).split(path.sep).join('/')}.`);
  } else lines.push(`${path.relative(root, dest).split(path.sep).join('/')} is already there.`);
  const m = ensureModules(dest, code, install); if (m) lines.push(m);
  pointCurrent(root, version);
  lines.push(`app/current points at v${version}. Your data, settings and profile stay where they are.`);
  lines.push(...refreshHome({ root, release: dest }).lines);
  const u = units();
  lines.push(...(u.lines || []));
  return { code: u.code ? 1 : 0, version, lines };
}

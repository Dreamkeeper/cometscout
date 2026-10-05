// Release metadata: release.json at the repo root, one entry per version, newest first. CHANGELOG.md and the text of
// each GitHub release are generated from it (tools/changelog.mjs), so there is one source.
//   { version, date, min_node, schema_version, migrations: ["002-..."], behaviour_changes: true|false,
//     notes: { highlights: [...], new: [...], changed: [...], action_needed: [{ text, setting }],
//              changed_defaults: [{ setting, default, text }] },
//     notes_ru: { the same keys, optional; a missing key falls back to notes },
//     media: [{ path, alt }] }
// Versions are semver ("0.2.0", "0.3.0-beta.1"); tags are "v" + version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_FILE = path.join(CODE, 'release.json');
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;
export const MIGRATION_ID = /^\d{3}-[a-z0-9][a-z0-9-]*$/;

/** "v1.2.3-beta.1" or "1.2.3" -> { major, minor, patch, pre: ["beta", 1] } or null. */
export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v ?? '').trim()); if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.').map(x => (/^\d+$/.test(x) ? +x : x)) : [] };
}
export const validVersion = v => !!parseVersion(v);
/** "1.2.3" for "v1.2.3" (null when not a version). */
export const bare = v => (validVersion(v) ? String(v).trim().replace(/^v/, '') : null);
export const isPrerelease = v => !!parseVersion(v)?.pre.length;
/** Semver order: negative when a < b. A pre-release sorts before its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1; if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1; if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** release.json of a code folder ([] when it has none). */
export function readReleases(file = RELEASE_FILE) {
  try { const l = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
}
export const releaseFor = (version, list = readReleases()) => list.find(r => r?.version === bare(version)) || null;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v, min = 0) => Array.isArray(v) && v.length >= min && v.every(s => typeof s === 'string' && s.trim());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function notesProblems(n, where, ru = false) {
  const out = [];
  if (!isObj(n)) return [`${where} must be an object`];
  if (!ru || n.highlights !== undefined) if (!strings(n.highlights, ru ? 0 : 1)) out.push(`${where}.highlights must be a list of at least one line`);
  for (const k of ['new', 'changed']) if (n[k] !== undefined && !strings(n[k])) out.push(`${where}.${k} must be a list of lines`);
  if (n.action_needed !== undefined && !(Array.isArray(n.action_needed) && n.action_needed.every(a => isObj(a) && typeof a.text === 'string' && a.text.trim() && (a.setting === undefined || (typeof a.setting === 'string' && a.setting.trim())))))
    out.push(`${where}.action_needed must be a list of { text, setting }`);
  if (n.changed_defaults !== undefined && !(Array.isArray(n.changed_defaults) && n.changed_defaults.every(a => isObj(a) && typeof a.setting === 'string' && a.setting.trim() && 'default' in a && typeof a.text === 'string')))
    out.push(`${where}.changed_defaults must be a list of { setting, default, text }`);
  const known = new Set(['highlights', 'new', 'changed', 'action_needed', 'changed_defaults']);
  for (const k of Object.keys(n)) if (!known.has(k)) out.push(`${where}.${k} is not a notes key (${[...known].join(', ')})`);
  return out;
}
/** What is wrong with one release.json entry ([] when fine). root: the code folder its media paths are in. */
export function entryProblems(e, { root = CODE } = {}) {
  if (!isObj(e)) return ['an entry must be an object'];
  const v = e.version, at = `release ${typeof v === 'string' ? v : '?'}`;
  const out = [];
  if (typeof v !== 'string' || !validVersion(v) || v.startsWith('v')) out.push(`${at}: version must be like "1.2.3" (no "v"), got ${JSON.stringify(v)}`);
  if (!(typeof e.date === 'string' && DATE_RE.test(e.date) && new Date(`${e.date}T00:00:00Z`).toISOString().slice(0, 10) === e.date)) out.push(`${at}: date must be YYYY-MM-DD`);
  if (!(Number.isInteger(e.min_node) && e.min_node >= 20)) out.push(`${at}: min_node must be a whole number, 20 or more`);
  if (!(Number.isInteger(e.schema_version) && e.schema_version >= 1)) out.push(`${at}: schema_version must be a whole number, 1 or more`);
  if (!(Array.isArray(e.migrations) && e.migrations.every(m => typeof m === 'string' && MIGRATION_ID.test(m)))) out.push(`${at}: migrations must be a list of ids like "002-add-field"`);
  if (typeof e.behaviour_changes !== 'boolean') out.push(`${at}: behaviour_changes must be true or false`);
  out.push(...notesProblems(e.notes, `${at}: notes`));
  if (e.notes_ru !== undefined) out.push(...notesProblems(e.notes_ru, `${at}: notes_ru`, true));
  if (e.media !== undefined) {
    if (!Array.isArray(e.media)) out.push(`${at}: media must be a list of { path, alt }`);
    else for (const m of e.media) {
      if (!isObj(m) || typeof m.path !== 'string' || typeof m.alt !== 'string' || !m.alt.trim()) { out.push(`${at}: media must be a list of { path, alt }`); continue; }
      if (!mediaPathOk(m.path)) out.push(`${at}: media path "${m.path}" must be a relative path to an image (png, jpg, gif, webp)`);
      else if (root && !fs.existsSync(path.join(root, ...m.path.split('/')))) out.push(`${at}: media file not found: ${m.path}`);
    }
  }
  const known = new Set(['version', 'date', 'min_node', 'schema_version', 'migrations', 'behaviour_changes', 'notes', 'notes_ru', 'media']);
  for (const k of Object.keys(e)) if (!known.has(k)) out.push(`${at}: unknown key "${k}"`);
  if (JSON.stringify(e).includes('\u2014')) out.push(`${at}: no em dashes in release notes`);
  return out;
}
/** Plain relative image paths only: no "..", no absolute path, no backslash. */
export const mediaPathOk = p => typeof p === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(png|jpe?g|gif|webp)$/i.test(p) && !p.split('/').some(s => s === '..' || s === '.' || !s);

/**
 * What is wrong with release.json as a whole: entries, unique versions, newest first, an entry for `version`
 * (package.json's), and that entry's schema_version equal to `schema` (when given).
 */
export function releaseProblems(list, { version, schema, root = CODE } = {}) {
  if (!Array.isArray(list) || !list.length) return ['release.json must be a list with at least one entry'];
  const out = list.flatMap(e => entryProblems(e, { root }));
  if (out.length) return out;
  const seen = new Set();
  for (const e of list) { if (seen.has(e.version)) out.push(`release ${e.version} is listed twice`); seen.add(e.version); }
  for (let i = 1; i < list.length; i++) if (compareVersions(list[i - 1].version, list[i].version) <= 0) out.push(`release.json must be newest first: ${list[i - 1].version} is listed before ${list[i].version}`);
  if (version !== undefined) {
    const e = list.find(x => x.version === version);
    if (!e) out.push(`package.json says ${version}, but release.json has no entry for it`);
    else if (schema !== undefined && e.schema_version !== schema) out.push(`release ${version}: schema_version is ${e.schema_version}, the code's data schema is ${schema}`);
  }
  return out;
}

/** The notes of an entry in a locale: notes_<locale> per key, falling back to the English notes. */
export function notesFor(entry, locale = 'en') {
  const en = entry?.notes || {}, loc = locale && locale !== 'en' ? entry?.[`notes_${locale}`] : null;
  const pick = k => (loc && Array.isArray(loc[k]) && loc[k].length ? loc[k] : Array.isArray(en[k]) ? en[k] : []);
  return { highlights: pick('highlights'), new: pick('new'), changed: pick('changed'), action_needed: pick('action_needed'), changed_defaults: pick('changed_defaults') };
}
/** Entries with from < version <= to, newest first. */
export const releasesBetween = (from, to, list = readReleases()) =>
  list.filter(e => validVersion(e?.version) && compareVersions(e.version, to) <= 0 && (!from || !validVersion(from) || compareVersions(e.version, from) > 0));

const section = (title, lines) => (lines.length ? [`### ${title}`, '', ...lines.map(l => `- ${l}`), ''] : []);
const actionLine = a => `${a.text}${a.setting ? ` (setting: \`${a.setting}\`)` : ''}`;
const defaultLine = d => `${d.text} New default for \`${d.setting}\`: ${JSON.stringify(d.default)}; your own value is kept.`;
function entryMarkdown(e, { heading = '##' } = {}) {
  const n = notesFor(e);
  return [`${heading} ${e.version} (${e.date})`, '',
    `Needs Node ${e.min_node} or newer.${e.behaviour_changes ? ' This version changes behaviour: read Changed before updating.' : ''}${e.migrations.length ? ` Data migrations: ${e.migrations.join(', ')}.` : ''}`, '',
    ...section('Highlights', n.highlights), ...section('New', n.new), ...section('Changed', n.changed),
    ...section('Action needed', [...n.action_needed.map(actionLine), ...n.changed_defaults.map(defaultLine)]),
    ...(e.media?.length ? ['### Screens', '', ...e.media.map(m => `![${m.alt}](${m.path})`), ''] : [])];
}
/** CHANGELOG.md for the whole list. */
export function changelogText(list) {
  return ['# Changelog', '', 'Generated from `release.json` by `node tools/changelog.mjs`. Edit `release.json`, not this file.', '',
    ...list.flatMap(e => entryMarkdown(e))].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// The text of a GitHub release: the version's notes, then three lines the update check reads (parseReleaseBody).
export function releaseBody(e, sha256 = '') {
  return [...entryMarkdown(e).slice(2),
    '---', '', `Behaviour changes: ${e.behaviour_changes ? 'yes' : 'no'}`, `Needs Node: ${e.min_node}`, `Source zip sha256: ${sha256 || 'FILL-IN'}`].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
/** { highlights, behaviour_changes, min_node, sha256 } from a GitHub release text (missing parts are empty or null). */
export function parseReleaseBody(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const highlights = [], lines = text.split('\n');
  const at = lines.findIndex(l => /^#{2,4}\s+Highlights\s*$/i.test(l));
  if (at >= 0) for (const l of lines.slice(at + 1)) { if (/^#{1,4}\s/.test(l) || /^---\s*$/.test(l)) break; const m = l.match(/^\s*[-*]\s+(.+)$/); if (m) highlights.push(m[1].trim()); }
  const bc = text.match(/^Behaviour changes:\s*(yes|no)\s*$/im), node = text.match(/^Needs Node:\s*(\d+)\s*$/im), sha = text.match(/^Source zip sha256:\s*([0-9a-f]{64})\s*$/im);
  return { highlights, behaviour_changes: bc ? bc[1].toLowerCase() === 'yes' : false, min_node: node ? Number(node[1]) : null, sha256: sha ? sha[1].toLowerCase() : null };
}

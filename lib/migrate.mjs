// Data migrations: migrations/NNN-name.mjs in the code, each exporting { id: "NNN-name", up(ctx) }, applied in order
// by cli.mjs migrate (an update runs the new release's own command, before switching to it).
// data/state/schema.json records { version, applied: ["002-name", ...] }: a migration runs once, and each must
// also be safe to run again (it checks before it writes). The rule (DEVELOPMENT.md): a release only adds files and
// fields the previous release ignores; removing or renaming waits for the release after (expand, then contract),
// so switching the code back is always safe.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA, STATE, SETTINGS_FILE, CODE_DIR, readJson, log } from './config.mjs';
import { SCHEMA_VERSION } from './archive.mjs';
import { MIGRATION_ID } from './release.mjs';

export const MIGRATIONS_DIR = path.join(CODE_DIR, 'migrations');
export const SCHEMA_FILE = () => STATE('schema.json');
const FILE_RE = /^(\d{3}-[a-z0-9][a-z0-9-]*)\.mjs$/;

/** The migration files of a code folder, in order: [{ id, file }]. */
export function listMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(f => FILE_RE.exec(f)).filter(Boolean).map(m => ({ id: m[1], file: path.join(dir, m[0]) })).sort((a, b) => a.id.localeCompare(b.id));
}
/** data/state/schema.json: { version, applied } (version 1 and nothing applied when it is missing). */
export function readSchema(file = SCHEMA_FILE()) {
  const s = readJson(file, null);
  return { version: Number.isInteger(s?.version) ? s.version : 1, applied: Array.isArray(s?.applied) ? s.applied.filter(x => typeof x === 'string') : [] };
}
const writeAtomic = (file, obj) => { const tmp = `${file}.tmp-${process.pid}`; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n'); fs.renameSync(tmp, file); };
/** What a migration gets: the home, data folders and a safe JSON writer. */
export const migrationContext = () => ({ root: ROOT, data: DATA, state: STATE, settingsFile: SETTINGS_FILE, readJson, writeJson: writeAtomic, log });

/**
 * Apply every migration not yet in schema.json, in order. A migration that throws stops the run; the ones before it
 * stay recorded (each is recorded right after it ran). dryRun lists what would run. Returns { applied, pending, version }.
 */
export async function runMigrations({ dir = MIGRATIONS_DIR, schemaFile = SCHEMA_FILE(), ctx = migrationContext(), dryRun = false, version = SCHEMA_VERSION } = {}) {
  const schema = readSchema(schemaFile), done = new Set(schema.applied);
  const pending = listMigrations(dir).filter(m => !done.has(m.id)), applied = [];
  if (dryRun) return { applied, pending: pending.map(m => m.id), version: schema.version };
  for (const m of pending) {
    const mod = await import(pathToFileURL(m.file).href);
    if (mod.id !== m.id || !MIGRATION_ID.test(mod.id)) throw new Error(`${path.basename(m.file)} must export id "${m.id}" (it exports ${JSON.stringify(mod.id)})`);
    if (typeof mod.up !== 'function') throw new Error(`${path.basename(m.file)} must export a function up(ctx)`);
    log(`migrate: ${m.id}`);
    await mod.up(ctx);
    schema.applied.push(m.id); applied.push(m.id);
    writeAtomic(schemaFile, { version: Math.max(schema.version, version), applied: schema.applied });
  }
  if (!pending.length && !fs.existsSync(schemaFile)) writeAtomic(schemaFile, { version, applied: schema.applied });
  return { applied, pending: [], version: Math.max(schema.version, version) };
}

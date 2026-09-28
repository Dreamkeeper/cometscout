// Configuration: settings.json (what to run), profile/ (who the candidate is), .env (secrets), data/ (the queue).
// Everything personal lives in profile/ and settings.json; the code never contains facts about a candidate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.JOBPILOT_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = p => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
export const readJson = (p, d = null) => { try { return JSON.parse(read(p)); } catch { return d; } };
/** Config JSON the user edits: missing file -> d; broken JSON -> a clear error naming the file, then exit. */
export function readConfig(p, d = null) {
  if (!fs.existsSync(p)) return d;
  try { return JSON.parse(read(p)); } catch (e) {
    console.error(`jobpilot: ${p} is not valid JSON (${e.message}).\nFix the file (a trailing comma or a missing quote is the usual cause) and run again.`);
    process.exit(2);
  }
}
/** A number setting: NaN, empty or out-of-range values fall back to the default, so a typo never disables a limit. */
export const num = (v, def, min = -Infinity, max = Infinity) => {
  const n = Number(v); return v === '' || v == null || !Number.isFinite(n) || n < min || n > max ? def : n;
};

// .env: KEY=value lines, optional "export ", optional matching quotes; values never printed.
// Lines that cannot be parsed are listed (by key only) in ENV_PROBLEMS, which doctor reports.
export const ENV_PROBLEMS = [];
function loadEnv() {
  for (const line of read(path.join(ROOT, '.env')).split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) { ENV_PROBLEMS.push(t.split('=')[0].trim().slice(0, 40) || '(no key)'); continue; }
    let v = m[2].trim(); const qm = v.match(/^(["'])(.*)(["'])$/); if (qm && qm[1] === qm[3]) v = qm[2];
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const DEFAULTS = {
  candidate_name: 'the candidate',
  timezone: 'UTC',
  llm: { provider: 'claude', model: 'sonnet', pack_model: 'opus', timeout_sec: 300, bin: null },
  picks: { per_day: 2, window_days: 14, max_shown: 3, exclude_location_regex: '' },
  sources: {},
  delivery: { telegram: { enabled: false, token_env: 'TELEGRAM_BOT_TOKEN', chat_id_env: 'TELEGRAM_CHAT_ID' } },
  pack: { enabled: true, pdf: 'auto' },
};
function merge(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return o;
}
export const SETTINGS_FILE = fs.existsSync(path.join(ROOT, 'settings.json')) ? path.join(ROOT, 'settings.json') : path.join(ROOT, 'settings.example.json');
export const SETTINGS = merge(DEFAULTS, readConfig(SETTINGS_FILE, {}));

const PROFILE_DIR = fs.existsSync(path.join(ROOT, 'profile')) ? path.join(ROOT, 'profile') : path.join(ROOT, 'profile.example');
export const PROFILE = {
  dir: PROFILE_DIR,
  isExample: PROFILE_DIR.endsWith('profile.example'),
  facts: read(path.join(PROFILE_DIR, 'profile.md')),                        // who they are, what they want, hard gates
  voice: read(path.join(PROFILE_DIR, 'voice.md')),                          // how they write (optional)
  coverLetter: read(path.join(PROFILE_DIR, 'cover-letter-template.md')),    // optional
  cvLibrary: readConfig(path.join(PROFILE_DIR, 'cv-library.json')),        // vetted CV text (required for packs)
  factRules: [], ruleErrors: [],
};
// A broken rule is skipped and reported by doctor instead of crashing every command.
for (const r of readConfig(path.join(PROFILE_DIR, 'fact-rules.json'), { rules: [] }).rules || []) {
  try { PROFILE.factRules.push({ ...r, re: new RegExp(r.pattern, 'i') }); } catch (e) { PROFILE.ruleErrors.push(`${r.id || '(no id)'}: ${e.message}`); }
}

export const DATA = process.env.JOBPILOT_DATA || path.join(ROOT, 'data');
export const DIRS = Object.fromEntries(['inbox', 'decoded', 'rejected', 'digests', 'packs', 'state', 'runs'].map(d => [d, path.join(DATA, d)]));
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
export const STATE = name => path.join(DIRS.state, name);

// Dates are in settings.timezone, so a run that crosses midnight UTC keeps one date; cli.mjs run pins it for every step.
const tzDate = () => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: SETTINGS.timezone || 'UTC' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };
export const today = () => process.env.JOBPILOT_RUN_DATE || tzDate();
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const secret = name => process.env[name] || '';

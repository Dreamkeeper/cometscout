// Configuration: settings.json (what to run), profile/ (who the candidate is), .env (secrets), data/ (the queue).
// Everything personal lives in profile/ and settings.json; the code never contains facts about a candidate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.JOBPILOT_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = p => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
export const readJson = (p, d = null) => { try { return JSON.parse(read(p)); } catch { return d; } };

// .env: KEY=value lines; values never printed.
function loadEnv() {
  for (const line of read(path.join(ROOT, '.env')).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
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
export const SETTINGS = merge(DEFAULTS, readJson(SETTINGS_FILE, {}));

const PROFILE_DIR = fs.existsSync(path.join(ROOT, 'profile')) ? path.join(ROOT, 'profile') : path.join(ROOT, 'profile.example');
export const PROFILE = {
  dir: PROFILE_DIR,
  isExample: PROFILE_DIR.endsWith('profile.example'),
  facts: read(path.join(PROFILE_DIR, 'profile.md')),                        // who they are, what they want, hard gates
  voice: read(path.join(PROFILE_DIR, 'voice.md')),                          // how they write (optional)
  coverLetter: read(path.join(PROFILE_DIR, 'cover-letter-template.md')),    // optional
  cvLibrary: readJson(path.join(PROFILE_DIR, 'cv-library.json')),          // vetted CV text (required for packs)
  factRules: (readJson(path.join(PROFILE_DIR, 'fact-rules.json'), { rules: [] }).rules || []).map(r => ({ ...r, re: new RegExp(r.pattern, 'i') })),
};

export const DATA = process.env.JOBPILOT_DATA || path.join(ROOT, 'data');
export const DIRS = Object.fromEntries(['inbox', 'decoded', 'rejected', 'digests', 'packs', 'state', 'runs'].map(d => [d, path.join(DATA, d)]));
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
export const STATE = name => path.join(DIRS.state, name);

export const today = () => new Date().toISOString().slice(0, 10);
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const secret = name => process.env[name] || '';

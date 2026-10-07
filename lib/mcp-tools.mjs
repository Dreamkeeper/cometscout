// The MCP server's tools, resources and prompts (lib/mcp.mjs speaks the protocol). Each tool has a scope: read (lists
// and reads), operate (status changes, booked interviews, adding a job) or admin (settings and the secrets link).
// Writes go through CometScout's own writers and are refused while a run holds the lock; every call to a tool that can
// write appends one line to data/state/mcp-log.jsonl with secret-looking values removed. Nothing here runs a shell,
// reads a file outside CometScout's home or returns a secret's value.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SETTINGS, SETTINGS_FILE, DIRS, STATE, CODE_DIR, read, readJson, today, parseEnv, effectiveSettings, reloadSettings, SECRET_VALUES } from './config.mjs';
import { APP_VERSION } from './archive.mjs';
import { readApplications, frontMatter, loadJob, parseResult, writeJob } from './queue.mjs';
import { setStatus, addInterview, queueEntry, STATUSES, APPS_FILE } from './applications.mjs';
import { scheduleOf, scheduleProblems, isoWeekday, addDays, TIME_RE, validDate } from './schedule.mjs';
import { lockHolder } from './lock.mjs';
import { lastRuns } from './run-log.mjs';
import { SOURCES, SCHEMA, entryFor, knownPath, unknownKeys, settingsProblems, secretKey, redactSettings, schemaView, REDACTED, forbiddenKeys } from './settings-schema.mjs';
import { setSetting } from './settings-writer.mjs';
import { secretNeeds, secretSet, issueLink, LINK_TTL_MS } from './secrets-form.mjs';
import { FORM_SECRETS, secretEnvOf } from './env-names.mjs';
import { status as updateStatus } from './update.mjs';
import { coachSettings } from './coach.mjs';
import { transcribeSettings, installed as transcribeInstalled } from './transcribe.mjs';
import { systemdHost, unitDir, UNITS } from './ops.mjs';
import { fetchDetail, companyFromUrl, parseSearchTitleRule, HEURISTIC_RULES } from './fetch-detail.mjs';
import { todayPayload, jobPayload, BUSY } from './workspace.mjs';

/** A problem the model can act on: answered as a tool result with isError true. */
export class ToolError extends Error { constructor(message, data) { super(message); this.data = data; } }

export const LOG_FILE = () => STATE('mcp-log.jsonl');
const CLI = path.join(CODE_DIR, 'cli.mjs');
/** What every tool gets: injectable for tests (fetch, the doctor run, the timer reinstall). */
export const toolContext = (over = {}) => ({ fetch: globalThis.fetch, now: () => new Date(), logFile: LOG_FILE(), runDoctor: defaultDoctor, reinstall: undefined, scope: 'operate', ...over });

// ---------- a small JSON Schema check (the subset the tools' schemas use) ----------
const jsonType = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
/** Problems of `value` against `schema` (type, enum, required, properties, additionalProperties false, items, bounds, pattern). */
export function validate(schema, value, at = 'value') {
  if (!schema || typeof schema !== 'object') return [];
  const out = [], t = jsonType(value);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some(x => x === t || (x === 'number' && t === 'integer'))) return [`${at} must be ${types.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) out.push(`${at} must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}`);
  if (t === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at} is longer than ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) out.push(`${at} has the wrong form`);
  }
  if ((t === 'integer' || t === 'number')) {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at} must be at most ${schema.maximum}`);
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at} needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => out.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) out.push(`${at}.${k} is required`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) out.push(...validate(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${k} is not a known argument`);
    }
  }
  return out;
}

// ---------- the audit log ----------
const envFileValues = () => Object.values(parseEnv(read(path.join(ROOT, '.env'))).values);
/** Every loaded or .env secret value of 8 characters or more (redaction compares against these). */
export const secretValues = () => [...new Set([...SECRET_VALUES(), ...envFileValues()].filter(v => v && String(v).length >= 8).map(String))];
/** A copy of tool arguments safe to log: secret-named keys, secret values and sensitive settings removed, long text cut. */
export function redactArgs(tool, args, secrets = secretValues()) {
  const walk = (v, key) => {
    if (key && secretKey(key)) return REDACTED;
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === 'string') {
      if (secrets.some(s => v.includes(s))) return REDACTED;
      return v.length > 300 ? `${v.slice(0, 300)}... (${v.length} characters)` : v;
    }
    return v;
  };
  const out = walk(args);
  if (tool.name === 'settings_set' && typeof args?.path === 'string') {
    const keys = args.path.split('.');
    const touchesSensitive = SCHEMA.some(x => x.sensitive && (x.key === args.path || x.key.startsWith(`${args.path}.`)));
    if (touchesSensitive || keys.some(secretKey) || entryFor(keys)?.sensitive) out.value = REDACTED;
  }
  return out;
}
/** One line in data/state/mcp-log.jsonl: { at, tool, args, ok, summary }. */
export function audit(tool, args, out, ctx) {
  const summary = out.error ? `refused: ${String(out.error).slice(0, 300)}` : tool.summary ? tool.summary(out.data, args) : 'ok';
  const line = { at: ctx.now().toISOString(), tool: tool.name, args: redactArgs(tool, args), ok: !out.error, summary };
  try { fs.appendFileSync(ctx.logFile, `${JSON.stringify(line)}\n`); } catch (e) { process.stderr.write(`cometscout mcp: could not write ${ctx.logFile}: ${e.message}\n`); }
}

/** workspace.url as the user wrote it into settings.json by hand (an http or https address), else null. */
function handWorkspaceUrl() {
  const v = (readJson(SETTINGS_FILE, {}) || {}).workspace?.url;
  if (typeof v !== 'string' || !v.trim()) return null;
  try { const u = new URL(v.trim()); return /^https?:$/.test(u.protocol) ? u.href.replace(/\/+$/, '') : null; } catch { return null; }
}
const notBusy = () => { const pid = lockHolder(); if (pid) throw new ToolError(`${BUSY} (a run holds the lock, pid ${pid}); nothing was written`); };
const appsOrError = () => { try { return readApplications(APPS_FILE()); } catch (e) { throw new ToolError(e.message); } };
const settingsNow = () => effectiveSettings(readJson(SETTINGS_FILE, {}) || {});

// ---------- status helpers ----------
function clockIn(tz, now) {
  try {
    return { day: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now), time: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now) };
  } catch { return { day: now.toISOString().slice(0, 10), time: now.toISOString().slice(11, 16) }; }
}
/** The next evening run (the timer fires every day) and the next digest day, in settings.timezone. */
export function nextRun(s = SETTINGS, now = new Date()) {
  const { days, time } = scheduleOf(s), tz = s.timezone || 'UTC', c = clockIn(tz, now);
  if (!TIME_RE.test(String(time))) return { date: null, time: String(time), timezone: tz, digest_day: null, next_digest_date: null };
  const date = c.time < time ? c.day : addDays(c.day, 1);
  const list = Array.isArray(days) && days.length ? days : [1, 2, 3, 4, 5, 6, 7];
  let d = date; for (let i = 0; i < 7 && !list.includes(isoWeekday(d)); i++) d = addDays(d, 1);
  return { date, time, timezone: tz, digest_day: list.includes(isoWeekday(date)), next_digest_date: d };
}
const timerInstalled = () => (systemdHost() ? fs.existsSync(path.join(unitDir(), UNITS.timer)) : null);
function runFailures(r) {
  const out = [];
  if (typeof r?.result === 'string' && r.result.startsWith('stopped')) out.push(`the run ${r.result}`);
  for (const s of r?.sources || []) if (s.exit !== 0) out.push(`source ${s.source} exited ${s.exit ?? 'killed'}${s.exit === 3 ? ' (it needs you: an expired login or token)' : ''}`);
  if (r?.decoder_exit) out.push(`decoder exited ${r.decoder_exit}`);
  if (r?.pack_exit) out.push(`pack step exited ${r.pack_exit}`);
  for (const p of r?.refused || []) out.push(`pack refused for ${p.company || p.file}, ${p.role || '?'}: vetted CV text breaks ${(p.rules || []).join(', ')}`);
  return out;
}
const profileDir = () => path.join(ROOT, 'profile');
/** Both Telegram secrets set, under the checked names (lib/env-names.mjs: a refused name counts as not set). */
const telegramSecretsSet = (s, env) => ['token_env', 'chat_id_env'].every(k => { const n = secretEnvOf(s, `delivery.telegram.${k}`); return !!n && secretSet(n, env); });

/** The onboarding steps of AGENTS.md, each done or not, from the files as they are now. */
export function onboardingState(s = settingsNow()) {
  const has = p => fs.existsSync(p);
  const facts = read(path.join(profileDir(), 'profile.md')).trim();
  const enabled = Object.keys(SOURCES).filter(k => k !== 'outcomes' && s.sources?.[k]?.enabled);
  const decoded = ['decoded', 'rejected'].some(d => { try { return fs.readdirSync(DIRS[d]).some(f => f.endsWith('.md')); } catch { return false; } });
  const tg = s.delivery?.telegram || {}, env = parseEnv(read(path.join(ROOT, '.env'))).values;
  const tgReady = !!tg.enabled && telegramSecretsSet(s, env);
  const timer = timerInstalled(), coach = coachSettings(s);
  const steps = [
    { id: 'machine', title: 'Check the machine', done: null, detail: 'run the doctor tool and fix what it lists', how: 'doctor' },
    { id: 'settings', title: 'settings.json', done: path.basename(SETTINGS_FILE) !== 'settings.example.json', detail: 'a settings.json of your own', how: 'copy settings.example.json to settings.json on the server (the onboarding does this)' },
    { id: 'profile', title: 'Profile (profile/profile.md)', done: has(profileDir()) && facts.length > 200, detail: facts ? `${facts.length} characters` : 'missing', how: 'interview the user and write profile/profile.md in the shape of profile.example/profile.md (AGENTS.md step 2)' },
    { id: 'cv_library', title: 'CV library (profile/cv-library.json)', done: has(path.join(profileDir(), 'cv-library.json')), detail: '', how: 'turn the user\'s CV into profile/cv-library.json (AGENTS.md step 3)' },
    { id: 'sources', title: 'First source', done: enabled.length > 0, detail: enabled.join(', ') || 'none enabled', how: 'settings_set sources.<name>.enabled true and its filters (AGENTS.md step 6); secrets through secrets_form' },
    { id: 'first_result', title: 'First result', done: decoded, detail: decoded ? 'decoded jobs exist' : 'nothing decoded yet', how: 'on the server: node cli.mjs sources, node cli.mjs decode --no-telegram, node cli.mjs pack --no-telegram (AGENTS.md step 7)' },
    { id: 'delivery', title: 'Daily delivery (Telegram)', done: tgReady, detail: tg.enabled ? (tgReady ? 'on' : 'on, but a secret is missing') : 'off', how: 'secrets_form for TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then settings_set delivery.telegram.enabled true and schedule.time (AGENTS.md step 8)' },
    { id: 'timer', title: 'Daily timer', done: timer, detail: timer === null ? 'no systemd on this machine' : timer ? 'installed' : 'not installed', how: 'on the server: node cli.mjs timer (or bash deploy/install.sh)' },
    { id: 'modules', title: 'Interview coach (optional)', done: coach.enabled ? fs.existsSync(path.join(coach.path, '.git')) : null, optional: true, detail: coach.enabled ? 'enabled' : 'not enabled', how: 'AGENTS.md step 9: bash deploy/modules/coach.sh, then settings_set modules.coach.enabled true' },
  ].map(x => ({ optional: false, ...x }));
  const next = steps.find(x => !x.optional && x.done === false);
  return { steps, next: next ? next.id : null, done: steps.filter(x => x.done === true).length, total: steps.filter(x => !x.optional).length };
}

/** doctor --json in a child process, so it sees the files as they are now. */
function defaultDoctor() {
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { encoding: 'utf8', timeout: 120000, env: process.env, cwd: ROOT });
  const last = String(r.stdout || '').trim().split('\n').pop();
  try { const items = JSON.parse(last); if (Array.isArray(items)) return items; } catch { /* below */ }
  throw new ToolError(`doctor did not answer (exit ${r.status ?? r.signal}): ${String(r.stderr || '').trim().slice(0, 300)}`);
}
const doctorView = items => ({ items, counts: { ok: items.filter(i => i.level === 'ok').length, todo: items.filter(i => i.level === 'todo').length, warn: items.filter(i => i.level === 'warn').length } });

/** The newest digest file's text (not the outcomes reports). */
export function latestDigest() {
  let files = []; try { files = fs.readdirSync(DIRS.digests).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort(); } catch { /* none */ }
  const f = files.pop();
  return f ? { file: f, text: read(path.join(DIRS.digests, f)) } : null;
}

// ---------- schema helpers for the tool definitions ----------
const obj = (properties, required = [], extra = {}) => ({ type: 'object', properties, required, ...extra });
const args = (properties, required = []) => obj(properties, required, { additionalProperties: false });
const s = (description, extra = {}) => ({ type: 'string', description, ...extra });
const ns = description => ({ type: ['string', 'null'], description });
const i = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const b = (description) => ({ type: 'boolean', description });
const arr = (items, description) => ({ type: 'array', items, description });
const any = description => ({ description });
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const jobRow = obj({ file: s('queue file name'), folder: s('inbox, decoded or rejected'), company: s('company'), role: s('role'), verdict: ns('decode verdict'), date: s('YYYY-MM-DD') }, ['file', 'folder', 'company', 'role', 'verdict', 'date']);
const doctorItem = obj({ level: s('ok, todo or warn', { enum: ['ok', 'todo', 'warn'] }), text: s('what was checked'), fix: s('how to fix it, when not ok') }, ['level', 'text']);
const writeResult = obj({ ok: b('true when written'), message: s('what was recorded'), key: s('the application key'), application: obj({}, [], { description: 'the application entry after the write' }) }, ['ok', 'message', 'key', 'application']);

// ---------- the tools ----------
export const TOOLS = [
  {
    name: 'status', scope: 'read', title: 'CometScout status',
    description: 'Version, home, schedule and timezone, the last run (time, result, counts), the next run, sources and their last result, Telegram, update available, optional modules.',
    annotations: READ, inputSchema: args({}),
    outputSchema: obj({
      version: s('CometScout version'), home: s('home folder on the server'), settings_file: s('settings file in use'), scope: s('this server\'s scope'),
      schedule: obj({ days: arr({ type: 'integer' }, 'digest days, 1 = Monday'), time: s('HH:MM'), timezone: s('IANA zone'), problems: arr({ type: 'string' }, 'what is wrong') }, ['days', 'time', 'timezone', 'problems']),
      last_run: { type: ['object', 'null'], description: 'the newest run: date, started, finished, seconds, exit, counts, failures' },
      next_run: obj({ date: ns('YYYY-MM-DD'), time: s('HH:MM'), timezone: s('IANA zone'), digest_day: { type: ['boolean', 'null'] }, next_digest_date: ns('YYYY-MM-DD') }, ['date', 'time', 'timezone']),
      timer_installed: { type: ['boolean', 'null'], description: 'null where there is no systemd' },
      sources: arr(obj({ name: s('source'), enabled: b('on'), last_exit: { type: ['integer', 'null'], description: 'exit code in the last run' } }, ['name', 'enabled', 'last_exit']), 'every source'),
      telegram: obj({ enabled: b('delivery on'), secrets_set: b('token and chat id set') }, ['enabled', 'secrets_set']),
      update: obj({ current: s('running version'), latest: ns('newest known'), available: b('newer version out'), checked_at: ns('last check') }, ['current', 'available']),
      modules: obj({ coach: obj({ enabled: b(''), installed: b('') }, ['enabled', 'installed']), transcribe: obj({ enabled: b(''), installed: b('') }, ['enabled', 'installed']) }, ['coach', 'transcribe']),
    }, ['version', 'home', 'schedule', 'last_run', 'next_run', 'sources', 'telegram', 'update', 'modules']),
    run(_a, ctx) {
      const st = settingsNow(), sch = scheduleOf(st), last = lastRuns(1)[0] || null, up = updateStatus(), tg = st.delivery?.telegram || {};
      const env = parseEnv(read(path.join(ROOT, '.env'))).values, coach = coachSettings(st), tr = transcribeSettings(st);
      return {
        version: APP_VERSION, home: ROOT, settings_file: SETTINGS_FILE, scope: ctx.scope,
        schedule: { days: Array.isArray(sch.days) ? sch.days.filter(Number.isInteger) : [], time: String(sch.time), timezone: st.timezone || 'UTC', problems: scheduleProblems(st) },
        last_run: last ? { ...last, failures: runFailures(last) } : null, next_run: nextRun(st, ctx.now()), timer_installed: timerInstalled(),
        sources: Object.keys(SOURCES).map(name => { const e = last?.sources?.find(x => x.source === name)?.exit; return { name, enabled: !!st.sources?.[name]?.enabled, last_exit: Number.isInteger(e) ? e : null }; }),
        telegram: { enabled: !!tg.enabled, secrets_set: telegramSecretsSet(st, env) },
        update: { current: up.current, latest: up.latest, available: !!up.available, checked_at: up.checked_at },
        modules: { coach: { enabled: coach.enabled, installed: fs.existsSync(path.join(coach.path, '.git')) }, transcribe: { enabled: tr.enabled, installed: !!transcribeInstalled(tr) } },
      };
    },
  },
  {
    name: 'doctor', scope: 'read', title: 'Setup check',
    description: 'The doctor check as items: level ok, todo or warn, what was checked, and the fix. Run it first and fix the todo items in order.',
    annotations: READ, inputSchema: args({}),
    outputSchema: obj({ items: arr(doctorItem, 'one per check'), counts: obj({ ok: i(''), todo: i(''), warn: i('') }, ['ok', 'todo', 'warn']) }, ['items', 'counts']),
    run: (_a, ctx) => doctorView(ctx.runDoctor()),
  },
  {
    name: 'run_log', scope: 'read', title: 'Run log',
    description: 'The last evening runs (newest first): when, how long, exit code, how it ended (result: finished, or skipped or stopped early and why), what each source did, counts (new jobs, decoded, worth applying, picks) and failures.',
    annotations: READ, inputSchema: args({ limit: i('how many runs, newest first (default 1)', { minimum: 1, maximum: 20 }) }),
    outputSchema: obj({ runs: arr(obj({ date: s(''), exit: { type: ['integer', 'null'] }, result: s('finished, skipped: why, or stopped: why (older runs have none)'), failures: arr({ type: 'string' }, '') }, ['failures']), 'newest first'), note: s('') }, ['runs']),
    run: a => { const runs = lastRuns(a.limit || 1).map(r => ({ ...r, failures: runFailures(r) })); return runs.length ? { runs } : { runs, note: 'No run recorded yet: the log starts with the first evening run of this version.' }; },
  },
  {
    name: 'settings_get', scope: 'read', title: 'Read settings',
    description: 'The effective settings (settings.json over the defaults) with every secret-looking value redacted, or one value by its dotted path (for example "picks.per_day").',
    annotations: READ, inputSchema: args({ path: s('dotted path; leave out for everything', { maxLength: 200 }) }),
    outputSchema: obj({ file: s('settings file'), path: ns('the path asked for'), value: any('the value (redacted where secret-looking)'), set: b('whether settings.json sets it'), default: any('the default, when the schema has one') }, ['file', 'path', 'value']),
    run(a) {
      const raw = readJson(SETTINGS_FILE, {}) || {}, eff = redactSettings(effectiveSettings(raw), { secrets: secretValues() });
      if (!a.path) return { file: SETTINGS_FILE, path: null, value: eff, set: true };
      const keys = a.path.split('.');
      if (!knownPath(keys)) throw new ToolError(`"${a.path}" is not a known setting; settings_schema lists them`);
      const pick = o => keys.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
      const x = entryFor(keys), v = pick(eff);
      return { file: SETTINGS_FILE, path: a.path, value: v === undefined ? null : v, set: pick(raw) !== undefined, ...(x?.default !== undefined ? { default: x.default } : {}) };
    },
  },
  {
    name: 'settings_schema', scope: 'read', title: 'Settings reference',
    description: 'Every known setting: type, default, allowed values, one line of help, and whether settings_set may change it (locked ones are edited by hand over SSH). Filter with a path prefix such as "sources.rtj".',
    annotations: READ, inputSchema: args({ path: s('only keys starting with this prefix', { maxLength: 200 }) }),
    outputSchema: obj({ settings: arr(obj({ key: s(''), type: s(''), help: s(''), settable: b('') }, ['key', 'type', 'help', 'settable']), ''), count: i('') }, ['settings', 'count']),
    run: a => { const list = schemaView().filter(x => !a.path || x.key === a.path || x.key.startsWith(`${a.path}.`)); return { settings: list, count: list.length }; },
  },
  {
    name: 'onboarding_state', scope: 'read', title: 'Onboarding state',
    description: 'The setup steps from AGENTS.md (settings, profile, CV library, first source, first result, delivery, timer, optional modules), each done or not, and the next step to take. Walk the user through them one at a time.',
    annotations: READ, inputSchema: args({}),
    outputSchema: obj({ steps: arr(obj({ id: s(''), title: s(''), done: { type: ['boolean', 'null'] }, optional: b(''), detail: s(''), how: s('') }, ['id', 'title', 'done', 'optional', 'how']), ''), next: ns('id of the next step'), done: i(''), total: i('') }, ['steps', 'next', 'done', 'total']),
    run: () => onboardingState(),
  },
  {
    name: 'today', scope: 'read', title: 'Today\'s picks',
    description: 'Today\'s picks, the pool picks choose from, and the interview prep state: what the workspace\'s Today screen shows.',
    annotations: READ, inputSchema: args({}),
    outputSchema: obj({ date: s('today'), picks_date: ns('the day of the newest picks'), picks: arr(obj({ file: s(''), company: s(''), role: s('') }, ['file', 'company', 'role']), ''), pool: arr(obj({ file: s('') }, ['file']), ''), prep: { type: ['object', 'null'], description: 'interview prep mode, or null' } }, ['date', 'picks_date', 'picks', 'pool', 'prep']),
    run() { try { return todayPayload(); } catch (e) { throw new ToolError(e.message); } },
  },
  {
    name: 'jobs_search', scope: 'read', title: 'Search jobs',
    description: 'Jobs in the queue (inbox, decoded, rejected), newest first: file, company, role, verdict, date. Filter by words in company, role, location or source, by verdict, folder and date range.',
    annotations: READ,
    inputSchema: args({
      query: s('words to find in company, role, location or source', { maxLength: 200 }), verdict: s('strong-fit, investable-stretch, long-shot, weak-fit, gate-reject or unreadable', { maxLength: 40 }),
      folder: s('one folder, or all (default)', { enum: ['inbox', 'decoded', 'rejected', 'all'] }), from: s('first day, YYYY-MM-DD', { pattern: DATE }), to: s('last day, YYYY-MM-DD', { pattern: DATE }),
      limit: i('most rows (default 20)', { minimum: 1, maximum: 200 }),
    }),
    outputSchema: obj({ jobs: arr(jobRow, ''), total: i('matches before the limit') }, ['jobs', 'total']),
    run(a) {
      const folders = !a.folder || a.folder === 'all' ? ['inbox', 'decoded', 'rejected'] : [a.folder];
      const words = String(a.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const rows = [];
      for (const folder of folders) {
        let files = []; try { files = fs.readdirSync(DIRS[folder]).filter(f => f.endsWith('.md')); } catch { /* none */ }
        for (const file of files) {
          const date = /^\d{4}-\d{2}-\d{2}/.test(file) ? file.slice(0, 10) : '';
          if ((a.from && date < a.from) || (a.to && date > a.to)) continue;
          const text = read(path.join(DIRS[folder], file)), fm = frontMatter(text);
          const verdict = folder === 'inbox' ? null : parseResult(text).verdict || null;
          if (a.verdict && verdict !== a.verdict) continue;
          const hay = [fm.company, fm.role, fm.location, fm.source].join(' ').toLowerCase();
          if (!words.every(w => hay.includes(w))) continue;
          rows.push({ file, folder, company: String(fm.company || ''), role: String(fm.role || ''), verdict, date });
        }
      }
      rows.sort((x, y) => y.date.localeCompare(x.date) || x.file.localeCompare(y.file));
      return { jobs: rows.slice(0, a.limit || 20), total: rows.length };
    },
  },
  {
    name: 'job_get', scope: 'read', title: 'One job',
    description: 'One job by its file name (from jobs_search or today): front matter, the job text, the decode (verdict, priority, rationale, fit signals, gaps, fact flags) and the application entry.',
    annotations: READ, inputSchema: args({ file: s('queue file name, e.g. 2026-10-01--acme--product-manager.md', { maxLength: 300 }) }, ['file']),
    outputSchema: obj({ file: s(''), folder: s(''), front_matter: obj({}, []), text: s('the job text'), decode: { type: ['object', 'null'] }, application: { type: ['object', 'null'] }, history: arr({ type: 'string' }, 'earlier decodes and applications at the company') }, ['file', 'folder', 'front_matter', 'text', 'decode', 'application']),
    run(a) {
      const q = queueEntry(a.file);
      if (!q) throw new ToolError(`"${a.file}" is not in the queue; jobs_search lists the files`);
      if (q.dir === 'inbox') { const j = loadJob(a.file); return { file: a.file, folder: 'inbox', front_matter: j.fm, text: j.body, decode: null, application: appsOrError()[a.file] || null, history: [] }; }
      let p; try { p = jobPayload(a.file); } catch (e) { throw new ToolError(e.message); }
      return { file: a.file, folder: p.dir, front_matter: p.fm, text: p.text, decode: p.decode, application: p.application, history: p.history };
    },
  },
  {
    name: 'applications_list', scope: 'read', title: 'Applications',
    description: 'What is recorded in applications.json: company, role, status, last update and the latest event, newest first. Filter by status.',
    annotations: READ, inputSchema: args({ status: s('only this status', { enum: STATUSES }) }),
    outputSchema: obj({ applications: arr(obj({ key: s(''), company: s(''), role: s(''), status: ns(''), updated: ns(''), events: i('how many events'), last_event: { type: ['object', 'null'] } }, ['key', 'company', 'role', 'status', 'updated', 'events', 'last_event']), ''), total: i('') }, ['applications', 'total']),
    run(a) {
      const rows = Object.entries(appsOrError()).filter(([, x]) => x && typeof x === 'object' && (!a.status || x.status === a.status)).map(([key, x]) => {
        const ev = Array.isArray(x.events) ? x.events : [];
        return { key, company: String(x.company || ''), role: String(x.role || ''), status: x.status || null, updated: x.updated || null, events: ev.length, last_event: ev[ev.length - 1] || null };
      }).sort((x, y) => String(y.updated || '').localeCompare(String(x.updated || '')));
      return { applications: rows, total: rows.length };
    },
  },
  {
    name: 'secrets_status', scope: 'read', title: 'Secrets status',
    description: 'Which secrets each feature needs and whether each is set. Never the value. To set one, use secrets_form (admin scope) or let the user edit .env on the server.',
    annotations: READ, inputSchema: args({}),
    outputSchema: obj({ features: arr(obj({ feature: s(''), enabled: b(''), keys: arr(obj({ name: s(''), set: b('') }, ['name', 'set']), ''), how: s('where the value comes from'), form: b('secrets_form can set it') }, ['feature', 'enabled', 'keys', 'how', 'form']), '') }, ['features']),
    run: () => ({ features: secretNeeds(settingsNow()) }),
  },

  // ---------- operate ----------
  {
    name: 'set_status', scope: 'operate', title: 'Record a status',
    description: 'Record what happened to a role, like `cli.mjs status`: applied, screen, interview, offer, accepted, rejected, skipped or closed. Name the role by file (from today or jobs_search), or by company and role words; manual records a role that is not in the queue.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: args({
      file: s('queue file name', { maxLength: 300 }), company: s('company name (when there is no file)', { maxLength: 200 }), status: s('the new status', { enum: STATUSES }),
      role_words: s('words of the role title, to pick one role at the company', { maxLength: 200 }), note: s('a short note (500 characters at most)', { maxLength: 500 }), manual: b('record a role that is not in the queue'),
    }, ['status']),
    outputSchema: writeResult,
    summary: d => d.message,
    run(a) {
      if (!a.file && !a.company) throw new ToolError('name the role: file, or company (with role_words when there are several roles)');
      notBusy();
      const r = setStatus({ file: a.file || null, company: a.company, status: a.status, words: a.role_words || '', note: String(a.note || '').trim(), manual: !!a.manual, source: 'mcp' });
      if (r.code) throw new ToolError(r.lines.join('\n'));
      return { ok: true, message: r.lines.join('\n'), key: r.key, application: r.entry };
    },
  },
  {
    name: 'record_interview', scope: 'operate', title: 'Record an interview',
    description: 'Record a booked interview, like `cli.mjs interview`: the day (YYYY-MM-DD), the time (HH:MM in settings.timezone) when known, and the round. Prep mode uses it. The status becomes interview unless it is already offer or accepted.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: args({
      file: s('queue file name', { maxLength: 300 }), company: s('company name (when there is no file)', { maxLength: 200 }), date: s('YYYY-MM-DD', { pattern: DATE }),
      time: s('HH:MM, 24-hour, settings.timezone', { pattern: '^\\d{1,2}:\\d{2}$' }), role_words: s('words of the role title', { maxLength: 200 }), round: s('for example "round 2" or "final"', { maxLength: 120 }), manual: b('record a role that is not in the queue'),
    }, ['date']),
    outputSchema: writeResult,
    summary: d => d.message,
    run(a) {
      if (!a.file && !a.company) throw new ToolError('name the role: file, or company (with role_words when there are several roles)');
      if (!validDate(a.date)) throw new ToolError(`${a.date} is not a calendar day`);
      notBusy();
      const r = addInterview({ file: a.file || null, company: a.company, date: a.date, time: a.time || '', words: a.role_words || '', round: a.round || '', manual: !!a.manual, source: 'mcp' });
      if (r.code) throw new ToolError(r.lines.join('\n'));
      return { ok: true, message: r.lines.join('\n'), key: r.key, application: r.entry };
    },
  },
  {
    name: 'add_job', scope: 'operate', title: 'Add a job',
    description: 'Put one job in the inbox for the next decode, like the drop-dir source: a link (CometScout fetches the posting itself, from the ATS API when it knows the board) or pasted text with company and role. Duplicates are skipped by the usual rules.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: args({
      url: s('link to the posting (http or https)', { maxLength: 2000 }), text: s('the posting text, when there is no link or it cannot be read', { maxLength: 60000 }),
      company: s('company (taken from the posting when left out)', { maxLength: 200 }), role: s('role title (taken from the posting when left out)', { maxLength: 300 }), location: s('location', { maxLength: 300 }),
    }),
    outputSchema: obj({ written: b('true when queued'), file: ns('inbox file'), reason: ns('why it was not queued'), company: s(''), role: s(''), fetched: b('the posting text was fetched from the link') }, ['written', 'file', 'reason', 'company', 'role', 'fetched']),
    summary: d => (d.written ? `queued ${d.file}` : `not queued: ${d.reason}`),
    async run(a, ctx) {
      if (!a.url && !a.text) throw new ToolError('give a url, or the posting text with company and role');
      let url = '';
      if (a.url) { let u; try { u = new URL(a.url); } catch { throw new ToolError(`"${a.url}" is not a link`); } if (!/^https?:$/.test(u.protocol)) throw new ToolError('only http and https links'); url = u.href; }
      let company = String(a.company || '').trim(), role = String(a.role || '').trim(), text = String(a.text || '').trim(), location = String(a.location || '').trim(), fetched = false;
      if (url && !text) {
        const d = await fetchDetail(url, { fetch: ctx.fetch });
        if (d.unavailable) throw new ToolError(`the posting is no longer open (${d.unavailable}); nothing was queued`);
        if (d.via === 'error') { if (!company || !role) throw new ToolError(`could not read the link (${d.error}); give company and role (and the text if you have it) to queue it anyway`); }
        else {
          // the same order of evidence as the drop-dir source: a site's own title format, the fetched data, the ATS slug, a punctuation guess last
          const p = parseSearchTitleRule(d.via === 'page' ? d.title || '' : ''), guess = HEURISTIC_RULES.has(p.rule);
          text = d.text || ''; fetched = !!text; location ||= d.location || '';
          company ||= (!guess && p.company) || d.companyHint || companyFromUrl(url) || p.company || '';
          role ||= (d.via !== 'page' ? d.title : '') || p.title || d.title || '';
        }
      }
      company ||= url ? companyFromUrl(url) || '' : '';
      if (!company || !role) throw new ToolError(`say the ${!company ? 'company' : 'role'}: it could not be read from the posting`);
      notBusy();
      const r = writeJob({ company, role, url, source: 'mcp', location, text });
      return { written: !!r.written, file: r.file || null, reason: r.written ? null : r.reason, company, role, fetched };
    },
  },

  // ---------- admin ----------
  {
    name: 'settings_set', scope: 'admin', title: 'Change a setting',
    description: 'Change one setting by its dotted path. A dry run by default: it checks the whole resulting settings like doctor and returns the unified diff. With dry_run false it writes through CometScout\'s settings writer (formatting and line endings kept) and reinstalls the timer when schedule.time or timezone changes. Unknown keys, secret keys and locked keys (paths, programs, hooks) are refused; settings_schema says which are settable.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: args({ path: s('dotted path, e.g. "picks.per_day" or "sources.rtj.enabled"', { maxLength: 200, pattern: '^[^.]+(\\.[^.]+)*$' }), value: any('the new value (any JSON: a number, text, true/false, a list or an object)'), dry_run: b('true (the default) only shows the diff') }, ['path', 'value']),
    outputSchema: obj({ path: s(''), dry_run: b(''), written: b(''), changed: b('the file would change'), diff: s('unified diff of settings.json'), warnings: arr({ type: 'string' }, 'things to do next, and problems the file already had'), timer: ns('reinstalled, manual, would reinstall, or null') }, ['path', 'dry_run', 'written', 'changed', 'diff', 'warnings', 'timer']),
    summary: (d, a) => `${d.written ? 'wrote' : d.changed ? 'dry run of' : 'no change to'} ${a.path}${d.timer ? `; timer ${d.timer}` : ''}`,
    run(a, ctx) {
      const keys = a.path.split('.'), dryRun = a.dry_run !== false;
      // a key that reaches into Object.prototype is never a setting, under any container (wildcards included)
      const evil = forbiddenKeys(keys, a.value);
      if (evil.length) throw new ToolError(`refused: ${evil.join(', ')} uses a reserved name (__proto__, constructor or prototype); no setting has one`);
      if (keys.some(secretKey)) throw new ToolError(`${a.path} looks like a secret: secrets live in .env, never in settings.json; use secrets_form`);
      if (!knownPath(keys)) throw new ToolError(`"${a.path}" is not a known setting; settings_schema lists them`);
      const unknown = unknownKeys(keys, a.value);
      if (unknown.length) throw new ToolError(`unknown key(s) in the value: ${unknown.join(', ')}; settings_schema lists the known ones`);
      const secrets = secretValues();
      if (secrets.some(x => JSON.stringify(a.value ?? null).includes(x))) throw new ToolError('the value contains a secret from .env; secrets never go into settings.json');
      const env = parseEnv(read(path.join(ROOT, '.env'))).values;
      const validate = (next, cur) => {
        const pick = (o, ks) => ks.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
        const locked = SCHEMA.filter(x => x.locked && !x.key.includes('*')).filter(x => JSON.stringify(pick(next, x.key.split('.'))) !== JSON.stringify(pick(cur, x.key.split('.'))));
        if (locked.length) return { problems: locked.map(x => `${x.key} is locked (${x.locked}); edit settings.json by hand over SSH`) };
        const before = new Set(settingsProblems(cur)), after = settingsProblems(next);
        const warnings = after.filter(p => before.has(p)).map(p => `already in settings.json: ${p}`);
        for (const need of secretNeeds(next)) if (need.enabled) for (const k of need.keys) if (!secretSet(k.name, env)) warnings.push(`${need.feature} needs ${k.name}: ${need.form ? 'use secrets_form' : need.how}`);
        return { problems: after.filter(p => !before.has(p)), warnings };
      };
      const sensitive = () => { const cur = readJson(SETTINGS_FILE, {}) || {}; return SCHEMA.filter(x => x.sensitive).map(x => x.key.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), cur)).filter(v => typeof v === 'string' && v); };
      const hide = [...secrets, ...sensitive()];
      const redact = text => hide.reduce((t, v) => t.split(v).join(REDACTED), text);
      if (!dryRun) notBusy();
      const r = setSetting(keys, a.value, { dryRun, validate, redact, reload: next => reloadSettings(next), ...(ctx.reinstall ? { reinstall: ctx.reinstall } : {}) });
      if (!r.ok) throw new ToolError(`not changed: ${r.problems.join('; ')}`, r);
      return { path: a.path, dry_run: r.dry_run, written: r.written, changed: r.changed, diff: r.diff, warnings: r.warnings, timer: r.timer };
    },
  },
  {
    name: 'secrets_form', scope: 'admin', title: 'One-time secrets link',
    description: `A one-time link to a page in the CometScout workspace where the user types a secret (a token, a cookie, a chat id) on their own computer; the workspace writes it to .env. The value never passes through this server or the chat. The link works once and expires after 15 minutes. Only these names can be set: ${FORM_SECRETS.join(', ')}. Give the user the steps from the result.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: args({ keys: arr({ type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' }, 'the .env variable names, from secrets_status'), port: i('the workspace port (default 8787)', { minimum: 1, maximum: 65535 }) }, ['keys']),
    outputSchema: obj({ url: s('open this in a browser on the user\'s computer'), loopback_url: s('the same link on 127.0.0.1 and the workspace port, through the SSH tunnel'), expires_at: s('ISO time'), keys: arr({ type: 'string' }, ''), workspace_running: b('the workspace answered on the server'), steps: arr({ type: 'string' }, 'what to tell the user') }, ['url', 'loopback_url', 'expires_at', 'keys', 'workspace_running', 'steps']),
    summary: d => `link for ${d.keys.join(', ')}, expires ${d.expires_at}`,
    async run(a, ctx) {
      if (!a.keys.length) throw new ToolError('name at least one variable; secrets_status lists them');
      let link; try { link = issueLink(a.keys, { now: ctx.now().getTime() }); } catch (e) { throw new ToolError(e.message); }
      // the link is built from the loopback address and the workspace port; workspace.url (locked for settings_set) is
      // used only when the user wrote it into settings.json by hand, and the loopback form is given next to it
      const port = a.port || 8787, loopback = `http://127.0.0.1:${port}`, own = handWorkspaceUrl();
      let running = false;
      try { const r = await ctx.fetch(`http://127.0.0.1:${port}/api/labels`, { signal: AbortSignal.timeout(1500) }); running = r.status === 200; await r.arrayBuffer().catch(() => {}); } catch { running = false; }
      const steps = [
        ...(running ? [] : [`On the server, start the workspace: node cli.mjs serve --port ${port} (it listens on 127.0.0.1 only).`]),
        `On your computer, open a tunnel: ssh -L ${port}:127.0.0.1:${port} <your server> (skip this when CometScout runs on this computer).`,
        `Open the link in your browser within ${LINK_TTL_MS / 60000} minutes, type the value and press Save. The link works once.`,
        ...(own ? [`The link uses workspace.url from settings.json (${own}). If that is not the address you open the workspace at, use loopback_url through the tunnel instead (${loopback}).`] : []),
        'Then ask the assistant to check secrets_status.',
      ];
      const page = `/secrets?t=${link.token}`;
      return { url: `${own || loopback}${page}`, loopback_url: `${loopback}${page}`, expires_at: link.expires_at, keys: a.keys, workspace_running: running, steps };
    },
  },
];

// ---------- resources ----------
export const RESOURCES = [
  { uri: 'cometscout://settings/schema', name: 'settings-schema', title: 'Settings reference', description: 'Every known setting with type, default, allowed values and help.', mimeType: 'application/json', read: () => JSON.stringify({ settings: schemaView() }, null, 1) },
  { uri: 'cometscout://digest/latest', name: 'digest-latest', title: 'Latest digest', description: 'The newest evening digest as it was written to data/digests.', mimeType: 'text/markdown', read: () => { const d = latestDigest(); return d ? d.text : '(no digest yet: the first evening run writes one)\n'; } },
  { uri: 'cometscout://doctor', name: 'doctor', title: 'Setup check', description: 'The doctor items: ok, todo or warn, with the fix.', mimeType: 'application/json', read: ctx => JSON.stringify(doctorView(ctx.runDoctor()), null, 1) },
  { uri: 'cometscout://onboarding', name: 'onboarding', title: 'Onboarding state', description: 'The setup steps from AGENTS.md, done or not, and the next one.', mimeType: 'application/json', read: () => JSON.stringify(onboardingState(), null, 1) },
];

// ---------- prompts ----------
const can = (scope, need) => ['read', 'operate', 'admin'].indexOf(scope) >= ['read', 'operate', 'admin'].indexOf(need);
export const PROMPTS = [
  {
    name: 'setup', title: 'Set CometScout up', description: 'Walk the user through the onboarding steps one at a time, using the tools.',
    text: (_a, { scope }) => [
      'Help me set up CometScout, one step at a time.',
      'First call onboarding_state and doctor. Take the steps in the order onboarding_state gives, and ask me one question at a time. Explain each change in a sentence and wait for my yes before writing anything.',
      can(scope, 'admin') ? 'For a setting, call settings_set with dry_run true first, show me the diff, and only after my yes call it again with dry_run false.' : 'This server is not in the admin scope, so tell me the setting to change and I will change it myself.',
      can(scope, 'admin') ? 'Never ask me to paste a token, cookie or password into this chat. When a feature needs a secret (secrets_status says which), call secrets_form and give me its steps; then check secrets_status again.' : 'Never ask me to paste a token, cookie or password into this chat; I will put secrets into .env on the server myself.',
      'Steps that need files written on the server (profile/profile.md, profile/cv-library.json) or commands run there (node cli.mjs timer, the first sources, decode and pack): tell me exactly what to run, following AGENTS.md. Never invent facts about me.',
      'Finish with status and say what happens every evening.',
    ].join('\n\n'),
  },
  {
    name: 'tune-gates', title: 'Tune gates and titles', description: 'Look at recent rejections and picks and propose gate or title filter changes, as dry runs first.',
    arguments: [{ name: 'days', description: 'how many days back to look (default 14)', required: false }],
    text: (a, { scope }) => {
      const days = /^\d{1,3}$/.test(String(a.days || '')) ? Number(a.days) : 14, from = addDays(today(), -days);
      return [
        `Look at my last ${days} days of CometScout results and suggest changes to my gates and title filters.`,
        `Use jobs_search with folder "rejected" and from "${from}" for what was rejected (job_get on a few to see the gate or the reason), jobs_search with folder "decoded" and the same date for what got through, today for the current picks and pool, and applications_list for what I applied to or skipped.`,
        'Read the current values with settings_get ("gates", and "title_include" / "title_exclude" under the enabled sources) and their meaning with settings_schema.',
        'Name the patterns you see (good roles rejected by a gate, poor roles that keep getting through), each with two or three job files as evidence. Then propose at most three changes, smallest first.',
        can(scope, 'admin') ? 'For each change call settings_set with dry_run true and show me the diff. Do not write anything until I say yes to that change.' : 'Write each change as the setting path and its new value; I will apply it myself.',
      ].join('\n\n');
    },
  },
  {
    name: 'weekly-review', title: 'Weekly review', description: 'Applications, outcomes and picks of the week.',
    arguments: [{ name: 'days', description: 'how many days back (default 7)', required: false }],
    text: a => {
      const days = /^\d{1,3}$/.test(String(a.days || '')) ? Number(a.days) : 7, from = addDays(today(), -days);
      return [
        `Give me a short review of my job search since ${from}.`,
        'Use applications_list for what I applied to and what came back (rejections, interviews, offers: look at each entry\'s latest event and its date), run_log with limit 7 for the evening runs (new jobs, decoded, worth applying, picks, failures), and jobs_search with verdict "strong-fit" and "investable-stretch" from that date for the strongest finds.',
        'Then tell me in a few lines: how many applications and answers, what is open, which sources brought the strong finds, anything that failed, and the one thing worth doing next week. Say when the data is thin rather than guessing.',
      ].join('\n\n');
    },
  },
];

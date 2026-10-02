#!/usr/bin/env node
// jobpilot command line.
//   node cli.mjs run                 # the evening run: every enabled source (and outcomes from Gmail), then decode + picks + digest, then packs
//   node cli.mjs sources|decode|pack|picks
//   node cli.mjs applied <company> [role words]   # record an application (picks stop showing it)
//   node cli.mjs status <company> <applied|screen|interview|offer|rejected|skipped|closed> [role words] [--note "..."]
//                                    # add --manual to record a role that is not in the queue (it does not affect picks)
//   node cli.mjs list                # what is recorded
//   node cli.mjs doctor              # check the setup, one line per item
//   node cli.mjs timer [HH:MM]       # (re)install the daily timer from settings.json (run_time, timezone)
//   node cli.mjs reset --yes         # delete everything in data/ (queue, picks, packs, seen lists), e.g. after trying the example
//   node cli.mjs export [--out file.zip|folder] [--data-only]   # data, profile and settings; .env is never exported
//   node cli.mjs export --csv <file.csv>                        # applications as a spreadsheet
//   node cli.mjs import --from <file.zip|file.tar.gz|folder> [--dry-run] [--on-conflict keep|theirs|both] [--data-only]
//   node cli.mjs export-secrets --out <file> | import-secrets --from <file> [--dry-run] [--force]   # .env, encrypted
//   node cli.mjs backup [--label <text>] | backups | restore <backup> [--dry-run]                  # backups/ in the home
//   node cli.mjs tracker-export [--out <file>] [--dry-run]   # applications as a job-pipeline-tracker import file (--dry-run: the rows on stdout, notes on stderr)
//   node cli.mjs sources-report [--send]                     # which source earns its price (data/reports/source-scorecard.md)
//   node cli.mjs notify <text>                               # send one Telegram message (the failure alert unit uses it)
//   node cli.mjs serve [--port 8787] [--host 127.0.0.1]      # the workspace (preview): today's picks, decode and pack in the browser
//   node cli.mjs coach-handoff [--out <file>]                # profile, CV, voice and applications for the interview coach's kickoff
//                                    # (default: materials/cometscout-handoff.md in the coach's folder; the run refreshes it when modules.coach.enabled)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, SETTINGS, SETTINGS_FILE, PROFILE, DATA, DIRS, STATE, ENV_PROBLEMS, readJson, secret, today } from './lib/config.mjs';
import { readApplications } from './lib/queue.mjs';
import { setStatus as recordStatus } from './lib/applications.mjs';
import { runHook, hooksFor, HOOK_EVENTS } from './lib/hooks.mjs';
import { archiveCommands } from './lib/archive-cli.mjs';
import { nightlyBackup, backupDoctor } from './lib/backup.mjs';
import { describeGates, GATE_KEYS } from './lib/gates.mjs';
import { checkSetup as careerOpsSetup } from './sources/career-ops.mjs';
import { promptFile, DEFAULT_PROMPT_FILE } from './decoder/decoder.mjs';
import { profileRules, lintLibrary, cyrillicBoundary } from './lib/lint.mjs';
import { binCommand } from './lib/llm.mjs';
import { trackerExport, exportNotes } from './lib/tracker.mjs';
import { sourcesReport, sourcesReportCommand } from './lib/scorecard.mjs';
import { trimSightings } from './lib/sightings.mjs';
import { healthPing, notify, unitFiles } from './lib/ops.mjs';
import { localeOk, LOCALES } from './lib/i18n.mjs';
import { sendText, telegramOn } from './lib/telegram.mjs';
import { startServer, vendorCheck } from './lib/server.mjs';
import { takeLock } from './lib/lock.mjs';
import { coachDoctor, coachHandoff, refreshHandoff } from './lib/coach.mjs';

const [cmd, ...rest] = process.argv.slice(2);
// Steps are scripts next to this file; ROOT (JOBPILOT_HOME) is where profile/ and settings live, which may be elsewhere.
const CODE = path.dirname(fileURLToPath(import.meta.url));
const node = (file, extra = []) => spawnSync(process.execPath, [path.join(CODE, file), ...extra], { stdio: 'inherit' }).status;
// outcomes reads application results from Gmail; it runs with the sources, so the decoder already knows what closed
// career_ops: reads a career-ops checkout, never writes to it
// hh_alerts: hh.ru alert emails (Gmail + the public vacancy page); hirify: saved filters, read with the user's session cookie
const SOURCES = { ats_boards: 'sources/ats-boards.mjs', rtj: 'sources/rtj.mjs', linkedin_alerts: 'sources/linkedin-alerts.mjs',
  hh_alerts: 'sources/hh-alerts.mjs', hirify: 'sources/hirify.mjs', career_ops: 'sources/career-ops.mjs', drop_dir: 'sources/drop-dir.mjs', outcomes: 'sources/outcomes.mjs' };
const APPS = STATE('applications.json');

// A source that exits non-zero is logged by name and listed in the run's result (the closing log line and run_done's
// sources_failed), so a dead source is never silent. Exit 3 means it cannot work until the user acts (an expired
// login): the run still decodes and packs what it has, then exits 3 too, so the timer's status and health alerts
// show it. Other exit codes do not change the run's own exit code.
const NEEDS_USER = 3;
// A broken applications.json would make every source stop half-way; check it once, before any source runs.
function appsBroken() {
  try { readApplications(APPS); return null; } catch (e) { return `jobpilot: ${e.message}`; }
}
function runSources() {
  const failed = [];
  for (const [k, f] of Object.entries(SOURCES)) {
    if (!SETTINGS.sources[k]?.enabled) continue;
    const exit = node(f);
    if (exit === 0) continue;
    failed.push({ source: k, exit });
    console.log(`jobpilot: source ${k} failed (exit ${exit ?? 'none, it was killed'})${exit === NEEDS_USER ? '; it needs you, see the message above' : ''}`);
  }
  return failed;
}
const failedLine = failed => failed.map(f => `${f.source} (exit ${f.exit ?? 'killed'})`).join(', ');
// pack.mjs records a refused pack in packs.json ({ refused: [rule ids], at, company, role, ... }); a run lists the ones from its own pack step
const refusedSince = at => Object.entries(readJson(STATE('packs.json'), {})).filter(([, v]) => v?.refused && String(v.at || '') >= at)
  .map(([file, v]) => ({ file, company: v.company || null, role: v.role || null, rules: v.refused }));
const refusedLine = refused => refused.map(r => `${r.company || r.file}, ${r.role || '?'} (${r.rules.join(', ')})`).join('; ');

// One run at a time: the timer and a manual command must not decode the same files or write state twice.
const lock = () => takeLock();

// The body lives in lib/applications.mjs, shared with the workspace server (POST /api/status).
function setStatus(company, status, words, note, manual) {
  const r = recordStatus({ company, status, words, note, manual, source: 'cli' });
  for (const l of r.lines) console.log(l);
  return r.code;
}

function timer(at) {
  const time = at || SETTINGS.run_time || '18:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { console.log(`Time must be HH:MM, got "${time}"`); return 1; }
  let tz = SETTINGS.timezone || ''; try { if (tz) new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { console.log(`Unknown timezone "${tz}" in settings.json; using the server's own`); tz = ''; }
  const dir = path.join(os.homedir(), '.config', 'systemd', 'user'); fs.mkdirSync(dir, { recursive: true });
  const envPath = `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
  // jobpilot.service names jobpilot-failure@.service in OnFailure=, so a failed run sends a Telegram alert (cli.mjs notify)
  for (const [name, text] of Object.entries(unitFiles({ root: ROOT, code: CODE, node: process.execPath, time, tz, envPath }))) fs.writeFileSync(path.join(dir, name), text);
  for (const a of [['daemon-reload'], ['enable', '--now', 'jobpilot.timer']]) spawnSync('systemctl', ['--user', ...a], { stdio: 'inherit' });
  spawnSync('systemctl', ['--user', 'list-timers', 'jobpilot.timer', '--no-pager'], { stdio: 'inherit' });
  return 0;
}

function doctor() {
  const ok = (good, text, fix = '') => console.log(`${good ? 'ok  ' : 'TODO'} ${text}${!good && fix ? `  ->  ${fix}` : ''}`);
  const ver = bin => { const [c, a] = binCommand(bin, ['--version']); const r = spawnSync(c, a, { encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? (r.stdout || '').trim().split('\n')[0] : null; };
  ok(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node}`, 'install Node 20 or newer');
  const { provider, model, pack_model } = SETTINGS.llm; const llm = SETTINGS.llm.bin || provider; const v = ver(llm);
  ok(!!v, `${provider} CLI${v ? `: ${v}` : ' not found'}`, provider === 'claude' ? 'install Claude Code and run `claude` once to sign in' : 'install Codex CLI and run `codex login`');
  const claudeish = m => /^(sonnet|opus|haiku|claude)/i.test(String(m || '')), openaiish = m => /^(gpt|o\d|codex)/i.test(String(m || ''));
  const wrong = [model, pack_model].filter(m => m && (provider === 'codex' ? claudeish(m) : openaiish(m)));
  ok(!wrong.length, `models for ${provider}: ${model} / ${pack_model}`, `${wrong.join(', ')} is not a ${provider} model; set llm.model and llm.pack_model in settings.json`);
  ok(!!process.env.JOBPILOT_SETTINGS || path.basename(SETTINGS_FILE) === 'settings.json', `settings: ${process.env.JOBPILOT_SETTINGS ? SETTINGS_FILE : path.basename(SETTINGS_FILE)}`, 'copy settings.example.json to settings.json and edit it (the onboarding does this)');
  const unknownHooks = Object.keys(SETTINGS.hooks || {}).filter(k => k !== 'timeout_sec' && !HOOK_EVENTS.includes(k));
  const hookCount = HOOK_EVENTS.reduce((n, e) => n + hooksFor(e).length, 0);
  const ctx = (SETTINGS.decoder?.context_files || []).filter(e => !/\*\.md$/.test(e) && !fs.existsSync(path.isAbsolute(e) ? e : path.join(PROFILE.dir, e)));
  const prompt = promptFile(), builtIn = prompt === DEFAULT_PROMPT_FILE;
  ok(fs.existsSync(prompt), `decoder prompt: ${builtIn ? 'built-in (decoder/prompt.md)' : prompt}`, `decoder.prompt_file not found; fix the path in settings.json (absolute, or relative to ${PROFILE.dir}) or remove it to use the built-in prompt`);
  ok(!ctx.length, `decoder context files: ${(SETTINGS.decoder?.context_files || []).length}`, `not found: ${ctx.join(', ')}`);
  ok(!unknownHooks.length, `hooks: ${hookCount} configured`, `unknown hook event(s) ignored: ${unknownHooks.join(', ')} (known: ${HOOK_EVENTS.join(', ')})`);
  ok(!PROFILE.isExample, `profile: ${path.basename(PROFILE.dir)}`, 'create profile/ with your own facts (the onboarding does this); the evening run waits until then');
  ok(PROFILE.facts.trim().length > 200, `profile.md: ${PROFILE.facts.trim().length} characters`, 'profile/profile.md is missing or nearly empty; every decode would run without your facts');
  ok(!!PROFILE.cvLibrary, 'CV library (profile/cv-library.json)', 'needed for application packs');
  ok(!PROFILE.ruleErrors.length, `fact rules: ${PROFILE.factRules.length} loaded`, `broken rule(s) skipped: ${PROFILE.ruleErrors.join('; ')}`);
  const lint = profileRules();
  ok(!lint.problems.length, `lint rules: ${lint.present ? `${lint.banned.length} banned, ${lint.warn.length} warn` : 'none (optional: profile/lint-rules.json)'}`, `rule(s) skipped: ${lint.problems.join('; ')}`);
  const warn = text => console.log(`warn ${text}`);
  // \b only sees ASCII word edges in JavaScript, so "\bслово\b" never matches; patterns are not rewritten
  const cyr = [...lint.banned, ...lint.warn, ...PROFILE.factRules].filter(r => cyrillicBoundary(r.pattern)).map(r => r.id);
  if (cyr.length) warn(`\\b next to Cyrillic never matches a word edge: ${[...new Set(cyr)].join(', ')}  ->  use (?<!\\p{L}) and (?!\\p{L}) in lint rules, (?<![a-zа-яё]) and (?![a-zа-яё]) in fact rules`);
  if (PROFILE.cvLibrary && lint.present) {
    const lib = lintLibrary(PROFILE.cvLibrary, lint);
    if (lint.banned.length) ok(!lib.errors.length, 'vetted CV text passes your lint rules', `vetted text breaks your own rule: ${lib.errors.map(b => `${b.item} (${b.id})`).join(', ')}; packs that use it are not built. Fix profile/cv-library.json or the rule`);
    // warnings on vetted text are reported here, once, not in every pack
    if (lib.warns.length) warn(`vetted CV text has ${lib.warns.length} lint warning(s): ${lib.warns.map(w => `${w.item} (${w.id}${w.id.endsWith('-length') ? `, ${w.match}` : ''})`).join(', ')}`);
  }
  ok(!ENV_PROBLEMS.length, '.env lines', `these lines are not KEY=value and were ignored: ${ENV_PROBLEMS.join(', ')}`);
  const enabled = Object.keys(SOURCES).filter(k => k !== 'outcomes' && SETTINGS.sources[k]?.enabled);   // outcomes finds no jobs
  ok(enabled.length > 0, `sources enabled: ${enabled.join(', ') || 'none'}`, 'enable at least one source in settings.json');
  const unknown = Object.keys(SETTINGS.sources).filter(k => !SOURCES[k]);
  ok(!unknown.length, 'source names in settings.json', `unknown source(s) ignored: ${unknown.join(', ')} (known: ${Object.keys(SOURCES).join(', ')})`);
  if (SETTINGS.sources.rtj?.enabled) ok(!!secret(SETTINGS.sources.rtj.token_env || 'RTJ_API_TOKEN'), 'RealtimeJobs token in .env', 'add RTJ_API_TOKEN=... to .env');
  const gmailUsers = [['linkedin_alerts', 'LinkedIn alerts'], ['outcomes', 'outcomes'], ['hh_alerts', 'hh.ru alerts']].filter(([k]) => SETTINGS.sources[k]?.enabled).map(([, n]) => n);
  if (gmailUsers.length) ok(['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].every(k => secret(k)), `Gmail read-only access (${gmailUsers.join(', ')})`, 'add GMAIL_CLIENT_ID/SECRET to .env, then run `node tools/gmail-auth.mjs`');
  if (SETTINGS.sources.hh_alerts?.enabled) { const l = [].concat(SETTINGS.gates?.languages ?? []).map(x => String(x).toLowerCase()); ok(!l.length || l.some(x => /^(ru|rus|russian)([-_].*)?$/.test(x)), 'hh.ru alerts: language gate', 'gates.languages has no "ru", so every Russian posting from hh.ru is rejected; add "ru"'); }
  if (SETTINGS.sources.career_ops?.enabled) { const c = careerOpsSetup(); ok(c.good, c.text, c.fix); }
  if (SETTINGS.sources.drop_dir?.enabled) { const d = SETTINGS.sources.drop_dir.dir; ok(!!d && fs.existsSync(d), `drop-dir folder: ${d || 'not set'}`, d ? `create ${d} or fix sources.drop_dir.dir in settings.json` : 'set sources.drop_dir.dir in settings.json'); }
  if (SETTINGS.sources.hirify?.enabled) {
    const h = SETTINGS.sources.hirify, env = h.cookie_env || 'HIRIFY_COOKIE';
    ok(!!secret(env), `Hirify session cookie (${env}) in .env`, `copy the cookie from your browser into ${env}=... in .env (README: Hirify)`);
    ok((h.filters || []).some(f => f?.query), `Hirify filters: ${(h.filters || []).filter(f => f?.query).length}`, 'add a saved filter to sources.hirify.filters: [{ "name": "...", "query": "..." }]');
  }
  const gates = describeGates(SETTINGS.gates);
  ok(!gates.unknown.length, `gates: ${gates.active.join(', ') || 'none (settings.gates not set)'}`, `unknown key(s) under gates ignored: ${gates.unknown.join(', ')} (known: ${GATE_KEYS.join(', ')})`);
  const tg = SETTINGS.delivery.telegram;
  ok(!tg.enabled || (secret(tg.token_env) && secret(tg.chat_id_env)), `Telegram delivery: ${tg.enabled ? 'on' : 'off (digest is written to data/digests only)'}`, 'add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env');
  const vendor = vendorCheck();
  ok(vendor.ok, `workspace modules: ${vendor.ok ? Object.entries(vendor.versions).map(([k, v]) => `${k} ${v}`).join(', ') : 'preact and htm not installed'}`, `run npm install in ${CODE} (needed for node cli.mjs serve only)`);
  ok(localeOk(), `locale: ${SETTINGS.locale || 'en'}`, `unknown locale "${SETTINGS.locale}"; use one of ${LOCALES.join(', ')} (English is used meanwhile)`);
  ok(true, `health ping: ${SETTINGS.health?.ping_url ? 'set' : 'not set (optional: health.ping_url, so a run that never happens is noticed)'}`);
  if (SETTINGS.tracker_export?.enabled) { const o = SETTINGS.tracker_export.out || 'tracker/pipeline.json'; ok(true, `tracker export: ${path.isAbsolute(o) ? o : path.posix.join(path.basename(DATA), o.replace(/\\/g, '/'))}`); }
  if (SETTINGS.sources_report?.enabled) ok(true, `source scorecard: on, ${Object.keys(SETTINGS.sources_report.prices || {}).length} price(s)`);
  const so = ver(process.env.SOFFICE || SETTINGS.pack.soffice || 'soffice');
  ok(!!so || process.platform === 'win32', `PDF export: ${so ? 'LibreOffice' : process.platform === 'win32' ? 'Word (Windows)' : 'LibreOffice not found'}`, 'sudo apt install libreoffice-writer-nogui fonts-liberation');
  ok(!!spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version']).stdout, 'Python 3 (packs the DOCX files)', 'install python3');
  for (const b of backupDoctor()) if (b.level === 'warn') warn(`${b.text}  ->  ${b.fix}`); else ok(b.level === 'ok', b.text, b.fix);
  for (const c of coachDoctor()) ok(c.level === 'ok', c.text, c.fix);   // modules.coach (optional)
}

async function optional(name, fn) {
  // a step after the digest: a failure is logged, the run's exit code stays
  try { await fn(); } catch (e) { console.log(`jobpilot: ${name} failed: ${e.message}`); }
}
async function evening() {
  // The timer is installed before onboarding; never spend the subscription decoding real jobs for the example person.
  if (PROFILE.isExample && !rest.includes('--example')) { console.log('jobpilot: no profile/ yet, so the evening run is skipped. Finish the onboarding (or run with --example to try it on the example profile).'); return 0; }
  process.env.JOBPILOT_RUN_DATE = today();          // one date for every step, even if the run crosses midnight
  const broken = appsBroken(); if (broken) { console.log(broken); return 2; }
  const t0 = Date.now(); runHook('before_run', { date: today() });
  await optional('sightings trim', () => trimSightings());   // here only, before any source writes: no two writers race
  const failed = runSources(); const decoder = node('decoder/decoder.mjs');
  if (SETTINGS.sources_report?.enabled) await optional('sources-report', () => sourcesReport({ send: sendText, print: () => {} }));
  const packStart = new Date().toISOString(); const pack = SETTINGS.pack.enabled ? node('pack/pack.mjs') : null;
  const refused = refusedSince(packStart);   // packs refused in this run (vetted CV text breaks a lint rule); not a failure
  if (SETTINGS.modules?.coach?.enabled && !PROFILE.isExample) await optional('coach-handoff', () => refreshHandoff());   // the interview coach's snapshot; no network
  if (SETTINGS.tracker_export?.enabled) await optional('tracker-export', () => { const r = trackerExport(); for (const l of [...exportNotes(r), r.message]) console.log(`tracker-export: ${l}`); });
  runHook('run_done', { date: today(), seconds: Math.round((Date.now() - t0) / 1000), decoder_exit: decoder, pack_exit: pack, sources_failed: failed, refused });
  const closing = [...(failed.length ? [`failed source(s): ${failedLine(failed)}`] : []), ...(refused.length ? [`refused pack(s): ${refusedLine(refused)}`] : [])];
  if (closing.length) console.log(`jobpilot: run finished; ${closing.join('; ')}`);
  await nightlyBackup({ alert: text => notify(text, { send: sendText, on: telegramOn }) });   // backup.nightly; never fails the run
  return failed.some(f => f.exit === NEEDS_USER) ? NEEDS_USER : 0;
}

// The workspace (lib/server.mjs). Loopback only until sign-in exists; --unsafe-no-auth is the explicit way around it.
async function serve() {
  // a flag given without a value ("--port" last, or followed by another flag) is an error, never the default
  const opt = n => { const i = rest.indexOf(`--${n}`); if (i < 0) return undefined; const v = rest[i + 1]; return v === undefined || v.startsWith('--') ? '' : v; };
  const port = opt('port') ?? '8787', host = opt('host') ?? '127.0.0.1', unsafeNoAuth = rest.includes('--unsafe-no-auth');
  if (port === '') { console.log('--port needs a number, e.g. --port 8787'); return 1; }
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) { console.log(`--port must be a number from 0 to 65535, got "${port}"`); return 1; }
  if (host === '') { console.log('--host needs an address, e.g. --host 127.0.0.1'); return 1; }
  let s; try { s = await startServer({ host, port: Number(port), unsafeNoAuth }); } catch (e) { console.log(`jobpilot serve: ${e.code === 'EADDRINUSE' ? `port ${port} is in use; try --port ${Number(port) + 1}` : e.message}`); return 1; }
  if (unsafeNoAuth) console.log(`WARNING: --unsafe-no-auth: the workspace has no sign-in; anyone who can reach ${host}:${s.port} can read your queue and packs and record statuses.`);
  console.log(`jobpilot workspace: ${s.url}  (data: ${DATA}; Ctrl+C stops it)`);
  const stop = () => { s.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise(() => {});
}

const locked = fn => () => { const busy = lock(); if (busy) { console.log(busy); return 1; } return fn(); };
const codes = {
  // After the run, health.ping_url hears the exit code, whatever happened.
  run: locked(async () => {
    let code = 1;
    try { code = await evening(); return code; } finally { await healthPing(code); }
  }),
  sources: locked(() => { const broken = appsBroken(); if (broken) { console.log(broken); return 2; } return runSources().some(f => f.exit === NEEDS_USER) ? NEEDS_USER : 0; }),
  decode: locked(() => node('decoder/decoder.mjs', rest)),
  picks: () => node('decoder/decoder.mjs', ['--picks']),
  pack: locked(() => node('pack/pack.mjs', rest)),
  applied: () => { const m = rest.includes('--manual'); const r = rest.filter(x => x !== '--manual'); return setStatus(r[0], 'applied', r.slice(1).join(' '), '', m); },
  status: () => {
    const m = rest.includes('--manual'); const r0 = rest.filter(x => x !== '--manual');
    const i = r0.indexOf('--note'); const note = i >= 0 ? r0.slice(i + 1).join(' ') : ''; const r = i >= 0 ? r0.slice(0, i) : r0;
    return setStatus(r[0], r[1], r.slice(2).join(' '), note, m);
  },
  list: () => { for (const a of Object.values(readJson(APPS, {}))) console.log(`${a.updated || '?'}  ${String(a.status || '?').padEnd(9)} ${a.company}: ${a.role}${a.events?.length ? `  (${a.events.length} event(s), last ${a.events[a.events.length - 1].date || '?'})` : ''}`); return 0; },
  doctor: () => { doctor(); return 0; },
  timer: () => timer(rest[0]),
  reset: locked(() => {
    if (!rest.includes('--yes')) { console.log(`This deletes everything in ${DATA} (queue, decodes, picks, packs, seen lists, applications). Run again with --yes to confirm.`); return 1; }
    for (const d of Object.values(DIRS)) for (const f of fs.readdirSync(d)) if (f !== 'run.lock') fs.rmSync(path.join(d, f), { recursive: true, force: true });
    console.log(`Cleared ${DATA}.`); return 0;
  }),
  'tracker-export': () => {
    const i = rest.indexOf('--out'); if (i >= 0 && !rest[i + 1]) { console.log('Usage: node cli.mjs tracker-export [--out <file>] [--dry-run]'); return 1; }
    try {
      const dryRun = rest.includes('--dry-run');
      const r = trackerExport({ out: i >= 0 ? rest[i + 1] : undefined, dryRun });
      // a dry run prints what the file would hold on stdout, alone, so it can be piped (jq); notes and the summary go to stderr
      const say = dryRun ? console.error : console.log;
      if (dryRun) console.log(JSON.stringify(r.applications, null, 1));
      for (const l of exportNotes(r)) say(l);
      say(r.message); return 0;
    } catch (e) { console.log(`tracker-export stopped: ${e.message}`); return 1; }
  },
  'sources-report': () => sourcesReportCommand({ send: rest.includes('--send') ? sendText : null }),
  notify: () => notify(rest.join(' '), { send: sendText, on: telegramOn }),
  serve: () => serve(),
  'coach-handoff': () => {
    const i = rest.indexOf('--out'); if (i >= 0 && (!rest[i + 1] || rest[i + 1].startsWith('--'))) { console.log('Usage: node cli.mjs coach-handoff [--out <file>]'); return 1; }
    return coachHandoff({ out: i >= 0 ? rest[i + 1] : undefined });
  },
  ...archiveCommands({ rest, locked }),
};
if (!codes[cmd]) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n')); process.exit(cmd ? 1 : 0); }
process.exitCode = (await codes[cmd]()) || 0;

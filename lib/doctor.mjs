// The setup check (node cli.mjs doctor): one item per thing, { level: "ok" | "todo" | "warn", text, fix }. cli.mjs prints
// them as lines ("ok  ", "TODO", "warn"; --json prints the items); the MCP server's doctor tool runs that command.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SETTINGS, SETTINGS_FILE, PROFILE, DATA, CODE_DIR, ENV_PROBLEMS, ENV_IGNORED, secret, today, fromEnvFile } from './config.mjs';
import { envSet, envVar, oldEnvVars } from './legacy-names.mjs';
import { hooksFor, HOOK_EVENTS } from './hooks.mjs';
import { backupDoctor } from './backup.mjs';
import { describeGates, GATE_KEYS } from './gates.mjs';
import { checkSetup as careerOpsSetup } from '../sources/career-ops.mjs';
import { promptFile, DEFAULT_PROMPT_FILE } from '../decoder/decoder.mjs';
import { profileRules, lintLibrary, cyrillicBoundary } from './lint.mjs';
import { binCommand } from './llm.mjs';
import { oldUnitsDoctor } from './ops.mjs';
import { scheduleOf, scheduleProblems, prepOf, weekdayNames, offDay } from './schedule.mjs';
import { localeOk, LOCALES } from './i18n.mjs';
import { vendorCheck } from './server.mjs';
import { coachDoctor } from './coach.mjs';
import { transcribeDoctor } from './transcribe.mjs';
import { updateDoctor } from './update.mjs';
import { SOURCES } from './settings-schema.mjs';

/** The doctor items, in the order the command prints them. */
export function doctorItems() {
  const items = [];
  const ok = (good, text, fix = '') => items.push({ level: good ? 'ok' : 'todo', text, fix: good ? '' : fix });
  const warn = (text, fix = '') => items.push({ level: 'warn', text, fix });
  const ver = bin => { const [c, a] = binCommand(bin, ['--version']); const r = spawnSync(c, a, { encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? (r.stdout || '').trim().split('\n')[0] : null; };
  ok(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node}`, 'install Node 20 or newer');
  const { provider, model, pack_model } = SETTINGS.llm; const llm = SETTINGS.llm.bin || provider; const v = ver(llm);
  ok(!!v, `${provider} CLI${v ? `: ${v}` : ' not found'}`, provider === 'claude' ? 'install Claude Code and run `claude` once to sign in' : 'install Codex CLI and run `codex login`');
  const claudeish = m => /^(sonnet|opus|haiku|claude)/i.test(String(m || '')), openaiish = m => /^(gpt|o\d|codex)/i.test(String(m || ''));
  const wrong = [model, pack_model].filter(m => m && (provider === 'codex' ? claudeish(m) : openaiish(m)));
  ok(!wrong.length, `models for ${provider}: ${model} / ${pack_model}`, `${wrong.join(', ')} is not a ${provider} model; set llm.model and llm.pack_model in settings.json`);
  ok(envSet('SETTINGS') || path.basename(SETTINGS_FILE) === 'settings.json', `settings: ${envSet('SETTINGS') ? SETTINGS_FILE : path.basename(SETTINGS_FILE)}`, 'copy settings.example.json to settings.json and edit it (the onboarding does this)');
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
  // \b only sees ASCII word edges in JavaScript, so "\bслово\b" never matches; patterns are not rewritten
  const cyr = [...lint.banned, ...lint.warn, ...PROFILE.factRules].filter(r => cyrillicBoundary(r.pattern)).map(r => r.id);
  if (cyr.length) warn(`\\b next to Cyrillic never matches a word edge: ${[...new Set(cyr)].join(', ')}`, 'use (?<!\\p{L}) and (?!\\p{L}) in lint rules, (?<![a-zа-яё]) and (?![a-zа-яё]) in fact rules');
  if (PROFILE.cvLibrary && lint.present) {
    const lib = lintLibrary(PROFILE.cvLibrary, lint);
    if (lint.banned.length) ok(!lib.errors.length, 'vetted CV text passes your lint rules', `vetted text breaks your own rule: ${lib.errors.map(b => `${b.item} (${b.id})`).join(', ')}; packs that use it are not built. Fix profile/cv-library.json or the rule`);
    // warnings on vetted text are reported here, once, not in every pack
    if (lib.warns.length) warn(`vetted CV text has ${lib.warns.length} lint warning(s): ${lib.warns.map(w => `${w.item} (${w.id}${w.id.endsWith('-length') ? `, ${w.match}` : ''})`).join(', ')}`);
  }
  ok(!ENV_PROBLEMS.length, '.env lines', `these lines are not KEY=value and were ignored: ${ENV_PROBLEMS.join(', ')}`);
  // an update's verify step sets COMETSCOUT_LLM_FAKE on purpose (with COMETSCOUT_LOCK_PARENT)
  ok(!ENV_IGNORED.length && (!envVar('LLM_FAKE') || !!envVar('LOCK_PARENT')), 'real model calls (no COMETSCOUT_LLM_FAKE)',
    ENV_IGNORED.length ? `${ENV_IGNORED.join(', ')} in .env is ignored (it is only for the update check and tests): remove the line` : 'unset COMETSCOUT_LLM_FAKE: with it every verdict is a canned answer');
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
  if (tg.enabled) ok(true, 'Telegram bot: node cli.mjs bot (/schedule, /time, /interview); node cli.mjs timer installs it as a service');
  // schedule (digest days and time) and picks.prep, checked like the settings writer checks them
  const sch = scheduleOf(), schProblems = scheduleProblems(), wd = weekdayNames('en'), prep = prepOf();
  const dayText = Array.isArray(sch.days) && sch.days.length === 7 ? 'every day' : (Array.isArray(sch.days) ? sch.days : []).map(d => wd[d - 1] ?? d).join(', ');
  ok(!schProblems.length, `digest schedule: ${dayText} at ${sch.time} (${SETTINGS.timezone || 'UTC'})${!schProblems.length && offDay(today()) ? '; today is an off day' : ''}`, schProblems.join('; '));
  if (sch.legacy) warn('run_time is read as schedule.time', `replace it with "schedule": { "days": [1, 2, 3, 4, 5, 6, 7], "time": "${sch.time}" } (saving in the workspace or the bot does this)`);
  ok(true, `interview prep: ${prep.days_before ? `${prep.days_before} day(s) before an interview, at most ${prep.max} pick(s)` : 'off (picks.prep.days_before is 0)'}`);
  const vendor = vendorCheck();
  ok(vendor.ok, `workspace modules: ${vendor.ok ? Object.entries(vendor.versions).map(([k, x]) => `${k} ${x}`).join(', ') : 'preact and htm not installed'}`, `run npm ci --omit=dev in ${CODE_DIR} (needed for node cli.mjs serve only)`);
  ok(localeOk(), `locale: ${SETTINGS.locale || 'en'}`, `unknown locale "${SETTINGS.locale}"; use one of ${LOCALES.join(', ')} (English is used meanwhile)`);
  ok(true, `health ping: ${SETTINGS.health?.ping_url ? 'set' : 'not set (optional: health.ping_url, so a run that never happens is noticed)'}`);
  if (SETTINGS.tracker_export?.enabled) { const o = SETTINGS.tracker_export.out || 'tracker/pipeline.json'; ok(true, `tracker export: ${path.isAbsolute(o) ? o : path.posix.join(path.basename(DATA), o.replace(/\\/g, '/'))}`); }
  if (SETTINGS.sources_report?.enabled) ok(true, `source scorecard: on, ${Object.keys(SETTINGS.sources_report.prices || {}).length} price(s)`);
  const so = ver(process.env.SOFFICE || SETTINGS.pack.soffice || 'soffice');
  ok(!!so || process.platform === 'win32', `PDF export: ${so ? 'LibreOffice' : process.platform === 'win32' ? 'Word (Windows)' : 'LibreOffice not found'}`, 'sudo apt install libreoffice-writer-nogui fonts-liberation');
  ok(!!spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version']).stdout, 'Python 3 (packs the DOCX files)', 'install python3');
  for (const b of backupDoctor()) if (b.level === 'warn') warn(b.text, b.fix); else ok(b.level === 'ok', b.text, b.fix);
  for (const c of coachDoctor()) ok(c.level === 'ok', c.text, c.fix);   // modules.coach (optional)
  for (const c of transcribeDoctor()) if (c.level === 'warn') warn(c.text); else ok(c.level === 'ok', c.text, c.fix);   // modules.transcribe (optional)
  for (const u of updateDoctor()) ok(u.level === 'ok', u.text, u.fix);   // app/releases and the update check (lib/update.mjs)
  // leftovers from before the rename to CometScout (lib/legacy-names.mjs): they still work, for a release or two
  for (const u of oldUnitsDoctor()) warn(u.text, u.fix);
  for (const x of oldEnvVars()) warn(`${x.old} is read as ${x.new}`, `rename it in ${fromEnvFile(x.old) ? '.env' : 'your environment (shell profile, systemd unit or hook)'}`);
  return items;
}

/** One printed line per item, the way `node cli.mjs doctor` has always printed them. */
export const doctorLine = i => (i.level === 'warn' ? `warn ${i.text}${i.fix ? `  ->  ${i.fix}` : ''}`
  : `${i.level === 'ok' ? 'ok  ' : 'TODO'} ${i.text}${i.level === 'todo' && i.fix ? `  ->  ${i.fix}` : ''}`);

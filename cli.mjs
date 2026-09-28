#!/usr/bin/env node
// jobpilot command line.
//   node cli.mjs run                 # the evening run: every enabled source, then decode + picks + digest, then packs
//   node cli.mjs sources|decode|pack|picks
//   node cli.mjs applied <company> [role words]   # record an application (picks stop showing it)
//   node cli.mjs status <company> <applied|interview|offer|rejected|skipped|closed> [role words] [--note "..."]
//                                    # add --manual to record a role that is not in the queue (it does not affect picks)
//   node cli.mjs list                # what is recorded
//   node cli.mjs doctor              # check the setup, one line per item
//   node cli.mjs timer [HH:MM]       # (re)install the daily timer from settings.json (run_time, timezone)
//   node cli.mjs reset --yes         # delete everything in data/ (queue, picks, packs, seen lists), e.g. after trying the example
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SETTINGS, SETTINGS_FILE, PROFILE, DATA, DIRS, STATE, ENV_PROBLEMS, readJson, secret, today } from './lib/config.mjs';
import { frontMatter, norm } from './lib/queue.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const node = (file, extra = []) => spawnSync(process.execPath, [path.join(ROOT, file), ...extra], { stdio: 'inherit' }).status;
const SOURCES = { ats_boards: 'sources/ats-boards.mjs', rtj: 'sources/rtj.mjs', linkedin_alerts: 'sources/linkedin-alerts.mjs' };
const APPS = STATE('applications.json');
const STATUSES = ['applied', 'interview', 'offer', 'rejected', 'skipped', 'closed'];

function runSources() { for (const [k, f] of Object.entries(SOURCES)) if (SETTINGS.sources[k]?.enabled) node(f); }

// One run at a time: the timer and a manual command must not decode the same files or write state twice.
function lock() {
  const f = STATE('run.lock');
  try { const pid = Number(fs.readFileSync(f, 'utf8')); if (pid && pid !== process.pid) { process.kill(pid, 0); return `another jobpilot run is in progress (pid ${pid}); try again when it finishes`; } } catch { /* no lock, or a stale one */ }
  fs.writeFileSync(f, String(process.pid)); process.on('exit', () => { try { fs.rmSync(f); } catch { /* already gone */ } });
  return null;
}

function findRole(company, words) {
  const c = norm(company), w = norm(words || '').split(' ').filter(Boolean);
  const all = [];
  for (const dir of ['decoded', 'rejected', 'inbox']) for (const f of fs.readdirSync(DIRS[dir])) {
    if (!f.endsWith('.md')) continue; const fm = frontMatter(fs.readFileSync(path.join(DIRS[dir], f), 'utf8').replace(/\r\n/g, '\n'));
    if (norm(fm.company).includes(c)) all.push({ file: f, company: fm.company, role: fm.role });
  }
  const exact = all.filter(h => norm(h.company) === c);              // "Ready" must not also pick "Readymade"
  const atCompany = exact.length ? exact : all;
  const roleWords = h => norm(h.role).split(' ');
  return { atCompany, hits: w.length ? atCompany.filter(h => w.every(x => roleWords(h).some(r => r.startsWith(x)))) : atCompany };
}
function setStatus(company, status, words, note, manual) {
  if (!company) { console.log('Say which company: node cli.mjs applied <company> [role words]'); return 1; }
  if (!STATUSES.includes(status)) { console.log(`Unknown status "${status ?? ''}". Use one of: ${STATUSES.join(', ')}`); return 1; }
  const { atCompany, hits } = findRole(company, words); const apps = readJson(APPS, {});
  if (hits.length > 1) { console.log(`Several roles match; add role words:\n${hits.map(h => `  ${h.company}: ${h.role}`).join('\n')}`); return 1; }
  if (!hits.length && !manual) {
    console.log(atCompany.length ? `No role at "${company}" matches "${words}". Roles there:\n${atCompany.map(h => `  ${h.company}: ${h.role}`).join('\n')}`
      : `"${company}" is not in the queue. Add --manual to record it anyway (it will not affect picks).`);
    return 1;
  }
  const key = hits[0]?.file || `manual:${norm(company)}|${norm(words)}`;
  apps[key] = { company: hits[0]?.company || company, role: hits[0]?.role || words || '', status, updated: today(), ...(note ? { note } : {}) };
  fs.writeFileSync(APPS, JSON.stringify(apps, null, 1)); console.log(`${apps[key].company}: ${apps[key].role || '(role not given)'} -> ${status}${hits.length ? '' : ' (manual record)'}`); return 0;
}

function timer(at) {
  const time = at || SETTINGS.run_time || '18:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { console.log(`Time must be HH:MM, got "${time}"`); return 1; }
  let tz = SETTINGS.timezone || ''; try { if (tz) new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { console.log(`Unknown timezone "${tz}" in settings.json; using the server's own`); tz = ''; }
  const dir = path.join(os.homedir(), '.config', 'systemd', 'user'); fs.mkdirSync(dir, { recursive: true });
  const envPath = `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
  fs.writeFileSync(path.join(dir, 'jobpilot.service'), `[Unit]\nDescription=jobpilot evening run: sources, decode, picks, application packs\n[Service]\nType=oneshot\nWorkingDirectory=${ROOT}\n` +
    `# systemd user units get a minimal PATH; keep the one that finds claude/codex (~/.local/bin, npm globals)\nEnvironment="PATH=${envPath}"\nExecStart=${process.execPath} ${path.join(ROOT, 'cli.mjs')} run\nTimeoutStartSec=2h\n`);
  fs.writeFileSync(path.join(dir, 'jobpilot.timer'), `[Unit]\nDescription=Run jobpilot every evening\n[Timer]\nOnCalendar=*-*-* ${time}:00${tz ? ` ${tz}` : ''}\nPersistent=true\n[Install]\nWantedBy=timers.target\n`);
  for (const a of [['daemon-reload'], ['enable', '--now', 'jobpilot.timer']]) spawnSync('systemctl', ['--user', ...a], { stdio: 'inherit' });
  spawnSync('systemctl', ['--user', 'list-timers', 'jobpilot.timer', '--no-pager'], { stdio: 'inherit' });
  return 0;
}

function doctor() {
  const ok = (good, text, fix = '') => console.log(`${good ? 'ok  ' : 'TODO'} ${text}${!good && fix ? `  ->  ${fix}` : ''}`);
  const ver = bin => { const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? (r.stdout || '').trim().split('\n')[0] : null; };
  ok(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node}`, 'install Node 20 or newer');
  const { provider, model, pack_model } = SETTINGS.llm; const llm = SETTINGS.llm.bin || provider; const v = ver(llm);
  ok(!!v, `${provider} CLI${v ? `: ${v}` : ' not found'}`, provider === 'claude' ? 'install Claude Code and run `claude` once to sign in' : 'install Codex CLI and run `codex login`');
  const claudeish = m => /^(sonnet|opus|haiku|claude)/i.test(String(m || '')), openaiish = m => /^(gpt|o\d|codex)/i.test(String(m || ''));
  const wrong = [model, pack_model].filter(m => m && (provider === 'codex' ? claudeish(m) : openaiish(m)));
  ok(!wrong.length, `models for ${provider}: ${model} / ${pack_model}`, `${wrong.join(', ')} is not a ${provider} model; set llm.model and llm.pack_model in settings.json`);
  ok(path.basename(SETTINGS_FILE) === 'settings.json', `settings: ${path.basename(SETTINGS_FILE)}`, 'copy settings.example.json to settings.json and edit it (the onboarding does this)');
  ok(!PROFILE.isExample, `profile: ${path.basename(PROFILE.dir)}`, 'create profile/ with your own facts (the onboarding does this); the evening run waits until then');
  ok(PROFILE.facts.trim().length > 200, `profile.md: ${PROFILE.facts.trim().length} characters`, 'profile/profile.md is missing or nearly empty; every decode would run without your facts');
  ok(!!PROFILE.cvLibrary, 'CV library (profile/cv-library.json)', 'needed for application packs');
  ok(!PROFILE.ruleErrors.length, `fact rules: ${PROFILE.factRules.length} loaded`, `broken rule(s) skipped: ${PROFILE.ruleErrors.join('; ')}`);
  ok(!ENV_PROBLEMS.length, '.env lines', `these lines are not KEY=value and were ignored: ${ENV_PROBLEMS.join(', ')}`);
  const enabled = Object.keys(SOURCES).filter(k => SETTINGS.sources[k]?.enabled);
  ok(enabled.length > 0, `sources enabled: ${enabled.join(', ') || 'none'}`, 'enable at least one source in settings.json');
  const unknown = Object.keys(SETTINGS.sources).filter(k => !SOURCES[k]);
  ok(!unknown.length, 'source names in settings.json', `unknown source(s) ignored: ${unknown.join(', ')} (known: ${Object.keys(SOURCES).join(', ')})`);
  if (SETTINGS.sources.rtj?.enabled) ok(!!secret(SETTINGS.sources.rtj.token_env || 'RTJ_API_TOKEN'), 'RealtimeJobs token in .env', 'add RTJ_API_TOKEN=... to .env');
  if (SETTINGS.sources.linkedin_alerts?.enabled) ok(['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].every(k => secret(k)), 'Gmail read-only access (LinkedIn alerts)', 'add GMAIL_CLIENT_ID/SECRET to .env, then run `node tools/gmail-auth.mjs`');
  const tg = SETTINGS.delivery.telegram;
  ok(!tg.enabled || (secret(tg.token_env) && secret(tg.chat_id_env)), `Telegram delivery: ${tg.enabled ? 'on' : 'off (digest is written to data/digests only)'}`, 'add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env');
  const so = ver(process.env.SOFFICE || SETTINGS.pack.soffice || 'soffice');
  ok(!!so || process.platform === 'win32', `PDF export: ${so ? 'LibreOffice' : process.platform === 'win32' ? 'Word (Windows)' : 'LibreOffice not found'}`, 'sudo apt install libreoffice-writer-nogui fonts-liberation');
  ok(!!spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version']).stdout, 'Python 3 (packs the DOCX files)', 'install python3');
}

const locked = fn => () => { const busy = lock(); if (busy) { console.log(busy); return 1; } return fn(); };
const codes = {
  run: locked(() => {
    // The timer is installed before onboarding; never spend the subscription decoding real jobs for the example person.
    if (PROFILE.isExample && !rest.includes('--example')) { console.log('jobpilot: no profile/ yet, so the evening run is skipped. Finish the onboarding (or run with --example to try it on the example profile).'); return 0; }
    process.env.JOBPILOT_RUN_DATE = today();          // one date for every step, even if the run crosses midnight
    runSources(); node('decoder/decoder.mjs'); if (SETTINGS.pack.enabled) node('pack/pack.mjs'); return 0;
  }),
  sources: locked(() => { runSources(); return 0; }),
  decode: locked(() => node('decoder/decoder.mjs', rest)),
  picks: () => node('decoder/decoder.mjs', ['--picks']),
  pack: locked(() => node('pack/pack.mjs', rest)),
  applied: () => { const m = rest.includes('--manual'); const r = rest.filter(x => x !== '--manual'); return setStatus(r[0], 'applied', r.slice(1).join(' '), '', m); },
  status: () => {
    const m = rest.includes('--manual'); const r0 = rest.filter(x => x !== '--manual');
    const i = r0.indexOf('--note'); const note = i >= 0 ? r0.slice(i + 1).join(' ') : ''; const r = i >= 0 ? r0.slice(0, i) : r0;
    return setStatus(r[0], r[1], r.slice(2).join(' '), note, m);
  },
  list: () => { for (const a of Object.values(readJson(APPS, {}))) console.log(`${a.updated || '?'}  ${String(a.status || '?').padEnd(9)} ${a.company}: ${a.role}`); return 0; },
  doctor: () => { doctor(); return 0; },
  timer: () => timer(rest[0]),
  reset: locked(() => {
    if (!rest.includes('--yes')) { console.log(`This deletes everything in ${DATA} (queue, decodes, picks, packs, seen lists, applications). Run again with --yes to confirm.`); return 1; }
    for (const d of Object.values(DIRS)) for (const f of fs.readdirSync(d)) if (f !== 'run.lock') fs.rmSync(path.join(d, f), { recursive: true, force: true });
    console.log(`Cleared ${DATA}.`); return 0;
  }),
};
if (!codes[cmd]) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n')); process.exit(cmd ? 1 : 0); }
process.exitCode = codes[cmd]() || 0;

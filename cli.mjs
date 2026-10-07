#!/usr/bin/env node
// CometScout command line: node cli.mjs <command>, or cometscout <command> once `npm link` has put it on the PATH.
//   node cli.mjs help                # this list (also --help)
//   node cli.mjs run                 # the evening run: every enabled source (and outcomes from Gmail), then decode + picks + digest, then packs
//   node cli.mjs sources|decode|pack|picks
//   node cli.mjs applied <company> [role words]   # record an application (picks stop showing it)
//   node cli.mjs status <company> <applied|screen|interview|offer|accepted|rejected|skipped|closed> [role words] [--note "..."]
//                                    # add --manual to record a role that is not in the queue (it does not affect picks)
//   node cli.mjs list                # what is recorded
//   node cli.mjs doctor [--json]     # check the setup, one line per item (--json: the items as JSON)
//   node cli.mjs timer [HH:MM] [--keep-old-units]  # (re)install the daily timer from settings.json (schedule.time, timezone); with Telegram on, also the bot unit; removes the units from before the rename unless --keep-old-units
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
//   node cli.mjs serve --check                               # start it on a free port, ask it for the page and today's data, stop (the update's check)
//   node cli.mjs coach-handoff [--out <file>]                # profile, CV, voice and applications for the interview coach's kickoff
//                                    # (default: materials/cometscout-handoff.md in the coach's folder; the run refreshes it when modules.coach.enabled)
//   node cli.mjs interview <company> <YYYY-MM-DD> [HH:MM] [role words] [--round "..."] [--manual]
//                                    # record a booked interview (time in settings.timezone); prep mode uses it
//   node cli.mjs transcribe <file> | --queue                 # speech to text on this machine's CPU (optional module, README: Transcription)
//   node cli.mjs transcribe --bench <file> [--models small,medium] [--threads N]   # time, real-time factor and memory per model
//   node cli.mjs mcp [--scope read|operate|admin]   # the MCP server on stdio for an AI client (README: Use it from an AI client)
//   node cli.mjs bot                 # the Telegram bot: /schedule, /time, /interview, /update, /help (cli.mjs timer installs it as a service)
//   node cli.mjs update [--to vX.Y.Z]                        # back up, install side by side, migrate, switch, verify; rolls back by itself on failure
//   node cli.mjs update --check | --tonight [vX.Y.Z] | --skip vX.Y.Z   # ask GitHub now; install after tonight's run; never offer this version again
//   node cli.mjs update --adopt [--no-units] [--keep-old-units]         # move a git-clone install's code into app/releases (once)
//   node cli.mjs update --to vX.Y.Z --from-zip <zip> --sha256 <hex>     # test hook (tools/rehearse): a local source zip instead of GitHub's
//   node cli.mjs rollback [--to vX.Y.Z] [--restore-data [--yes]]        # switch the code back; --restore-data also restores the pre-update backup
//   node cli.mjs migrate [--dry-run]                         # apply this version's data migrations (an update runs it)
//   node cli.mjs evals sample --set <name> [--size 70] [--from D] [--to D] [--seed N] [--include <file>]   # a label set (label it at /label?set=<name>)
//   node cli.mjs evals decode --set <name> [--system queue|replay|file:<path>] [--compare <system>]      # verdicts against your labels
//   node cli.mjs evals pack --a <dir> --b <dir> [--judge-model m] | evals voice --dir <packs> | evals sets   # blind pack A/B, voice, sets
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, SETTINGS, PROFILE, DATA, DIRS, STATE, readJson, today } from './lib/config.mjs';
import { readApplications } from './lib/queue.mjs';
import { setStatus as recordStatus, addInterview } from './lib/applications.mjs';
import { runBot } from './lib/bot.mjs';
import { runHook } from './lib/hooks.mjs';
import { archiveCommands } from './lib/archive-cli.mjs';
import { nightlyBackup } from './lib/backup.mjs';
import { trackerExport, exportNotes } from './lib/tracker.mjs';
import { sourcesReport, sourcesReportCommand } from './lib/scorecard.mjs';
import { trimSightings } from './lib/sightings.mjs';
import { healthPing, notify, installTimer, UNITS } from './lib/ops.mjs';
import { scheduleOf, offDay } from './lib/schedule.mjs';
import { sendText, telegramOn } from './lib/telegram.mjs';
import { startServer } from './lib/server.mjs';
import { takeLock } from './lib/lock.mjs';
import { coachHandoff, refreshHandoff } from './lib/coach.mjs';
import { transcribeCommand, transcribeSettings, scanInbox, kickQueue, installed as transcribeInstalled } from './lib/transcribe.mjs';
import { updateCommands } from './lib/update-cli.mjs';
import { afterRun as updateAfterRun } from './lib/update.mjs';
import { evalsCommand } from './evals/cli.mjs';
import { doctorItems, doctorLine } from './lib/doctor.mjs';
import { SOURCES } from './lib/settings-schema.mjs';
import { queueSnapshot, runCounts, recordRun } from './lib/run-log.mjs';
import { mcpCommand } from './lib/mcp.mjs';

const [cmd, ...rest] = process.argv.slice(2);
// Steps are scripts next to this file; ROOT (COMETSCOUT_HOME) is where profile/ and settings live, which may be elsewhere.
const CODE = path.dirname(fileURLToPath(import.meta.url));
const node = (file, extra = []) => spawnSync(process.execPath, [path.join(CODE, file), ...extra], { stdio: 'inherit' }).status;
// A git clone that is its own home and has moved its code to app/releases (cli.mjs update --adopt) hands every command
// to app/current, so "node cli.mjs ..." in the home always runs the active release; --adopt itself runs here.
{
  const active = path.join(ROOT, 'app', 'current', 'cli.mjs'), real = p => { try { return fs.realpathSync(p); } catch { return null; } };
  if (real(CODE) === real(ROOT) && real(active) && real(active) !== real(fileURLToPath(import.meta.url)) && !(cmd === 'update' && rest.includes('--adopt'))) {
    process.stderr.write(`cometscout: running the installed release (${real(active)}); git pull here no longer changes it, use node cli.mjs update\n`);
    const r = spawnSync(process.execPath, [active, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}
// outcomes reads application results from Gmail; it runs with the sources, so the decoder already knows what closed
// career_ops: reads a career-ops checkout, never writes to it
// hh_alerts: hh.ru alert emails (Gmail + the public vacancy page); hirify: saved filters, read with the user's session cookie
// (the table is SOURCES in lib/settings-schema.mjs, with every setting the MCP server can explain)
const APPS = STATE('applications.json');

// A source that exits non-zero is logged by name and listed in the run's result (the closing log line and run_done's
// sources_failed), so a dead source is never silent. Exit 3 means it cannot work until the user acts (an expired
// login): the run still decodes and packs what it has, then exits 3 too, so the timer's status and health alerts
// show it. Other exit codes do not change the run's own exit code.
const NEEDS_USER = 3;
// A broken applications.json would make every source stop half-way; check it once, before any source runs.
function appsBroken() {
  try { readApplications(APPS); return null; } catch (e) { return `cometscout: ${e.message}`; }
}
// results (optional) collects every source's { source, exit }, for the run log (lib/run-log.mjs).
function runSources(results = []) {
  const failed = [];
  for (const [k, f] of Object.entries(SOURCES)) {
    if (!SETTINGS.sources[k]?.enabled) continue;
    const exit = node(f);
    results.push({ source: k, exit });
    if (exit === 0) continue;
    failed.push({ source: k, exit });
    console.log(`cometscout: source ${k} failed (exit ${exit ?? 'none, it was killed'})${exit === NEEDS_USER ? '; it needs you, see the message above' : ''}`);
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

function timer(...a) {
  const keepOld = a.includes('--keep-old-units'), at = a.find(x => x && !x.startsWith('--'));
  const r = installTimer({ time: at || scheduleOf().time, keepOld });
  for (const l of r.lines) console.log(l);
  if (!r.code) spawnSync('systemctl', ['--user', 'list-timers', UNITS.timer, '--no-pager'], { stdio: 'inherit' });
  return r.code;
}

async function optional(name, fn) {
  // a step after the digest: a failure is logged, the run's exit code stays
  try { await fn(); } catch (e) { console.log(`cometscout: ${name} failed: ${e.message}`); }
}
async function evening() {
  // The timer is installed before onboarding; never spend the subscription decoding real jobs for the example person.
  if (PROFILE.isExample && !rest.includes('--example')) { console.log('cometscout: no profile/ yet, so the evening run is skipped. Finish the onboarding (or run with --example to try it on the example profile).'); return 0; }
  process.env.COMETSCOUT_RUN_DATE = today();          // one date for every step, even if the run crosses midnight
  // An off day (not in schedule.days) still collects and decodes, but the steps send nothing and show no picks
  // (decoder/decoder.mjs finishRun, sources/outcomes.mjs); failure and backup alerts still go out.
  process.env.COMETSCOUT_EVENING = '1'; const off = offDay(today());
  if (off) console.log(`cometscout: ${today()} is an off day (schedule.days); sources and decode run, nothing is sent`);
  const broken = appsBroken(); if (broken) { console.log(broken); return 2; }
  const t0 = Date.now(), started = new Date().toISOString(), before = queueSnapshot(); runHook('before_run', { date: today() });
  await optional('sightings trim', () => trimSightings());   // here only, before any source writes: no two writers race
  const ran = [], failed = runSources(ran); const decoder = node('decoder/decoder.mjs');
  if (SETTINGS.sources_report?.enabled) await optional('sources-report', () => sourcesReport({ send: off ? null : sendText, print: () => {} }));
  const packStart = new Date().toISOString(); const pack = SETTINGS.pack.enabled ? node('pack/pack.mjs') : null;
  const refused = refusedSince(packStart);   // packs refused in this run (vetted CV text breaks a lint rule); not a failure
  if (SETTINGS.modules?.coach?.enabled && !PROFILE.isExample) await optional('coach-handoff', () => refreshHandoff());   // the interview coach's snapshot; no network
  // audio left in the transcription inbox (a file that landed as the last job finished) gets its queue started; no wait
  const tr = transcribeSettings();
  if (tr.enabled && transcribeInstalled(tr)) await optional('transcribe', () => { if (scanInbox(tr).ready.length) console.log(`transcribe: audio waiting in the inbox; queue started (${kickQueue()})`); });
  if (SETTINGS.tracker_export?.enabled) await optional('tracker-export', () => { const r = trackerExport(); for (const l of [...exportNotes(r), r.message]) console.log(`tracker-export: ${l}`); });
  runHook('run_done', { date: today(), seconds: Math.round((Date.now() - t0) / 1000), decoder_exit: decoder, pack_exit: pack, sources_failed: failed, refused });
  const closing = [...(failed.length ? [`failed source(s): ${failedLine(failed)}`] : []), ...(refused.length ? [`refused pack(s): ${refusedLine(refused)}`] : [])];
  if (closing.length) console.log(`cometscout: run finished; ${closing.join('; ')}`);
  const exit = failed.some(f => f.exit === NEEDS_USER) ? NEEDS_USER : 0;
  // data/state/runs.jsonl: what the MCP server's status and run_log tools report; never fails the run
  await optional('run log', () => recordRun({ date: today(), started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), exit, off_day: off,
    sources: ran, decoder_exit: decoder, pack_exit: pack, refused, counts: runCounts(before, today()) }));
  await nightlyBackup({ alert: text => notify(text, { send: sendText, on: telegramOn }) });   // backup.nightly; never fails the run
  // the update check (settings.update); a newer version is announced once, a Tonight update starts after this run; never fails the run
  if (!PROFILE.isExample) await updateAfterRun({ quiet: off });
  return exit;
}

// The workspace (lib/server.mjs). Loopback only until sign-in exists; --unsafe-no-auth is the explicit way around it.
async function serve() {
  // a flag given without a value ("--port" last, or followed by another flag) is an error, never the default
  const opt = n => { const i = rest.indexOf(`--${n}`); if (i < 0) return undefined; const v = rest[i + 1]; return v === undefined || v.startsWith('--') ? '' : v; };
  if (rest.includes('--check')) return serveCheck();
  const port = opt('port') ?? '8787', host = opt('host') ?? '127.0.0.1', unsafeNoAuth = rest.includes('--unsafe-no-auth');
  if (port === '') { console.log('--port needs a number, e.g. --port 8787'); return 1; }
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) { console.log(`--port must be a number from 0 to 65535, got "${port}"`); return 1; }
  if (host === '') { console.log('--host needs an address, e.g. --host 127.0.0.1'); return 1; }
  let s; try { s = await startServer({ host, port: Number(port), unsafeNoAuth }); } catch (e) { console.log(`cometscout serve: ${e.code === 'EADDRINUSE' ? `port ${port} is in use; try --port ${Number(port) + 1}` : e.message}`); return 1; }
  if (unsafeNoAuth) console.log(`WARNING: --unsafe-no-auth: the workspace has no sign-in; anyone who can reach ${host}:${s.port} can read your queue and packs and record statuses.`);
  console.log(`cometscout workspace: ${s.url}  (data: ${DATA}; Ctrl+C stops it)`);
  const stop = () => { s.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise(() => {});
}

/** serve --check: the workspace starts, answers the page and /api/today, and stops. */
async function serveCheck() {
  let s; try { s = await startServer({ host: '127.0.0.1', port: 0, log: () => {} }); } catch (e) { console.log(`serve --check: ${e.message}`); return 1; }
  try {
    for (const p of ['', 'api/today', 'api/labels']) {
      const r = await fetch(s.url + p, { signal: AbortSignal.timeout(20000) });
      if (r.status !== 200) { console.log(`serve --check: /${p} answered ${r.status}: ${(await r.text()).slice(0, 200)}`); return 1; }
      await r.arrayBuffer();
    }
    console.log('serve --check: the workspace answers'); return 0;
  } catch (e) { console.log(`serve --check: ${e.message}`); return 1; } finally { await s.close(); }
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
  doctor: () => { const items = doctorItems(); if (rest.includes('--json')) console.log(JSON.stringify(items)); else for (const i of items) console.log(doctorLine(i)); return 0; },
  timer: () => timer(...rest),
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
  interview: () => {
    const usage = 'Usage: node cli.mjs interview <company> <YYYY-MM-DD> [HH:MM] [role words] [--round "..."] [--manual]';
    const manual = rest.includes('--manual'); let r = rest.filter(x => x !== '--manual'), round = '';
    const i = r.indexOf('--round');
    if (i >= 0) { if (!r[i + 1] || r[i + 1].startsWith('--')) { console.log(usage); return 1; } round = r[i + 1]; r = [...r.slice(0, i), ...r.slice(i + 2)]; }
    const [company, date, ...more] = r;
    if (!company || !date) { console.log(usage); return 1; }
    const time = /^\d{1,2}:\d{2}$/.test(more[0] || '') ? more.shift() : '';
    const res = addInterview({ company, date, time, words: more.join(' '), round, manual, source: 'cli' });
    for (const l of res.lines) console.log(l);
    return res.code;
  },
  bot: () => runBot(),
  mcp: () => mcpCommand(rest),
  transcribe: () => transcribeCommand(rest),
  evals: () => evalsCommand(rest),
  'coach-handoff': () => {
    const i = rest.indexOf('--out'); if (i >= 0 && (!rest[i + 1] || rest[i + 1].startsWith('--'))) { console.log('Usage: node cli.mjs coach-handoff [--out <file>]'); return 1; }
    return coachHandoff({ out: i >= 0 ? rest[i + 1] : undefined });
  },
  ...archiveCommands({ rest, locked }),
  ...updateCommands({ rest, locked }),
};
const help = !cmd || ['help', '--help', '-h'].includes(cmd);
if (help || !codes[cmd]) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n')); process.exit(help ? 0 : 1); }
process.exitCode = (await codes[cmd]()) || 0;

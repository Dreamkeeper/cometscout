// Running CometScout unattended: the health ping after each run, the failure alert message, and the systemd units.
// settings.health = { ping_url: "https://hc-ping.com/<uuid>" }   // healthchecks.io style; the URL is a secret
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, SETTINGS, STATE, log } from './config.mjs';
import { scheduleOf, TIME_RE, nextRunLine } from './schedule.mjs';
import { telegramOn } from './telegram.mjs';
import { OLD_UNITS_TO_STOP, oldUnitsIn } from './legacy-names.mjs';
import { unitCode } from './layout.mjs';
import { transcribeSettings, transcribeUnitFiles, UNIT_PATH as TRANSCRIBE_PATH_UNIT, UNIT_SERVICE as TRANSCRIBE_SERVICE } from './transcribe.mjs';

/**
 * GET <ping_url> after a run that exited 0, <ping_url>/<exit code> otherwise. 10 s timeout. Never throws and never
 * logs the URL. Returns 'sent', 'off' or 'failed'.
 */
export async function healthPing(exitCode, { url = SETTINGS.health?.ping_url, fetch = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!url) return 'off';
  const target = exitCode ? `${String(url).replace(/\/+$/, '')}/${exitCode}` : String(url);
  try {
    const r = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) { log(`health ping failed: HTTP ${r.status}`); return 'failed'; }
    log(`health ping sent (exit ${exitCode || 0})`);
    return 'sent';
  } catch (e) {
    log(`health ping failed: ${e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : 'network error'}`);
    return 'failed';
  }
}

/** One Telegram message. Delivery off is not an error: it is logged and counts as done. Returns the exit code. */
export async function notify(text, { send, on }) {
  const msg = String(text || '').trim();
  if (!msg) { console.log('Usage: node cli.mjs notify <text>'); return 1; }
  if (!on()) { log(`notify: Telegram delivery is off, not sent: ${msg}`); return 0; }
  try { await send(msg); log('notify: sent'); return 0; } catch (e) { log(`notify: Telegram failed: ${e.message}`); return 1; }
}

export const UNITS = { run: 'cometscout.service', timer: 'cometscout.timer', failure: 'cometscout-failure@.service', bot: 'cometscout-bot.service' };
const FAILURE_TEMPLATE = new URL('../deploy/cometscout-failure@.service', import.meta.url);
/**
 * The systemd user units for the daily run: { 'cometscout.service', 'cometscout.timer', 'cometscout-failure@.service' },
 * plus 'cometscout-bot.service' (cli.mjs bot, always running) when bot is true, and 'cometscout-transcribe.path' with its
 * service when transcribe is { inbox } (the transcription module is enabled: a file in the inbox starts the queue).
 * The run unit names the failure template in OnFailure=, so a failed run sends a Telegram alert.
 * Paths in the units use "/" on every platform: systemd reads them on Linux, and the tests also run on Windows.
 */
export function unitFiles({ root, code = root, node, time, tz = '', envPath, bot = false, transcribe = null, persistent = false }) {
  // root is COMETSCOUT_HOME (settings, profile, data); code is where cli.mjs lives. They differ when COMETSCOUT_HOME is set.
  const home = code === root ? '' : `Environment="COMETSCOUT_HOME=${root}"\n`;
  return {
    [UNITS.run]: `[Unit]\nDescription=CometScout evening run: sources, decode, picks, application packs\nOnFailure=cometscout-failure@%n.service\n[Service]\nType=oneshot\nWorkingDirectory=${root}\n` +
      `# systemd user units get a minimal PATH; keep the one that finds claude/codex (~/.local/bin, npm globals)\nEnvironment="PATH=${envPath}"\n${home}ExecStart=${node} ${code}/cli.mjs run\nTimeoutStartSec=2h\n`,
    // Persistent (a run missed while the server was off is caught up when it starts) only once an evening run has
    // happened (timerPlan); installTimer also resets the timer's stamp, so installing or changing it never starts a run
    [UNITS.timer]: `[Unit]\nDescription=Run CometScout every evening\n[Timer]\nOnCalendar=*-*-* ${time}:00${tz ? ` ${tz}` : ''}\n${persistent ? 'Persistent=true\n' : ''}[Install]\nWantedBy=timers.target\n`,
    [UNITS.failure]: fs.readFileSync(FAILURE_TEMPLATE, 'utf8').replaceAll('@ROOT@', root).replaceAll('@CODE@', code).replaceAll('@NODE@', node).replace('[Service]\n', `[Service]\n${home}`),
    ...(bot ? { [UNITS.bot]: `[Unit]\nDescription=CometScout Telegram bot: /schedule, /time, /interview\nAfter=network-online.target\n[Service]\nType=simple\nWorkingDirectory=${root}\n` +
      `Environment="PATH=${envPath}"\n${home}ExecStart=${node} ${code}/cli.mjs bot\nRestart=on-failure\nRestartSec=30\n[Install]\nWantedBy=default.target\n` } : {}),
    ...(transcribe ? transcribeUnitFiles({ root, code, node, envPath, inbox: transcribe.inbox, home }) : {}),
  };
}

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** True on a host where systemd user units can be installed (Linux with systemd running). */
export const systemdHost = () => process.platform === 'linux' && fs.existsSync('/run/systemd/system');
export const unitDir = () => path.join(os.homedir(), '.config', 'systemd', 'user');
/**
 * Units from before the rename (lib/legacy-names.mjs). Called only after the new units are enabled, so a failure here
 * never leaves the user without a timer. The old timer is stopped and disabled (a run already going is left to finish),
 * the files and .wants links removed, and the old bot stopped last with --no-block: this code may be running inside it
 * (/time from the bot), and a blocking stop would kill the call before it finishes. Returns the names removed.
 */
export function removeOldUnits({ dir = unitDir(), run = spawnSync, stdio = 'inherit' } = {}) {
  const found = oldUnitsIn(dir); if (!found.length) return [];
  const sc = (...a) => run('systemctl', ['--user', ...a], { stdio });
  const [oldTimer, oldBot] = OLD_UNITS_TO_STOP;
  if (found.includes(oldTimer)) { sc('stop', oldTimer); sc('disable', oldTimer); }
  if (found.includes(oldBot)) sc('disable', oldBot);
  for (const u of found) fs.rmSync(path.join(dir, u), { force: true });
  for (const w of fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.endsWith('.wants'))) for (const u of found) fs.rmSync(path.join(dir, w.name, u), { force: true });
  sc('daemon-reload');
  if (found.includes(oldBot)) sc('stop', '--no-block', oldBot);
  return found;
}
/** doctor lines for units from before the rename that are still installed. */
export function oldUnitsDoctor({ dir = unitDir() } = {}) {
  const found = fs.existsSync(dir) ? oldUnitsIn(dir) : [];
  return found.length ? [{ level: 'warn', text: `old systemd units still installed: ${found.join(', ')}`, fix: 'node cli.mjs timer installs the CometScout units and removes these' }] : [];
}
/** PATH for the units: ~/.local/bin (where Claude Code installs itself) first, then this shell's PATH, each folder once. */
export function unitPath(envPath = process.env.PATH, home = os.homedir()) {
  const dirs = [path.posix.join(home.split(path.sep).join('/'), '.local', 'bin'), ...String(envPath || '/usr/local/bin:/usr/bin:/bin').split(':')].filter(Boolean);
  return [...new Set(dirs)].join(':');
}
/** systemd keeps a persistent timer's last trigger in this file (its modification time). */
export const stampFile = (env = process.env, home = os.homedir()) => path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'systemd', 'timers', `stamp-${UNITS.timer}`);
/**
 * How the timer is installed. Installing or changing it never starts a run: the next run is the next scheduled time.
 * Persistent=true (a run missed while the server was off is caught up when it starts) only once an evening run has
 * happened (data/state/runs.jsonl has one); even then the stamp is reset to now before the timer starts, so the
 * catch-up can only follow a scheduled time missed after this install. { persistent, resetStamp }
 */
export function timerPlan({ ranBefore }) {
  return { persistent: !!ranBefore, resetStamp: !!ranBefore };
}
const runsRecorded = () => { try { return fs.readFileSync(STATE('runs.jsonl'), 'utf8').trim().length > 0; } catch { return false; } };
/**
 * After an evening run (cli.mjs run): a timer installed before any run has no Persistent=, so it would never catch up
 * a missed run. Once runs.jsonl has a line, Persistent=true goes into the installed timer unit (in the place unitFiles
 * puts it) and systemd reloads it; the timer is not stopped or started, so this starts no run. Returns a line to log,
 * or null when there is nothing to do (no systemd, no timer, already persistent, no run recorded yet).
 */
export function ensurePersistent({ dir = unitDir(), run = spawnSync, systemd = systemdHost(), ranBefore = runsRecorded() } = {}) {
  const file = path.join(dir, UNITS.timer);
  if (!systemd || !ranBefore || !fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  if (/^Persistent=/m.test(text) || !/^OnCalendar=.*$/m.test(text)) return null;
  const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, text.replace(/^(OnCalendar=.*)$/m, '$1\nPersistent=true')); fs.renameSync(tmp, file);
  const r = run('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  return r && (r.error || r.status) ? `timer: Persistent=true written to ${file}, but systemctl --user daemon-reload failed; node cli.mjs timer loads it` : 'timer: an evening run has happened, so a run missed while the server is off is now caught up when it starts (Persistent=true)';
}

/**
 * (Re)install the units at `time` (default schedule.time) in settings.timezone and enable the timer, and the bot
 * when Telegram delivery is on. Old units from before the rename are removed only after the new timer is enabled
 * (removeOldUnits), and never with keepOld (install.sh in a new folder while an old install still runs). The timer is
 * stopped first and started again with its stamp reset (timerPlan), so this never starts a run. dryRun writes and
 * runs nothing and says what it would do. run is spawnSync, dir the unit folder, stamp the stamp file and ranBefore
 * whether an evening run has happened, injected by tests. Returns { code, time, lines }.
 */
export function installTimer({ time = scheduleOf().time, tz = SETTINGS.timezone || '', bot = !!telegramOn(), transcribe = transcribeSettings(), run = spawnSync, dir = unitDir(), stdio = 'inherit', keepOld = false,
  dryRun = false, stamp = stampFile(), ranBefore = runsRecorded(), now = new Date() } = {}) {
  if (!TIME_RE.test(String(time))) return { code: 1, time, lines: [`Time must be HH:MM, got "${time}"`] };
  const lines = [];
  try { if (tz) new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { lines.push(`Unknown timezone "${tz}" in settings.json; using the server's own`); tz = ''; }
  const plan = timerPlan({ ranBefore }), next = nextRunLine({ ...SETTINGS, timezone: tz }, now, time);
  if (dryRun) {
    lines.push(`Dry run: would install the daily timer at ${time}${tz ? ` ${tz}` : ''}${bot ? ' and the Telegram bot unit' : ''}; nothing written. Installing it never starts a run.`, next);
    return { code: 0, time, lines };
  }
  fs.mkdirSync(dir, { recursive: true });
  const envPath = unitPath();
  // cometscout.service names cometscout-failure@.service in OnFailure=, so a failed run sends a Telegram alert (cli.mjs notify)
  // a release in app/releases runs as app/current, so switching versions is a link swap (lib/layout.mjs)
  const tr = transcribe?.enabled ? transcribe : null;
  for (const [name, text] of Object.entries(unitFiles({ root: ROOT, code: unitCode(CODE, ROOT), node: process.execPath, time, tz, envPath, bot, transcribe: tr, persistent: plan.persistent }))) fs.writeFileSync(path.join(dir, name), text);
  if (tr) fs.mkdirSync(tr.inbox, { recursive: true });
  // the module turned off: its watcher goes (the queue service only runs when the watcher or a kick starts it)
  const trOff = !tr && fs.existsSync(path.join(dir, TRANSCRIBE_PATH_UNIT));
  if (trOff) { run('systemctl', ['--user', 'disable', '--now', TRANSCRIBE_PATH_UNIT], { stdio }); for (const u of [TRANSCRIBE_PATH_UNIT, TRANSCRIBE_SERVICE]) fs.rmSync(path.join(dir, u), { force: true }); }
  // a non-zero exit, or no systemctl at all (spawn error): both count as failed
  const bad = r => !!r && (!!r.error || (typeof r.status === 'number' && r.status !== 0));
  const sc = (a, opts = { stdio }) => run('systemctl', ['--user', ...a], opts);
  const advice = 'Check that a user systemd session is running (loginctl enable-linger, or log in once), then run node cli.mjs timer again.';
  const wasActive = sc(['is-active', '--quiet', UNITS.timer], { stdio: 'ignore' })?.status === 0;
  if (bad(sc(['daemon-reload']))) {
    // nothing was stopped: a running timer goes on with the definition systemd already has
    lines.push(`systemctl --user failed: daemon-reload. The unit files are written to ${dir}; the running timer was not touched and nothing old was removed.`, advice);
    return { code: 1, time, lines };
  }
  // stopped right before it is enabled again (a run already going is not touched; a timer not loaded yet is fine), so
  // the start reads the stamp again: with the stamp at now, a new or earlier time cannot count as missed
  sc(['stop', UNITS.timer], { stdio: 'ignore' });
  if (plan.resetStamp) { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.closeSync(fs.openSync(stamp, 'a')); fs.utimesSync(stamp, now, now); }
  if (bad(sc(['enable', '--now', UNITS.timer]))) {
    // never leave the user without the timer they had: start it again (with the unit files just loaded)
    const back = wasActive && !bad(sc(['start', UNITS.timer]));
    lines.push(`systemctl --user failed: enable --now ${UNITS.timer}. The unit files are written to ${dir}; nothing old was removed.`,
      wasActive ? (back ? `${UNITS.timer} was started again, so evening runs go on.` : `${UNITS.timer} could not be started again: NO evening run happens until node cli.mjs timer works.`) : `${UNITS.timer} is not running: no evening run happens until node cli.mjs timer works.`, advice);
    return { code: 1, time, lines };
  }
  const failed = [];
  for (const a of [...(bot ? [['enable', '--now', UNITS.bot]] : []), ...(tr ? [['enable', '--now', TRANSCRIBE_PATH_UNIT]] : [])]) if (bad(sc(a))) failed.push(a.join(' '));
  if (failed.length) {
    lines.push(`systemctl --user failed: ${failed.join('; ')}. The daily timer is enabled; the unit files are written to ${dir}; nothing old was removed.`, advice);
    return { code: 1, time, lines };
  }
  lines.push(`The daily timer runs at ${time}${tz ? ` ${tz}` : ''}${bot ? '; the Telegram bot unit is enabled' : ''}. Installing it started no run.`, next);
  if (tr) lines.push(`Transcription: a file in ${tr.inbox} starts ${TRANSCRIBE_SERVICE} (${TRANSCRIBE_PATH_UNIT}).`);
  if (trOff) lines.push(`Transcription is off, so ${TRANSCRIBE_PATH_UNIT} was disabled and removed.`);
  if (keepOld) { const kept = oldUnitsIn(dir); if (kept.length) lines.push(`Kept the units of the older install (${kept.join(', ')}): both installs now run. Once it is moved, node cli.mjs timer removes them.`); }
  else { const old = removeOldUnits({ dir, run, stdio }); if (old.length) lines.push(`Removed the units from before the rename: ${old.join(', ')}.`); }
  return { code: 0, time, lines };
}

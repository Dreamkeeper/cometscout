// Running jobpilot unattended: the health ping after each run, the failure alert message, and the systemd units.
// settings.health = { ping_url: "https://hc-ping.com/<uuid>" }   // healthchecks.io style; the URL is a secret
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, SETTINGS, log } from './config.mjs';
import { scheduleOf, TIME_RE } from './schedule.mjs';
import { telegramOn } from './telegram.mjs';

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

const FAILURE_TEMPLATE = new URL('../deploy/jobpilot-failure@.service', import.meta.url);
/**
 * The systemd user units for the daily run: { 'jobpilot.service', 'jobpilot.timer', 'jobpilot-failure@.service' },
 * plus 'jobpilot-bot.service' (cli.mjs bot, always running) when bot is true.
 * The run unit names the failure template in OnFailure=, so a failed run sends a Telegram alert.
 * Paths in the units use "/" on every platform: systemd reads them on Linux, and the tests also run on Windows.
 */
export function unitFiles({ root, code = root, node, time, tz = '', envPath, bot = false }) {
  // root is JOBPILOT_HOME (settings, profile, data); code is where cli.mjs lives. They differ when JOBPILOT_HOME is set.
  const home = code === root ? '' : `Environment="JOBPILOT_HOME=${root}"\n`;
  return {
    'jobpilot.service': `[Unit]\nDescription=jobpilot evening run: sources, decode, picks, application packs\nOnFailure=jobpilot-failure@%n.service\n[Service]\nType=oneshot\nWorkingDirectory=${root}\n` +
      `# systemd user units get a minimal PATH; keep the one that finds claude/codex (~/.local/bin, npm globals)\nEnvironment="PATH=${envPath}"\n${home}ExecStart=${node} ${code}/cli.mjs run\nTimeoutStartSec=2h\n`,
    'jobpilot.timer': `[Unit]\nDescription=Run jobpilot every evening\n[Timer]\nOnCalendar=*-*-* ${time}:00${tz ? ` ${tz}` : ''}\nPersistent=true\n[Install]\nWantedBy=timers.target\n`,
    'jobpilot-failure@.service': fs.readFileSync(FAILURE_TEMPLATE, 'utf8').replaceAll('@ROOT@', root).replaceAll('@CODE@', code).replaceAll('@NODE@', node).replace('[Service]\n', `[Service]\n${home}`),
    ...(bot ? { 'jobpilot-bot.service': `[Unit]\nDescription=jobpilot Telegram bot: /schedule, /time, /interview\nAfter=network-online.target\n[Service]\nType=simple\nWorkingDirectory=${root}\n` +
      `Environment="PATH=${envPath}"\n${home}ExecStart=${node} ${code}/cli.mjs bot\nRestart=on-failure\nRestartSec=30\n[Install]\nWantedBy=default.target\n` } : {}),
  };
}

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** True on a host where systemd user units can be installed (Linux with systemd running). */
export const systemdHost = () => process.platform === 'linux' && fs.existsSync('/run/systemd/system');
/**
 * (Re)install the units at `time` (default schedule.time) in settings.timezone and enable the timer, and the bot
 * when Telegram delivery is on. run is spawnSync and dir the unit folder, injected by tests. Returns { code, time, lines }.
 */
export function installTimer({ time = scheduleOf().time, tz = SETTINGS.timezone || '', bot = !!telegramOn(), run = spawnSync, dir = path.join(os.homedir(), '.config', 'systemd', 'user'), stdio = 'inherit' } = {}) {
  if (!TIME_RE.test(String(time))) return { code: 1, time, lines: [`Time must be HH:MM, got "${time}"`] };
  const lines = [];
  try { if (tz) new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { lines.push(`Unknown timezone "${tz}" in settings.json; using the server's own`); tz = ''; }
  fs.mkdirSync(dir, { recursive: true });
  const envPath = `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
  // jobpilot.service names jobpilot-failure@.service in OnFailure=, so a failed run sends a Telegram alert (cli.mjs notify)
  for (const [name, text] of Object.entries(unitFiles({ root: ROOT, code: CODE, node: process.execPath, time, tz, envPath, bot }))) fs.writeFileSync(path.join(dir, name), text);
  for (const a of [['daemon-reload'], ['enable', '--now', 'jobpilot.timer'], ...(bot ? [['enable', '--now', 'jobpilot-bot.service']] : [])]) run('systemctl', ['--user', ...a], { stdio });
  lines.push(`The daily timer runs at ${time}${tz ? ` ${tz}` : ''}${bot ? '; the Telegram bot unit is enabled' : ''}.`);
  return { code: 0, time, lines };
}

// Running jobpilot unattended: the health ping after each run, the failure alert message, and the systemd units.
// settings.health = { ping_url: "https://hc-ping.com/<uuid>" }   // healthchecks.io style; the URL is a secret
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, log } from './config.mjs';

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
 * The systemd user units for the daily run: { 'jobpilot.service', 'jobpilot.timer', 'jobpilot-failure@.service' }.
 * The run unit names the failure template in OnFailure=, so a failed run sends a Telegram alert.
 */
export function unitFiles({ root, node, time, tz = '', envPath }) {
  return {
    'jobpilot.service': `[Unit]\nDescription=jobpilot evening run: sources, decode, picks, application packs\nOnFailure=jobpilot-failure@%n.service\n[Service]\nType=oneshot\nWorkingDirectory=${root}\n` +
      `# systemd user units get a minimal PATH; keep the one that finds claude/codex (~/.local/bin, npm globals)\nEnvironment="PATH=${envPath}"\nExecStart=${node} ${path.join(root, 'cli.mjs')} run\nTimeoutStartSec=2h\n`,
    'jobpilot.timer': `[Unit]\nDescription=Run jobpilot every evening\n[Timer]\nOnCalendar=*-*-* ${time}:00${tz ? ` ${tz}` : ''}\nPersistent=true\n[Install]\nWantedBy=timers.target\n`,
    'jobpilot-failure@.service': fs.readFileSync(FAILURE_TEMPLATE, 'utf8').replaceAll('@ROOT@', root).replaceAll('@NODE@', node),
  };
}

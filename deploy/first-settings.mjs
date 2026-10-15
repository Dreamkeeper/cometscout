// A fresh install's settings.json: settings.example.json with this machine's time zone instead of the example's, so
// the digest arrives at the hour the user expects. deploy/install.sh calls it only when settings.json does not exist
// yet; an existing settings.json is never touched. The zone comes from timedatectl, then /etc/timezone, then what
// Node reports; a zone Node does not know keeps the example's. One line says which zone was used and how to change it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setPath } from '../lib/jsonedit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** True when Intl knows the zone (an IANA name such as Europe/Berlin, or UTC). */
export function validZone(zone) {
  if (!zone || typeof zone !== 'string') return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

/** This machine's time zone, or '' when none of the sources gives a valid one. */
export function systemTimezone({
  timedatectl = () => execFileSync('timedatectl', ['show', '-p', 'Timezone', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }),
  etcTimezone = () => fs.readFileSync('/etc/timezone', 'utf8'),
  intl = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
} = {}) {
  for (const source of [timedatectl, etcTimezone, intl]) {
    let zone = '';
    try { zone = String(source() || '').trim(); } catch { /* not on this system */ }
    if (validZone(zone)) return zone;
  }
  return '';
}

/** The example settings text with `timezone` set to zone (formatting kept); the example as it is when zone is not valid. */
export function firstSettings(exampleText, zone) {
  if (!validZone(zone)) return { text: exampleText, zone: null };
  return { text: setPath(exampleText, ['timezone'], zone), zone };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
  const target = path.join(dir, 'settings.json');
  if (fs.existsSync(target)) process.exit(0);
  const example = fs.readFileSync(path.join(dir, 'settings.example.json'), 'utf8');
  const { text, zone } = firstSettings(example, systemTimezone());
  fs.writeFileSync(target, text);
  const used = zone || JSON.parse(example).timezone;
  console.log(zone
    ? `Time zone: ${used} (this machine's). The digest time follows it; to use another, set "timezone" in settings.json and run node cli.mjs timer.`
    : `Time zone: ${used} (the example's; this machine's zone could not be read). Set "timezone" in settings.json and run node cli.mjs timer.`);
}

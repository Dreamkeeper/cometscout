// Names from before the rename to CometScout: the product was called jobpilot. Existing installs still supply them,
// so for a release or two they keep working: the new name is read first, then the old one; only new names are written.
// Every fallback in the JavaScript code comes from this file, so removing them later is this file plus its callers.
// Outside it (they cannot import it): deploy/install.sh (JOBPILOT_TIME, an old ~/jobpilot folder), web/lib/logic.js
// (the workspace filters saved in the browser under the old key), package.json (the jobpilot command).
// test/names.test.mjs fails on any other "jobpilot" in the code.
import fs from 'node:fs';
import path from 'node:path';

export const OLD = 'jobpilot', NEW = 'cometscout';
const OLD_ENV = `${OLD.toUpperCase()}_`, NEW_ENV = `${NEW.toUpperCase()}_`;

/** COMETSCOUT_<name>, else JOBPILOT_<name>, else ''. */
export const envVar = (name, env = process.env) => env[NEW_ENV + name] || env[OLD_ENV + name] || '';
/** True when either name is set (to anything but ''). */
export const envSet = (name, env = process.env) => !!envVar(name, env);

/** Old variables set without their new name: [{ old, new }] (doctor). */
export const oldEnvVars = (env = process.env) => Object.keys(env).filter(k => k.toUpperCase().startsWith(OLD_ENV) && env[k] && !env[NEW_ENV + k.slice(OLD_ENV.length)])
  .map(k => ({ old: k, new: NEW_ENV + k.slice(OLD_ENV.length) })).sort((a, b) => a.old.localeCompare(b.old));

/** The environment for a hook: every COMETSCOUT_ variable also under its old name and the other way round (new wins). */
export function withOldNames(env) {
  const out = { ...env };
  const names = new Set(Object.keys(env).filter(k => k.startsWith(NEW_ENV) || k.startsWith(OLD_ENV)).map(k => k.slice((k.startsWith(NEW_ENV) ? NEW_ENV : OLD_ENV).length)));
  for (const n of names) { const v = envVar(n, env); if (v) { out[NEW_ENV + n] = v; out[OLD_ENV + n] = v; } }
  return out;
}

// The workspace header: the web client sends X-CometScout; the server still accepts the old one.
export const OLD_HEADER = `x-${OLD}`;

// systemd user units an old install has; cli.mjs timer disables and removes them, doctor reports leftovers.
export const OLD_UNITS = [`${OLD}.timer`, `${OLD}-bot.service`, `${OLD}.service`, `${OLD}-failure@.service`];
// Stopped (the timer first) and disabled before their files are removed. The run unit is never stopped: it may be mid-run.
export const OLD_UNITS_TO_STOP = [`${OLD}.timer`, `${OLD}-bot.service`];
/** The old unit files in `dir`. */
export const oldUnitsIn = dir => OLD_UNITS.filter(u => fs.existsSync(path.join(dir, u)));

// File names: backups, exports and secrets files made before the rename start with "jobpilot-".
export const NAME_FAMILIES = [NEW, OLD];
// Export formats still read: "jobpilot-export" (v2, same layout) and "jobpilot-export-v1" (the first format).
export const OLD_EXPORT_FORMAT = `${OLD}-export`, OLD_EXPORT_FORMAT_V1 = `${OLD}-export-v1`;
// Secrets files: the format id is also the AES-GCM associated data, so an old file is decrypted with the old id.
export const OLD_SECRETS_FORMAT = `${OLD}-secrets`;

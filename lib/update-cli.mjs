// The update, rollback and migrate commands of cli.mjs (lib/update.mjs, lib/layout.mjs, lib/migrate.mjs).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, CODE_DIR } from './config.mjs';
import { adopt, currentLink } from './layout.mjs';
import { runUpdate, runRollback, checkForUpdate, updateAction, statusText } from './update.mjs';
import { runMigrations } from './migrate.mjs';
import { systemdHost } from './ops.mjs';
import { bare } from './release.mjs';

const USAGE = {
  update: 'node cli.mjs update [--to vX.Y.Z] | --check | --tonight [vX.Y.Z] | --skip vX.Y.Z | --adopt [--no-units] [--keep-old-units]',
  rollback: 'node cli.mjs rollback [--to vX.Y.Z] [--restore-data [--yes]]',
};

/** The units after --adopt: cli.mjs timer from app/current, on systemd hosts only. */
function adoptUnits(keepOld) {
  if (!systemdHost()) return { code: 0, lines: ['Not a systemd host: no units to install here (node cli.mjs timer does it on the server).'] };
  const r = spawnSync(process.execPath, [path.join(currentLink(ROOT), 'cli.mjs'), 'timer', ...(keepOld ? ['--keep-old-units'] : [])], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, COMETSCOUT_HOME: ROOT } });
  return { code: r.error || r.status ? 1 : 0, lines: r.error || r.status ? ['node cli.mjs timer failed; run it again from app/current once the problem above is fixed.'] : ['The units now run app/current/cli.mjs.'] };
}

export function updateCommands({ rest, locked }) {
  const opt = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : null; };
  const has = name => rest.includes(name);
  const usage = cmd => { console.log(`Usage: ${USAGE[cmd]}`); return 1; };
  return {
    update: async () => {
      if (has('--adopt')) {
        const r = adopt({ root: ROOT, code: CODE_DIR, units: has('--no-units') ? () => ({ code: 0, lines: [] }) : () => adoptUnits(has('--keep-old-units')) });
        for (const l of r.lines) console.log(l);
        return r.code;
      }
      if (has('--check')) {
        const st = await checkForUpdate();
        if (!st.ok) console.log(`The update check failed: ${st.error}. Nothing changed.`);
        console.log(statusText(st));
        return 0;   // a failed check is never fatal
      }
      if (has('--skip') || has('--tonight')) {
        const action = has('--skip') ? 'skip' : 'tonight';
        let v = opt(`--${action}`);
        if (v === null && action === 'skip') return usage('update');
        if (!v) { const st = await checkForUpdate({ maxAgeH: 1 }); if (!st.available) { console.log(st.ok ? `You have the newest version (v${st.current}).` : `The update check failed: ${st.error}.`); return st.ok ? 0 : 1; } v = st.latest; }
        if (!bare(v)) return usage('update');
        const r = updateAction(action, v);
        console.log(r.message);
        return r.ok ? 0 : 1;
      }
      const to = opt('--to'); if (to === null) return usage('update');
      const r = await runUpdate({ to: to || null, waitLock: has('--wait-lock'), say: console.log });
      return r.code;
    },
    rollback: async () => {
      const to = opt('--to'); if (to === null) return usage('rollback');
      return (await runRollback({ to: to || null, restoreData: has('--restore-data'), yes: has('--yes'), say: console.log })).code;
    },
    migrate: locked(async () => {
      try {
        const r = await runMigrations({ dryRun: has('--dry-run') });
        if (has('--dry-run')) console.log(r.pending.length ? `Pending migrations: ${r.pending.join(', ')}` : 'No pending migrations.');
        else console.log(r.applied.length ? `Applied ${r.applied.join(', ')} (data schema ${r.version}).` : `No pending migrations (data schema ${r.version}).`);
        return 0;
      } catch (e) { console.log(`Migration stopped: ${e.message}`); return 1; }
    }),
  };
}

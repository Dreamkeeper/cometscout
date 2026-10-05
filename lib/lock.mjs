// The run lock (data/state/run.lock, the pid of the process holding it). cli.mjs takes it for the evening run and
// every command that writes many files at once (decode, pack, reset, import, backup, restore, migrate, update,
// rollback); the workspace server only checks it, so it never writes applications.json in the middle of one of them.
// A command the update runs as a step (the new release's migrate and its checks) runs under the update's lock: the
// update sets COMETSCOUT_LOCK_PARENT to its own pid, and a child whose parent holds the lock does not take it again.
import fs from 'node:fs';
import { STATE } from './config.mjs';
import { envVar } from './legacy-names.mjs';

export const LOCK_FILE = () => STATE('run.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const heldPid = file => { try { return Number(fs.readFileSync(file, 'utf8')); } catch { return null; } };
/** True when the lock belongs to the process that started this one and said so (COMETSCOUT_LOCK_PARENT). */
const parentHolds = pid => !!pid && pid === process.ppid && envVar('LOCK_PARENT') === String(pid);
/** The pid of another live process holding the lock, or null (no lock, a stale one, our own, or our parent's). */
export function lockHolder(file = LOCK_FILE()) {
  const pid = heldPid(file);
  return pid && pid !== process.pid && !parentHolds(pid) && alive(pid) ? pid : null;
}
/** Take the lock: null when taken (released on exit), else the message to print. */
export function takeLock(file = LOCK_FILE()) {
  const pid = lockHolder(file);
  if (pid) return `another CometScout run is in progress (pid ${pid}); try again when it finishes`;
  if (parentHolds(heldPid(file))) return null;   // the update that started this step holds it and releases it
  fs.writeFileSync(file, String(process.pid)); process.on('exit', () => { try { fs.rmSync(file); } catch { /* already gone */ } });
  return null;
}

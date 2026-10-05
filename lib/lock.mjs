// The run lock (data/state/run.lock, the pid of the process holding it). cli.mjs takes it for the evening run and
// every command that writes many files at once (decode, pack, reset, import, backup, restore); the workspace server
// only checks it, so it never writes applications.json in the middle of one of them.
import fs from 'node:fs';
import { STATE } from './config.mjs';

export const LOCK_FILE = () => STATE('run.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** The pid of another live process holding the lock, or null (no lock, a stale one, or our own). */
export function lockHolder(file = LOCK_FILE()) {
  let pid; try { pid = Number(fs.readFileSync(file, 'utf8')); } catch { return null; }
  return pid && pid !== process.pid && alive(pid) ? pid : null;
}
/** Take the lock: null when taken (released on exit), else the message to print. */
export function takeLock(file = LOCK_FILE()) {
  const pid = lockHolder(file);
  if (pid) return `another CometScout run is in progress (pid ${pid}); try again when it finishes`;
  fs.writeFileSync(file, String(process.pid)); process.on('exit', () => { try { fs.rmSync(file); } catch { /* already gone */ } });
  return null;
}

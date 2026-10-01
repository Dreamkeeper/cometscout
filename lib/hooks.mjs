// Hooks: let your own scripts react to pipeline events without changing jobpilot.
// settings.hooks = { "<event>": "command" | ["command", ...], "timeout_sec": 60 }
// Events: before_run, job_written, decoded, picks, pack_built, outcome, run_done.
// Each command runs through the shell in the jobpilot folder with the event as JSON on stdin
// ({ event, at, ...payload }) and JOBPILOT_EVENT set. A failing or slow hook is logged and never stops the run.
// The timeout kills the shell; on Linux `sh -c` execs a single command, so the hook itself stops. On Windows a
// child of cmd.exe can outlive it, so keep hooks short there or make them exit on their own.
import { spawnSync } from 'node:child_process';
import { SETTINGS, ROOT, num, log } from './config.mjs';

export const HOOK_EVENTS = ['before_run', 'job_written', 'decoded', 'picks', 'pack_built', 'outcome', 'run_done'];

export function hooksFor(event) {
  const h = SETTINGS.hooks?.[event];
  return (Array.isArray(h) ? h : h ? [h] : []).filter(c => typeof c === 'string' && c.trim());
}

/** Run every command configured for `event`; returns [{ cmd, ok, status, error? }]. */
export function runHook(event, payload = {}) {
  if (!HOOK_EVENTS.includes(event)) throw new Error(`unknown hook event "${event}"`);
  const cmds = hooksFor(event); if (!cmds.length) return [];
  const input = JSON.stringify({ event, at: new Date().toISOString(), ...payload });
  const timeout = num(SETTINGS.hooks?.timeout_sec, 60, 1, 3600) * 1000;
  return cmds.map(cmd => {
    const r = spawnSync(cmd, { shell: true, cwd: ROOT, input, encoding: 'utf8', timeout, env: { ...process.env, JOBPILOT_EVENT: event } });
    const ok = r.status === 0 && !r.error;
    if (!ok) log(`hook ${event} failed (${r.error ? r.error.code || r.error.message : `exit ${r.status}`}): ${cmd.slice(0, 80)}${r.stderr ? ` :: ${r.stderr.trim().slice(0, 200)}` : ''}`);
    return { cmd, ok, status: r.status, ...(r.error ? { error: r.error.message } : {}) };
  });
}

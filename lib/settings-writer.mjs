// The one writer for the settings a user changes from the workspace or the Telegram bot: schedule.days,
// schedule.time and picks.prep.days_before. It validates like doctor, edits only those values in settings.json
// (unknown keys, key order and layout stay; lib/jsonedit.mjs), moves an old run_time into schedule, and reinstalls
// the timer when the time changed (on systemd hosts; elsewhere it names the command to run).
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, SETTINGS_FILE, read } from './config.mjs';
import { scheduleOf, prepOf, scheduleProblems } from './schedule.mjs';
import { setPath, replaceMember, deletePath } from './jsonedit.mjs';
import { installTimer, systemdHost } from './ops.mjs';
import { translator } from './i18n.mjs';

/** What the settings screens show: { days, time, timezone, prep_days, problems }. */
export function scheduleView(s = SETTINGS) {
  const { days, time } = scheduleOf(s);
  return { days, time, timezone: s.timezone || 'UTC', prep_days: prepOf(s).days_before, problems: scheduleProblems(s) };
}

/** The timer on this host: reinstalled under systemd, else the command to run. */
export function defaultReinstall(time) {
  if (!systemdHost()) return { done: false };
  const r = installTimer({ time, stdio: 'ignore' });
  return { done: !r.code };
}

/**
 * Apply { days?, time?, prep_days? } to settings.json. Returns { ok, problems, view, timeChanged, timer, message }:
 * ok false (nothing written) when the result would not pass doctor's checks or the file cannot be read.
 * timer: "reinstalled", "manual" (run node cli.mjs timer) or null when the time did not change.
 */
export function writeSettings(patch = {}, { file = SETTINGS_FILE, reinstall = defaultReinstall, t = translator() } = {}) {
  const fail = problems => ({ ok: false, problems, message: problems.join('\n') });
  if (!patch || typeof patch !== 'object') return fail(['send { days, time, prep_days }']);
  if (path.basename(file) === 'settings.example.json') return fail(['There is no settings.json yet: copy settings.example.json to settings.json first (the onboarding does this).']);
  const raw = read(file);
  let cur; try { cur = JSON.parse(raw); } catch (e) { return fail([`${path.basename(file)} is not valid JSON (${e.message}); fix it by hand first.`]); }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return fail([`${path.basename(file)} is not a JSON object.`]);
  const was = scheduleOf(cur);
  const days = patch.days !== undefined ? patch.days : was.days, time = patch.time !== undefined ? patch.time : was.time;
  const prepDays = patch.prep_days !== undefined ? patch.prep_days : cur.picks?.prep?.days_before;
  // validate what the file would say, with doctor's checks
  const touch = patch.days !== undefined || patch.time !== undefined;
  const next = { ...cur, picks: { ...(cur.picks || {}) } };
  if (touch) { next.schedule = { ...(cur.schedule && typeof cur.schedule === 'object' ? cur.schedule : {}), days, time }; delete next.run_time; }
  if (prepDays !== undefined) next.picks.prep = { ...(cur.picks?.prep && typeof cur.picks.prep === 'object' ? cur.picks.prep : {}), days_before: prepDays };
  const problems = scheduleProblems(next);
  if (problems.length) return fail(problems);
  if (touch) next.schedule.days = [...days].sort((a, b) => a - b);

  let text = raw;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hasSchedule = cur.schedule && typeof cur.schedule === 'object' && !Array.isArray(cur.schedule);
  const daysChanged = touch && !same(next.schedule.days, hasSchedule ? cur.schedule.days : undefined), timeChanged = touch && time !== was.time;
  if (patch.days !== undefined || patch.time !== undefined) {
    if (!('schedule' in cur) && 'run_time' in cur) text = replaceMember(text, ['run_time'], 'schedule', { days: next.schedule.days, time });
    else if (!hasSchedule) text = setPath(text, ['schedule'], { days: next.schedule.days, time });
    else {
      if (daysChanged) text = setPath(text, ['schedule', 'days'], next.schedule.days);
      if (time !== cur.schedule.time) text = setPath(text, ['schedule', 'time'], time);
    }
    text = deletePath(text, ['run_time']);   // schedule.time holds it now
  }
  if (patch.prep_days !== undefined && cur.picks?.prep?.days_before !== prepDays) text = setPath(text, ['picks', 'prep', 'days_before'], prepDays);
  if (text !== raw) {
    const tmp = `${file}.tmp-${process.pid}`;
    // read() gives LF; a file that had CRLF keeps it
    const crlf = fs.readFileSync(file, 'utf8').includes('\r\n');
    fs.writeFileSync(tmp, crlf ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8'); fs.renameSync(tmp, file);
  }
  // this process (the workspace, the bot) reads the new values from now on
  if (path.resolve(file) === path.resolve(SETTINGS_FILE)) {
    const fresh = JSON.parse(text);
    if (fresh.schedule) { SETTINGS.schedule = fresh.schedule; delete SETTINGS.run_time; }
    SETTINGS.picks = { ...SETTINGS.picks, ...(fresh.picks?.prep ? { prep: fresh.picks.prep } : {}) };
  }
  let timer = null;
  if (timeChanged) timer = reinstall(time).done ? 'reinstalled' : 'manual';
  const view = scheduleView(JSON.parse(text));
  const message = [t('settings.saved'), timer === 'reinstalled' ? t('settings.timer_done', { time }) : timer === 'manual' ? t('settings.timer_run', { time }) : null].filter(Boolean).join(' ');
  return { ok: true, problems: [], view, timeChanged, timer, message };
}

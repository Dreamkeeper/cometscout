// Digest days and time (settings.schedule) and interview prep mode (settings.picks.prep).
// settings.schedule = { days: [1, 2, 3, 4, 5, 6, 7], time: "18:00" }: ISO weekdays (Monday = 1) and HH:MM, both in
//   settings.timezone. An older settings.run_time is read as schedule.time. The timer runs every day at the time;
//   the evening run checks the day, so changing days never touches the timer.
// settings.picks.prep = { days_before: 2, max: 1, verdicts: ["strong-fit"], max_priority: 1, fresh_days: 2 }:
//   in the days_before days before an interview (and on its day, before its time) the digest leads with the
//   interview and shows at most `max` picks, each a fresh decode with one of `verdicts` and priority <= max_priority.
//   days_before 0 turns prep mode off.
import { SETTINGS, today, num } from './config.mjs';

export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const PREP_MAX_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day as YYYY-MM-DD (2026-02-30 is not). */
export const validDate = s => DATE_RE.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
/** 1 (Monday) to 7 (Sunday) for a YYYY-MM-DD day. */
export const isoWeekday = day => { const d = new Date(`${day}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
/** Whole days from a to b (YYYY-MM-DD), b - a. */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** { days, time, legacy }: settings.schedule with defaults; legacy is true when the time comes from run_time. */
export function scheduleOf(s = SETTINGS) {
  const sc = isObj(s?.schedule) ? s.schedule : {};
  return { days: sc.days ?? ALL_DAYS, time: sc.time ?? s?.run_time ?? '18:00', legacy: sc.time == null && s?.run_time != null };
}
/** settings.picks.prep with defaults (num(): a typo never disables a limit). */
export function prepOf(s = SETTINGS) {
  const p = isObj(s?.picks?.prep) ? s.picks.prep : {};
  return {
    days_before: num(p.days_before, 2, 0, PREP_MAX_DAYS), max: num(p.max, 1, 0, 10), verdicts: Array.isArray(p.verdicts) ? p.verdicts.map(String) : ['strong-fit'],
    max_priority: num(p.max_priority, 1, 1, 5), fresh_days: num(p.fresh_days, 2, 1, 30),
  };
}
/** What is wrong with schedule and picks.prep, one line each ([] when fine). doctor and the settings writer use it. */
export function scheduleProblems(s = SETTINGS) {
  const out = [];
  if (s?.schedule !== undefined && !isObj(s.schedule)) out.push('schedule must be an object: { "days": [1, 2, 3, 4, 5, 6, 7], "time": "18:00" }');
  const { days, time } = scheduleOf(s);
  if (!Array.isArray(days) || !days.length) out.push('schedule.days needs at least one day (1 = Monday ... 7 = Sunday)');
  else if (days.some(d => !Number.isInteger(d) || d < 1 || d > 7)) out.push(`schedule.days must be whole numbers from 1 (Monday) to 7 (Sunday), got ${JSON.stringify(days)}`);
  else if (new Set(days).size !== days.length) out.push(`schedule.days lists a day twice: ${JSON.stringify(days)}`);
  if (!TIME_RE.test(String(time))) out.push(`schedule.time must be HH:MM, got ${JSON.stringify(time)}`);
  const p = s?.picks?.prep;
  if (p !== undefined && !isObj(p)) out.push('picks.prep must be an object');
  else if (p) {
    const int = (k, lo, hi) => { if (p[k] !== undefined && !(Number.isInteger(p[k]) && p[k] >= lo && p[k] <= hi)) out.push(`picks.prep.${k} must be a whole number from ${lo} to ${hi}, got ${JSON.stringify(p[k])}`); };
    int('days_before', 0, PREP_MAX_DAYS); int('max', 0, 10); int('max_priority', 1, 5); int('fresh_days', 1, 30);
    if (p.verdicts !== undefined && !(Array.isArray(p.verdicts) && p.verdicts.every(v => typeof v === 'string'))) out.push('picks.prep.verdicts must be a list of verdicts, e.g. ["strong-fit"]');
  }
  return out;
}
/**
 * True when `day` is not one of schedule.days. A broken schedule counts every day as a digest day: a typo never
 * silences the digest (doctor names the problem).
 */
export function offDay(day = today(), s = SETTINGS) {
  if (scheduleProblems(s).some(p => p.startsWith('schedule'))) return false;
  return !scheduleOf(s).days.includes(isoWeekday(day));
}

/**
 * The clock in settings.timezone as HH:MM, for comparing with an interview time on the run's day. A run that has
 * crossed midnight (the run date is pinned, cli.mjs run) is past every time of its day: "24:00".
 */
export function nowTime(tz = SETTINGS.timezone || 'UTC', now = new Date(), runDate = today()) {
  let day, time;
  try {
    day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
    time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  } catch { day = now.toISOString().slice(0, 10); time = now.toISOString().slice(11, 16); }
  return day === runDate ? time : day > runDate ? '24:00' : '00:00';
}

// Applications with nothing ahead: their interview events no longer count.
const FINISHED = new Set(['rejected', 'skipped', 'closed', 'withdrawn']);
/** Interviews on or after `day`, soonest first: [{ key, company, role, round, date, time }] (time '' when unknown). */
export function upcomingInterviews(apps, day = today()) {
  const out = [], seen = new Set();
  for (const [key, a] of Object.entries(apps || {})) {
    if (!isObj(a) || FINISHED.has(a.status)) continue;
    for (const e of Array.isArray(a.events) ? a.events : []) {
      if (e?.type !== 'interview' || !validDate(e.event_date) || e.event_date < day) continue;
      const time = TIME_RE.test(String(e.event_time || '')) ? e.event_time : '';
      const id = `${key}|${e.event_date}|${time}`; if (seen.has(id)) continue; seen.add(id);
      out.push({ key, company: a.company || '', role: a.role || '', round: e.round ?? null, date: e.event_date, time });
    }
  }
  // no time sorts last on its day: it counts as "later today"
  return out.sort((x, y) => x.date.localeCompare(y.date) || (x.time || '99').localeCompare(y.time || '99') || String(x.company).localeCompare(String(y.company)));
}
/**
 * Prep mode for a digest on `day` at `time` (HH:MM), or null: the soonest interview 1 to days_before days ahead, or
 * later today (an interview with no time counts as later today). Returns { interview, days, step } where step is
 * "prep" (2 or more days out), "practice" (1 day) or "warmup" (the day itself).
 */
export function prepState({ apps, day = today(), time = nowTime(), settings = SETTINGS } = {}) {
  const P = prepOf(settings);
  if (!P.days_before) return null;
  for (const i of upcomingInterviews(apps, day)) {
    const d = daysBetween(day, i.date);
    if (d > P.days_before) break;
    if (d === 0 && i.time && i.time <= time) continue;
    return { interview: i, days: d, step: d >= 2 ? 'prep' : d === 1 ? 'practice' : 'warmup' };
  }
  return null;
}
/** Whether a pool job may be a pick in prep mode: a fresh decode with a prep verdict and a top priority. */
export function prepQualifies(c, day = today(), P = prepOf()) {
  const pr = Number(c?.v?.apply_priority), decoded = String(c?.v?.decoded_on || c?.file || '').slice(0, 10);
  return P.verdicts.includes(c?.v?.verdict) && Number.isFinite(pr) && pr >= 1 && pr <= P.max_priority
    && validDate(decoded) && daysBetween(decoded, day) >= 0 && daysBetween(decoded, day) < P.fresh_days;
}

/** Short weekday names, Monday first, in a locale. */
export const weekdayNames = (locale = 'en') => ALL_DAYS.map(d => { try { return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, d))); } catch { return String(d); } });
/** "Tue, Oct 6" (en) or "вт, 6 окт." (ru) for a YYYY-MM-DD day. */
export const dayLabel = (day, locale = 'en') => { try { return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`)); } catch { return day; } };

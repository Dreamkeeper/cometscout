// Digest and picks text, in the user's locale (lib/i18n.mjs). Pure functions: the decoder passes in what it decoded.
import { SETTINGS } from '../lib/config.mjs';
import { translator } from '../lib/i18n.mjs';
import { dayLabel } from '../lib/schedule.mjs';

export const APPLY_WORTHY = ['strong-fit', 'investable-stretch'];
const T = translator();
const LOCALE = () => SETTINGS.locale || 'en';
export const verdictLabel = (v, t = T) => { const k = `verdict.${v}`; const s = t(k); return s === k ? v : s; };

/** The "Apply today" block: [] when there are no picks. */
export const picksText = ({ picks, open }, t = T) => picks.length ? [t('picks.header', { n: picks.length, open }),
  ...picks.flatMap((p, i) => [`${i + 1}. ${p.fm.company}: ${p.fm.role} [${String(p.fm.location || '').slice(0, 60)}] ${verdictLabel(p.v.verdict, t)}, p${p.v.apply_priority}, ${t('picks.via', { source: p.fm.source })}`,
    `   ${t('picks.how')} ${p.v.action}`, `   ${p.fm.url || ''}`]), ''] : [];

/**
 * The prep-mode opening (lib/schedule.mjs prepState): the interview with its day and time, the day's prep step and,
 * when the coach module is on, the coach command for it. The digest and the workspace's Today screen both use it.
 */
export function prepLines(prep, t = T, { locale = LOCALE(), coach = !!SETTINGS.modules?.coach?.enabled } = {}) {
  if (!prep) return [];
  const i = prep.interview;
  const when = prep.days === 0 ? t('prep.today') : prep.days === 1 ? t('prep.tomorrow') : t('prep.in_days', { n: prep.days });
  const round = Number.isInteger(i.round) && i.round > 0 ? t('prep.round', { n: i.round }) : typeof i.round === 'string' ? i.round.trim() : '';
  const what = [i.company || '?', round, dayLabel(i.date, locale), i.time].filter(Boolean).join(', ');
  return [t('prep.header', { when, what }), t(`prep.step.${prep.step}`), ...(coach ? [t(`prep.coach.${prep.step}`, { company: i.company || '' })] : [])];
}
/** "Held back on Sat, Oct 3; Sun, Oct 4: ..." for the off days since the last digest; null when there were none. */
export function heldBackLine(held, t = T, locale = LOCALE()) {
  if (!held?.length) return null;
  const n = held.reduce((s, h) => s + (h.decoded || 0), 0), worth = held.reduce((s, h) => s + (h.worth || 0), 0);
  return t('digest.held_back', { days: held.map(h => dayLabel(h.date, locale)).join('; '), n, worth });
}
const jobLine = (d, i, t) => `${i + 1}. ${d.fm.company}: ${d.fm.role} [${String(d.fm.location || '').slice(0, 60)}] ${verdictLabel(d.v.verdict, t)}, p${d.v.apply_priority}`;

/**
 * The whole digest. done: [{ file, fm, v }] decoded this run; failed / gaveUp: [{ file }]; pk: the picks (with
 * pk.prep in prep mode: { interview, days, step, wait }); left: jobs still waiting because of the cap.
 * off: the day, when this is an off day (written, not sent); held: off days held back since the last digest.
 */
export function digestText({ name, date, dry = false, done = [], failed = [], gaveUp = [], pk = { picks: [], open: 0 }, left = 0, cap = 0, maxTries = 0, off = null, held = [], locale = LOCALE(), coach } = {}, t = T) {
  const worth = done.filter(d => APPLY_WORTHY.includes(d.v.verdict)), heldJobs = done.filter(d => ['long-shot', 'unreadable'].includes(d.v.verdict)), rej = done.filter(d => ['gate-reject', 'weak-fit'].includes(d.v.verdict));
  const prep = pk.prep || null, back = heldBackLine(held, t, locale);
  const L = [...(off ? [t('digest.off_day', { day: dayLabel(off, locale) }), ''] : []), ...(back ? [back, ''] : [])];
  if (prep) L.push(...prepLines(prep, t, { locale, coach }), ...(pk.picks.length ? ['', ...picksText(pk, t)] : [t('prep.wait', { n: prep.wait }), '']));
  else L.push(...picksText(pk, t));
  L.push(`${t('digest.decoded', { name, n: done.length, date })}${dry ? t('digest.dry_run') : ''}`, '');
  if (prep) {
    // in prep mode today's finds are listed one line each, for after the interview; the pick above is not repeated
    const later = worth.filter(d => !pk.picks.some(p => p.file === d.file));
    if (later.length) L.push(t('prep.after', { n: later.length }), ...later.map((d, i) => jobLine(d, i, t)), '');
  } else if (worth.length) L.push(t('digest.worth', { n: worth.length }), ...worth.flatMap((d, i) => [jobLine(d, i, t), `   ${d.v.action}`,
    ...(d.v.fact_flags?.length ? [`   ${t('digest.fact_check')} ${d.v.fact_flags.map(x => x.why).join(' ')}`] : []), `   ${d.fm.url || ''}`]), '');
  if (heldJobs.length) L.push(t('digest.held', { n: heldJobs.length }), ...heldJobs.flatMap(d => [`- ${d.fm.company}: ${d.fm.role}`, `   ${t('digest.why_held')} ${d.v.hold_reason || d.v.rationale}`, `   ${d.fm.url || ''}`]), '');
  if (rej.length) L.push(t('digest.rejected', { n: rej.length }), ...rej.map(d => `- ${d.fm.company}: ${d.v.gate || t('digest.weak_fit')}`), '');
  if (failed.length) L.push(t('digest.failed', { n: failed.length, files: failed.map(f => f.file).join(', ') }));
  if (gaveUp.length) L.push(t('digest.gave_up', { tries: maxTries, n: gaveUp.length, files: gaveUp.map(f => f.file).join(', ') }));
  if (left) L.push(t('digest.waiting', { n: left, cap }));
  return L.join('\n');
}

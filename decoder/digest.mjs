// Digest and picks text, in the user's locale (lib/i18n.mjs). Pure functions: the decoder passes in what it decoded.
import { translator } from '../lib/i18n.mjs';

export const APPLY_WORTHY = ['strong-fit', 'investable-stretch'];
const T = translator();
export const verdictLabel = (v, t = T) => { const k = `verdict.${v}`; const s = t(k); return s === k ? v : s; };

/** The "Apply today" block: [] when there are no picks. */
export const picksText = ({ picks, open }, t = T) => picks.length ? [t('picks.header', { n: picks.length, open }),
  ...picks.flatMap((p, i) => [`${i + 1}. ${p.fm.company}: ${p.fm.role} [${String(p.fm.location || '').slice(0, 60)}] ${verdictLabel(p.v.verdict, t)}, p${p.v.apply_priority}, ${t('picks.via', { source: p.fm.source })}`,
    `   ${t('picks.how')} ${p.v.action}`, `   ${p.fm.url || ''}`]), ''] : [];

/**
 * The whole digest. done: [{ file, fm, v }] decoded this run; failed / gaveUp: [{ file }]; pk: buildPicks() result;
 * left: jobs still waiting because of the cap.
 */
export function digestText({ name, date, dry = false, done = [], failed = [], gaveUp = [], pk = { picks: [], open: 0 }, left = 0, cap = 0, maxTries = 0 }, t = T) {
  const worth = done.filter(d => APPLY_WORTHY.includes(d.v.verdict)), held = done.filter(d => ['long-shot', 'unreadable'].includes(d.v.verdict)), rej = done.filter(d => ['gate-reject', 'weak-fit'].includes(d.v.verdict));
  const L = [...picksText(pk, t), `${t('digest.decoded', { name, n: done.length, date })}${dry ? t('digest.dry_run') : ''}`, ''];
  if (worth.length) L.push(t('digest.worth', { n: worth.length }), ...worth.flatMap((d, i) => [`${i + 1}. ${d.fm.company}: ${d.fm.role} [${String(d.fm.location || '').slice(0, 60)}] ${verdictLabel(d.v.verdict, t)}, p${d.v.apply_priority}`, `   ${d.v.action}`,
    ...(d.v.fact_flags?.length ? [`   ${t('digest.fact_check')} ${d.v.fact_flags.map(x => x.why).join(' ')}`] : []), `   ${d.fm.url || ''}`]), '');
  if (held.length) L.push(t('digest.held', { n: held.length }), ...held.flatMap(d => [`- ${d.fm.company}: ${d.fm.role}`, `   ${t('digest.why_held')} ${d.v.hold_reason || d.v.rationale}`, `   ${d.fm.url || ''}`]), '');
  if (rej.length) L.push(t('digest.rejected', { n: rej.length }), ...rej.map(d => `- ${d.fm.company}: ${d.v.gate || t('digest.weak_fit')}`), '');
  if (failed.length) L.push(t('digest.failed', { n: failed.length, files: failed.map(f => f.file).join(', ') }));
  if (gaveUp.length) L.push(t('digest.gave_up', { tries: maxTries, n: gaveUp.length, files: gaveUp.map(f => f.file).join(', ') }));
  if (left) L.push(t('digest.waiting', { n: left, cap }));
  return L.join('\n');
}

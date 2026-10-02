// Company and role matching for reports (tracker overrides, the source scorecard).
// Uses lib/companies.mjs (alias families, role overlap) when it exists; until then plain normalised equality.
import { norm } from './queue.mjs';

let companies = null;
try { companies = await import('./companies.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND' || !String(e.message).includes('companies.mjs')) throw e; }

const known = s => !!s && s !== 'unknown';
/** True when a and b name the same company. */
export function companyMatch(a, b) {
  if (companies?.companyMatch) return !!companies.companyMatch(a, b);
  const x = norm(a), y = norm(b);
  return known(x) && x === y;
}
/** Share of role words the two roles have in common, 0..1. */
export function roleOverlap(a, b) {
  if (companies?.roleOverlap) return companies.roleOverlap(a, b);
  const x = norm(a), y = norm(b);
  return x && x === y ? 1 : 0;
}
export const usingAliases = () => !!companies?.companyMatch;

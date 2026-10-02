// Company names and role titles: alias families (settings.queue.aliases), whether two company names are one employer,
// and whether two role titles are the same role. Shared by the queue (dedupe against applications), the decoder
// (history, picks) and the outcomes source.
// settings.queue.aliases = [["Acme Robotics", "Acme"], ["Northwind Labs", "Northwind", "NWL Group"]]
//   (or { "Acme Robotics": ["Acme"] }): every name in one list is the same employer.
import { SETTINGS } from './config.mjs';
import { norm } from './text.mjs';

/** Alias families from settings.queue.aliases, each a Set of normalised names. */
export function aliasFamilies(aliases = SETTINGS.queue?.aliases) {
  if (!aliases) return [];
  const fams = Array.isArray(aliases) ? aliases.filter(Array.isArray) : Object.entries(aliases).map(([k, v]) => [k, ...[].concat(v)]);
  return fams.map(f => new Set(f.map(norm).filter(Boolean))).filter(f => f.size);
}

// Normalised names are words joined by single spaces, so whole-word containment is a padded substring test.
const hasWords = (hay, needle) => ` ${hay} `.includes(` ${needle} `);
const known = n => !!n && n !== 'unknown';

/**
 * The normalised names of every alias family one of whose names occurs in the name as whole words ("ola" never matches
 * "Motorola"; a name shorter than 3 characters only matches the whole name). Without a family: [norm(name)].
 */
export function familyOf(name, families = aliasFamilies()) {
  const n = norm(name); if (!n) return [];
  const out = new Set();
  for (const f of families) if ([...f].some(a => (a.length < 3 ? n === a : hasWords(n, a)))) for (const a of f) out.add(a);
  return out.size ? [...out] : [n];
}

// A name that is only one of these words says nothing about the employer ("Labs" is not "Ridgeway Labs").
export const GENERIC_COMPANY_WORDS = new Set(['labs', 'group', 'inc', 'corp', 'holdings', 'technologies', 'systems', 'gmbh', 'ltd', 'llc', 'ооо', 'ао']);
const contains = (hay, needle) => needle.length >= 4 && !GENERIC_COMPANY_WORDS.has(needle) && hasWords(hay, needle);
/**
 * Two company names are one employer when a name of one's family equals a name of the other's, or one is contained
 * in the other as whole words ("Ridgeway" and "Ridgeway Labs", either way round). The contained name must be at least
 * 4 characters and not a single generic word (labs, group, inc ...). Empty or "unknown" never matches.
 */
export function companyMatch(a, b, families = aliasFamilies()) {
  if (!known(norm(a)) || !known(norm(b))) return false;
  const fa = familyOf(a, families), fb = familyOf(b, families);
  for (const x of fa) for (const y of fb) if (x === y || contains(x, y) || contains(y, x)) return true;
  return false;
}

/**
 * The stricter match the outcomes source uses: 'exact' when equal after normalising or in one alias family,
 * 'prefix' when one name is the other plus extra words ("Ridgeway" / "Ridgeway Labs"), else null.
 */
export function companyKind(a, b, families = aliasFamilies()) {
  const x = norm(a), y = norm(b); if (!x || !y) return null;
  if (x === y || families.some(f => f.has(x) && f.has(y))) return 'exact';
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return long.startsWith(`${short} `) ? 'prefix' : null;
}

// Seniority, generic job words and filler never make two roles the same ("Senior Data Analyst" is not "Senior Product Manager").
export const ROLE_STOPWORDS = new Set(['senior', 'sr', 'junior', 'jr', 'middle', 'mid', 'lead', 'head', 'principal', 'staff', 'chief', 'manager', 'engineer', 'developer', 'specialist', 'associate', 'of', 'the', 'and', 'for', 'in', 'at', 'to', 'with',
  'старший', 'младший', 'ведущий', 'главный', 'руководитель', 'менеджер', 'инженер', 'разработчик', 'специалист', 'по']);

// The duplicate check also ignores the words nearly every title in a product search shares, so two openings at one
// company are only one role when their distinguishing words match. settings.queue.role_stopwords adds more.
const DEDUPE_EXTRA = ['product', 'owner', 'продукта', 'продукту', 'mfd'];
export const dedupeStopwords = (extra = SETTINGS.queue?.role_stopwords) =>
  new Set([...ROLE_STOPWORDS, ...DEDUPE_EXTRA, ...(Array.isArray(extra) ? extra : []).map(norm).filter(Boolean)]);
const NO_STOPWORDS = new Set();

/** Normalised words of a role title longer than 2 characters, without the given stoplist (default ROLE_STOPWORDS). */
export const roleWords = (role, stop = ROLE_STOPWORDS) => new Set(norm(role).split(' ').filter(w => w.length > 2 && !stop.has(w)));

/** Shared role words divided by the smaller set; 0 when either role has no words left. */
export function roleOverlap(a, b, stop = ROLE_STOPWORDS) {
  const x = roleWords(a, stop), y = roleWords(b, stop);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const w of y) if (x.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

/**
 * The duplicate check against applications: more than half of the smaller title's words shared, after
 * dedupeStopwords(). "Software Engineer, Backend" and "Software Engineer, Mobile" share only half: two roles.
 */
export const sameRoleForDedupe = (a, b, stop = dedupeStopwords()) => roleOverlap(a, b, stop) > 0.5;

/** Words of a role title the picks compare: every normalised word longer than 2 characters, no stoplist. */
export const pickRoleWords = role => roleWords(role, NO_STOPWORDS);
/**
 * The picks' check that an application covers a job's role: half the smaller title's words shared, no stoplist; a
 * title with no such words on either side counts as the same process (the employer already matched).
 */
export function sameRole(a, b) {
  if (!pickRoleWords(a).size || !pickRoleWords(b).size) return true;
  return roleOverlap(a, b, NO_STOPWORDS) >= 0.5;
}

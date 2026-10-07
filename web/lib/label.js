// Pure logic for the labelling screen (/label?set=<name>): keys, progress, where to go after a save. No DOM.

export const SURFACES = ['yes', 'no', 'unsure'];
// e.code as well as e.key, so Y, N and U work on a Cyrillic layout too
const LETTER = { y: 'yes', n: 'no', u: 'unsure', KeyY: 'yes', KeyN: 'no', KeyU: 'unsure' };
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * The action for a key press on the labelling screen, or null. e: { key, code, ctrlKey, metaKey, altKey, tag }.
 * Y, N, U choose; Enter saves and goes on (in the reason field too); arrows move; Escape leaves a field.
 * While typing in a field, only Enter and Escape count.
 */
export function labelKey(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Escape') return { action: 'blur' };
  const tag = String(e.tag || '').toUpperCase(), typing = TYPING.has(tag);
  if (e.key === 'Enter') return tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' ? null : { action: 'save' };   // a focused button or link keeps its own Enter
  if (typing) return null;
  if (e.key === 'ArrowRight') return { action: 'next' };
  if (e.key === 'ArrowLeft') return { action: 'prev' };
  const s = LETTER[String(e.key || '').toLowerCase()] || LETTER[e.code];
  return s ? { action: 'choose', surface: s } : null;
}

/** A label can be saved when a surface is chosen; Unsure needs a reason (which fact is missing). */
export const canSave = (surface, reason) => SURFACES.includes(surface) && (surface !== 'unsure' || !!String(reason || '').trim());

/** The index to show after saving `index`: the next unlabelled job after it (wrapping), else the next one, else the same. */
export function afterSave(files, labels, index) {
  const n = files.length;
  for (let k = 1; k <= n; k++) { const i = (index + k) % n; if (!labels[files[i]]) return i; }
  return Math.min(index + 1, n - 1);
}
/** { done, total }: how many jobs have a label. */
export const progress = (files, labels) => ({ done: files.filter(f => labels[f]).length, total: files.length });
/** One step from `index`, staying inside the list. */
export const step = (files, index, by) => Math.max(0, Math.min(files.length - 1, index + by));
/** The set name from a location search string ("?set=x"), or ''. */
export const setFromSearch = search => { try { return new URLSearchParams(search).get('set') || ''; } catch { return ''; } };
/**
 * profile/eval-rubric.md as plain blocks for the panel: [{ kind: "h" | "li" | "p", text }]. Headings ("#" to "####")
 * and list items ("-", "*", "1.") are recognised; ** and ` marks are dropped; no HTML is ever produced.
 */
export function rubricBlocks(md) {
  const clean = s => s.replace(/\*\*|__|`/g, '').trim();
  return String(md || '').replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    if (/^#{1,4}\s/.test(l)) return { kind: 'h', text: clean(l.replace(/^#+\s*/, '')) };
    if (/^([-*]|\d+\.)\s/.test(l)) return { kind: 'li', text: clean(l.replace(/^([-*]|\d+\.)\s+/, '')) };
    return { kind: 'p', text: clean(l) };
  });
}

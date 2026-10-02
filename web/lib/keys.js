// The keyboard map for the desktop screen. Pure: it turns a key event's fields into an action name.

/** Keys on the main screen -> action. */
export const KEYMAP = Object.freeze({ j: 'next', k: 'prev', a: 'applied', s: 'skip', l: 'later', o: 'open', '/': 'search', '?': 'help', Escape: 'close' });
/** What the help overlay lists: [key, label key]. */
export const KEY_HELP = [['j', 'ws.key.next'], ['k', 'ws.key.prev'], ['a', 'ws.key.applied'], ['s', 'ws.key.skip'], ['l', 'ws.key.later'],
  ['o', 'ws.key.open'], ['/', 'ws.key.search'], ['?', 'ws.key.help'], ['Esc', 'ws.key.close']];

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/**
 * The action for a key press, or null. e: { key, ctrlKey, metaKey, altKey, tag, editable }; mode: "main", or the
 * open dialog: "skip" (1 to `reasons` picks a reason: { action: "skip-reason", index }), "later" (1, 3 or 7:
 * { action: "later-days", days }), "help". While typing in a field only Escape counts (it leaves the field).
 * Returns { action, ... }.
 */
export function keyAction(e, mode = 'main', { reasons = 8, laterDays = [1, 3, 7] } = {}) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key;
  if (key === 'Escape') return { action: 'close' };
  if (TYPING.has(String(e.tag || '').toUpperCase()) || e.editable) return null;
  if (mode === 'skip') { const n = Number(key); return Number.isInteger(n) && n >= 1 && n <= reasons ? { action: 'skip-reason', index: n - 1 } : null; }
  if (mode === 'later') { const n = Number(key); return laterDays.includes(n) ? { action: 'later-days', days: n } : null; }
  if (mode === 'help') return key === '?' ? { action: 'close' } : null;
  const action = KEYMAP[key] ?? KEYMAP[String(key).toLowerCase()];
  return action ? { action } : null;
}

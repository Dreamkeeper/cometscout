// Label lookup for the browser: the table comes from /api/labels (lib/i18n.mjs, settings.locale). Pure.

// Enough to say that the server is unreachable before the table has loaded.
export const FALLBACK = Object.freeze({ 'ws.error': 'The server did not answer: {error}', 'ws.retry': 'Try again', 'ws.loading': 'Loading' });

/** A translate function: the label for key with {placeholders} filled from vars; the fallback, then the key itself, when missing. */
export function makeT(labels = {}) {
  return (key, vars = {}) => String(labels[key] ?? FALLBACK[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}

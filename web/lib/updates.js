// The update banner and the What is new screen, as plain logic (no DOM): node --test runs it.

/** The banner for GET /api/update, or null: a newer version that was not skipped. */
export function bannerFor(u) {
  if (!u || !u.available || u.skipped || !u.latest) return null;
  return { version: u.latest, current: u.current, pending: u.pending === u.latest, behaviour: !!u.behaviour_changes };
}

/** A setting's value as the screen shows it: lists joined, text quoted, nothing as "none". */
export function showValue(v) {
  if (v === null || v === undefined || v === '') return 'none';
  if (Array.isArray(v)) return v.join(', ');
  return typeof v === 'string' ? `"${v}"` : String(v);
}

/** True when a release in the What is new payload has anything to show. */
export const hasNotes = r => !!r && ['highlights', 'new', 'changed', 'action_needed', 'changed_defaults', 'media'].some(k => Array.isArray(r[k]) && r[k].length);

/** The settings dialog's field for a writable key (days, time, prep_days); null for anything else. */
export const SETTING_FIELDS = { days: 'setting-days', time: 'setting-time', prep_days: 'setting-prep_days' };
export const fieldFor = key => (Object.hasOwn(SETTING_FIELDS, key || '') ? SETTING_FIELDS[key] : null);

/** The body of POST /api/settings that accepts a changed default ({ time: "19:00" }), or null when it cannot be written here. */
export const acceptPatch = d => (d && fieldFor(d.key) ? { [d.key]: d.default } : null);

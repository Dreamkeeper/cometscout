// Applications as CSV, a one-way view next to the archive: node cli.mjs export --csv <file>.
// Columns: Company, Role, Status, Applied, Last activity, Source, Link, Notes. UTF-8 with a BOM and CRLF line ends, so
// Excel opens Cyrillic and other non-Latin text correctly; fields with commas, quotes or line breaks are quoted.
import fs from 'node:fs';
import path from 'node:path';
import { STATE, today } from './config.mjs';
import { readApplications } from './queue.mjs';
import { toRow, queueMeta } from './tracker.mjs';

export const CSV_HEADER = ['Company', 'Role', 'Status', 'Applied', 'Last activity', 'Source', 'Link', 'Notes'];
/** One CSV field. A value starting with = + - @ gets a leading ' so a spreadsheet never runs it as a formula. */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const day = v => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : '');

/** The CSV text (with BOM) for an applications.json object. */
export function applicationsCsv({ apps = readApplications(STATE('applications.json')), date = today(), meta = queueMeta } = {}) {
  const rows = Object.entries(apps || {}).filter(([, a]) => a && typeof a === 'object').map(([k, a]) => {
    const r = toRow(k, a, meta(k), date);
    const events = (a.events || []).filter(e => e && typeof e === 'object');
    const applied = events.filter(e => e.type === 'applied').map(e => day(e.date)).filter(Boolean).sort()[0] || day(a.applied) || (a.status && a.status !== 'skipped' ? r.dateApplied : '');
    const note = a.note || [...events].reverse().find(e => e.note)?.note || '';
    return [r.company, r.role, a.status || '', applied, r.lastActivity, r.source, r.link, note];
  }).sort((x, y) => (x[3] || '9999').localeCompare(y[3] || '9999') || x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
  return '﻿' + [CSV_HEADER, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
/** Write the CSV to `out`. Returns { out, rows }. */
export function writeApplicationsCsv(out, opts) {
  const text = applicationsCsv(opts); const abs = path.resolve(out);
  fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text, 'utf8');
  return { out: abs, rows: text.split('\r\n').length - 2 };
}

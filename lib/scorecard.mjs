// Source scorecard: which source earns its price. Writes data/reports/source-scorecard.md.
//   node cli.mjs sources-report [--send]
// settings.sources_report = {
//   enabled: false,              // cli.mjs run builds it after the digest and sends it (see --send)
//   window_days: 30,
//   prices: { "rtj": { "price_month": 10, "currency": "USD", "renews": "2026-12-01", "decision": "under review" },
//             "some-premium-plan": { "feed": false, "price_month": 20, "currency": "EUR" } }   // feed: false = not a job feed
// }
// Price keys are source names as the queue files carry them (rtj, linkedin, hh, ats:greenhouse ...); a source with a
// ":" and no price of its own uses the price of the part before it ("openclaw" for "openclaw:web-search").
// --send sends a short Telegram version on the 1st of the month and when a "renews" date is 7 days away or less,
// once per occasion (data/state/sources-report.json remembers what was sent).
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, DATA, DIRS, STATE, read, readJson, today, num } from './config.mjs';
import { frontMatter, parseResult } from './queue.mjs';
import { readSightings } from './sightings.mjs';
import { companyMatch, roleOverlap } from './match.mjs';
import { isApplication, furthestStage, queueMeta } from './tracker.mjs';
import { translator } from './i18n.mjs';
import { APPLY_WORTHY } from '../decoder/digest.mjs';

export const SAME_JOB_DAYS = 7;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 864e5;
const minus = (date, n) => new Date(Date.parse(date) - n * 864e5).toISOString().slice(0, 10);
const UNKNOWN = '(unknown)';
const cfg = () => SETTINGS.sources_report || {};
export const REPORT_FILE = () => path.join(DATA, 'reports', 'source-scorecard.md');
const STATE_FILE = () => STATE('sources-report.json');

/** Every queue file: { file, dir, source, company, role, found, verdict }. */
function queueFiles() {
  const out = [];
  for (const dir of ['inbox', 'decoded', 'rejected']) for (const f of fs.readdirSync(DIRS[dir])) {
    if (!f.endsWith('.md')) continue;
    const t = read(path.join(DIRS[dir], f)); const fm = frontMatter(t);
    out.push({ file: f, dir, source: fm.source || UNKNOWN, company: fm.company, role: fm.role, found: DATE.test(fm.found || '') ? fm.found : f.slice(0, 10), verdict: dir === 'inbox' ? null : parseResult(t).verdict });
  }
  return out;
}

/** True when another source saw this job within SAME_JOB_DAYS: the same file, or the same company and role. */
export function seenElsewhere(job, sightings) {
  return sightings.some(s => s.source && s.source !== job.source && DATE.test(String(s.date || '')) && Math.abs(days(s.date, job.found)) <= SAME_JOB_DAYS
    && ((s.where && path.basename(s.where) === job.file) || (companyMatch(s.company, job.company) && roleOverlap(s.role, job.role) >= 0.5)));
}

/** The numbers, per source. */
export function scorecard({ date = today(), window = num(cfg().window_days, 30, 1, 3650), prices = cfg().prices || {} } = {}) {
  const since = minus(date, window);
  const files = queueFiles(), sightings = readSightings();
  // queue files count as sightings too, so jobs queued before sightings.jsonl existed are not "only here" by mistake
  const seen = [...sightings, ...files.map(f => ({ source: f.source, company: f.company, role: f.role, date: f.found, where: `${f.dir}/${f.file}` }))];
  const rows = new Map();
  const row = s => { if (!rows.has(s)) rows.set(s, { source: s, queued: 0, worth: 0, only: 0, picks: 0, applied: 0, past: 0 }); return rows.get(s); };
  const bySource = new Map(files.map(f => [f.file, f.source]));
  for (const f of files) {
    if (f.found < since || f.found > date) continue;
    const r = row(f.source); r.queued++;
    if (!APPLY_WORTHY.includes(f.verdict)) continue;
    r.worth++;
    if (!seenElsewhere(f, seen)) r.only++;
  }
  for (const [file, p] of Object.entries(readJson(STATE('picks.json'), {}))) if (String(p?.last || '') >= since) row(bySource.get(file) || UNKNOWN).picks++;
  for (const [key, a] of Object.entries(readJson(STATE('applications.json'), {}))) {
    if (!isApplication(a)) continue;
    const r = row(queueMeta(key).source || a.source || '(manual)'); r.applied++;
    if (furthestStage(a) !== 'Applied') r.past++;
  }
  // a priced feed with no jobs yet still gets its row, unless sources such as "<key>:something" carry its price
  const feeds = Object.entries(prices).filter(([, p]) => p && p.feed !== false);
  for (const [s] of feeds) if (![...rows.keys()].some(k => k === s || k.startsWith(`${s}:`))) row(s);
  for (const r of rows.values()) {
    const p = priceFor(prices, r.source);
    if (p && p.feed !== false && num(p.price_month, null, 0) != null) {
      r.price = { month: num(p.price_month, 0, 0), currency: p.currency || '', renews: p.renews || '', decision: p.decision || '' };
      if (r.only) r.price.perOnly = r.price.month * (window / 30) / r.only;
    }
  }
  const notFeeds = Object.entries(prices).filter(([, p]) => p && p.feed === false).map(([source, p]) => ({ source, month: num(p.price_month, 0, 0), currency: p.currency || '', renews: p.renews || '', decision: p.decision || '' }));
  const list = [...rows.values()].sort((a, b) => b.queued - a.queued || a.source.localeCompare(b.source));
  return { date, window, since, rows: list, notFeeds };
}

/** The price entry for a source: its own, else the one for the part before ":". */
export const priceFor = (prices, source) => prices[source] ?? (String(source).includes(':') ? prices[String(source).split(':')[0]] : undefined);

const money = (n, cur) => `${Math.round(n * 100) / 100}${cur ? ` ${cur}` : ''}`;
/** The Markdown report. */
export function markdown(sc) {
  const L = [`# Source scorecard, ${sc.date}`, '', `Last ${sc.window} days (${sc.since} to ${sc.date}); applied and past application are all time.`, '',
    '| Source | Queued | Worth applying | Only here | Picks shown | Applied | Past application | Price a month | Per only-here role | Renews | Decision |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|'];
  for (const r of sc.rows) L.push(`| ${r.source} | ${r.queued} | ${r.worth} | ${r.only} | ${r.picks} | ${r.applied} | ${r.past} | ${r.price ? money(r.price.month, r.price.currency) : ''} | ${r.price ? (r.price.perOnly != null ? money(r.price.perOnly, r.price.currency) : 'none only here') : ''} | ${r.price?.renews || ''} | ${r.price?.decision || ''} |`);
  if (!sc.rows.length) L.push('| (nothing queued yet) | | | | | | | | | | |');
  if (sc.notFeeds.length) L.push('', 'Not a job feed:', ...sc.notFeeds.map(n => `- ${n.source}: ${money(n.month, n.currency)} a month${n.renews ? `, renews ${n.renews}` : ''}${n.decision ? `, ${n.decision}` : ''}`));
  L.push('', `Worth applying: decoded strong-fit or investable-stretch. Only here: worth applying, and no other source sighted the same company and role within ${SAME_JOB_DAYS} days. Past application: reached screen, interview or offer (an accepted offer counts as an offer).`);
  return L.join('\n') + '\n';
}

/** The short Telegram version, one line per source, in settings.locale. */
export function telegramText(sc, t = translator()) {
  const L = [t('report.header', { days: sc.window })];
  for (const r of sc.rows) {
    const extra = r.price ? [t('report.price', { price: money(r.price.month, r.price.currency) }),
      r.price.perOnly != null ? t('report.per_only', { price: money(r.price.perOnly, r.price.currency) }) : t('report.no_only'),
      ...(r.price.renews ? [t('report.renews', { date: r.price.renews })] : [])] : [];
    L.push(`${t('report.line', { source: r.source, queued: r.queued, worth: r.worth, only: r.only, applied: r.applied })}${extra.length ? `; ${extra.join(', ')}` : ''}`);
  }
  for (const n of sc.notFeeds) L.push(`${t('report.not_feed', { source: n.source, price: money(n.month, n.currency) })}${n.renews ? `, ${t('report.renews', { date: n.renews })}` : ''}`);
  return L.join('\n');
}

/** Occasions to send on this date: the 1st of the month, and each renewal 7 days away or less. */
export function sendTriggers(date, prices = cfg().prices || {}) {
  const keys = [];
  if (date.endsWith('-01')) keys.push(`month:${date.slice(0, 7)}`);
  for (const [s, p] of Object.entries(prices)) if (DATE.test(String(p?.renews || ''))) { const d = days(p.renews, date); if (d >= 0 && d <= 7) keys.push(`renews:${s}:${p.renews}`); }
  return keys;
}

/**
 * Build, write and print the report; with send, send the Telegram text when a trigger has not been sent yet.
 * send: async (text) => true when delivered (lib/telegram.mjs sendText). Returns { file, markdown, text, triggers, sent }.
 */
export async function sourcesReport({ send = null, date = today(), print = console.log } = {}) {
  const sc = scorecard({ date });
  const md = markdown(sc), text = telegramText(sc), file = REPORT_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md, 'utf8');
  print(md);
  let sent = false, pending = [];
  if (send) {
    const state = readJson(STATE_FILE(), {}); state.sent = state.sent || {};
    pending = sendTriggers(date).filter(k => !state.sent[k]);
    if (pending.length && await send(text)) {
      sent = true;
      for (const k of pending) state.sent[k] = date;
      const old = minus(date, 400);
      for (const [k, d] of Object.entries(state.sent)) if (d < old) delete state.sent[k];
      fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 1));
    } else if (pending.length) print('sources-report: Telegram delivery is off; the short version was not sent');
  }
  return { file, markdown: md, text, triggers: pending, sent, scorecard: sc };
}

/** cli.mjs sources-report [--send]: never a stack trace. A failed Telegram send is logged (the report is written first). */
export async function sourcesReportCommand({ send = null, print = console.log } = {}) {
  try {
    const r = await sourcesReport({ send, print });
    print(r.sent ? 'sources-report: sent to Telegram' : `sources-report: written to ${r.file}`);
    return 0;
  } catch (e) { print(`sources-report stopped: ${e.message}${fs.existsSync(REPORT_FILE()) ? ` (the report is in ${REPORT_FILE()})` : ''}`); return 1; }
}

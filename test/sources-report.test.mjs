// Source scorecard: sightings from writeJob (duplicates too, trimmed by cli.mjs run only), the per-source table, "only here",
// prices, the short Telegram text and when it is sent. Synthetic queue files and applications; Telegram is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-scorecard-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
process.env.COMETSCOUT_RUN_DATE = '2026-10-01';
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({
  timezone: 'UTC',
  sources_report: {
    enabled: true, window_days: 30,
    prices: { rtj: { price_month: 10, currency: 'USD', renews: '2026-10-05', decision: 'under review' }, 'premium-plan': { feed: false, price_month: 20, currency: 'EUR' } },
  },
}));
const DATA = process.env.COMETSCOUT_DATA;
const STATE = n => path.join(DATA, 'state', n);
const SIGHTINGS = STATE('sightings.jsonl');
for (const d of ['inbox', 'decoded', 'rejected', 'state']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

// Sightings from before this run: one past the 120 days, one recent.
fs.writeFileSync(SIGHTINGS, [{ date: '2026-05-01', source: 'rtj', company: 'Old', role: 'Old', result: 'written' }, { date: '2026-09-29', source: 'hh', company: 'Recent', role: 'PM', result: 'written' }].map(s => JSON.stringify(s)).join('\n') + '\n');
// Queue files written before sightings existed: the same Zeta Labs role from two sources, and one outside the window.
const queueFile = (dir, file, fm, verdict) => fs.writeFileSync(path.join(DATA, dir, file),
  `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${k === 'found' ? v : `"${v}"`}`).join('\n')}\n---\n\n# ${fm.company} - ${fm.role}\n\ntext\n${verdict ? `\n## Decode Result\nDecoded ${fm.found} by CometScout (test).\nverdict: ${verdict}\nconfidence: high\n` : ''}`);
queueFile('decoded', '2026-09-25--zeta-labs--product-manager.md', { company: 'Zeta Labs', role: 'Product Manager', url: 'https://jobs.example/z/1', source: 'linkedin', found: '2026-09-25' }, 'strong-fit');
queueFile('decoded', '2026-09-28--zeta-labs--product-manager.md', { company: 'Zeta Labs', role: 'Product Manager', url: 'https://boards.example/zeta/9', source: 'rtj', found: '2026-09-28' }, 'investable-stretch');
queueFile('decoded', '2026-08-01--epsilon--designer.md', { company: 'Epsilon', role: 'Designer', url: 'https://jobs.example/e/1', source: 'ats:greenhouse', found: '2026-08-01' }, 'strong-fit');

const { writeJob } = await import('../lib/queue.mjs');
const sightings = await import('../lib/sightings.mjs');
const sc = await import('../lib/scorecard.mjs');
const { translator } = await import('../lib/i18n.mjs');

// Decode a job by hand: move it from the inbox with a result block.
const decode = (file, verdict) => {
  const t = fs.readFileSync(path.join(DATA, 'inbox', file), 'utf8'); fs.rmSync(path.join(DATA, 'inbox', file));
  fs.writeFileSync(path.join(DATA, ['weak-fit', 'gate-reject'].includes(verdict) ? 'rejected' : 'decoded', file), `${t}\n## Decode Result\nDecoded 2026-10-01 by CometScout (test).\nverdict: ${verdict}\n`);
};

test('writeJob records a sighting per call, duplicates included, and only appends', () => {
  const acme = writeJob({ company: 'Acme', role: 'Product Manager', url: 'https://jobs.example/acme/1', source: 'rtj', text: 'x' });
  const dup = writeJob({ company: 'Acme', role: 'Product Manager', url: 'https://www.linkedin.example/jobs/view/42', source: 'linkedin', text: 'x' });
  writeJob({ company: 'Beta', role: 'Product Owner', url: 'https://jobs.example/beta/1', source: 'rtj', text: 'x' });
  assert.equal(acme.written, true); assert.equal(dup.written, false);
  const s = sightings.readSightings();
  assert.deepEqual(s.map(x => x.company), ['Old', 'Recent', 'Acme', 'Acme', 'Beta'], 'writeJob never rewrites the file, so the old line is still there');
  assert.deepEqual(s.slice(2, 4).map(x => [x.source, x.result, x.where]), [['rtj', 'written', `inbox/${acme.file}`], ['linkedin', 'duplicate', `inbox/${acme.file}`]]);
  assert.deepEqual(Object.keys(s[2]), ['date', 'source', 'company', 'role', 'url', 'result', 'where']);
  assert.equal(s[2].date, '2026-10-01');
  assert.ok(!fs.existsSync(STATE('sightings-trim.json')));
  assert.equal(sightings.trimSightings({ date: '2026-10-01' }), 1, 'the 2026-05-01 line is past 120 days');
  assert.deepEqual(sightings.readSightings().map(x => x.company), ['Recent', 'Acme', 'Acme', 'Beta']);
  assert.equal(sightings.trimSightings({ date: '2026-10-01' }), 0);
});

test('cli.mjs run trims sightings once, before the sources start', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-scorecard-run-'));
  fs.mkdirSync(path.join(home, 'profile')); fs.writeFileSync(path.join(home, 'profile', 'profile.md'), '# Test Person\n\nSynthetic profile.\n');
  fs.mkdirSync(path.join(home, 'data', 'state'), { recursive: true });
  const file = path.join(home, 'data', 'state', 'sightings.jsonl');
  fs.writeFileSync(file, [{ date: '2026-01-01', source: 'rtj', company: 'Old' }, { date: '2026-09-30', source: 'rtj', company: 'Kept' }].map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ timezone: 'UTC', pack: { enabled: false } }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'run'], { encoding: 'utf8',
    env: { ...process.env, COMETSCOUT_HOME: home, COMETSCOUT_DATA: path.join(home, 'data'), COMETSCOUT_SETTINGS: path.join(home, 'settings.json') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).company), ['Kept']);
});

test('the table counts queued, worth applying, only here, picks, applied and past application per source', () => {
  writeJob({ company: 'Gamma', role: 'Analyst', url: 'https://jobs.example/gamma/1', source: 'linkedin', text: 'x' });
  writeJob({ company: 'Delta', role: 'Product Lead', url: 'https://jobs.example/delta/1', source: 'hh', text: 'x' });
  decode('2026-10-01--acme--product-manager.md', 'strong-fit');
  decode('2026-10-01--beta--product-owner.md', 'investable-stretch');
  decode('2026-10-01--gamma--analyst.md', 'weak-fit');
  decode('2026-10-01--delta--product-lead.md', 'long-shot');
  fs.writeFileSync(STATE('picks.json'), JSON.stringify({ '2026-10-01--beta--product-owner.md': { shown: 2, last: '2026-09-30' }, '2026-08-01--epsilon--designer.md': { shown: 1, last: '2026-08-02' } }));
  fs.writeFileSync(STATE('applications.json'), JSON.stringify({
    '2026-10-01--acme--product-manager.md': { company: 'Acme', role: 'Product Manager', status: 'applied', updated: '2026-10-01', events: [{ date: '2026-10-01', type: 'applied' }, { date: '2026-10-01', type: 'interview' }] },
    '2026-08-01--epsilon--designer.md': { company: 'Epsilon', role: 'Designer', status: 'rejected', updated: '2026-08-20', events: [{ date: '2026-08-05', type: 'applied' }] },
    'manual:kite|pm': { company: 'Kite', role: 'PM', status: 'applied', updated: '2026-09-10' },
    'manual:loom|pm': { company: 'Loom', role: 'PM', status: 'skipped', updated: '2026-09-10' },
    'manual:orbit|data pm': { company: 'Orbit', role: 'Data PM', status: 'accepted', updated: '2026-09-12', events: [{ date: '2026-09-01', type: 'applied' }, { date: '2026-09-12', type: 'accepted' }] },
  }));
  const r = sc.scorecard({ date: '2026-10-01' });
  const by = Object.fromEntries(r.rows.map(x => [x.source, x]));
  const pick = x => ({ queued: x.queued, worth: x.worth, only: x.only, picks: x.picks, applied: x.applied, past: x.past });
  assert.deepEqual(pick(by.rtj), { queued: 3, worth: 3, only: 1, picks: 1, applied: 1, past: 1 }, 'Acme was sighted by linkedin too, Zeta Labs came from linkedin 3 days earlier; Beta is only here');
  assert.deepEqual(pick(by.linkedin), { queued: 2, worth: 1, only: 0, picks: 0, applied: 0, past: 0 }, 'Zeta Labs was seen by rtj too');
  assert.deepEqual(pick(by.hh), { queued: 1, worth: 0, only: 0, picks: 0, applied: 0, past: 0 });
  assert.deepEqual(pick(by['ats:greenhouse']), { queued: 0, worth: 0, only: 0, picks: 0, applied: 1, past: 0 }, 'outside the window; applications are all time');
  assert.equal(by['(manual)'].applied, 2, 'a manual record counts; a skipped role does not');
  assert.equal(by['(manual)'].past, 1, 'an accepted offer counts where an offer counts');
  assert.deepEqual(by.rtj.price, { month: 10, currency: 'USD', renews: '2026-10-05', decision: 'under review', perOnly: 10 });
  assert.deepEqual(r.notFeeds.map(n => n.source), ['premium-plan']);
  assert.ok(!by['premium-plan'], 'not a job feed: listed under the table, not in it');
  assert.equal(r.rows[0].source, 'rtj', 'sorted by queued');

  const md = sc.markdown(r);
  assert.match(md, /\| rtj \| 3 \| 3 \| 1 \| 1 \| 1 \| 1 \| 10 USD \| 10 USD \| 2026-10-05 \| under review \|/);
  assert.match(md, /\| linkedin \| 2 \| 1 \| 0 \| 0 \| 0 \| 0 \|  \|  \|  \|  \|/);
  assert.match(md, /Not a job feed:\n- premium-plan: 20 EUR a month/);
  assert.ok(!md.includes('—'), 'no em dashes');
});

test('the only-here rule: same company and role within 7 days either side, from another source', () => {
  const job = { file: 'f.md', source: 'rtj', company: 'Acme', role: 'Product Manager', found: '2026-10-01' };
  const seen = s => sc.seenElsewhere(job, [{ source: 'linkedin', company: 'Acme', role: 'Product Manager', date: '2026-10-01', ...s }]);
  assert.equal(seen({}), true);
  assert.equal(seen({ date: '2026-10-08' }), true, '7 days later');
  assert.equal(seen({ date: '2026-09-24' }), true, '7 days earlier');
  assert.equal(seen({ date: '2026-10-09' }), false, '8 days later');
  assert.equal(seen({ source: 'rtj' }), false, 'the same source again');
  assert.equal(seen({ role: 'Data Analyst' }), false);
  assert.equal(seen({ company: 'Northwind' }), false);
  assert.equal(seen({ company: 'Other', role: 'Other', where: 'inbox/f.md' }), true, 'a duplicate of the same file');
});

test('the Telegram text is one line per source, in the locale', () => {
  const r = sc.scorecard({ date: '2026-10-01' });
  const en = sc.telegramText(r, translator('en')).split('\n');
  assert.equal(en[0], 'Sources, last 30 days');
  assert.ok(en.includes('rtj: 3 queued, 3 worth applying, 1 only here, 1 applied; 10 USD a month, 10 USD per only-here role, renews 2026-10-05'), en.join('\n'));
  assert.ok(en.includes('linkedin: 2 queued, 1 worth applying, 0 only here, 0 applied'));
  assert.ok(en.includes('premium-plan: 20 EUR a month, not a job feed'));
  assert.equal(en.length, 1 + r.rows.length + 1);
  const ru = sc.telegramText(r, translator('ru'));
  assert.match(ru, /^Источники, окно 30 дн\./);
  assert.match(ru, /rtj: в очереди 3, стоит откликнуться 3, только здесь 1, откликов 1; 10 USD в месяц/);
});

test('--send: on the 1st and within 7 days of a renewal, once per occasion', async () => {
  assert.deepEqual(sc.sendTriggers('2026-10-01'), ['month:2026-10', 'renews:rtj:2026-10-05']);
  assert.deepEqual(sc.sendTriggers('2026-09-28'), ['renews:rtj:2026-10-05'], '7 days before');
  assert.deepEqual(sc.sendTriggers('2026-09-27'), [], '8 days before');
  assert.deepEqual(sc.sendTriggers('2026-10-03'), ['month:2026-10', 'renews:rtj:2026-10-05'], 'the month report stays due for the first 7 days (an off day on the 1st)');
  assert.deepEqual(sc.sendTriggers('2026-10-08'), [], 'not after the 7th');
  assert.deepEqual(sc.sendTriggers('2026-10-06'), ['month:2026-10'], 'after the renewal (the month report is still due, sent once)');

  const sent = []; const send = async t => { sent.push(t); return true; };
  const quiet = () => {};
  const off = await sc.sourcesReport({ date: '2026-10-01', send: async () => false, print: quiet });
  assert.equal(off.sent, false, 'Telegram off: nothing is marked sent');
  const first = await sc.sourcesReport({ date: '2026-10-01', send, print: quiet });
  assert.equal(first.sent, true);
  assert.deepEqual(first.triggers, ['month:2026-10', 'renews:rtj:2026-10-05']);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Sources, last 30 days\nrtj: /);
  assert.ok(fs.existsSync(path.join(DATA, 'reports', 'source-scorecard.md')));
  await sc.sourcesReport({ date: '2026-10-01', send, print: quiet });
  await sc.sourcesReport({ date: '2026-10-03', send, print: quiet });
  assert.equal(sent.length, 1, 'the same occasions are not sent again');
  await sc.sourcesReport({ date: '2026-11-01', send, print: quiet });
  assert.equal(sent.length, 2, 'the next 1st is a new occasion');
  const none = await sc.sourcesReport({ date: '2026-10-15', print: quiet });
  assert.equal(none.sent, false, 'without --send nothing is sent');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(STATE('sources-report.json'), 'utf8')).sent).sort(), ['month:2026-10', 'month:2026-11', 'renews:rtj:2026-10-05']);
});

test('a price falls back to the part before ":"', () => {
  queueFile('decoded', '2026-09-30--orbit--product-manager.md', { company: 'Orbit', role: 'Product Manager', url: 'https://jobs.example/orbit/1', source: 'openclaw:web-search', found: '2026-09-30' }, 'strong-fit');
  const prices = { openclaw: { price_month: 6, currency: 'USD' }, rtj: { price_month: 10, currency: 'USD' } };
  assert.equal(sc.priceFor(prices, 'openclaw:web-search'), prices.openclaw);
  assert.equal(sc.priceFor(prices, 'openclaw'), prices.openclaw);
  assert.equal(sc.priceFor(prices, 'linkedin'), undefined);
  assert.equal(sc.priceFor({ ...prices, 'openclaw:web-search': { price_month: 2 } }, 'openclaw:web-search').price_month, 2, 'its own price wins');
  const r = sc.scorecard({ date: '2026-10-01', prices });
  const by = Object.fromEntries(r.rows.map(x => [x.source, x]));
  assert.equal(by['openclaw:web-search'].price.month, 6);
  assert.equal(by['openclaw:web-search'].price.perOnly, 6);
  assert.ok(!by.openclaw, 'no empty row for the key when a source carries its price');
});

test('cli.mjs sources-report --send: a Telegram failure is a clear line and exit 1, never a stack trace', async () => {
  fs.rmSync(STATE('sources-report.json'), { force: true });   // the 1st of the month, not sent yet
  const lines = [];
  const code = await sc.sourcesReportCommand({ send: async () => { throw new Error('Telegram sendMessage 400: chat not found'); }, print: l => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.at(-1), /^sources-report stopped: Telegram sendMessage 400: chat not found \(the report is in .*source-scorecard\.md\)$/);
  assert.ok(!fs.existsSync(STATE('sources-report.json')), 'a failed send is not marked sent');
  const ok = await sc.sourcesReportCommand({ send: async () => true, print: l => lines.push(l) });
  assert.equal(ok, 0);
  assert.equal(lines.at(-1), 'sources-report: sent to Telegram');
});

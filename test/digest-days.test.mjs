// The evening digest with schedule.days and interview prep mode (decoder/decoder.mjs finishRun): an off day sends
// nothing and shows no picks, the next digest says what was held back (only days really held back), and before an
// interview at most one qualifying pick is shown while the rest wait without using up their showings.
// Telegram and links are injected fakes; synthetic companies only.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-digest-days-'));
const DATA = path.join(tmp, 'data');
const DAY = new Date().toISOString().slice(0, 10);
const addDays = n => { const d = new Date(`${DAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = DATA;
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
process.env.COMETSCOUT_RUN_DATE = DAY;
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC', candidate_name: 'Sam Example', picks: { per_day: 2, window_days: 14, max_shown: 3 } }));
for (const d of ['decoded', 'state', 'digests']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const d = await import('../decoder/decoder.mjs');
const { SETTINGS } = await import('../lib/config.mjs');
const { isoWeekday, dayLabel, ALL_DAYS } = await import('../lib/schedule.mjs');
const STATE = f => path.join(DATA, 'state', f);
const readState = (f, def) => { try { return JSON.parse(fs.readFileSync(STATE(f), 'utf8')); } catch { return def; } };
const digest = day => fs.readFileSync(path.join(DATA, 'digests', `${day}.md`), 'utf8');

let n = 0;
const job = (company, role, { verdict = 'strong-fit', priority = 1, ago = 0 } = {}) => {
  const day = addDays(-ago), file = `${day}--job-${++n}.md`;
  const fm = { company, role, url: `https://jobs.example/${n}`, location: 'Remote', source: 'ats_boards' };
  fs.writeFileSync(path.join(DATA, 'decoded', file), ['---', ...Object.entries(fm).map(([k, v]) => `${k}: "${v}"`), `found: ${day}`, '---', '', `# ${company} - ${role}`, '', 'text', '',
    '## Decode Result', `Decoded ${day} by CometScout (claude/sonnet).`, `verdict: ${verdict}`, 'confidence: high', `apply_priority: ${priority}`, 'rationale: r', 'action: Apply on the company site.', ''].join('\n'));
  return { file, fm, v: { verdict, apply_priority: priority, action: 'Apply on the company site.', decoded_on: day } };
};
const alive = async () => ({ ok: true, status: 200, url: '', text: async () => '<html>open</html>' });
const telegram = () => { const sent = []; const send = async t => { sent.push(t); return true; }; send.sent = sent; return send; };
const onlyOff = day => ALL_DAYS.filter(x => x !== isoWeekday(day));
const run = (opts) => d.finishRun({ evening: true, time: '18:00', fetch: alive, ...opts });

beforeEach(() => {
  for (const dir of ['decoded', 'state', 'digests']) for (const f of fs.readdirSync(path.join(DATA, dir))) fs.rmSync(path.join(DATA, dir, f));
  fs.writeFileSync(STATE('applications.json'), '{}');
  SETTINGS.schedule = { days: ALL_DAYS, time: '18:00' };
  SETTINGS.picks = { per_day: 2, window_days: 14, max_shown: 3 };
  SETTINGS.modules = {};
});

test('off day: no Telegram call, picks unchanged, the digest file says so; the next digest names the held-back days only', async () => {
  const a = job('Brightwater', 'Product Manager'); job('Cedarline', 'Product Owner', { priority: 2, ago: 1 });
  SETTINGS.schedule.days = onlyOff(DAY);
  const send = telegram();
  const r = await run({ done: [a], date: DAY, send });
  assert.equal(r.off, true);
  assert.deepEqual(send.sent, [], 'nothing sent');
  assert.deepEqual(readState('picks.json', {}), {}, 'nothing counted as shown');
  assert.match(digest(DAY).split('\n')[0], /^Off day \(.+\): this digest was not sent and no picks were shown\./);
  assert.match(digest(DAY), /Worth applying \(1\)/, 'the decodes are still in the file');
  assert.deepEqual(readState('digest-days.json', {}).held, [{ date: DAY, decoded: 1, worth: 1 }]);
  // a manual decode on the same day is not the evening run: no off day
  assert.equal((await d.finishRun({ done: [], date: DAY, time: '18:00', fetch: alive, send: telegram(), noTg: true })).off, false);
  fs.rmSync(STATE('picks.json'), { force: true });

  // the next digest day: the held-back line first, then the picks
  SETTINGS.schedule.days = ALL_DAYS;
  const send2 = telegram();
  const r2 = await run({ done: [], date: addDays(1), send: send2 });
  assert.equal(send2.sent.length, 1);
  assert.equal(send2.sent[0].split('\n')[0], `Held back on ${dayLabel(DAY)}: 1 decoded, 1 worth applying. They are in the picks pool.`);
  assert.equal(r2.pk.picks.length, 2);
  assert.deepEqual(readState('digest-days.json', {}).held, [], 'cleared once said');

  // a day whose digest was sent (addDays(1)) is never counted; only the next off day is
  SETTINGS.schedule.days = onlyOff(addDays(2));
  await run({ done: [], date: addDays(2), send: telegram() });
  SETTINGS.schedule.days = ALL_DAYS;
  const send3 = telegram();
  await run({ done: [], date: addDays(3), send: send3 });
  const first = send3.sent[0].split('\n')[0];
  assert.equal(first, `Held back on ${dayLabel(addDays(2))}: 0 decoded, 0 worth applying. They are in the picks pool.`);
  assert.ok(!first.includes(dayLabel(DAY)) && !first.includes(dayLabel(addDays(1))));
});

const interview = (date, time = '', company = 'Harborview') => fs.writeFileSync(STATE('applications.json'), JSON.stringify({
  'manual:harborview|pm': { company, role: 'Product Manager', status: 'interview', updated: DAY,
    events: [{ date: DAY, type: 'interview', event_date: date, ...(time ? { event_time: time } : {}), round: 2, source: 'cli' }] },
}, null, 1));

test('prep mode: interview tomorrow, at most one qualifying pick; today\'s finds listed for after the interview', async () => {
  const a = job('Brightwater', 'Product Manager'), b = job('Cedarline', 'Product Owner', { priority: 2 }), c = job('Driftmark', 'Product Lead', { verdict: 'investable-stretch' });
  interview(addDays(1), '10:00');
  SETTINGS.modules = { coach: { enabled: true } };
  const send = telegram();
  const r = await run({ done: [a, b, c], date: DAY, send });
  assert.deepEqual(r.pk.picks.map(p => p.fm.company), ['Brightwater']);
  const text = send.sent[0], lines = text.split('\n');
  assert.equal(lines[0], `📅 Interview tomorrow: Harborview, round 2, ${dayLabel(addDays(1))}, 10:00`);
  assert.match(lines[1], /^Prep step: practise answers/);
  assert.equal(lines[2], 'In the interview coach: practice, or mock for a full run.');
  assert.match(text, /🎯 Apply today \(1; 3 open in the pipeline\)\n1\. Brightwater: Product Manager/);
  assert.match(text, /For after the interview \(2\)\n1\. Cedarline: Product Owner \[Remote\] Strong fit, p2\n2\. Driftmark: Product Lead \[Remote\] Investable stretch, p1\n/);
  assert.doesNotMatch(text, /Worth applying/);
  assert.equal(text.match(/Apply on the company site/g).length, 1, 'only the pick carries its apply instructions');
  assert.deepEqual(Object.keys(readState('picks.json', {})), [a.file], 'the roles that wait are not marked as shown');
});

test('prep mode with no qualifying role: "N roles wait", no pick, showings unchanged', async () => {
  const a = job('Brightwater', 'Product Manager', { priority: 2 }), b = job('Cedarline', 'Product Owner', { ago: 3 });
  interview(addDays(2));
  fs.writeFileSync(STATE('picks.json'), JSON.stringify({ [b.file]: { shown: 1, last: addDays(-1) } }));
  const send = telegram();
  const r = await run({ done: [a], date: DAY, send });
  assert.deepEqual(r.pk.picks, []);
  assert.match(send.sent[0], /^📅 Interview in 2 days: Harborview, round 2, .+\nPrep step: research the company and the role, and list the concerns they are likely to raise\.\n2 roles wait until after the interview\.\n/);
  assert.doesNotMatch(send.sent[0], /interview coach/, 'no coach line while the module is off');
  assert.deepEqual(readState('picks.json', {}), { [b.file]: { shown: 1, last: addDays(-1) } });
});

test('interview today: prep before its time, normal after it; days_before 0 turns prep off', async () => {
  job('Brightwater', 'Product Manager'); job('Cedarline', 'Product Owner', { priority: 2 });
  interview(DAY, '20:00');
  let r = await run({ date: DAY, time: '18:00', send: telegram(), dry: true });
  assert.equal(r.pk.prep?.step, 'warmup'); assert.equal(r.pk.picks.length, 1);
  assert.match(r.text, /^📅 Interview today: Harborview, round 2, .+, 20:00\nPrep step: a short confidence plan/);
  r = await run({ date: DAY, time: '20:30', send: telegram(), dry: true });
  assert.equal(r.pk.prep, null); assert.equal(r.pk.picks.length, 2, 'after the interview: the usual picks');
  interview(addDays(1));
  SETTINGS.picks.prep = { days_before: 0 };
  r = await run({ date: DAY, send: telegram(), dry: true });
  assert.equal(r.pk.prep, null); assert.equal(r.pk.picks.length, 2);
  assert.equal(fs.existsSync(path.join(DATA, 'digests', `${DAY}.md`)), false, 'a dry run writes no digest');
});

// Digest days and time (settings.schedule), the prep window (picks.prep), the settings writer (validation, unknown
// keys and layout kept, run_time moved, the timer reinstalled only on a time change), JSON text edits, the timer
// and bot units. Synthetic settings only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-schedule-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
process.env.JOBPILOT_RUN_DATE = '2026-10-05';
const SETTINGS_TEXT = `{
  "_comment": "Synthetic settings for a test.",
  "candidate_name": "Sam Example",
  "timezone": "UTC",
  "run_time": "18:00",
  "picks": {
    "per_day": 2, "window_days": 14,
    "shape_bonus": []
  },
  "my_own_key": { "kept": true, "list": [1,2,3] }
}
`;
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, SETTINGS_TEXT);

const S = await import('../lib/schedule.mjs');
const J = await import('../lib/jsonedit.mjs');
const { writeSettings, scheduleView } = await import('../lib/settings-writer.mjs');
const { SETTINGS } = await import('../lib/config.mjs');
const { unitFiles, installTimer } = await import('../lib/ops.mjs');
const FILE = process.env.JOBPILOT_SETTINGS;

test('schedule: days and time with defaults; run_time is read as schedule.time', () => {
  assert.deepEqual(S.scheduleOf({}), { days: [1, 2, 3, 4, 5, 6, 7], time: '18:00', legacy: false });
  assert.deepEqual(S.scheduleOf({ run_time: '07:30' }), { days: [1, 2, 3, 4, 5, 6, 7], time: '07:30', legacy: true });
  assert.deepEqual(S.scheduleOf({ run_time: '07:30', schedule: { days: [1, 3], time: '19:00' } }), { days: [1, 3], time: '19:00', legacy: false });
  assert.equal(S.isoWeekday('2026-10-05'), 1, 'a Monday'); assert.equal(S.isoWeekday('2026-10-11'), 7, 'a Sunday');
});

test('schedule validation: unique whole days 1 to 7, at least one, HH:MM, and the prep keys', () => {
  assert.deepEqual(S.scheduleProblems({ schedule: { days: [1, 2, 3, 4, 5], time: '18:00' } }), []);
  const p = s => S.scheduleProblems(s).join(' | ');
  assert.match(p({ schedule: { days: [] } }), /at least one day/);
  assert.match(p({ schedule: { days: [0, 8] } }), /from 1 \(Monday\) to 7/);
  assert.match(p({ schedule: { days: [1.5] } }), /whole numbers/);
  assert.match(p({ schedule: { days: [2, 2] } }), /twice/);
  assert.match(p({ schedule: { days: '1-5' } }), /at least one day/);
  assert.match(p({ schedule: { time: '7pm' } }), /HH:MM/);
  assert.match(p({ run_time: '25:00' }), /HH:MM/);
  assert.match(p({ schedule: 'weekdays' }), /must be an object/);
  assert.match(p({ picks: { prep: { days_before: -1 } } }), /days_before must be a whole number from 0 to 7/);
  assert.match(p({ picks: { prep: { verdicts: 'strong-fit' } } }), /verdicts must be a list/);
  assert.deepEqual(S.scheduleProblems({ picks: { prep: { days_before: 0 } } }), []);
});

test('off days: a day not in schedule.days; a broken schedule never silences the digest', () => {
  const weekdays = { schedule: { days: [1, 2, 3, 4, 5], time: '18:00' } };
  assert.equal(S.offDay('2026-10-10', weekdays), true, 'Saturday');
  assert.equal(S.offDay('2026-10-09', weekdays), false, 'Friday');
  assert.equal(S.offDay('2026-10-10', { schedule: { days: [9] } }), false);
  assert.equal(S.offDay('2026-10-10', {}), false, 'every day by default');
});

test('prep state: 1 to days_before days ahead, or later today; no time counts as later today; 0 turns it off', () => {
  const apps = t => ({ a: { company: 'Brightwater', role: 'Product Manager', status: 'interview', events: [{ date: '2026-10-01', type: 'interview', event_date: t.date, ...(t.time ? { event_time: t.time } : {}), round: 2 }] } });
  const st = (date, time, now = '18:00', settings = {}) => S.prepState({ apps: apps({ date, time }), day: '2026-10-05', time: now, settings });
  assert.equal(st('2026-10-06').step, 'practice'); assert.equal(st('2026-10-06').days, 1);
  assert.equal(st('2026-10-07').step, 'prep');
  assert.equal(st('2026-10-08'), null, '3 days out with days_before 2');
  assert.equal(st('2026-10-08', '', '18:00', { picks: { prep: { days_before: 3 } } }).days, 3);
  assert.equal(st('2026-10-05', '19:00').step, 'warmup', 'today, after the run');
  assert.equal(st('2026-10-05', '10:00'), null, 'today, already past');
  assert.equal(st('2026-10-05').step, 'warmup', 'today with no time');
  assert.equal(st('2026-10-06', '', '18:00', { picks: { prep: { days_before: 0 } } }), null, 'off');
  assert.equal(st('2026-10-04'), null, 'past');
  const rejected = { a: { ...apps({ date: '2026-10-06' }).a, status: 'rejected' } };
  assert.equal(S.prepState({ apps: rejected, day: '2026-10-05', time: '18:00', settings: {} }), null, 'a rejected application has no interview ahead');
  assert.equal(S.nowTime('UTC', new Date('2026-10-06T01:00:00Z'), '2026-10-05'), '24:00', 'a run that crossed midnight is past every time of its day');
  assert.equal(S.nowTime('UTC', new Date('2026-10-05T17:04:00Z'), '2026-10-05'), '17:04');
});

test('prep picks: a fresh decode with a prep verdict and a top priority', () => {
  const P = S.prepOf({});
  const c = (verdict, pr, decoded) => ({ file: `${decoded}--x.md`, v: { verdict, apply_priority: pr, decoded_on: decoded } });
  assert.equal(S.prepQualifies(c('strong-fit', 1, '2026-10-05'), '2026-10-05', P), true);
  assert.equal(S.prepQualifies(c('strong-fit', 1, '2026-10-04'), '2026-10-05', P), true, 'yesterday is in the last 2 days');
  assert.equal(S.prepQualifies(c('strong-fit', 1, '2026-10-03'), '2026-10-05', P), false);
  assert.equal(S.prepQualifies(c('strong-fit', 2, '2026-10-05'), '2026-10-05', P), false);
  assert.equal(S.prepQualifies(c('investable-stretch', 1, '2026-10-05'), '2026-10-05', P), false);
});

test('JSON text edits keep every other byte', () => {
  const t = '{\n  "a": 1,\n  "b": { "x": [1,2], "y": "z" },\n  "c": "keep"\n}\n';
  assert.equal(J.setPath(t, ['b', 'y'], 'w'), t.replace('"y": "z"', '"y": "w"'));
  assert.equal(J.setPath(t, ['b', 'n'], 3), t.replace('"y": "z" }', '"y": "z", "n": 3 }'), 'a one-line object stays on one line');
  assert.equal(J.setPath(t, ['d', 'e'], [1, 2]), t.replace('"c": "keep"\n', '"c": "keep",\n  "d": { "e": [1, 2] }\n'), 'a new member on its own line');
  assert.equal(J.deletePath(t, ['a']), t.replace('"a": 1,\n  ', ''));
  assert.equal(J.deletePath(t, ['c']), t.replace(',\n  "c": "keep"', ''));
  assert.equal(J.replaceMember(t, ['a'], 'z', { k: 1 }), t.replace('"a": 1', '"z": { "k": 1 }'));
  assert.equal(J.setPath('{}', ['a'], 1), '{ "a": 1 }');
  assert.equal(J.deletePath('{ "a": 1 }', ['a']), '{}');
  assert.throws(() => J.parseSpans('{ "a": 1, }'));
});

test('settings writer: validates, moves run_time into schedule, keeps unknown keys and layout, reinstalls only on a time change', () => {
  const calls = []; const reinstall = time => { calls.push(time); return { done: true }; };
  const bad = writeSettings({ days: [] }, { reinstall });
  assert.equal(bad.ok, false); assert.match(bad.message, /at least one day/);
  assert.equal(fs.readFileSync(FILE, 'utf8'), SETTINGS_TEXT, 'nothing written');
  assert.equal(writeSettings({ time: '7pm' }, { reinstall }).ok, false);

  const r = writeSettings({ days: [5, 1, 2, 3, 4] }, { reinstall });
  assert.equal(r.ok, true, r.message); assert.equal(r.timeChanged, false); assert.deepEqual(calls, [], 'days only: no timer change');
  const text = fs.readFileSync(FILE, 'utf8');
  assert.equal(text, SETTINGS_TEXT.replace('"run_time": "18:00"', '"schedule": { "days": [1, 2, 3, 4, 5], "time": "18:00" }'), 'run_time became schedule in its place; nothing else moved');
  assert.deepEqual(SETTINGS.schedule, { days: [1, 2, 3, 4, 5], time: '18:00' }, 'this process reads the new values');
  assert.equal(SETTINGS.run_time, undefined);

  const r2 = writeSettings({ time: '19:30', prep_days: 1 }, { reinstall });
  assert.equal(r2.ok, true); assert.equal(r2.timeChanged, true); assert.equal(r2.timer, 'reinstalled'); assert.deepEqual(calls, ['19:30']);
  assert.match(r2.message, /19:30/);
  const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepEqual(after.schedule, { days: [1, 2, 3, 4, 5], time: '19:30' });
  assert.deepEqual(after.picks, { per_day: 2, window_days: 14, shape_bonus: [], prep: { days_before: 1 } });
  assert.deepEqual(after.my_own_key, { kept: true, list: [1, 2, 3] }); assert.equal(after._comment, 'Synthetic settings for a test.');
  assert.match(fs.readFileSync(FILE, 'utf8'), /"list": \[1,2,3\]/, 'untouched values keep their own formatting');

  const r3 = writeSettings({ time: '19:30' }, { reinstall: () => ({ done: false }) });
  assert.equal(r3.timer, null, 'the same time is not a change');
  const r4 = writeSettings({ time: '06:00' }, { reinstall: () => ({ done: false }) });
  assert.equal(r4.timer, 'manual'); assert.match(r4.message, /node cli\.mjs timer/);
  assert.deepEqual(scheduleView(), { days: [1, 2, 3, 4, 5], time: '06:00', timezone: 'UTC', prep_days: 1, problems: [] });
  assert.equal(writeSettings({ prep_days: 9 }, { reinstall }).ok, false);
  assert.equal(writeSettings({ days: [1] }, { file: path.join(tmp, 'settings.example.json'), reinstall }).ok, false, 'never writes the example');
});

test('the timer units: the bot unit only with Telegram on; installTimer writes them and enables the bot', () => {
  const plain = unitFiles({ root: '/srv/jp', node: '/usr/bin/node', time: '18:30', envPath: '/usr/bin' });
  assert.ok(!plain['jobpilot-bot.service']);
  const u = unitFiles({ root: '/srv/jp', node: '/usr/bin/node', time: '18:30', envPath: '/usr/bin', bot: true });
  assert.match(u['jobpilot-bot.service'], /^ExecStart=\/usr\/bin\/node \/srv\/jp\/cli\.mjs bot$/m);
  assert.match(u['jobpilot-bot.service'], /^Restart=on-failure$/m);
  const dir = path.join(tmp, 'units'), runs = [];
  const r = installTimer({ time: '07:15', tz: 'UTC', bot: true, dir, run: (cmd, args) => runs.push([cmd, ...args].join(' ')), stdio: 'ignore' });
  assert.equal(r.code, 0);
  assert.match(fs.readFileSync(path.join(dir, 'jobpilot.timer'), 'utf8'), /OnCalendar=\*-\*-\* 07:15:00 UTC/);
  assert.ok(fs.existsSync(path.join(dir, 'jobpilot-bot.service')));
  assert.deepEqual(runs, ['systemctl --user daemon-reload', 'systemctl --user enable --now jobpilot.timer', 'systemctl --user enable --now jobpilot-bot.service']);
  assert.equal(installTimer({ time: '7:15', dir, run: () => {} }).code, 1);
});

test('settings writer keeps CRLF line endings', () => {
  const crlf = path.join(tmp, 'settings-crlf.json');
  fs.writeFileSync(crlf, '{\r\n  "timezone": "Europe/Madrid",\r\n  "schedule": { "days": [1, 2, 3, 4, 5, 6, 7], "time": "18:00" }\r\n}\r\n');
  const r = writeSettings({ days: [1, 2, 3, 4, 5] }, { file: crlf, reinstall: () => ({ done: true }) });
  assert.equal(r.ok, true);
  const out = fs.readFileSync(crlf, 'utf8');
  assert.ok(!/[^\r]\n/.test(out), 'every newline is CRLF');
  assert.deepEqual(JSON.parse(out).schedule.days, [1, 2, 3, 4, 5]);
});

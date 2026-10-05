// The Telegram bot (lib/bot.mjs) on a fake transport: only the configured chat is answered, /schedule buttons change
// settings.json through the settings writer, /time reinstalls the timer, /interview records an interview, and the
// poll loop keeps its offset. No network; synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-bot-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'Europe/Madrid', locale: 'en', schedule: { days: [1, 2, 3, 4, 5, 6, 7], time: '18:00' }, extra: 'kept' }, null, 2) + '\n');

const { createBot, poll, splitArgs } = await import('../lib/bot.mjs');
const { writeSettings } = await import('../lib/settings-writer.mjs');
const { translator } = await import('../lib/i18n.mjs');
const CHAT = '4242';
const fake = (results = {}) => { const calls = []; return { calls, call: async (method, params) => { calls.push({ method, params }); const r = results[method]; return typeof r === 'function' ? r(params) : r ?? true; } }; };
const settings = () => JSON.parse(fs.readFileSync(process.env.JOBPILOT_SETTINGS, 'utf8'));
const msg = (text, chat = CHAT) => ({ message: { message_id: 7, chat: { id: Number(chat) }, text } });
const press = (data, chat = CHAT) => ({ callback_query: { id: 'q1', data, message: { message_id: 9, chat: { id: Number(chat) } } } });
const reinstalls = [];
const make = (extra = {}) => { const transport = fake(); const bot = createBot({ transport, chatId: CHAT, write: p => writeSettings(p, { reinstall: time => { reinstalls.push(time); return { done: true }; } }), ...extra }); return { transport, bot }; };

test('another chat is ignored without a reply', async () => {
  const { transport, bot } = make();
  for (const u of [msg('/schedule', '999'), press('day:1', '999'), msg('/time 07:00', '999'), { edited_message: { chat: { id: 4242 }, text: '/help' } }, {}]) await bot.handle(u);
  assert.deepEqual(transport.calls, []);
  assert.equal(settings().schedule.time, '18:00');
});

test('/help, /start and unknown commands', async () => {
  const { transport, bot } = make();
  await bot.handle(msg('/help')); await bot.handle(msg('/start@CometScoutBot')); await bot.handle(msg('/nonsense')); await bot.handle(msg('hello'));
  assert.deepEqual(transport.calls.map(c => c.params.chat_id), [CHAT, CHAT, CHAT, CHAT]);
  assert.match(transport.calls[0].params.text, /\/schedule: digest days, time and interview prep/);
  assert.equal(transport.calls[1].params.text, transport.calls[0].params.text);
  assert.match(transport.calls[2].params.text, /^Unknown command/);
});

test('/schedule shows days, time and prep with buttons; a day button and a prep button change settings.json', async () => {
  const { transport, bot } = make();
  await bot.handle(msg('/schedule'));
  const sent = transport.calls[0].params;
  assert.equal(sent.text, 'Digest days: Mon, Tue, Wed, Thu, Fri, Sat, Sun\nTime: 18:00 (Europe/Madrid)\nInterview prep: 2 days before');
  const kb = sent.reply_markup.inline_keyboard;
  assert.deepEqual(kb.map(r => r.length), [4, 3, 4]);
  assert.deepEqual(kb[0][0], { text: '✓ Mon', callback_data: 'day:1' });
  assert.deepEqual(kb[2].map(b => b.callback_data), ['prep:0', 'prep:1', 'prep:2', 'prep:3']);
  assert.equal(kb[2][2].text, '✓ Prep 2');

  transport.calls.length = 0;
  await bot.handle(press('day:6')); await bot.handle(press('day:7'));
  assert.deepEqual(settings().schedule.days, [1, 2, 3, 4, 5], 'weekend off');
  assert.equal(settings().extra, 'kept');
  assert.deepEqual(transport.calls.map(c => c.method), ['answerCallbackQuery', 'editMessageText', 'answerCallbackQuery', 'editMessageText']);
  const edited = transport.calls[3].params;
  assert.equal(edited.message_id, 9); assert.match(edited.text, /^Digest days: Mon, Tue, Wed, Thu, Fri\n/);
  assert.equal(edited.reply_markup.inline_keyboard[1][1].text, '· Sat');
  await bot.handle(press('day:6'));
  assert.deepEqual(settings().schedule.days, [1, 2, 3, 4, 5, 6], 'toggled back on');
  await bot.handle(press('prep:0'));
  assert.equal(settings().picks.prep.days_before, 0);
  assert.deepEqual(reinstalls, [], 'days and prep never touch the timer');
  // the last day cannot be switched off: the writer refuses and says why
  for (const d of [1, 2, 3, 4, 5]) await bot.handle(press(`day:${d}`));
  assert.deepEqual(settings().schedule.days, [6]);
  transport.calls.length = 0;
  await bot.handle(press('day:6'));
  assert.deepEqual(settings().schedule.days, [6]);
  assert.match(transport.calls[0].params.text, /at least one day/); assert.equal(transport.calls.length, 1, 'no edit when nothing changed');
});

test('/time sets the time and reinstalls the timer; a bad time gets the usage', async () => {
  const { transport, bot } = make();
  await bot.handle(msg('/time 7:45'));
  assert.equal(settings().schedule.time, '07:45');
  assert.deepEqual(reinstalls, ['07:45']);
  assert.match(transport.calls[0].params.text, /07:45/);
  await bot.handle(msg('/time evening')); await bot.handle(msg('/time 24:10'));
  assert.match(transport.calls[1].params.text, /^Send the time as HH:MM/);
  assert.match(transport.calls[2].params.text, /HH:MM/);
  assert.deepEqual(reinstalls, ['07:45']);
});

test('/interview records through addInterview (quotes keep a company name together); busy waits', async () => {
  const seen = [];
  const { transport, bot } = make({ interview: a => { seen.push(a); return { code: 0, lines: ['Glenmoor Labs: Product Manager -> interview on 2026-10-07 10:00'] }; } });
  await bot.handle(msg('/interview "Glenmoor Labs" 2026-10-07 10:00 product manager'));
  assert.deepEqual(seen, [{ company: 'Glenmoor Labs', date: '2026-10-07', time: '10:00', words: 'product manager', source: 'telegram' }]);
  assert.match(transport.calls[0].params.text, /-> interview on 2026-10-07 10:00/);
  await bot.handle(msg('/interview Glenmoor'));
  assert.match(transport.calls[1].params.text, /^Usage: \/interview/);
  const busy = make({ busy: () => 1234, interview: () => { throw new Error('must not write'); } });
  await busy.bot.handle(msg('/interview Glenmoor 2026-10-07'));
  assert.match(busy.transport.calls[0].params.text, /busy/);
  assert.deepEqual(splitArgs('a "b c" d'), ['a', 'b c', 'd']);
});

test('poll: answers each update once and keeps the offset across restarts', async () => {
  const stateFile = path.join(tmp, 'bot-state.json');
  const updates = [{ update_id: 10, ...msg('/help') }, { update_id: 11, ...msg('/help', '1') }];
  const transport = fake({ getUpdates: p => updates.filter(u => u.update_id >= p.offset) });
  const bot = createBot({ transport, chatId: CHAT, write: () => ({ ok: false, message: 'no' }) });
  await poll({ bot, transport, stateFile, once: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { offset: 12 });
  assert.equal(transport.calls.filter(c => c.method === 'sendMessage').length, 1, 'the other chat got nothing');
  await poll({ bot, transport, stateFile, once: true });
  assert.equal(transport.calls.filter(c => c.method === 'sendMessage').length, 1, 'nothing answered twice');
  assert.equal(transport.calls.filter(c => c.method === 'getUpdates').at(-1).params.offset, 12);
  // a failed getUpdates is logged and retried, never thrown
  const broken = { call: async () => { const e = new Error('Telegram getUpdates 409: Conflict'); e.status = 409; throw e; } };
  await poll({ bot, transport: broken, stateFile, once: true });
});

test('the bot speaks the locale', async () => {
  const transport = fake();
  const bot = createBot({ transport, chatId: CHAT, t: translator('ru'), locale: 'ru', view: () => ({ days: [1, 2], time: '18:00', timezone: 'UTC', prep_days: 0 }) });
  await bot.handle(msg('/schedule'));
  assert.equal(transport.calls[0].params.text, 'Дни сводки: пн, вт\nВремя: 18:00 (UTC)\nПодготовка к собеседованию: выключена');
});

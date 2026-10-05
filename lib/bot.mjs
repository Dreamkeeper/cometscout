// The Telegram bot (cli.mjs bot), the first piece of the M5 bot: it long-polls getUpdates and answers only the
// chat in TELEGRAM_CHAT_ID; everyone else is ignored without a reply. Commands live in COMMANDS and inline buttons
// in BUTTONS ("kind:value" callback data), so later commands (picks, applied, skip) are one entry each.
//   /schedule                show digest days, time and the interview prep window, with buttons to change them
//   /time HH:MM              set the digest time (the timer is reinstalled)
//   /interview <company> <YYYY-MM-DD> [HH:MM] [role words]   record a booked interview, as cli.mjs interview
//   /help                    the commands
// Settings go through lib/settings-writer.mjs, the same writer as the workspace.
import fs from 'node:fs';
import { SETTINGS, STATE, readJson, secret, log } from './config.mjs';
import { translator } from './i18n.mjs';
import { ALL_DAYS, weekdayNames } from './schedule.mjs';
import { writeSettings, scheduleView } from './settings-writer.mjs';
import { addInterview } from './applications.mjs';
import { lockHolder } from './lock.mjs';

/** The Bot API over HTTPS: call(method, params) -> result. Errors name the method and status, never the token. */
export function telegramTransport({ token, fetch = globalThis.fetch }) {
  return {
    async call(method, params = {}, timeoutMs = 70000) {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { const e = new Error(`Telegram ${method} ${r.status}: ${String(j.description || '').slice(0, 200)}`); e.status = r.status; throw e; }
      return j.result;
    },
  };
}

/** Words of a command line; "double quotes" keep spaces ("Acme Robotics"). */
export const splitArgs = s => [...String(s || '').matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
const PREP_CHOICES = [0, 1, 2, 3];

/**
 * The handler: handle(update) answers one update. Everything outside is injected so tests need no network:
 * transport.call(method, params), write (the settings writer), interview (addInterview), busy (the run lock).
 */
export function createBot({ transport, chatId, t = translator(), locale = SETTINGS.locale || 'en', write = p => writeSettings(p), interview = addInterview, busy = lockHolder, view = () => scheduleView() }) {
  const mine = chat => chat?.id !== undefined && String(chat.id) === String(chatId);
  const say = (text, extra = {}) => transport.call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra });

  function scheduleMessage(v = view()) {
    const names = weekdayNames(locale);
    const days = Array.isArray(v.days) && v.days.length ? v.days.map(d => names[d - 1] ?? d).join(', ') : t('bot.no_days');
    const text = t('bot.schedule', { days, time: v.time, tz: v.timezone, prep: v.prep_days ? t('bot.prep_on', { n: v.prep_days }) : t('bot.prep_off') });
    const on = d => Array.isArray(v.days) && v.days.includes(d);
    const dayButtons = ALL_DAYS.map(d => ({ text: `${on(d) ? '✓' : '·'} ${names[d - 1]}`, callback_data: `day:${d}` }));
    const prepButtons = PREP_CHOICES.map(n => ({ text: `${n === v.prep_days ? '✓ ' : ''}${t('bot.prep_button', { n })}`, callback_data: `prep:${n}` }));
    return { text, reply_markup: { inline_keyboard: [dayButtons.slice(0, 4), dayButtons.slice(4), prepButtons] } };
  }

  const COMMANDS = {
    help: async () => say(t('bot.help')),
    start: async () => say(t('bot.help')),
    schedule: async () => { const m = scheduleMessage(); return say(m.text, { reply_markup: m.reply_markup }); },
    time: async args => {
      const time = String(args[0] || '').replace(/^(\d):/, '0$1:');
      if (!/^\d{2}:\d{2}$/.test(time)) return say(t('bot.time_usage'));
      const r = write({ time });
      return say(r.message);
    },
    interview: async args => {
      const [company, date, ...more] = args;
      if (!company || !date) return say(t('bot.interview_usage'));
      if (busy()) return say(t('bot.busy'));
      const time = /^\d{1,2}:\d{2}$/.test(more[0] || '') ? more.shift() : '';
      const r = interview({ company, date, time, words: more.join(' '), source: 'telegram' });
      return say(r.lines.join('\n'));
    },
  };
  const BUTTONS = {
    day: v => { const d = Number(v), cur = Array.isArray(view().days) ? view().days : ALL_DAYS; return { days: cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d].sort((a, b) => a - b) }; },
    prep: v => ({ prep_days: Number(v) }),
  };

  async function onMessage(msg) {
    const m = String(msg.text || '').trim().match(/^\/([A-Za-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
    if (!m) return say(t('bot.unknown'));
    const name = m[1].toLowerCase(), cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;   // never a prototype key (/__proto__)
    return cmd ? cmd(splitArgs(m[2])) : say(t('bot.unknown'));
  }
  async function onButton(q) {
    const [kind, value] = String(q.data || '').split(':');
    const patch = Object.hasOwn(BUTTONS, kind) ? BUTTONS[kind](value) : null;
    const before = JSON.stringify(scheduleMessage());
    const r = patch ? write(patch) : { ok: false, message: t('bot.unknown') };
    await transport.call('answerCallbackQuery', { callback_query_id: q.id, text: String(r.message || '').slice(0, 190) });
    // Telegram refuses an edit that changes nothing ("message is not modified"), e.g. a press on the selected button
    if (r.ok && q.message?.message_id) { const s = scheduleMessage(); if (JSON.stringify(s) !== before) await transport.call('editMessageText', { chat_id: chatId, message_id: q.message.message_id, text: s.text, reply_markup: s.reply_markup }); }
    return r;
  }
  /** One update from getUpdates. Anything not from the configured chat is ignored, with no reply. */
  async function handle(u) {
    if (u?.message && mine(u.message.chat)) return onMessage(u.message);
    if (u?.callback_query && mine(u.callback_query.message?.chat)) return onButton(u.callback_query);
    return null;
  }
  return { handle, scheduleMessage, COMMANDS, BUTTONS };
}

/**
 * Long-poll getUpdates until `signal` aborts. The next offset is kept in data/state/bot.json, so a restart never
 * answers an update twice. A failed call waits (5 s, doubling up to 60 s) and tries again.
 */
export async function poll({ bot, transport, stateFile = STATE('bot.json'), signal = null, timeoutSec = 50, wait = ms => new Promise(r => setTimeout(r, ms)), once = false }) {
  let offset = readJson(stateFile, {}).offset || 0, backoff = 5000;
  while (!signal?.aborted) {
    let updates;
    try { updates = await transport.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 20) * 1000); backoff = 5000; }
    catch (e) { log(`bot: ${e.message}${e.status === 409 ? ' (another getUpdates or a webhook uses this bot)' : ''}; retrying in ${backoff / 1000} s`); if (once) return; await wait(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
    for (const u of updates || []) {
      try { await bot.handle(u); } catch (e) { log(`bot: update ${u.update_id} failed: ${e.message}`); }
      offset = u.update_id + 1; fs.writeFileSync(stateFile, JSON.stringify({ offset }));
    }
    if (once) return;
  }
}

/** cli.mjs bot: needs Telegram delivery on (token and chat id in .env). */
export async function runBot() {
  const tg = SETTINGS.delivery.telegram, token = secret(tg.token_env), chatId = secret(tg.chat_id_env);
  if (!tg.enabled || !token || !chatId) { console.log('jobpilot bot: Telegram delivery is off; set delivery.telegram.enabled and put TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.'); return 0; }   // 0: the service does not restart in a loop
  const transport = telegramTransport({ token }), ac = new AbortController();
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { ac.abort(); process.exit(0); });
  log('jobpilot bot: listening (/schedule, /time, /interview, /help); Ctrl+C stops it');
  await poll({ bot: createBot({ transport, chatId }), transport, signal: ac.signal });
  return 0;
}

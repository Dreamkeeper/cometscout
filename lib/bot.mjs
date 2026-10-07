// The Telegram bot (cli.mjs bot), the first piece of the M5 bot: it long-polls getUpdates and answers only the
// chat in TELEGRAM_CHAT_ID; everyone else is ignored without a reply. Commands live in COMMANDS and inline buttons
// in BUTTONS ("kind:value" callback data), so later commands (picks, applied, skip) are one entry each.
//   /schedule                show digest days, time and the interview prep window, with buttons to change them
//   /time HH:MM              set the digest time (the timer is reinstalled)
//   /interview <company> <YYYY-MM-DD> [HH:MM] [role words]   record a booked interview, as cli.mjs interview
//   /update                  the installed and the newest version; buttons Update now / Tonight / Skip when one is out
//                            (also under the update notice after the evening run, lib/update.mjs: "upd:<action>:<version>")
//   /help                    the commands
//   an audio file, a voice message, a video or an audio document: saved to the transcription inbox (lib/transcribe.mjs)
//                            when modules.transcribe is enabled. The Bot API lets bots download up to 20 MB, so a bigger
//                            file gets the other ways in (the workspace upload, a copy into the inbox).
// Settings go through lib/settings-writer.mjs, the same writer as the workspace. Update now never runs inside this
// process: the update restarts the bot unit, so it is started detached (lib/update.mjs launchDetached).
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SETTINGS, STATE, readJson, secret, log } from './config.mjs';
import { secretEnvOf } from './env-names.mjs';
import { translator } from './i18n.mjs';
import { ALL_DAYS, weekdayNames } from './schedule.mjs';
import { writeSettings, scheduleView } from './settings-writer.mjs';
import { addInterview } from './applications.mjs';
import { lockHolder } from './lock.mjs';
import { checkForUpdate, updateAction, statusText, updateButtons } from './update.mjs';
import { validVersion } from './release.mjs';
import { transcribeSettings, safeAudioName, isAudio, stagingFile, intoInbox, kickQueue, BOT_MAX_MB, INSTALL_COMMAND } from './transcribe.mjs';

/** The Bot API over HTTPS: call(method, params) -> result. Errors name the method and status, never the token. */
export function telegramTransport({ token, fetch = globalThis.fetch }) {
  return {
    async call(method, params = {}, timeoutMs = 70000) {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { const e = new Error(`Telegram ${method} ${r.status}: ${String(j.description || '').slice(0, 200)}`); e.status = r.status; throw e; }
      return j.result;
    },
    /** A file from getFile's file_path, streamed to dest. The error never names the URL (it holds the token). */
    async download(filePath, dest, timeoutMs = 600000) {
      const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok || !r.body) { const e = new Error(`Telegram file download ${r.status}`); e.status = r.status; throw e; }
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
    },
  };
}

// Extensions for files Telegram sends without a usable name (voice messages, some audio).
const MIME_EXT = { 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/flac': '.flac', 'audio/webm': '.webm', 'audio/opus': '.opus', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
/**
 * The file in a message that can be transcribed: { file_id, size, name } (size 0 when Telegram did not say), or null.
 * Audio, voice, video and video notes always count; a document counts when its type or name is audio or video.
 */
export function audioOf(msg) {
  const d = msg?.document;
  const doc = d && (/^(audio|video)\//i.test(String(d.mime_type || '')) || isAudio(d.file_name)) ? d : null;
  const kind = msg?.voice ? 'voice' : msg?.video_note ? 'video-note' : msg?.audio ? 'audio' : msg?.video ? 'video' : doc ? 'audio' : null;
  const f = msg?.voice || msg?.video_note || msg?.audio || msg?.video || doc;
  if (!kind || !f?.file_id) return null;
  const ext = MIME_EXT[String(f.mime_type || '').toLowerCase()] || (kind === 'video-note' || kind === 'video' ? '.mp4' : '.ogg');
  const stamp = new Date((Number(msg.date) || Date.now() / 1000) * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const given = f.file_name ? String(f.file_name) : '';
  const name = safeAudioName(given) || (given && safeAudioName(`${given}${ext}`)) || `${kind}-${stamp}${ext}`;
  return { file_id: f.file_id, size: Number(f.file_size) || 0, name };
}

/** Words of a command line; "double quotes" keep spaces ("Acme Robotics"). */
export const splitArgs = s => [...String(s || '').matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
const PREP_CHOICES = [0, 1, 2, 3];

/**
 * The handler: handle(update) answers one update. Everything outside is injected so tests need no network:
 * transport.call(method, params), write (the settings writer), interview (addInterview), busy (the run lock).
 */
export function createBot({ transport, chatId, t = translator(), locale = SETTINGS.locale || 'en', write = p => writeSettings(p), interview = addInterview, busy = lockHolder, view = () => scheduleView(),
  check = () => checkForUpdate({ maxAgeH: 1 }), act = (action, version) => updateAction(action, version, { busy, t }),
  transcribe = () => transcribeSettings(), kick = () => kickQueue(), install = INSTALL_COMMAND }) {
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
    update: async () => {
      const st = await check();
      return say(statusText(st, t), st.available && !st.skipped ? { reply_markup: updateButtons(st.latest, t) } : {});
    },
  };
  const BUTTONS = {
    day: v => { const d = Number(v), cur = Array.isArray(view().days) ? view().days : ALL_DAYS; return { days: cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d].sort((a, b) => a - b) }; },
    prep: v => ({ prep_days: Number(v) }),
  };

  // an audio file for the transcription inbox: downloaded to staging first, so the queue never sees half a file
  async function onAudio(a) {
    const s = transcribe();
    if (!s.enabled) return say(t('bot.audio_off', { install }));
    const tooBig = () => say(t('bot.audio_too_big', { size: a.size ? (a.size / 1048576).toFixed(1) : `> ${BOT_MAX_MB}`, max: s.max_upload_mb, inbox: s.inbox }));
    if (a.size > BOT_MAX_MB * 1048576) return tooBig();
    let staged = null;
    try {
      const f = await transport.call('getFile', { file_id: a.file_id });
      staged = stagingFile(s);
      await transport.download(f.file_path, staged);
      const name = intoInbox(staged, a.name, s); staged = null;
      kick();
      return say(t('bot.audio_saved', { name }));
    } catch (e) {
      if (staged) fs.rmSync(staged, { force: true });
      if (/too big/i.test(e.message)) return tooBig();
      return say(t('bot.audio_failed', { error: e.message }));
    }
  }

  async function onMessage(msg) {
    const a = audioOf(msg); if (a) return onAudio(a);
    const m = String(msg.text || '').trim().match(/^\/([A-Za-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
    if (!m) return say(t('bot.unknown'));
    const name = m[1].toLowerCase(), cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;   // never a prototype key (/__proto__)
    return cmd ? cmd(splitArgs(m[2])) : say(t('bot.unknown'));
  }
  // upd:<now|tonight|skip>:<version>: the answer says what happened; the buttons go once the choice changed something
  async function onUpdateButton(q, action, version) {
    const r = validVersion(version) ? await act(action, version) : { ok: false, changed: false, message: t('bot.unknown') };
    await transport.call('answerCallbackQuery', { callback_query_id: q.id, text: String(r.message || '').slice(0, 190) });
    if (r.changed && q.message?.message_id) await transport.call('editMessageText', { chat_id: chatId, message_id: q.message.message_id, text: `${String(q.message.text || '').trim()}\n\n${r.message}`.trim() });
    return r;
  }
  async function onButton(q) {
    const [kind, value, extra] = String(q.data || '').split(':');
    if (kind === 'upd') return onUpdateButton(q, value, extra);
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
/** The heartbeat: bot.json is touched after each long poll, so others can tell the bot is running (lib/update.mjs botRunning). */
function alive(file, offset) {
  try { const now = new Date(); if (fs.existsSync(file)) fs.utimesSync(file, now, now); else fs.writeFileSync(file, JSON.stringify({ offset })); } catch { /* not fatal */ }
}
export async function poll({ bot, transport, stateFile = STATE('bot.json'), signal = null, timeoutSec = 50, wait = ms => new Promise(r => setTimeout(r, ms)), once = false }) {
  let offset = readJson(stateFile, {}).offset || 0, backoff = 5000;
  while (!signal?.aborted) {
    let updates;
    try { updates = await transport.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 20) * 1000); backoff = 5000; }
    catch (e) { log(`bot: ${e.message}${e.status === 409 ? ' (another getUpdates or a webhook uses this bot)' : ''}; retrying in ${backoff / 1000} s`); if (once) return; await wait(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
    alive(stateFile, offset);
    for (const u of updates || []) {
      try { await bot.handle(u); } catch (e) { log(`bot: update ${u.update_id} failed: ${e.message}`); }
      offset = u.update_id + 1; fs.writeFileSync(stateFile, JSON.stringify({ offset }));
    }
    if (once) return;
  }
}

/** cli.mjs bot: needs Telegram delivery on (token and chat id in .env). */
export async function runBot() {
  const tg = SETTINGS.delivery.telegram, token = secret(secretEnvOf(SETTINGS, 'delivery.telegram.token_env')), chatId = secret(secretEnvOf(SETTINGS, 'delivery.telegram.chat_id_env'));
  if (!tg.enabled || !token || !chatId) { console.log('cometscout bot: Telegram delivery is off; set delivery.telegram.enabled and put TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.'); return 0; }   // 0: the service does not restart in a loop
  const transport = telegramTransport({ token }), ac = new AbortController();
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { ac.abort(); process.exit(0); });
  log('cometscout bot: listening (/schedule, /time, /interview, /update, /help, audio for transcription); Ctrl+C stops it');
  await poll({ bot: createBot({ transport, chatId }), transport, signal: ac.signal });
  return 0;
}

// The update check against canned GitHub answers (stable and edge channels, drafts, the cache, a failure logged once a
// day and never thrown), the Telegram notice (once per version, never for a skipped one, quiet on off days, commands
// when the bot is not running), Tonight after a run, the bot's /update and its buttons, the detached launch (no real
// systemd-run), /api/update, What is new and /media/, and the canned model answer. No network; synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-updcheck-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC', locale: 'en', schedule: { days: [1, 2, 3, 4, 5, 6, 7], time: '18:00' }, update: { channel: 'stable' } }, null, 2) + '\n');
const U = await import('../lib/update.mjs');
const { SETTINGS, STATE } = await import('../lib/config.mjs');
const { APP_VERSION } = await import('../lib/archive.mjs');
const { createBot } = await import('../lib/bot.mjs');
const W = await import('../lib/workspace.mjs');
const { makeHandler } = await import('../lib/server.mjs');
const { fakeAnswer, CANNED, callJson } = await import('../lib/llm.mjs');
const { releaseBody } = await import('../lib/release.mjs');

const SHA = 'cd'.repeat(32);
const rel = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: /-/.test(tag), html_url: `https://github.example/r/${tag}`, published_at: '2026-11-01T10:00:00Z',
  body: releaseBody({ version: tag.slice(1), date: '2026-11-01', min_node: 20, schema_version: 1, migrations: [], behaviour_changes: tag === 'v0.3.0', notes: { highlights: [`Highlight of ${tag}.`, 'Second line.'] } }, SHA), ...extra });
const LIST = [rel('v0.1.0'), rel('v0.3.0-beta.1'), rel('v0.2.0'), rel('v0.9.0', { draft: true }), rel('nightly'), rel('v0.2.1-rc.1', { prerelease: false })];
const calls = [];
const fakeFetch = (list = LIST, status = 200) => async (url, opts) => {
  calls.push({ url, ua: opts?.headers?.['User-Agent'] });
  if (status !== 200) return { ok: false, status, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => list };
};
const reset = (state = {}) => fs.writeFileSync(U.STATE_FILE(), JSON.stringify(state));
const NOW = new Date('2026-11-02T18:30:00Z');

test('stable takes the newest tag without a pre-release suffix; edge takes pre-releases too; drafts and non-versions never', async () => {
  assert.equal(U.newestRelease(LIST, 'stable').tag_name, 'v0.2.0', 'v0.2.1-rc.1 is a pre-release by its tag even if not flagged');
  assert.equal(U.newestRelease(LIST, 'edge').tag_name, 'v0.3.0-beta.1');
  assert.equal(U.newestRelease([], 'stable'), null);
  reset();
  const st = await U.checkForUpdate({ fetch: fakeFetch(), now: NOW, current: '0.1.0' });
  assert.equal(st.ok, true); assert.equal(st.latest, '0.2.0'); assert.equal(st.available, true);
  assert.deepEqual(st.highlights, ['Highlight of v0.2.0.', 'Second line.']);
  assert.match(calls.at(-1).url, /^https:\/\/api\.github\.com\/repos\/Dreamkeeper\/cometscout\/releases\?per_page=30$/);
  assert.equal(calls.at(-1).ua, 'cometscout-update-check');
  const cached = U.readState();
  assert.equal(cached.latest.sha256, SHA); assert.equal(cached.latest.zip_url, 'https://github.com/Dreamkeeper/cometscout/archive/refs/tags/v0.2.0.zip');
  const edge = await U.checkForUpdate({ fetch: fakeFetch(), now: NOW, current: '0.1.0', settings: { ...U.updateSettings(), channel: 'edge' } });
  assert.equal(edge.latest, '0.3.0-beta.1');
});

test('the cache answers within maxAgeH on the same channel; a failure is logged once a day, never thrown', async () => {
  reset();
  await U.checkForUpdate({ fetch: fakeFetch(), now: NOW, current: '0.1.0' });
  const n = calls.length;
  const st = await U.checkForUpdate({ fetch: () => assert.fail('no request'), now: new Date(NOW.getTime() + 1800000), maxAgeH: 1, current: '0.1.0' });
  assert.equal(st.cached, true); assert.equal(st.latest, '0.2.0'); assert.equal(calls.length, n);
  const logs = [];
  const f1 = await U.checkForUpdate({ fetch: fakeFetch(LIST, 503), now: NOW, current: '0.1.0', log: l => logs.push(l) });
  const f2 = await U.checkForUpdate({ fetch: async () => { throw new Error('offline'); }, now: NOW, current: '0.1.0', log: l => logs.push(l) });
  assert.equal(f1.ok, false); assert.match(f1.error, /503/); assert.equal(f2.ok, false); assert.equal(f2.latest, '0.2.0', 'the cached answer stays');
  assert.equal(logs.length, 1, 'once a day'); assert.match(logs[0], /update check failed: GitHub answered 503/);
  await U.checkForUpdate({ fetch: fakeFetch(LIST, 503), now: new Date('2026-11-03T18:30:00Z'), current: '0.1.0', log: l => logs.push(l) });
  assert.equal(logs.length, 2, 'and again the next day');
});

test('the notice: three lines, buttons, the commands when the bot is not running; once per version; never a skipped one; quiet on off days', async () => {
  reset();
  const st = await U.checkForUpdate({ fetch: fakeFetch([rel('v0.3.0')]), now: NOW, current: '0.1.0' });
  const m = U.noticeMessage(st, { bot: true });
  assert.equal(m.text, 'CometScout v0.3.0 is out; you have v0.1.0.\nHighlight of v0.3.0. Second line.\nThis version changes behaviour: read the notes before you update.');
  assert.deepEqual(m.reply_markup.inline_keyboard[0].map(b => b.callback_data), ['upd:now:0.3.0', 'upd:tonight:0.3.0', 'upd:skip:0.3.0']);
  assert.match(U.noticeMessage(st, { bot: false }).text, /\n\nWithout the bot: node cli\.mjs update --to v0\.3\.0 \(now\)/);

  const sent = [], launched = [];
  const run = (extra = {}) => U.afterRun({ fetch: fakeFetch([rel('v0.3.0')]), now: NOW, current: '0.1.0', send: async (text, markup) => sent.push({ text, markup }), launch: a => { launched.push(a); return { ok: true, how: 'test' }; }, ...extra });
  await run({ quiet: true });
  assert.equal(sent.length, 0, 'an off day sends nothing'); assert.equal(U.readState().notified, undefined, 'and the notice waits for a digest day');
  await run(); await run();
  assert.equal(sent.length, 1, 'once per version'); assert.equal(U.readState().notified, '0.3.0');
  reset({ skipped: ['0.3.0'] }); await run();
  assert.equal(sent.length, 1, 'a skipped version is never announced');
  assert.equal(launched.length, 0);
  SETTINGS.update = { check: false }; reset(); await run(); SETTINGS.update = { channel: 'stable' };
  assert.equal(sent.length, 1, 'update.check false: no check, no notice');
});

test('Tonight: the next run starts the update detached, waiting for the lock; an installed version is just cleared', async () => {
  const launched = [];
  const launch = a => { launched.push(a); return { ok: true, how: 'test' }; };
  reset({ pending: '0.3.0', notified: '0.3.0' });
  await U.afterRun({ fetch: fakeFetch([rel('v0.3.0')]), now: NOW, current: '0.1.0', launch, send: async () => {} });
  assert.deepEqual(launched, [['update', '--to', 'v0.3.0', '--wait-lock']]);
  reset({ pending: '0.1.0' });
  await U.afterRun({ fetch: fakeFetch([]), now: NOW, current: '0.1.0', launch, send: async () => {} });
  assert.equal(launched.length, 1); assert.equal(U.readState().pending, null);
});

test('the buttons: tonight and skip change update.json once; now refuses while a run holds the lock, else launches detached', () => {
  reset();
  const launched = [], launch = a => { launched.push(a); return { ok: true }; };
  const a = (action, v, busy = () => null) => U.updateAction(action, v, { launch, busy, current: '0.1.0' });
  assert.deepEqual(a('tonight', '0.3.0'), { ok: true, changed: true, message: 'v0.3.0 will be installed after tonight\'s run.' });
  assert.equal(a('tonight', 'v0.3.0').changed, false);
  assert.equal(U.readState().pending, '0.3.0');
  assert.equal(a('skip', '0.3.0').changed, true);
  assert.deepEqual([U.readState().skipped, U.readState().pending], [['0.3.0'], null]);
  assert.equal(a('skip', '0.3.0').changed, false);
  assert.equal(a('now', '0.3.0', () => 4242).message, 'A run is in progress. Choose Tonight, or try again when it finishes.');
  assert.equal(launched.length, 0);
  assert.equal(a('now', '0.3.0').message, 'Updating to v0.3.0. I will write when it is done.');
  assert.deepEqual(launched, [['update', '--to', 'v0.3.0']]);
  assert.equal(a('now', '0.1.0').ok, false, 'not newer');
  for (const bad of [['__proto__', '0.3.0'], ['now', 'latest'], ['constructor', '1.0.0']]) assert.equal(a(...bad).ok, false);
});

test('launchDetached: systemd-run --user on systemd hosts, else a detached child with a log file; nothing real is started', () => {
  const runs = [];
  const r = U.launchDetached(['update', '--to', 'v0.3.0'], { systemd: true, now: NOW, run: (cmd, args) => { runs.push([cmd, ...args]); return { status: 0 }; }, spawn: () => assert.fail('no spawn') });
  assert.deepEqual([r.ok, r.how, r.unit], [true, 'systemd-run', 'cometscout-update-20261102-183000']);
  assert.equal(runs[0][0], 'systemd-run');
  assert.ok(runs[0].includes('--user') && runs[0].includes('--collect') && runs[0].includes(`--setenv=COMETSCOUT_HOME=${tmp}`));
  assert.deepEqual(runs[0].slice(-3), ['update', '--to', 'v0.3.0']);
  const spawned = [];
  const d = U.launchDetached(['update'], { systemd: true, now: NOW, run: () => ({ status: 1 }), spawn: (cmd, args, opts) => { spawned.push({ args, opts }); return { unref() {} }; } });
  assert.equal(d.how, 'detached', 'systemd-run failing falls back to a detached child');
  assert.equal(spawned[0].opts.detached, true); assert.equal(spawned[0].opts.env.COMETSCOUT_HOME, tmp);
  assert.ok(fs.existsSync(d.log));
});

test('botRunning: bot.json touched in the last 3 minutes', () => {
  const f = STATE('bot.json');
  fs.writeFileSync(f, '{"offset":1}');
  assert.equal(U.botRunning({ file: f }), true);
  const old = new Date(Date.now() - 600000); fs.utimesSync(f, old, old);
  assert.equal(U.botRunning({ file: f }), false);
  assert.equal(U.botRunning({ file: path.join(tmp, 'none.json') }), false);
});

const CHAT = '777';
const fakeTransport = () => { const calls = []; return { calls, call: async (method, params) => { calls.push({ method, params }); return true; } }; };
const press = (data, chat = CHAT, text = 'CometScout v0.3.0 is out; you have v0.1.0.') => ({ callback_query: { id: 'q', data, message: { message_id: 5, text, chat: { id: Number(chat) } } } });
test('the bot: /update shows the versions and buttons; a button answers, edits once, and never for another chat', async () => {
  reset({ latest: { version: '0.3.0', highlights: ['Highlight.'] }, checked_at: '2026-11-02T18:30:00Z', channel: 'stable' });
  const transport = fakeTransport(), launched = [];
  const bot = createBot({ transport, chatId: CHAT, check: async () => ({ ok: true, ...U.status(U.readState(), '0.1.0') }), act: (a, v) => U.updateAction(a, v, { current: '0.1.0', busy: () => null, launch: x => { launched.push(x); return { ok: true }; } }) });
  await bot.handle({ message: { message_id: 1, chat: { id: 777 }, text: '/update' } });
  assert.equal(transport.calls[0].params.text, 'You have v0.1.0. Newest on the stable channel: v0.3.0.\nChecked 2026-11-02 18:30 UTC.\nHighlight.');
  assert.equal(transport.calls[0].params.reply_markup.inline_keyboard[0][1].callback_data, 'upd:tonight:0.3.0');
  transport.calls.length = 0;
  await bot.handle(press('upd:tonight:0.3.0', '999'));
  assert.equal(transport.calls.length, 0, 'another chat: no reply');
  await bot.handle(press('upd:tonight:0.3.0'));
  assert.deepEqual(transport.calls.map(c => c.method), ['answerCallbackQuery', 'editMessageText']);
  assert.match(transport.calls[1].params.text, /installed after tonight's run\.$/);
  assert.equal(transport.calls[1].params.reply_markup, undefined, 'the buttons go');
  await bot.handle(press('upd:tonight:0.3.0'));
  assert.deepEqual(transport.calls.map(c => c.method), ['answerCallbackQuery', 'editMessageText', 'answerCallbackQuery'], 'nothing changed: no edit');
  await bot.handle(press('upd:now:not-a-version'));
  assert.equal(transport.calls.at(-1).params.text, 'Unknown command. /help lists what I can do.');
  await bot.handle(press('upd:now:0.3.0'));
  assert.deepEqual(launched, [['update', '--to', 'v0.3.0']], 'Update now is started outside the bot process');
});

test('/api/update and POST /api/update use the same actions; bad input is a 400', () => {
  reset({ latest: { version: '9.0.0', highlights: [] } });
  assert.equal(W.updatePayload().latest, '9.0.0');
  assert.equal(W.updatePayload().current, APP_VERSION);
  assert.throws(() => W.postUpdate({ action: 'rm', version: '9.0.0' }), e => e.status === 400);
  assert.throws(() => W.postUpdate({ action: 'now', version: 'x' }), e => e.status === 400);
  const r = W.postUpdate({ action: 'tonight', version: '9.0.0' });
  assert.equal(r.update.pending, '9.0.0');
  assert.throws(() => W.postUpdate({ action: 'now', version: '9.0.0' }, { act: () => ({ ok: false, message: 'busy' }) }), e => e.status === 409);
});

test('What is new: shown once after an update, the notes since the old version, Action needed linked to the settings dialog', () => {
  const list = [
    { version: '0.3.0', date: '2026-11-01', min_node: 20, schema_version: 1, migrations: [], behaviour_changes: true, media: [{ path: 'docs/screenshots/x.png', alt: 'The screen' }],
      notes: { highlights: ['Three.'], new: ['N3'], changed: ['C3'], action_needed: [{ text: 'Check the time.', setting: 'schedule.time' }, { text: 'Read the docs.' }], changed_defaults: [{ setting: 'schedule.time', default: '19:00', text: 'The run moves.' }, { setting: 'picks.per_day', default: 3, text: 'More picks.' }] },
      notes_ru: { highlights: ['Три.'] } },
    { version: '0.2.0', date: '2026-10-20', min_node: 20, schema_version: 1, migrations: [], behaviour_changes: false, notes: { highlights: ['Two.'] } },
    { version: '0.1.0', date: '2026-10-05', min_node: 20, schema_version: 1, migrations: [], behaviour_changes: false, notes: { highlights: ['One.'] } },
  ];
  const state = { whats_new_pending: '0.3.0', whats_new_from: '0.1.0' };
  const w = U.whatsNew({ state, current: '0.3.0', list });
  assert.equal(w.show, true);
  assert.deepEqual(w.releases.map(r => r.version), ['0.3.0', '0.2.0']);
  assert.deepEqual(w.releases[0].action_needed, [{ text: 'Check the time.', setting: 'schedule.time', key: 'time' }, { text: 'Read the docs.', setting: null, key: null }]);
  assert.deepEqual(w.releases[0].changed_defaults, [{ setting: 'schedule.time', default: '19:00', yours: '18:00', text: 'The run moves.', key: 'time' }, { setting: 'picks.per_day', default: 3, yours: 2, text: 'More picks.', key: null }]);
  assert.deepEqual(w.releases[0].media, [{ url: '/media/docs/screenshots/x.png', alt: 'The screen' }]);
  assert.deepEqual(U.whatsNew({ state, current: '0.3.0', list, locale: 'ru' }).releases[0].highlights, ['Три.']);
  assert.equal(U.whatsNew({ state, current: '0.2.0', list }).show, false, 'rolled back: not shown');
  assert.equal(U.whatsNew({ state: {}, current: '0.3.0', list }).show, false, 'a fresh install: nothing to show');
  reset({ whats_new_pending: APP_VERSION, whats_new_from: '0.0.1' });
  assert.equal(W.whatsNewPayload().show, true);
  assert.throws(() => W.postWhatsNew({ seen: '0.0.9' }), e => e.status === 400);
  W.postWhatsNew({ seen: APP_VERSION });
  assert.equal(W.whatsNewPayload().show, false); assert.equal(U.readState().last_seen, APP_VERSION);
});

test('/media/ serves only images release.json names', async () => {
  const list = [{ media: [{ path: 'docs/screenshots/workspace-today-desktop.png', alt: 'x' }] }];
  assert.ok(U.mediaFile('docs/screenshots/workspace-today-desktop.png', list));
  assert.equal(U.mediaFile('docs/screenshots/workspace-today-phone-list.png', list), null, 'not named');
  assert.equal(U.mediaFile('../package.json', [{ media: [{ path: '../package.json' }] }]), null);
  const handler = makeHandler({ hosts: () => new Set(['127.0.0.1:1']) });
  const get = p => new Promise(resolve => { const res = { headers: {}, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { resolve({ status: this.status, type: this.headers['Content-Type'], len: b?.length }); } }; handler({ method: 'GET', url: p, headers: { host: '127.0.0.1:1' } }, res); });
  assert.equal((await get('/media/package.json')).status, 404);
  assert.equal((await get('/media/%2e%2e/package.json')).status, 404);
  assert.equal((await get('/api/update')).status, 200);
});

test('COMETSCOUT_LLM_FAKE: "1" is the canned verdict, a path is a JSON answer; no model CLI starts', async () => {
  assert.equal(fakeAnswer({}), null);
  assert.deepEqual(fakeAnswer({ COMETSCOUT_LLM_FAKE: '1' }), CANNED);
  const f = path.join(tmp, 'answer.json'); fs.writeFileSync(f, JSON.stringify({ verdict: 'strong-fit' }));
  assert.deepEqual(fakeAnswer({ COMETSCOUT_LLM_FAKE: f }), { verdict: 'strong-fit' });
  assert.throws(() => fakeAnswer({ COMETSCOUT_LLM_FAKE: path.join(tmp, 'missing.json') }), /cannot read/);
  SETTINGS.llm.bin = path.join(tmp, 'no-such-model-cli');
  process.env.COMETSCOUT_LLM_FAKE = '1';
  try { assert.deepEqual((await callJson({ prompt: 'x', schema: {} })).value, CANNED); } finally { delete process.env.COMETSCOUT_LLM_FAKE; }
});

test('doctor lines: the code layout and the update state; a wrong channel is named', () => {
  const lines = U.updateDoctor();
  assert.match(lines.map(l => l.text).join('\n'), /code: .*a git clone/);
  assert.match(lines.map(l => l.text).join('\n'), /updates: checked after the evening run, stable channel/);
  assert.deepEqual(U.updateSettings({ update: { channel: 'nightly' } }).problems, ['update.channel must be "stable" or "edge", got "nightly"']);
  assert.equal(U.updateSettings({}).repo, 'Dreamkeeper/cometscout');
});

test('the bot\'s poll loop touches bot.json, so the notice knows the bot is running', async () => {
  const { poll } = await import('../lib/bot.mjs');
  const f = path.join(tmp, 'bot-alive.json');
  fs.writeFileSync(f, JSON.stringify({ offset: 3 }));
  const old = new Date(Date.now() - 600000); fs.utimesSync(f, old, old);
  assert.equal(U.botRunning({ file: f }), false);
  await poll({ bot: { handle: async () => {} }, transport: { call: async () => [] }, stateFile: f, once: true });
  assert.equal(U.botRunning({ file: f }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { offset: 3 }, 'the offset is untouched');
});

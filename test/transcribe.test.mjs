// The transcription module (lib/transcribe.mjs) with a fake transcriber (COMETSCOUT_TRANSCRIBE_CMD, a Node script that
// writes canned segments): one file and the queue, one job at a time, the outputs and their content, audio moved and
// pruned, the failure note and its one alert, the coach copy and hand-off listing, the bench math, the upload API, the
// bot taking small audio and refusing big files, doctor lines, the units, and Russian labels. No Python, model,
// network or systemctl; synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-transcribe-'));
// kept as .txt in fixtures, so node --test does not run it as a test file
const FAKE = path.join(tmp, 'fake-transcriber.mjs');
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'transcribe', 'fake-transcriber.mjs.txt'), FAKE);
const HOME = path.join(tmp, 'home'), DATA = path.join(HOME, 'data'), MOD = path.join(tmp, 'module'), COACH = path.join(tmp, 'coach');
const FAKE_LOG = path.join(tmp, 'fake.log');
fs.mkdirSync(HOME, { recursive: true }); fs.mkdirSync(COACH, { recursive: true });
Object.assign(process.env, { COMETSCOUT_HOME: HOME, COMETSCOUT_DATA: DATA, COMETSCOUT_SETTINGS: path.join(HOME, 'settings.json'), COMETSCOUT_TRANSCRIBE_CMD: FAKE, FAKE_TRANSCRIBE_LOG: FAKE_LOG });
const SETTINGS = { timezone: 'UTC', locale: 'en', modules: { coach: { enabled: true, path: COACH }, transcribe: { enabled: true, path: MOD, threads: 2, keep_audio_days: 30, max_upload_mb: 1 } } };
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify(SETTINGS));

const T = await import('../lib/transcribe.mjs');
const { translator } = await import('../lib/i18n.mjs');
const { createBot, audioOf } = await import('../lib/bot.mjs');
const { coachHandoff } = await import('../lib/coach.mjs');
const { unitFiles, installTimer } = await import('../lib/ops.mjs');
const { startServer, uploadAudio } = await import('../lib/server.mjs');
const W = await import('../web/lib/transcribe.js');
const { createApi } = await import('../web/lib/api.js');

const s = T.transcribeSettings();
const quiet = () => {};
const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env: { ...process.env, ...env }, timeout: 120000 });
const past = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };
/** A synthetic "recording" in the inbox: a small text file the fake transcriber reads; written `age` ms ago. */
const audio = (name, text = 'synthetic audio', age = 120000, dir = s.inbox) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); fs.writeFileSync(f, text); if (age) past(f, age); return f; };
const fakeCalls = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const clean = () => { for (const d of [s.inbox, s.done, s.transcripts, path.join(COACH, 'materials')]) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(FAKE_LOG, { force: true }); };
const dirsIn = d => (fs.existsSync(d) ? fs.readdirSync(d) : []);

test('settings: defaults, the inbox inside the data folder, paths resolved', () => {
  const d = T.transcribeSettings({}, '/srv/home', '/srv/home/data');
  assert.equal(d.enabled, false);
  assert.equal(d.path, path.resolve('/srv/home', '..', 'cometscout-transcribe'));
  assert.deepEqual([d.model, d.compute_type, d.threads, d.nice, d.language, d.keep_audio_days, d.max_upload_mb], ['large-v3-turbo', 'int8', 2, 10, null, 30, 500]);
  assert.equal(d.inbox, path.join('/srv/home/data', 'audio', 'inbox'));
  assert.equal(T.transcribeSettings({}, '/srv/home', '/elsewhere/data').inbox, path.join('/elsewhere/data', 'audio', 'inbox'), 'follows COMETSCOUT_DATA');
  assert.equal(T.transcribeSettings({ modules: { transcribe: { inbox: 'recordings' } } }, '/srv/home', '/x').inbox, path.resolve('/srv/home', 'recordings'));
  const odd = T.transcribeSettings({ modules: { transcribe: { threads: 'many', nice: 99, language: 'RU', keep_audio_days: -1, model: '' } } }, '/srv/home', '/x');
  assert.deepEqual([odd.threads, odd.nice, odd.language, odd.keep_audio_days, odd.model], [2, 10, 'ru', 30, 'large-v3-turbo'], 'a typo never removes a limit');
  assert.equal(T.transcribeSettings({ modules: { transcribe: { language: 'english' } } }, '/r', '/x').language, null);
});

test('the command: the fake from COMETSCOUT_TRANSCRIBE_CMD, else the venv Python; nice and ionice where they exist', () => {
  const [cmd, args] = T.transcriberCommand({ ...s, language: 'ru' }, { audio: 'a.mp3', out: 'o.json' });
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args.slice(0, 1), [FAKE]);
  assert.deepEqual(args.slice(1), ['--out', 'o.json', '--model', 'large-v3-turbo', '--compute-type', 'int8', '--threads', '2', '--models-dir', path.join(MOD, 'models'), '--language', 'ru', 'a.mp3']);
  const [py, pargs] = T.transcriberCommand(s, { audio: 'a.mp3', out: 'o.json', env: {} });
  assert.equal(py, T.venvPython(s)); assert.equal(pargs[0], T.SCRIPT);
  assert.ok(T.SCRIPT.endsWith(path.join('deploy', 'modules', 'transcribe', 'transcribe.py')));
  assert.deepEqual(T.lowPriority(['py', ['x']], { nice: 10, platform: 'linux', has: () => true }), { cmd: 'nice', args: ['-n', '10', 'ionice', '-c', '2', '-n', '7', 'py', 'x'], renice: 0 });
  assert.deepEqual(T.lowPriority(['py', ['x']], { nice: 10, platform: 'linux', has: n => n === 'nice' }), { cmd: 'nice', args: ['-n', '10', 'py', 'x'], renice: 0 });
  assert.deepEqual(T.lowPriority(['py', ['x']], { nice: 5, platform: 'linux', has: () => false }), { cmd: 'py', args: ['x'], renice: 5 });
  assert.deepEqual(T.lowPriority(['py.exe', ['x']], { nice: 10, platform: 'win32', has: () => true }), { cmd: 'py.exe', args: ['x'], renice: 10 });
  const env = T.jobEnv(3, {});
  assert.deepEqual([env.OMP_NUM_THREADS, env.MKL_NUM_THREADS, env.OPENBLAS_NUM_THREADS, env.HF_HUB_DISABLE_TELEMETRY], ['3', '3', '3', '1']);
});

test('rendering: timestamps, paragraphs, SubRip; transcript.md in English and Russian', () => {
  assert.equal(T.clock(3725.4), '01:02:05'); assert.equal(T.srtTime(3725.4), '01:02:05,400'); assert.equal(T.srtTime(0.0004), '00:00:00,000');
  const segs = [{ start: 0, end: 2, text: ' One.' }, { start: 2.5, end: 4, text: 'Two.' }, { start: 7, end: 8, text: 'Three.' }, { start: 8.2, end: 9, text: '  ' }];
  assert.deepEqual(T.paragraphs(segs).map(p => [p.start, p.text]), [[0, 'One. Two.'], [7, 'Three.']]);
  const long = (t1, t2 = 'next.') => T.paragraphs([{ start: 0, end: 1, text: t1 }, { start: 1, end: 2, text: t2 }]).length;
  assert.equal(long(`${'x'.repeat(700)}.`), 2, 'a long paragraph is closed at the end of a sentence');
  assert.equal(long('x'.repeat(700)), 1, 'not in the middle of one');
  assert.equal(long('x'.repeat(1300)), 2, 'unless it is twice the length');
  assert.equal(T.renderSrt(segs), '1\n00:00:00,000 --> 00:00:02,000\nOne.\n\n2\n00:00:02,500 --> 00:00:04,000\nTwo.\n\n3\n00:00:07,000 --> 00:00:08,000\nThree.\n');
  assert.equal(T.rtf(30, 120), 0.25); assert.equal(T.rtf(30, 0), null);
  const r = { source: 'Синтетика.m4a', at: '2026-10-07 18:00 UTC', language: 'ru', language_probability: 0.912, duration: 3730, model: 'small', compute_type: 'int8', threads: 4, seconds: 400, transcribe_seconds: 373, segments: segs };
  const en = T.renderMarkdown(r);
  assert.match(en, /^# Transcript: Синтетика\.m4a\n\n- Language: ru \(detected, 91%\)\n- Length: 01:02:10 \(1 h 2 min\)\n- Model: small \(int8, CPU, 4 threads\)\n- Transcribed: in 6 min 40 s, real-time factor 0\.1, on 2026-10-07 18:00 UTC\n- Speakers: not separated\n\n\[00:00:00\] One\. Two\.\n\n\[00:00:07\] Three\.\n$/);
  const ru = T.renderMarkdown({ ...r, language_set: true }, translator('ru'));
  assert.match(ru, /^# Расшифровка: Синтетика\.m4a$/m);
  assert.match(ru, /^- Язык: ru \(задан в настройках\)$/m);
  assert.match(ru, /^- Длительность: 01:02:10 \(1 ч 2 мин\)$/m);
  assert.match(ru, /^- Говорящие: не разделены$/m);
  for (const w of ['Transcript', 'Language', 'Length', 'Speakers', 'threads']) assert.ok(!ru.includes(w), `ru still says ${w}`);
  assert.match(T.renderMarkdown({ ...r, segments: [] }), /No speech was found in this recording\./);
});

test('file names: only the last part, no control or reserved characters, an audio or video extension', () => {
  const cases = { '../../etc/passwd': null, '..\\..\\Windows\\x.mp3': 'x.mp3', '.hidden.mp3': 'hidden.mp3', 'a\u0000b\u0007.wav': 'ab.wav', 'notes.txt': null, '.mp3': null,
    'C:evil.MP3': 'Cevil.mp3', 'Собеседование 7 окт.m4a': 'Собеседование 7 окт.m4a', 'call?.<x>.ogg': 'call.x.ogg', '': null, [`${'a'.repeat(300)}.opus`]: `${'a'.repeat(115)}.opus`,
    // Windows device names, with any extension: a "_" in front on every platform
    'nul.mp3': '_nul.mp3', 'CON.m4a': '_CON.m4a', 'prn.backup.ogg': '_prn.backup.ogg', 'aux.MP4': '_aux.mp4', 'com1 .wav': '_com1.wav', 'LPT9.mp3': '_LPT9.mp3', 'COM¹.mp3': '_COM¹.mp3',
    'null.mp3': 'null.mp3', 'console.mp3': 'console.mp3', 'com10.mp3': 'com10.mp3', 'nul': null };
  for (const [raw, want] of Object.entries(cases)) assert.equal(T.safeAudioName(raw), want, raw);
  assert.equal(audioOf({ audio: { file_id: 'n', file_name: 'nul.ogg', mime_type: 'audio/ogg' } }).name, '_nul.ogg', 'the bot uses the same rule');
  assert.equal(T.slug('Call with ACME (final).m4a'), 'call-with-acme-final-m4a');
  assert.equal(T.slug('Собеседование!'), 'собеседование');
  assert.equal(T.slug('***'), 'audio');
});

test('one file from the inbox: transcript.md, .srt and segments.json; the audio moves to done/; the coach gets a copy', () => {
  clean();
  const f = audio('Call with Acme.m4a');
  const r = cli(['transcribe', f]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [dir] = dirsIn(s.transcripts);
  assert.match(dir, /^\d{4}-\d{2}-\d{2}--call-with-acme$/);
  const out = path.join(s.transcripts, dir);
  assert.deepEqual(dirsIn(out).sort(), ['segments.json', 'transcript.md', 'transcript.srt']);
  const md = fs.readFileSync(path.join(out, 'transcript.md'), 'utf8');
  assert.match(md, /^# Transcript: Call with Acme\.m4a$/m);
  assert.match(md, /^- Language: en \(detected, 97%\)$/m);
  assert.match(md, /^- Length: 01:02:10 \(1 h 2 min\)$/m);
  assert.match(md, /^- Model: large-v3-turbo \(int8, CPU, 2 threads\)$/m);
  // the factor comes from the measured wall time, so a busy machine makes it larger: the format is what is tested
  assert.match(md, /^- Transcribed: in .+, real-time factor \d+(\.\d+)?, on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/m);
  assert.match(md, /^- Speakers: not separated$/m);
  assert.match(md, /^\[00:00:00\] Hello, thanks for joining the call today\. Could you walk me through your last product launch\?$/m);
  assert.match(md, /^\[00:00:13\] Sure\. We shipped a synthetic billing feature in six weeks\.$/m);
  assert.match(md, /^\[01:02:05\] Thank you, that is all from me\.$/m);
  const srt = fs.readFileSync(path.join(out, 'transcript.srt'), 'utf8');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:04,200\nHello, thanks for joining the call today\.\n/);
  assert.match(srt, /\n4\n01:02:05,400 --> 01:02:09,000\nThank you, that is all from me\.\n$/);
  const j = JSON.parse(fs.readFileSync(path.join(out, 'segments.json'), 'utf8'));
  assert.deepEqual([j.source, j.duration, j.language, j.model, j.speakers, j.segments.length, j.segments[0].text], ['Call with Acme.m4a', 3730, 'en', 'large-v3-turbo', 'not separated', 4, 'Hello, thanks for joining the call today.']);
  assert.ok(!fs.existsSync(f), 'gone from the inbox');
  assert.deepEqual(dirsIn(s.done), [`${dir}.m4a`]);
  const coachCopy = path.join(COACH, 'materials', 'transcripts', `${dir}.md`);
  assert.equal(fs.readFileSync(coachCopy, 'utf8'), md);
  assert.match(r.stdout, /For the coach: .*say analyze/);
  const [call] = fakeCalls();
  assert.equal(call.omp, '2', 'thread cap in the environment');
  assert.deepEqual(call.args.slice(call.args.indexOf('--threads'), call.args.indexOf('--threads') + 2), ['--threads', '2']);
  assert.ok(!fs.existsSync(T.LOCK(s)), 'the lock is released');
});

test('a file outside the inbox is transcribed and left where it is; a missing file is an error', () => {
  clean();
  const f = audio('elsewhere.mp3', 'synthetic', 0, path.join(tmp, 'outside'));
  assert.equal(cli(['transcribe', f]).status, 0);
  assert.ok(fs.existsSync(f));
  assert.equal(dirsIn(s.transcripts).length, 1);
  const r = cli(['transcribe', path.join(tmp, 'nope.mp3')]);
  assert.equal(r.status, 1); assert.match(r.stdout, /No such file/);
  assert.match(cli(['transcribe']).stdout, /^Usage: node cli\.mjs transcribe/);
});

test('the queue: ready files oldest first, one at a time; dot files and other files are left alone', async () => {
  clean();
  audio('second.wav', 'x', 200000); audio('first.mp3', 'x', 300000);
  const part = audio('.upload.mp3', 'x', 300000), notes = audio('notes.txt', 'x', 300000);
  const logs = [], ready = [];
  const r = await T.runQueue({ s, settleMs: 1000, sleep: async () => {}, log: l => logs.push(l), notifyDone: async x => { ready.push(x); } });
  assert.deepEqual(r, { done: 2, failed: 0 });
  assert.deepEqual(fakeCalls().map(c => path.basename(c.audio)), ['first.mp3', 'second.wav']);
  assert.deepEqual(dirsIn(s.inbox).sort(), ['.upload.mp3', 'notes.txt']);
  assert.ok(fs.existsSync(part) && fs.existsSync(notes));
  assert.ok(logs.some(l => /ignored notes\.txt \(not an audio or video file\)/.test(l)));
  // the real transcripts folder (COMETSCOUT_DATA here), not a fixed data/transcripts
  assert.ok(ready[0].startsWith(`Transcript ready: first.mp3 (01:02:10, en), ${path.join(s.transcripts, '')}`), ready[0]);
  assert.match(ready[0], /\d{4}-\d{2}-\d{2}--first$/);
  assert.equal(dirsIn(s.done).length, 2);
});

test('the queue waits for a file still being written, and gives up waiting after maxWaitMs', async () => {
  clean();
  const f = audio('late.ogg', 'x', 0);
  let sleeps = 0;
  const r = await T.runQueue({ s, settleMs: 60000, pollMs: 5, sleep: async () => { sleeps++; past(f, 120000); }, log: quiet, notifyDone: async () => {} });
  assert.deepEqual([r.done, sleeps], [1, 1]);
  const g = audio('stuck.ogg', 'x', 0);
  const r2 = await T.runQueue({ s, settleMs: 60000, pollMs: 10, maxWaitMs: 30, sleep: async () => { sleeps++; }, log: quiet });
  assert.deepEqual(r2, { done: 0, failed: 0 });
  assert.ok(fs.existsSync(g));
});

test('one job at a time: a second run exits (the queue with 0, a single file with 1) while the lock is held', () => {
  clean();
  const f = audio('wait.mp3');
  fs.mkdirSync(MOD, { recursive: true }); fs.writeFileSync(T.LOCK(s), String(process.pid));   // a live process that is not the child
  try {
    const q = cli(['transcribe', '--queue']);
    assert.equal(q.status, 0); assert.match(q.stdout, /a job is already running \(pid \d+\); it picks up new files/);
    const one = cli(['transcribe', f]);
    assert.equal(one.status, 1); assert.match(one.stdout, /A transcription is already running/);
    assert.ok(fs.existsSync(f)); assert.deepEqual(fakeCalls(), []);
    assert.equal(T.takeTranscribeLock(T.LOCK(s)).busy, undefined, 'its own pid is not another holder');
  } finally { fs.rmSync(T.LOCK(s), { force: true }); }
  fs.writeFileSync(T.LOCK(s), String(process.ppid));
  try { assert.equal(T.takeTranscribeLock(T.LOCK(s)).busy, process.ppid); } finally { fs.rmSync(T.LOCK(s), { force: true }); }
  const lock = T.takeTranscribeLock(T.LOCK(s)); assert.ok(lock.release); lock.release(); assert.ok(!fs.existsSync(T.LOCK(s)));
});

test('a failure: the audio stays with a .failed note, one alert; the next run skips it; deleting the note retries', async () => {
  clean();
  const f = audio('broken.mp3', 'FAIL');
  const alerts = [];
  const alert = async x => { alerts.push(x); };
  const r = await T.runQueue({ s, settleMs: 0, log: quiet, alert, notifyDone: async () => {} });
  assert.deepEqual(r, { done: 0, failed: 1 });
  assert.ok(fs.existsSync(f));
  const note = fs.readFileSync(`${f}.failed`, 'utf8');
  assert.match(note, /RuntimeError: synthetic decoder failure/); assert.match(note, /Delete this note to try again/);
  assert.deepEqual(alerts, ['Transcription failed: broken.mp3. RuntimeError: synthetic decoder failure. The audio stays in the inbox with a .failed note; delete the note to try again.']);
  await T.runQueue({ s, settleMs: 0, log: quiet, alert, notifyDone: async () => {} });
  assert.equal(alerts.length, 1, 'alerted once'); assert.equal(fakeCalls().length, 1, 'not tried again');
  const st = T.queueStatus({ s });
  assert.deepEqual(st.failed.map(x => [x.name, x.error]), [['broken.mp3', 'RuntimeError: synthetic decoder failure']]);
  assert.deepEqual(st.waiting, []);
  fs.writeFileSync(f, 'now fine'); past(f, 120000); fs.rmSync(`${f}.failed`);
  assert.deepEqual(await T.runQueue({ s, settleMs: 0, log: quiet, alert, notifyDone: async () => {} }), { done: 1, failed: 0 });
  assert.ok(!fs.existsSync(f) && !fs.existsSync(`${f}.failed`));
  // a transcriber that writes nothing, or cannot start, fails the same way
  const g = audio('nojson.mp3', 'NOJSON');
  assert.equal((await T.transcribeFile(g, { s, fromInbox: true, log: quiet, alert })).error, 'the transcriber exited with 0');
  const missing = await T.transcribeFile(audio('x.mp3', 'x'), { s, fromInbox: false, log: quiet, alert }, process.env.COMETSCOUT_TRANSCRIBE_CMD = path.join(tmp, 'no-such-transcriber'));
  process.env.COMETSCOUT_TRANSCRIBE_CMD = FAKE;
  assert.equal(missing.ok, false); assert.match(missing.error, /not found|did not start|ENOENT|No such file/);   // with ionice on the PATH (Linux) it reports the missing file
  assert.equal(alerts.length, 2, 'a file outside the queue mode gets no note and no alert');
  // the full path in an error becomes the file's name (JSON.stringify doubles backslashes, as Python's repr does)
  const bad = await T.transcribeFile(audio('Long name.ogg', 'BADPATH'), { s, fromInbox: true, log: quiet, alert });
  assert.equal(bad.error, 'InvalidDataError: Invalid data found when processing input: "Long name.ogg"');
});

test('a transcriber that cannot even be spawned (spawn throws at once) is a normal failure: the note and one alert', async () => {
  clean();
  const start = () => { throw new Error('spawn EINVAL (synthetic)'); };
  const r = await T.runTranscriber(s, { audio: 'x.mp3', start, echo: false });
  assert.deepEqual([r.code, r.json, r.err], [null, null, 'spawn EINVAL (synthetic)']);
  const f = audio('nostart.mp3');
  const alerts = [];
  assert.deepEqual(await T.runQueue({ s, settleMs: 0, log: quiet, alert: async x => { alerts.push(x); }, notifyDone: async () => {}, start }), { done: 0, failed: 1 });
  assert.ok(fs.existsSync(f));
  assert.match(fs.readFileSync(`${f}.failed`, 'utf8'), /spawn EINVAL \(synthetic\)/);
  assert.deepEqual(alerts, ['Transcription failed: nostart.mp3. spawn EINVAL (synthetic). The audio stays in the inbox with a .failed note; delete the note to try again.']);
});

test('a file stamped in the future (a wrong clock) is ready at once instead of settling for hours', async () => {
  clean();
  const f = audio('future.m4a', 'x', 0);
  const ahead = new Date(Date.now() + 3 * 3600000); fs.utimesSync(f, ahead, ahead);
  assert.deepEqual(T.scanInbox(s).ready.map(x => x.name), ['future.m4a']);
  let sleeps = 0;
  assert.deepEqual(await T.runQueue({ s, sleep: async () => { sleeps++; }, log: quiet, notifyDone: async () => {} }), { done: 1, failed: 0 });
  assert.equal(sleeps, 0, 'no waiting');
  audio('fresh.m4a', 'x', 0);
  assert.deepEqual(T.scanInbox(s).settling.map(x => x.name), ['fresh.m4a'], 'a file written just now still settles');
});

test('a job that throws outside its failure path (no transcripts folder can be made): note, one alert, next file, exit 0', async () => {
  clean();
  const a = audio('one.mp3', 'x', 300000), b = audio('two.mp3', 'x', 200000);
  const blocker = path.join(tmp, 'a-file-not-a-folder'); fs.writeFileSync(blocker, 'x');
  const alerts = [];
  const r = await T.runQueue({ s: { ...s, transcripts: blocker }, settleMs: 0, log: quiet, alert: async x => { alerts.push(x); }, notifyDone: async () => {} });
  assert.deepEqual(r, { done: 0, failed: 2 }, 'both tried, one after the other');
  for (const f of [a, b]) { assert.ok(fs.existsSync(f)); assert.match(fs.readFileSync(`${f}.failed`, 'utf8'), /EEXIST|ENOTDIR/); }
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /^Transcription failed: one\.mp3\. .*(EEXIST|ENOTDIR)/);
  // through the CLI, as the path unit runs it: data/transcripts is a file, the queue still exits 0
  clean();
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(s.transcripts, 'not a folder');
  const c = audio('cli.mp3');
  try {
    const q = cli(['transcribe', '--queue']);
    assert.equal(q.status, 0, q.stdout + q.stderr);
    assert.match(q.stdout, /queue done \(0 transcribed, 1 failed\)/);
    assert.ok(fs.existsSync(`${c}.failed`));
  } finally { fs.rmSync(s.transcripts, { force: true }); }
});

test('enabled but not installed: the queue alerts once, leaves the audio waiting and exits 0; installing clears that', async () => {
  clean();
  const bare = { ...s, path: path.join(tmp, 'never-installed') };
  const memory = path.join(DATA, 'state', 'transcribe-not-installed.json');
  fs.rmSync(memory, { force: true });
  const f = audio('waiting.mp3');
  const alerts = [], logs = [];
  const opts = { s: bare, log: l => logs.push(l), alert: async x => { alerts.push(x); } };
  delete process.env.COMETSCOUT_TRANSCRIBE_CMD;
  try {
    for (let i = 0; i < 3; i++) assert.equal(await T.transcribeCommand(['--queue'], opts), 0);
    assert.equal(alerts.length, 1, 'one alert, not one per inbox event');
    assert.match(alerts[0], /^Transcription is on, but the module is not installed at .*never-installed, so recordings wait in the inbox\. Install it: .*transcribe\.(sh|ps1)\. This alert is sent once\.$/);
    assert.ok(fs.existsSync(memory));
    assert.equal(logs.filter(l => /not installed/.test(l)).length, 3);
    assert.ok(fs.existsSync(f) && !fs.existsSync(`${f}.failed`), 'the audio waits, with no failure note');
    assert.deepEqual(fakeCalls(), []);
    assert.equal(await T.transcribeCommand([f], { ...opts, log: quiet }), 1, 'one file by hand still exits 1');
    // as the path unit starts it: exit 0, no new alert
    const q = cli(['transcribe', '--queue'], { COMETSCOUT_TRANSCRIBE_CMD: '' });
    assert.equal(q.status, 0, q.stdout + q.stderr); assert.match(q.stdout, /not installed .*audio waits in the inbox/);
  } finally { process.env.COMETSCOUT_TRANSCRIBE_CMD = FAKE; }
  // installed (the fake transcriber stands in): the memory goes and the audio is transcribed
  assert.equal(await T.transcribeCommand(['--queue'], { ...opts, notifyDone: async () => {} }), 0);
  assert.ok(!fs.existsSync(memory)); assert.ok(!fs.existsSync(f));
  // removed again later: one new alert
  delete process.env.COMETSCOUT_TRANSCRIBE_CMD;
  try { await T.transcribeCommand(['--queue'], opts); } finally { process.env.COMETSCOUT_TRANSCRIBE_CMD = FAKE; }
  assert.equal(alerts.length, 2);
  fs.rmSync(memory, { force: true });
});

test('"Transcript ready" attaches transcript.md as a document; text only with the setting off, over 50 MB or when the upload fails', async () => {
  clean();
  const sent = [];
  const tg = { on: () => true, send: async x => { sent.push(['text', x]); }, sendDoc: async (file, caption) => { sent.push(['document', path.basename(file), caption, fs.readFileSync(file, 'utf8').split('\n')[0]]); } };
  audio('attach.mp3');
  assert.deepEqual(await T.runQueue({ s, settleMs: 0, log: quiet, tg }), { done: 1, failed: 0 });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].slice(0, 2), ['document', 'transcript.md']);
  assert.match(sent[0][2], /^Transcript ready: attach\.mp3 \(01:02:10, en\), /, 'the short text is the caption');
  assert.equal(sent[0][3], '# Transcript: attach.mp3');
  sent.length = 0; audio('plain.mp3');
  await T.runQueue({ s: { ...s, telegram_attach: false }, settleMs: 0, log: quiet, tg });
  assert.deepEqual(sent.map(x => x[0]), ['text'], 'telegram_attach: false');
  sent.length = 0; audio('small-limit.mp3');
  const logs = [];
  await T.runQueue({ s, settleMs: 0, log: l => logs.push(l), tg: { ...tg, max: 10 } });
  assert.deepEqual(sent.map(x => x[0]), ['text']);
  assert.ok(logs.some(l => /transcript\.md is .* MB, over the .* a bot can send; sending the text only/.test(l)));
  // a real file over the 50 MB bot upload limit
  const huge = path.join(tmp, 'huge-transcript.md');
  fs.writeFileSync(huge, ''); fs.truncateSync(huge, T.TELEGRAM_UPLOAD_MAX + 1);
  try {
    sent.length = 0;
    assert.equal(await T.sendReady('Transcript ready: huge', { file: huge, log: quiet, tg }), 'text');
    assert.deepEqual(sent, [['text', 'Transcript ready: huge']]);
  } finally { fs.rmSync(huge, { force: true }); }
  const md = path.join(s.transcripts, dirsIn(s.transcripts)[0], 'transcript.md');
  sent.length = 0;
  assert.equal(await T.sendReady('refused', { file: md, log: quiet, tg: { ...tg, sendDoc: async () => { throw new Error('Telegram sendDocument 400'); } } }), 'text');
  assert.deepEqual(sent, [['text', 'refused']]);
  assert.equal(await T.sendReady('off', { file: md, tg: { ...tg, on: () => false } }), false, 'Telegram off: nothing');
  assert.equal(T.transcribeSettings({}).telegram_attach, true, 'on by default');
  assert.equal(T.transcribeSettings({ modules: { transcribe: { telegram_attach: false } } }).telegram_attach, false);
});

test('audio in done/ is deleted after keep_audio_days; 0 deletes it right after the transcript', async () => {
  clean();
  fs.mkdirSync(s.done, { recursive: true });
  const old = path.join(s.done, 'old.mp3'), young = path.join(s.done, 'young.mp3');
  fs.writeFileSync(old, 'x'); fs.writeFileSync(young, 'x');
  past(old, 31 * 86400000); past(young, 29 * 86400000);
  assert.deepEqual(T.pruneAudio(s), ['old.mp3']);
  assert.deepEqual(dirsIn(s.done), ['young.mp3']);
  const f = audio('now.mp3');
  assert.equal((await T.transcribeFile(f, { s: { ...s, keep_audio_days: 0 }, fromInbox: true, log: quiet })).ok, true);
  assert.ok(!fs.existsSync(f)); assert.deepEqual(dirsIn(s.done), ['young.mp3']);
  // a moved file counts from the move, not from when it was recorded
  const g = audio('recorded-long-ago.mp3', 'x', 400 * 86400000);
  await T.transcribeFile(g, { s, fromInbox: true, log: quiet });
  assert.deepEqual(T.pruneAudio(s), []);
});

test('the coach hand-off lists the transcripts in the coach\'s folder as ready for analyze', async () => {
  clean();
  await T.transcribeFile(audio('Screen call.mp3'), { s, fromInbox: true, log: quiet });
  const [dir] = dirsIn(s.transcripts);
  const logs = [];
  assert.equal(coachHandoff({ profileDir: path.join(ROOT, 'profile.example'), log: l => logs.push(l) }), 0);
  const text = fs.readFileSync(path.join(COACH, 'materials', 'cometscout-handoff.md'), 'utf8');
  assert.match(text, /^## Interview transcripts$/m);
  assert.ok(text.includes(`- materials/transcripts/${dir}.md (${dir.slice(0, 10)}), ready for analyze`), text.slice(-600));
  assert.match(text, /Speakers are not separated/);
  // without the coach enabled nothing is copied
  assert.equal(T.copyToCoach(path.join(s.transcripts, dir), { settings: { modules: { coach: { enabled: false } } }, log: quiet }), null);
});

test('bench: real-time factor, an hour of audio, peak memory per model; nothing is written or moved', () => {
  const row = T.benchRow('small', { code: 0, json: { duration: 120, transcribe_seconds: 30, load_seconds: 2, peak_rss_mb: 700.4 }, wall: 33 });
  assert.deepEqual(row, { model: 'small', ok: true, error: null, load: 2, transcribe: 30, duration: 120, rtf: 0.25, per_hour: 900, peak_mb: 700.4 });
  assert.equal(T.benchRow('tiny', { code: 0, json: { duration: 60 }, wall: 12 }).rtf, 0.2, 'wall time when the script does not say');
  const bad = T.benchRow('large-v3', { code: 1, json: null, err: 'loading\nerror: out of memory', wall: 3 });
  assert.deepEqual([bad.ok, bad.error], [false, 'out of memory']);
  const report = T.benchReport([row, bad], { file: '/x/sample.wav', threads: 4, compute: 'int8' });
  assert.match(report, /^Bench: sample\.wav, 120 s of audio, 4 thread\(s\), int8, CPU .+ \(\d+ logical cores\)$/m);
  assert.match(report, /^small\s+2 s\s+30 s\s+0\.25\s+15 min\s+700 MB$/m);
  assert.match(report, /^large-v3\s+failed: out of memory$/m);

  clean();
  const f = audio('sample.wav');
  const r = cli(['transcribe', '--bench', f, '--models', 'small,medium', '--threads', '3']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Bench: sample\.wav, 3730 s of audio, 3 thread\(s\), int8/m);
  assert.match(r.stdout, /^small\s+1\.5 s\s+186\.5 s\s+0\.05\s+3 min\s+812 MB$/m);
  assert.match(r.stdout, /^medium\s+1\.5 s\s+373 s\s+0\.1\s+6 min\s+1530 MB$/m);
  assert.deepEqual(fakeCalls().map(c => [c.args[c.args.indexOf('--model') + 1], c.args[c.args.indexOf('--threads') + 1]]), [['small', '3'], ['medium', '3']]);
  assert.ok(fs.existsSync(f), 'the sample stays in place');
  assert.deepEqual(dirsIn(s.transcripts), []);
  assert.match(cli(['transcribe', '--bench']).stdout, /^Usage/);
});

test('the workspace upload: streamed into the inbox under a safe name, size limit, header, path safety, queue status', async () => {
  clean();
  let kicks = 0;
  const srv = await startServer({ port: 0, log: quiet, kick: () => { kicks++; } });
  after(() => srv.close());
  const req = (method, p, { headers = {}, body, chunked = false } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: { Host: `127.0.0.1:${srv.port}`, ...headers } }, res => {
      const c = []; res.on('data', x => c.push(x)); res.on('end', () => { const buf = Buffer.concat(c); let json = null; try { json = JSON.parse(buf); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, buf, headers: res.headers }); });
    });
    r.on('error', reject);
    if (body !== undefined) { if (chunked) { for (let i = 0; i < body.length; i += 65536) r.write(body.subarray(i, i + 65536)); } else r.write(body); }
    r.end();
  });
  const up = (name, body, extra = {}) => req('POST', '/api/transcribe/upload', { headers: { 'X-CometScout': '1', 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...extra }, body });
  const small = Buffer.from('synthetic recording bytes');

  assert.equal((await req('POST', '/api/transcribe/upload', { headers: { 'X-File-Name': 'a.mp3' }, body: small })).status, 403, 'no X-CometScout header');
  assert.equal((await up('notes.txt', small)).status, 400);
  assert.equal((await up('../../etc/passwd', small)).status, 400);
  assert.equal((await up('empty.mp3', Buffer.alloc(0))).status, 400);
  // Over the limit: the 413 comes and the server closes the connection without reading the rest. The client never
  // ends its request, so a server that waited for the end of the body would answer nothing (or never close) here.
  const overLimit = (headers, bodyBytes) => new Promise(resolve => {
    let status = null, body = '';
    const r = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/transcribe/upload', agent: false,
      headers: { Host: `127.0.0.1:${srv.port}`, 'X-CometScout': '1', 'X-File-Name': 'big.mp3', ...headers } });
    const timer = setTimeout(() => { r.destroy(); resolve({ status, body, closed: false }); }, 5000);
    r.on('response', res => { status = res.statusCode; res.on('data', c => { body += c; }); });
    r.on('error', () => {});   // the server hangs up on a body it does not want
    r.on('close', () => { clearTimeout(timer); resolve({ status, body, closed: true }); });
    r.flushHeaders();
    if (bodyBytes) r.write(Buffer.alloc(bodyBytes, 1));
  });
  const declared = await overLimit({ 'Content-Length': String(500 * 1048576) }, 0);
  assert.deepEqual([declared.status, declared.closed], [413, true], 'by Content-Length: answered and closed with no body read');
  assert.match(JSON.parse(declared.body).error, /over 1 MB/);
  const streamed = await overLimit({ 'Transfer-Encoding': 'chunked' }, 1048576 + 1);
  assert.deepEqual([streamed.status, streamed.closed], [413, true], 'no length: counted as it streams, answered and closed at the limit');
  assert.deepEqual(dirsIn(s.inbox), [], 'nothing kept');
  assert.deepEqual(dirsIn(s.staging).filter(n => n.startsWith('.part-')), [], 'no partial file left');
  assert.equal(kicks, 0);

  const ok = await up('../../Final round.m4a', small);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.name, ok.json.size], ['Final round.m4a', small.length]);
  assert.deepEqual(fs.readFileSync(path.join(s.inbox, 'Final round.m4a')), small);
  assert.equal(kicks, 1);
  assert.equal((await up('Final round.m4a', small)).json.name, 'Final round-2.m4a', 'never overwrites');
  const st = (await req('GET', '/api/transcribe')).json;
  assert.deepEqual([st.enabled, st.installed, st.max_upload_mb], [true, true, 1]);
  assert.deepEqual(st.waiting.map(w => w.name).sort(), ['Final round-2.m4a', 'Final round.m4a']);

  // transcripts are served from data/transcripts only
  fs.utimesSync(path.join(s.inbox, 'Final round.m4a'), new Date(0), new Date(0));
  await T.transcribeFile(path.join(s.inbox, 'Final round.m4a'), { s, fromInbox: true, log: quiet });
  const done = (await req('GET', '/api/transcribe')).json.done[0];
  assert.deepEqual(done.files.map(f => f.name), ['transcript.md', 'transcript.srt', 'segments.json']);
  const md = await req('GET', done.files[0].url);
  assert.equal(md.status, 200); assert.match(md.headers['content-type'], /^text\/markdown/); assert.match(String(md.buf), /^# Transcript: Final round\.m4a/);
  for (const bad of ['/files/transcripts/..%2F..%2Fsettings.json', '/files/transcripts/x/../../settings.json', `/files/transcripts/${done.dir}/..%5C..%5Csettings.json`, `/files/transcripts/${done.dir}`, '/files/transcripts/a/b/c.md'])
    assert.equal((await req('GET', bad)).status, 404, bad);

  // two uploads of one name at the same moment: both kept, under different names, none overwritten
  const both = await Promise.all([up('Same call.m4a', Buffer.from('synthetic first')), up('Same call.m4a', Buffer.from('synthetic second'))]);
  assert.deepEqual(both.map(x => x.json.name).sort(), ['Same call-2.m4a', 'Same call.m4a']);
  assert.deepEqual(['Same call.m4a', 'Same call-2.m4a'].map(n => fs.readFileSync(path.join(s.inbox, n), 'utf8')).sort(), ['synthetic first', 'synthetic second']);
  // claimInto never renames over a file that is there, whatever was checked before
  const staged = T.stagingFile(s); fs.writeFileSync(staged, 'synthetic new');
  fs.writeFileSync(path.join(s.inbox, 'Taken.mp3'), 'synthetic theirs');
  assert.equal(path.basename(T.claimInto(s.inbox, 'Taken.mp3', staged)), 'Taken-2.mp3');
  assert.equal(fs.readFileSync(path.join(s.inbox, 'Taken.mp3'), 'utf8'), 'synthetic theirs');
  assert.equal(fs.readFileSync(path.join(s.inbox, 'Taken-2.mp3'), 'utf8'), 'synthetic new');
  assert.ok(!fs.existsSync(staged));

  // the module turned off: uploads are refused
  const off = http.createServer((q, s2) => uploadAudio(q, s2, { settings: () => ({ ...s, enabled: false }), kick: () => { kicks++; } }));
  await new Promise(r => off.listen(0, '127.0.0.1', r));
  try {
    const r = await new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: off.address().port, method: 'POST', path: '/', headers: { 'X-File-Name': 'a.mp3' } }, res => { res.resume(); resolve(res.statusCode); }); q.on('error', reject); q.end(small); });
    assert.equal(r, 409);
  } finally { off.close(); }
});

test('the bot: a voice message and an audio document go to the inbox; over 20 MB the bot explains the other ways', async () => {
  clean();
  const calls = [];
  let kicks = 0;
  const transport = {
    call: async (method, params) => { calls.push({ method, params }); if (method === 'getFile') { if (params.file_id === 'huge') throw new Error('Telegram getFile 400: Bad Request: file is too big'); return { file_path: `voice/${params.file_id}.oga` }; } return true; },
    download: async (fp, dest) => { calls.push({ method: 'download', fp }); fs.writeFileSync(dest, `synthetic ${fp}`); },
  };
  const make = (opts = {}) => createBot({ transport, chatId: '77', transcribe: () => s, kick: () => { kicks++; }, ...opts });
  const msg = m => ({ message: { message_id: 1, chat: { id: 77 }, date: 1790000000, ...m } });
  const bot = make();
  await bot.handle(msg({ voice: { file_id: 'v1', file_size: 4096, mime_type: 'audio/ogg', duration: 7 } }));
  assert.deepEqual(dirsIn(s.inbox), ['voice-202609211413.ogg']);
  assert.equal(fs.readFileSync(path.join(s.inbox, 'voice-202609211413.ogg'), 'utf8'), 'synthetic voice/v1.oga');
  assert.match(calls.at(-1).params.text, /^Got voice-202609211413\.ogg: it is in the transcription queue/);
  assert.equal(kicks, 1);

  await bot.handle(msg({ document: { file_id: 'd1', file_size: 1000, file_name: 'Recruiter call.m4a', mime_type: 'application/octet-stream' } }));
  assert.ok(dirsIn(s.inbox).includes('Recruiter call.m4a'));

  calls.length = 0;
  await bot.handle(msg({ audio: { file_id: 'a1', file_size: 25 * 1048576, file_name: 'Interview.mp3' } }));
  assert.deepEqual(calls.map(c => c.method), ['sendMessage'], 'nothing downloaded');
  const text = calls[0].params.text;
  assert.match(text, /^This file is 25\.0 MB, and Telegram lets bots download files only up to 20 MB\./);
  assert.match(text, /the Transcribe button in the workspace \(up to 1 MB\)/);
  assert.ok(text.includes(s.inbox), 'names the inbox');
  assert.match(text, /scp, rsync or Syncthing/);

  calls.length = 0;   // Telegram did not give a size, then refused at getFile
  await bot.handle(msg({ audio: { file_id: 'huge', file_name: 'Long.mp3' } }));
  assert.match(calls.at(-1).params.text, /^This file is > 20 MB/);

  calls.length = 0;
  await bot.handle(msg({ document: { file_id: 'p1', file_size: 1000, file_name: 'cv.pdf', mime_type: 'application/pdf' } }));
  assert.match(calls.at(-1).params.text, /^Unknown command/, 'a document that is not audio is no recording');

  calls.length = 0;
  await make({ transcribe: () => ({ ...s, enabled: false }) }).handle(msg({ voice: { file_id: 'v2', file_size: 10 } }));
  assert.match(calls.at(-1).params.text, /^Transcription is off/);
  assert.ok(calls.at(-1).params.text.includes(T.INSTALL_COMMAND), 'names the installer for this platform');
  assert.ok(!calls.some(c => c.method === 'getFile'));
  await make({ transcribe: () => ({ ...s, enabled: false }), install: T.installCommand('win32') }).handle(msg({ voice: { file_id: 'v3', file_size: 10 } }));
  assert.match(calls.at(-1).params.text, /^Transcription is off\. To turn it on: powershell -ExecutionPolicy Bypass -File deploy\\modules\\transcribe\.ps1, then set modules\.transcribe\.enabled/);
  assert.equal(T.installCommand('linux'), 'bash deploy/modules/transcribe.sh');

  calls.length = 0;
  await make({ t: translator('ru') }).handle(msg({ audio: { file_id: 'a2', file_size: 30 * 1048576 } }));
  assert.match(calls.at(-1).params.text, /^Этот файл весит 30\.0 МБ/);
  assert.ok(!/Telegram lets|workspace/.test(calls.at(-1).params.text));

  assert.equal(audioOf({ text: '/help' }), null);
  assert.deepEqual(audioOf({ date: 1790000000, video_note: { file_id: 'n', file_size: 5 } }), { file_id: 'n', size: 5, name: 'video-note-202609211413.mp4' });
  assert.equal(audioOf({ audio: { file_id: 'x', file_name: '../x', mime_type: 'audio/mpeg' } }).name, 'x.mp3');
  assert.equal(audioOf({ date: 1790000000, audio: { file_id: 'y', mime_type: 'audio/mpeg' } }).name, 'audio-202609211413.mp3');
});

test('doctor: off, not installed, then the venv, faster-whisper, the model, disk, ffmpeg, inbox and the path unit', () => {
  const settings = { modules: { transcribe: { enabled: true, path: path.join(tmp, 'doc-mod'), model: 'medium' } } };
  const base = { root: HOME, data: DATA, has: () => false, statfs: () => ({ bavail: 100, bsize: 1e9 }), systemd: false };
  assert.deepEqual(T.transcribeDoctor({ ...base, settings: {} }).map(l => l.level), ['ok']);
  assert.match(T.transcribeDoctor({ ...base, settings: {} })[0].text, /^transcription: off \(optional: .*transcribe\.(sh|ps1), README: Transcription\)$/);
  const missing = T.transcribeDoctor({ ...base, settings });
  assert.deepEqual([missing[0].level, missing[0].text], ['todo', `transcription: not installed at ${path.join(tmp, 'doc-mod')}`]);
  const ds = T.transcribeSettings(settings, HOME, DATA);
  fs.mkdirSync(path.dirname(T.venvPython(ds)), { recursive: true }); fs.writeFileSync(T.venvPython(ds), '');
  fs.mkdirSync(path.join(ds.path, 'venv', 'lib', 'python3.12', 'site-packages', 'faster_whisper-1.2.1.dist-info'), { recursive: true });
  let lines = T.transcribeDoctor({ ...base, settings });
  const text = lines.map(l => `${l.level} ${l.text}`).join('\n');
  assert.match(text, /^ok transcription: Python environment in /m);
  assert.match(text, /^ok faster-whisper 1\.2\.1$/m);
  assert.match(text, /^ok model medium: not downloaded yet \(about 1\.5 GB; the first job downloads it into /m);
  assert.match(text, /^ok free disk for the module: 100\.0 GB, the model needs about 1\.5 GB$/m);
  assert.match(text, /^ok ffmpeg not on the PATH \(optional: faster-whisper decodes audio itself\)$/m);
  assert.match(text, /^ok transcription inbox: .*audio kept 30 day\(s\)/m);
  // a download cut half-way (blobs, no snapshot) is not a model; a snapshot with model.bin is
  const repo = path.join(ds.path, 'models', 'models--Systran--faster-whisper-medium');
  fs.mkdirSync(path.join(repo, 'blobs'), { recursive: true }); fs.writeFileSync(path.join(repo, 'blobs', 'part'), Buffer.alloc(500));
  assert.equal(T.cachedModel(ds), null);
  const snap = path.join(repo, 'snapshots', 'abc123');
  fs.mkdirSync(snap, { recursive: true }); fs.writeFileSync(path.join(snap, 'model.bin'), Buffer.alloc(2000)); fs.writeFileSync(path.join(snap, 'config.json'), '{}');
  assert.deepEqual(T.cachedModel(ds), { dir: snap, bytes: 2002 });
  fs.mkdirSync(path.join(ds.path, 'models', 'models--Systran--faster-whisper-medium.en', 'snapshots', 'x'), { recursive: true });
  lines = T.transcribeDoctor({ ...base, settings, statfs: () => ({ bavail: 1, bsize: 5e8 }), systemd: true, unitDir: path.join(tmp, 'no-units') });
  const t2 = lines.map(l => `${l.level} ${l.text}`).join('\n');
  assert.match(t2, /^ok model medium: downloaded \(0\.0 GB\)$/m);
  assert.match(t2, /^todo free disk for the module: 0\.5 GB$/m, 'the model is there, but 1 GB of room is wanted');
  assert.match(t2, /^todo cometscout-transcribe\.path: not installed$/m);
  assert.equal(lines.find(l => /path: not installed/.test(l.text)).fix, 'node cli.mjs timer');
  fs.rmSync(path.join(ds.path, 'venv', 'lib'), { recursive: true });
  assert.match(T.transcribeDoctor({ ...base, settings }).map(l => `${l.level} ${l.text}`).join('\n'), /^todo faster-whisper: not installed/m);
  // through cli.mjs doctor: this test's module folder has no venv
  const r = cli(['doctor']);
  assert.match(r.stdout, /^TODO transcription: not installed at .+ {2}-> {2}(bash deploy\/modules\/transcribe\.sh|powershell .*transcribe\.ps1)$/m);
});

test('units: the path unit watches the inbox and starts the queue service; cli.mjs timer enables it, and removes it when the module is off', () => {
  const u = unitFiles({ root: '/srv/cs', node: '/usr/bin/node', time: '18:00', envPath: '/usr/bin', transcribe: { inbox: '/srv/cs/data/audio/inbox' } });
  assert.match(u['cometscout-transcribe.path'], /^PathChanged=\/srv\/cs\/data\/audio\/inbox$/m);
  assert.match(u['cometscout-transcribe.path'], /^MakeDirectory=yes$/m);
  assert.match(u['cometscout-transcribe.path'], /^Unit=cometscout-transcribe\.service$/m);
  assert.match(u['cometscout-transcribe.path'], /^WantedBy=default\.target$/m);
  assert.match(u['cometscout-transcribe.service'], /^ExecStart=\/usr\/bin\/node \/srv\/cs\/cli\.mjs transcribe --queue$/m);
  assert.match(u['cometscout-transcribe.service'], /^OnFailure=cometscout-failure@%n\.service$/m);
  assert.match(u['cometscout-transcribe.service'], /^Type=oneshot$/m);
  assert.ok(!('cometscout-transcribe.path' in unitFiles({ root: '/srv/cs', node: '/usr/bin/node', time: '18:00', envPath: '/usr/bin' })));
  const win = unitFiles({ root: '/srv/cs', node: '/usr/bin/node', time: '18:00', envPath: '/usr/bin', transcribe: { inbox: 'C:\\cs\\data\\audio\\inbox' } });
  assert.match(win['cometscout-transcribe.path'], /^PathChanged=C:\/cs\/data\/audio\/inbox$/m, '"/" paths everywhere');

  const dir = path.join(tmp, 'units'), runs = [];
  const run = (cmd, args) => { runs.push([cmd, ...args].join(' ')); return { status: 0 }; };
  const r = installTimer({ time: '19:30', tz: 'UTC', bot: false, transcribe: s, dir, run, stdio: 'ignore' });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual(runs, ['systemctl --user daemon-reload', 'systemctl --user enable --now cometscout.timer', 'systemctl --user enable --now cometscout-transcribe.path']);
  assert.ok(fs.existsSync(path.join(dir, 'cometscout-transcribe.path')) && fs.existsSync(path.join(dir, 'cometscout-transcribe.service')));
  assert.ok(r.lines.some(l => /^Transcription: a file in .* starts cometscout-transcribe\.service/.test(l)));
  runs.length = 0;
  const off = installTimer({ time: '19:30', tz: 'UTC', bot: false, transcribe: { ...s, enabled: false }, dir, run, stdio: 'ignore' });
  assert.deepEqual(runs, ['systemctl --user disable --now cometscout-transcribe.path', 'systemctl --user daemon-reload', 'systemctl --user enable --now cometscout.timer']);
  assert.ok(!fs.existsSync(path.join(dir, 'cometscout-transcribe.path')) && !fs.existsSync(path.join(dir, 'cometscout-transcribe.service')));
  assert.ok(off.lines.some(l => /Transcription is off/.test(l)));
});

test('kickQueue: through systemd when the path unit is installed, otherwise a detached cli.mjs transcribe --queue', () => {
  const dir = path.join(tmp, 'kick-units'); fs.mkdirSync(dir, { recursive: true });
  const runs = [], starts = [];
  const start = (cmd, args, opts) => { starts.push({ cmd, args, detached: opts.detached }); return { unref() {} }; };
  assert.equal(T.kickQueue({ systemd: true, dir, run: () => ({ status: 0 }), start }), 'spawned', 'no unit file yet');
  fs.writeFileSync(path.join(dir, 'cometscout-transcribe.path'), '');
  assert.equal(T.kickQueue({ systemd: true, dir, run: (c, a) => { runs.push([c, ...a].join(' ')); return { status: 0 }; }, start }), 'systemd');
  assert.deepEqual(runs, ['systemctl --user start --no-block cometscout-transcribe.service']);
  assert.equal(T.kickQueue({ systemd: false, dir, run: () => { throw new Error('no systemctl here'); }, start }), 'spawned');
  assert.deepEqual(starts.map(x => [x.cmd, x.args.slice(1), x.detached]), [[process.execPath, ['transcribe', '--queue'], true], [process.execPath, ['transcribe', '--queue'], true]]);
  assert.ok(starts[0].args[0].endsWith('cli.mjs'));
});

test('the workspace side: upload checks, lengths, and the API client sends the raw file with its name', async () => {
  assert.equal(W.uploadProblem({ name: 'a.MP3', size: 10 }, { max_upload_mb: 1 }), null);
  assert.deepEqual(W.uploadProblem({ name: 'cv.pdf', size: 10 }, { max_upload_mb: 1 }), { key: 'ws.tr.not_audio', vars: { name: 'cv.pdf' } });
  assert.deepEqual(W.uploadProblem({ name: 'a.wav', size: 3 * 1048576 }, { max_upload_mb: 2 }), { key: 'ws.tr.too_big', vars: { name: 'a.wav', size: '3.0', mb: 2 } });
  assert.deepEqual([W.length(3730), W.length(65), W.length(null)], ['1:02:10', '1:05', '']);
  assert.deepEqual(W.AUDIO_EXTS.slice().sort(), [...T.AUDIO_EXT].sort(), 'the browser and the server take the same files');
  assert.equal(W.busyQueue({ waiting: [], running: null }), false); assert.equal(W.busyQueue({ waiting: [{}] }), true);
  const seen = [];
  const api = createApi({ fetch: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true, name: 'x.mp3' }) }; } });
  const file = { name: 'Звонок 1.m4a', size: 3 };
  await api.uploadAudio(file); await api.transcribe();
  assert.equal(seen[0].url, '/api/transcribe/upload');
  assert.equal(seen[0].init.body, file, 'the file itself, not JSON');
  assert.deepEqual([seen[0].init.headers['X-CometScout'], seen[0].init.headers['X-File-Name'], seen[0].init.headers['Content-Type']], ['1', encodeURIComponent('Звонок 1.m4a'), 'application/octet-stream']);
  assert.equal(seen[1].url, '/api/transcribe');
});

test('queue status: waiting, running (a live pid), failed and done', () => {
  clean();
  audio('a.mp3'); audio('b.mp3');
  fs.writeFileSync(path.join(DATA, 'state', 'transcribe.json'), JSON.stringify({ current: { file: 'a.mp3', started: '2026-10-07T10:00:00.000Z', pid: process.pid } }));
  const st = T.queueStatus({ s });
  assert.deepEqual(st.running, { name: 'a.mp3', started: '2026-10-07T10:00:00.000Z' });
  assert.deepEqual(st.waiting.map(w => w.name), ['b.mp3']);
  fs.writeFileSync(path.join(DATA, 'state', 'transcribe.json'), '{}');
  assert.equal(T.queueStatus({ s }).running, null);
});

test('transcribe.py: Python syntax (only where python is installed)', t => {
  const py = ['python3', 'python'].find(p => { const r = spawnSync(p, ['--version'], { encoding: 'utf8' }); return r.status === 0 && /Python 3/.test(r.stdout + r.stderr); });
  if (!py) return t.skip('no python3 here');
  const r = spawnSync(py, ['-c', 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', T.SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the installer: checks Python, makes the venv, installs the pinned faster-whisper, downloads no model', () => {
  const settings = { modules: { transcribe: { enabled: false, path: path.join(tmp, 'inst-mod') } } };
  const is = T.transcribeSettings(settings, HOME, DATA);
  const runs = [];
  const fakeRun = ({ version = '3.12', pipStatus = 0, venvOk = true } = {}) => (cmd, args) => {
    runs.push([path.basename(cmd), ...args.map(a => (a === T.venvPython(is) || a === path.join(is.path, 'venv') ? '<venv>' : a))].join(' '));
    if (args.some(a => String(a).startsWith('import sys'))) return version ? { status: 0, stdout: `${version}\n` } : { status: 1, error: new Error('ENOENT') };
    if (args.includes('venv') && venvOk) { fs.mkdirSync(path.dirname(T.venvPython(is)), { recursive: true }); fs.writeFileSync(T.venvPython(is), ''); return { status: 0 }; }
    if (args.includes('pip')) return { status: pipStatus };
    return { status: 1 };
  };
  const logs = [];
  const log = l => logs.push(l);
  const env = { PYTHON: 'python3.12' };
  assert.equal(T.installTranscribe({ settings, root: HOME, data: DATA, run: fakeRun({ version: null }), log, env }), 1);
  assert.match(logs.at(-1), /^Python 3 is needed for the transcription module/);
  for (const v of ['3.8', '3.9']) {
    assert.equal(T.installTranscribe({ settings, root: HOME, data: DATA, run: fakeRun({ version: v }), log, env }), 1);
    assert.match(logs.at(-1), /needs Python 3.10 or newer \(its pinned libraries have no wheels for older ones\)/);
  }
  assert.equal(T.installTranscribe({ settings, root: HOME, data: DATA, run: fakeRun({ venvOk: false }), log, env }), 1);
  assert.ok(!fs.existsSync(path.join(is.path, 'venv')), 'a half-made venv is removed');
  runs.length = 0;
  assert.equal(T.installTranscribe({ settings, root: HOME, data: DATA, run: fakeRun({ pipStatus: 1 }), log, env }), 1);
  assert.match(logs.at(-1), /pip could not install faster-whisper 1\.2\.1 with the pinned libraries \(.*constraints\.txt\) for Python 3\.12\. If no wheel exists for this Python yet, set PYTHON/);
  runs.length = 0; logs.length = 0;
  assert.equal(T.installTranscribe({ settings, root: HOME, data: DATA, run: fakeRun(), log, env }), 0);
  assert.deepEqual(runs.slice(1), [`${path.basename(T.venvPython(is))} -m pip install --disable-pip-version-check --no-input -c ${T.CONSTRAINTS} faster-whisper==${T.FASTER_WHISPER_VERSION}`], 'the venv exists now, so only pip runs, with the constraints');
  const inst = JSON.parse(fs.readFileSync(path.join(is.path, 'installed.json'), 'utf8'));
  assert.deepEqual([inst.faster_whisper, inst.pinned], ['1.2.1', T.pinnedVersions()]);
  assert.ok(logs.some(l => /with pinned libraries \(ctranslate2 \d/.test(l)));
  assert.ok(logs.some(l => /No model is downloaded yet: the first job downloads large-v3-turbo/.test(l)));
  assert.ok(logs.some(l => /node cli\.mjs transcribe --bench/.test(l)));
  assert.ok(logs.some(l => /set modules\.transcribe\.enabled to true/.test(l)));
  assert.ok(!fs.existsSync(path.join(is.path, 'models')), 'no model download at install time');
  assert.deepEqual(T.pythonCommand({}, 'linux'), ['python3', []]); assert.deepEqual(T.pythonCommand({}, 'win32'), ['py', ['-3']]); assert.deepEqual(T.pythonCommand({ PYTHON: '/opt/py' }, 'linux'), ['/opt/py', []]);
});

test('the installer pins the compiled dependencies in one constraints file that both installers use', () => {
  const pins = T.pinnedVersions();
  for (const p of ['ctranslate2', 'av', 'tokenizers', 'onnxruntime']) assert.match(pins[p] || '', /^\d+(\.\d+)+$/, `${p} pinned`);
  assert.ok(fs.readFileSync(T.CONSTRAINTS, 'utf8').split('\n').every(l => !l.trim() || l.startsWith('#') || /^[a-z0-9._-]+==[\d.]+(; python_version [<>]=? "3\.\d+")?$/i.test(l)), 'name==version lines, with an optional python_version marker');
  // Python 3.10 (Ubuntu 22.04) gets its own pins where the newest ones need 3.11
  assert.match(fs.readFileSync(T.CONSTRAINTS, 'utf8'), /onnxruntime==[\d.]+; python_version < "3\.11"/);
  assert.deepEqual(T.MIN_PYTHON, [3, 10]);
  // both installers hand over to lib/transcribe.mjs install, which passes -c CONSTRAINTS to pip
  for (const f of ['transcribe.sh', 'transcribe.ps1']) {
    const text = fs.readFileSync(path.join(ROOT, 'deploy', 'modules', f), 'utf8');
    assert.match(text, /lib[\\/]transcribe\.mjs["')]* install/, f);
    assert.match(text, /constraints\.txt/, f);
  }
});

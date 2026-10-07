// The transcription module (optional): speech to text on the server's own CPU with faster-whisper, in a Python virtual
// environment of its own next to the home. Audio never leaves the server; the model is downloaded once from Hugging Face.
//   bash deploy/modules/transcribe.sh | deploy/modules/transcribe.ps1   # install (both run: node lib/transcribe.mjs install)
//   node cli.mjs transcribe <file>                                       # one file now
//   node cli.mjs transcribe --queue                                      # every file in the inbox, oldest first, one at a time
//   node cli.mjs transcribe --bench <file> [--models small,medium] [--threads N]   # speed and memory per model, nothing written
// settings.modules.transcribe = { enabled: false, path: null, model: "medium", compute_type: "int8", threads: 2, nice: 10,
//   language: null, inbox: "data/audio/inbox", keep_audio_days: 30, max_upload_mb: 500 }
//   path: null means <home>/../cometscout-transcribe (the venv in venv/, models in models/). language: null detects it.
//   inbox: a relative path starting with data/ is inside the data folder (COMETSCOUT_DATA), others are relative to the home.
// One job at a time across the machine: transcribe.lock in the module's folder, separate from the run lock. The model runs as
// deploy/modules/transcribe/transcribe.py under nice and ionice with `threads` CPU threads. COMETSCOUT_TRANSCRIBE_CMD
// replaces it (an executable, or a .mjs/.js script run with node) and takes the same arguments: tests use a fake one.
// Output: data/transcripts/<date>--<name>/ with transcript.md, transcript.srt and segments.json. An inbox file then moves
// to data/audio/done/ (deleted after keep_audio_days; 0 deletes it at once). A file elsewhere is left where it is.
// A failure leaves the audio in the inbox with a <name>.failed note and sends one alert; delete the note to try again.
// With the interview coach enabled (lib/coach.mjs), transcript.md is copied to the coach's materials/transcripts/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, SETTINGS, DATA, STATE, CODE_DIR, num, readJson, isMain, log as stamp } from './config.mjs';
import { envVar } from './legacy-names.mjs';
import { binCommand } from './llm.mjs';
import { lockHolder } from './lock.mjs';
import { coachSettings, onPath, COACH_TRANSCRIPTS } from './coach.mjs';
import { translator } from './i18n.mjs';
import { sendText, telegramOn } from './telegram.mjs';

export const FASTER_WHISPER_VERSION = '1.2.1';
// Download sizes in GB, for doctor and the installer (faster-whisper's CTranslate2 conversions on Hugging Face).
export const MODEL_GB = { tiny: 0.08, base: 0.15, small: 0.5, medium: 1.5, 'large-v1': 3, 'large-v2': 3, 'large-v3': 3, 'large-v3-turbo': 1.6, turbo: 1.6 };
// What the queue and the uploads take: audio, and video files whose sound track faster-whisper reads.
export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.opus', '.flac', '.aac', '.wma', '.amr', '.3gp', '.webm', '.mp4', '.mkv', '.mov', '.m4v']);
export const BOT_MAX_MB = 20;   // the Bot API lets bots download files up to 20 MB
const WIN = process.platform === 'win32';
export const INSTALL_COMMAND = WIN ? 'powershell -ExecutionPolicy Bypass -File deploy\\modules\\transcribe.ps1' : 'bash deploy/modules/transcribe.sh';
export const SCRIPT = path.join(CODE_DIR, 'deploy', 'modules', 'transcribe', 'transcribe.py');
// in the module's folder, so every CometScout home that shares the module (and its CPU) shares the one lock
export const LOCK = (s = transcribeSettings()) => path.join(s.path, 'transcribe.lock');
const STATUS = () => STATE('transcribe.json');
export const UNIT_PATH = 'cometscout-transcribe.path', UNIT_SERVICE = 'cometscout-transcribe.service';
const JOB_TIMEOUT_MS = 12 * 3600 * 1000;

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const home = p => (/^~([/\\]|$)/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** settings.modules.transcribe with defaults, every path resolved. */
export function transcribeSettings(settings = SETTINGS, root = ROOT, data = DATA) {
  const c = settings?.modules?.transcribe || {};
  const dir = str(c.path) ? path.resolve(root, home(str(c.path))) : path.resolve(root, '..', 'cometscout-transcribe');
  const inboxSetting = home(str(c.inbox) || 'data/audio/inbox');
  const inbox = path.isAbsolute(inboxSetting) ? inboxSetting : /^data([/\\]|$)/.test(inboxSetting) ? path.join(data, inboxSetting.slice(5)) : path.resolve(root, inboxSetting);
  const language = str(c.language)?.toLowerCase();
  return {
    enabled: c.enabled === true,
    path: dir,
    model: str(c.model) || 'medium',
    compute_type: str(c.compute_type) || 'int8',
    threads: Math.floor(num(c.threads, 2, 1, 256)),
    nice: Math.floor(num(c.nice, 10, 0, 19)),
    language: language && /^[a-z]{2,3}$/.test(language) ? language : null,
    inbox,
    keep_audio_days: num(c.keep_audio_days, 30, 0, 36500),
    max_upload_mb: num(c.max_upload_mb, 500, 1, 100000),
    done: path.join(data, 'audio', 'done'),
    staging: path.join(data, 'audio', 'uploads'),
    transcripts: path.join(data, 'transcripts'),
  };
}

export const venvDir = s => path.join(s.path, 'venv');
export const venvPython = (s, platform = process.platform) => (platform === 'win32' ? path.join(venvDir(s), 'Scripts', 'python.exe') : path.join(venvDir(s), 'bin', 'python'));
export const modelsDir = s => path.join(s.path, 'models');
const fakeCmd = (env = process.env) => envVar('TRANSCRIBE_CMD', env);
/** True when there is something to run: the venv, or COMETSCOUT_TRANSCRIBE_CMD. */
export const installed = s => !!fakeCmd() || isFile(venvPython(s));

/** The transcriber for one file: [command, args]. COMETSCOUT_TRANSCRIBE_CMD replaces the module's Python. */
export function transcriberCommand(s, { audio, out, model = s.model, threads = s.threads, env = process.env } = {}) {
  const args = ['--out', out, '--model', model, '--compute-type', s.compute_type, '--threads', String(threads), '--models-dir', modelsDir(s),
    ...(s.language ? ['--language', s.language] : []), audio];
  const fake = fakeCmd(env);
  return fake ? binCommand(fake, args) : [venvPython(s), [SCRIPT, ...args]];
}

/**
 * The command under nice and ionice where they exist (Linux): { cmd, args, renice }. renice is the priority to set with
 * os.setPriority after the start when there is no nice command (Windows: below normal).
 */
export function lowPriority([cmd, args], { nice = 10, platform = process.platform, has = onPath } = {}) {
  if (platform === 'win32') return { cmd, args, renice: nice > 0 ? nice : 0 };
  let c = cmd, a = args;
  if (has('ionice')) { a = ['-c', '2', '-n', '7', c, ...a]; c = 'ionice'; }   // best effort, lowest: disk stays free for the rest
  if (nice > 0 && has('nice')) return { cmd: 'nice', args: ['-n', String(nice), c, ...a], renice: 0 };
  return { cmd: c, args: a, renice: nice };
}

/** The environment for the model: thread caps for the math libraries, no Hugging Face telemetry. */
export function jobEnv(threads, env = process.env) {
  const n = String(threads);
  return { ...env, OMP_NUM_THREADS: n, MKL_NUM_THREADS: n, OPENBLAS_NUM_THREADS: n, CT2_INTER_THREADS: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONIOENCODING: 'utf-8' };
}

// ---------- the lock ----------
/** Take the transcription lock: { release } when taken, { busy: pid } when another live process holds it. */
export function takeTranscribeLock(file = LOCK()) {
  const pid = lockHolder(file);
  if (pid) return { busy: pid };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  const release = () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file); } catch { /* already gone */ } };
  process.once('exit', release);
  return { release };
}

// ---------- rendering ----------
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** 3725.4 -> "01:02:05" */
export const clock = sec => { const s = Math.max(0, Math.floor(Number(sec) || 0)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
/** 3725.4 -> "01:02:05,400" (SubRip) */
export const srtTime = sec => { const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000)); return `${clock(ms / 1000)},${pad(ms % 1000, 3)}`; };
/** A length in words: "1 h 2 min", "42 min 10 s", "9 s". */
export function spoken(sec, t = translator()) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s >= 3600) return t('tr.h_min', { h: Math.floor(s / 3600), m: Math.floor(s / 60) % 60 });
  if (s >= 60) return t('tr.min_s', { m: Math.floor(s / 60), s: s % 60 });
  return t('tr.s', { s });
}

/**
 * Segments into paragraphs: a new one after a pause of `gap` seconds, or once one holds `maxChars` characters and ends a
 * sentence (at twice that length it ends anyway).
 */
export function paragraphs(segments, { gap = 2, maxChars = 600 } = {}) {
  const out = [];
  let cur = null;
  const full = p => p.text.length >= maxChars * 2 || (p.text.length >= maxChars && /[.!?…]["'»)\]]?$/.test(p.text));
  for (const s of segments || []) {
    const text = String(s?.text || '').trim(); if (!text) continue;
    if (!cur || Number(s.start) - cur.end >= gap || full(cur)) { cur = { start: Number(s.start) || 0, end: Number(s.end) || 0, text }; out.push(cur); }
    else { cur.text += ` ${text}`; cur.end = Number(s.end) || cur.end; }
  }
  return out;
}

/** transcript.md: what was transcribed, how, and the text with a timestamp on every paragraph. */
export function renderMarkdown(r, t = translator()) {
  const lang = r.language ? (r.language_set ? t('tr.language_set', { lang: r.language }) : t('tr.language_detected', { lang: r.language, p: Math.round((r.language_probability || 0) * 100) })) : '?';
  const paras = paragraphs(r.segments);
  return [
    `# ${t('tr.title', { name: r.source })}`,
    '',
    `- ${t('tr.language')}: ${lang}`,
    `- ${t('tr.duration')}: ${clock(r.duration)} (${spoken(r.duration, t)})`,
    `- ${t('tr.model')}: ${t('tr.model_line', { model: r.model, compute: r.compute_type, threads: r.threads })}`,
    `- ${t('tr.took')}: ${t('tr.took_line', { took: spoken(r.seconds, t), rtf: rtf(r.transcribe_seconds ?? r.seconds, r.duration) ?? '?', at: r.at })}`,
    `- ${t('tr.speakers')}`,
    '',
    ...(paras.length ? paras.flatMap(p => [`[${clock(p.start)}] ${p.text}`, '']) : [t('tr.empty'), '']),
  ].join('\n');
}

/** transcript.srt */
export const renderSrt = segments => (segments || []).filter(s => String(s?.text || '').trim())
  .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${String(s.text).trim()}\n`).join('\n');

/** Real-time factor: processing seconds per second of audio, two decimals (null without a length). */
export const rtf = (seconds, duration) => (Number(duration) > 0 && Number.isFinite(Number(seconds)) ? Math.round((Number(seconds) / Number(duration)) * 100) / 100 : null);

// ---------- names and files ----------
/** A plain name for folders: letters and digits of any script, dashes; at most 60 characters. */
export const slug = name => String(name || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'audio';
/** dir/name, or dir/name-2... when it exists. */
export function unique(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) { const n = i === 1 ? name : `${base}-${i}${ext}`; if (!fs.existsSync(path.join(dir, n))) return path.join(dir, n); }
}
export const isAudio = name => AUDIO_EXT.has(path.extname(String(name || '')).toLowerCase());
/**
 * A safe file name for the inbox from a name a client or Telegram sent, or null: the last path part only, no control
 * or reserved characters, no leading dot, an audio or video extension, at most 120 characters.
 */
export function safeAudioName(raw) {
  let n = String(raw ?? '');
  n = n.split(/[/\\]/).pop().normalize('NFC').replace(/[\p{Cc}<>:"|?*]/gu, '').replace(/^[\s.]+/, '').replace(/\s+$/, '');
  const ext = path.extname(n).toLowerCase();
  if (!n || !AUDIO_EXT.has(ext) || n.length === ext.length) return null;
  const base = n.slice(0, n.length - ext.length).slice(0, 120 - ext.length).replace(/[\s.]+$/, '');
  return base ? base + ext : null;
}
/** Move a file, across file systems too (an inbox on another disk). */
export function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(from, to); fs.rmSync(from); }
}
const failedNote = file => `${file}.failed`;

/** The inbox: { ready, settling, failed, ignored }. Ready files are audio not written to for settleMs, oldest first. */
export function scanInbox(s, { now = Date.now(), settleMs = 30000 } = {}) {
  const out = { ready: [], settling: [], failed: [], ignored: [] };
  let names; try { names = fs.readdirSync(s.inbox); } catch { return out; }
  for (const name of names) {
    // dot files are uploads in progress (rsync, Syncthing, the workspace's staging) or hidden; notes are not audio
    if (name.startsWith('.') || name.endsWith('.failed')) continue;
    const file = path.join(s.inbox, name);
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    if (!isAudio(name)) { out.ignored.push(name); continue; }
    const item = { name, file, size: st.size, mtime: st.mtimeMs };
    if (fs.existsSync(failedNote(file))) out.failed.push({ ...item, note: fs.readFileSync(failedNote(file), 'utf8') });
    else (now - st.mtimeMs >= settleMs ? out.ready : out.settling).push(item);
  }
  for (const k of ['ready', 'settling', 'failed']) out[k].sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  return out;
}

/** Delete audio in done/ older than keep_audio_days (by the time it was moved there). Returns the names deleted. */
export function pruneAudio(s, { now = Date.now() } = {}) {
  const gone = [];
  let names; try { names = fs.readdirSync(s.done); } catch { return gone; }
  for (const name of names) {
    const file = path.join(s.done, name);
    try { const st = fs.statSync(file); if (st.isFile() && now - st.mtimeMs > s.keep_audio_days * 86400000) { fs.rmSync(file); gone.push(name); } } catch { /* gone meanwhile */ }
  }
  return gone;
}

// ---------- running the model ----------
/** Run the transcriber once: resolves to { code, json, err, wall } (json null when it wrote nothing readable). */
export function runTranscriber(s, { audio, model, threads = s.threads, has = onPath, timeoutMs = JOB_TIMEOUT_MS, echo = true } = {}) {
  fs.mkdirSync(s.staging, { recursive: true });
  const out = path.join(s.staging, `.job-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  const { cmd, args, renice } = lowPriority(transcriberCommand(s, { audio, out, model, threads }), { nice: s.nice, has });
  const t0 = Date.now();
  return new Promise(resolve => {
    let err = '', settled = false;
    const done = code => {
      if (settled) return; settled = true; clearTimeout(timer);
      let json = null; try { json = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* none */ }
      for (const f of [out, `${out}.tmp`]) fs.rmSync(f, { force: true });
      resolve({ code, json, err: err.trim(), wall: (Date.now() - t0) / 1000 });
    };
    let p;
    try { p = spawn(cmd, args, { env: jobEnv(threads), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); } catch (e) { err = e.message; return done(null); }
    if (renice && p.pid) try { os.setPriority(p.pid, renice); } catch { /* not allowed here: it runs at normal priority */ }
    const timer = setTimeout(() => { err += `\nstopped after ${timeoutMs / 3600000} h`; p.kill('SIGTERM'); }, timeoutMs);
    p.stderr.on('data', c => { const x = String(c); if (echo) process.stderr.write(x); err = (err + x).slice(-4000); });
    p.on('error', e => { err += `\n${e.code === 'ENOENT' ? `${cmd} not found` : e.message}`; done(null); });
    p.on('close', code => done(code));
  });
}
/** The last line of the transcriber's error output that says something, for the note and the alert. */
const reason = (r, fallback) => {
  const lines = String(r.err || '').split('\n').map(l => l.trim()).filter(Boolean);
  return (lines.reverse().find(l => /^error\b/i.test(l)) || lines[0] || fallback).replace(/^error:\s*/i, '').slice(0, 2000);
};

function writeStatus(current) {
  try { fs.writeFileSync(STATUS(), JSON.stringify(current ? { current } : {})); } catch { /* status only */ }
}

/**
 * Transcribe one file and write the outputs. fromInbox: move the audio to done/ after, or leave a .failed note and send
 * one alert when it fails. Resolves to { ok, dir?, result?, error? }.
 */
export async function transcribeFile(file, { s = transcribeSettings(), settings = SETTINGS, root = ROOT, fromInbox = false, t = translator(), log = stamp,
  alert = defaultAlert, date = new Date(), has = onPath } = {}) {
  const name = path.basename(file);
  writeStatus({ file: name, started: date.toISOString(), pid: process.pid });
  log(`transcribe: ${name} (model ${s.model}, ${s.threads} threads)`);
  let r;
  try { r = await runTranscriber(s, { audio: file, has }); } finally { writeStatus(null); }
  const j = r.json;
  const fail = async reasonText => {
    // the file's full path (also as Python prints it on Windows, with doubled backslashes) becomes its name
    const why = [file, file.replace(/\\/g, '\\\\')].reduce((w, p) => w.split(p).join(name), reasonText).replace(/\.$/, '').slice(0, 300);
    log(`transcribe: ${name} failed: ${why}`);
    if (fromInbox) {
      fs.writeFileSync(failedNote(file), `${date.toISOString()}\n${why}\nThe audio stays here. Delete this note to try again (node cli.mjs transcribe --queue).\n`);
      await alert(t('tr.failed', { name, error: why }));
    }
    return { ok: false, error: why };
  };
  if (r.code !== 0 || !j) return fail(reason(r, r.code === null ? 'the transcriber did not start' : `the transcriber exited with ${r.code}`));
  if (!Array.isArray(j.segments)) return fail('the transcriber wrote no segments');

  const day = date.toISOString().slice(0, 10);
  const base = `${day}--${slug(path.basename(name, path.extname(name)))}`;
  fs.mkdirSync(s.transcripts, { recursive: true });
  const dir = unique(s.transcripts, base);
  const result = {
    source: name, at: `${day} ${date.toISOString().slice(11, 16)} UTC`, language: j.language || s.language || null, language_set: !!s.language,
    language_probability: j.language_probability ?? null, duration: Number(j.duration) || 0, model: j.model || s.model, compute_type: j.compute_type || s.compute_type,
    threads: j.threads || s.threads, seconds: Math.round(r.wall * 10) / 10, load_seconds: j.load_seconds ?? null, transcribe_seconds: j.transcribe_seconds ?? null,
    peak_rss_mb: j.peak_rss_mb ?? null, speakers: 'not separated',
    segments: j.segments.map(x => ({ start: Number(x.start) || 0, end: Number(x.end) || 0, text: String(x.text || '').trim() })),
  };
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'transcript.md'), renderMarkdown(result, t));
  fs.writeFileSync(path.join(dir, 'transcript.srt'), renderSrt(result.segments));
  fs.writeFileSync(path.join(dir, 'segments.json'), `${JSON.stringify(result, null, 1)}\n`);
  log(`transcribe: wrote ${dir} (${clock(result.duration)} of audio in ${spoken(result.seconds, t)})`);
  if (fromInbox) {
    fs.rmSync(failedNote(file), { force: true });
    if (s.keep_audio_days === 0) fs.rmSync(file, { force: true });
    else { const to = unique(s.done, `${path.basename(dir)}${path.extname(name).toLowerCase()}`); moveFile(file, to); const now = new Date(); fs.utimesSync(to, now, now); }
  }
  const copied = copyToCoach(dir, { settings, root, log });
  return { ok: true, dir, result, coach: copied };
}

/** With the coach enabled and installed: transcript.md to <coach>/materials/transcripts/<dir name>.md. Returns the path or null. */
export function copyToCoach(dir, { settings = SETTINGS, root = ROOT, log = stamp } = {}) {
  const c = coachSettings(settings, root);
  if (!c.enabled) return null;
  if (!isDir(c.path)) { log(`transcribe: the coach is not installed at ${c.path}, so the transcript was not copied there`); return null; }
  const to = path.join(c.path, COACH_TRANSCRIPTS, `${path.basename(dir)}.md`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(dir, 'transcript.md'), to);
  log(`transcribe: copied for the coach: ${to} (ready for analyze)`);
  return to;
}

/** One Telegram message; off is not an error (logged). Never throws. */
export async function defaultAlert(text) {
  if (!telegramOn()) { stamp(`transcribe: Telegram delivery is off, not sent: ${text}`); return false; }
  try { await sendText(text); return true; } catch (e) { stamp(`transcribe: Telegram failed: ${e.message}`); return false; }
}

// "Transcript ready" goes out only when Telegram is on, without a log line when it is off
const quietSend = async text => (telegramOn() ? defaultAlert(text) : false);
const wait = ms => new Promise(r => setTimeout(r, ms));
/**
 * The queue: every ready file in the inbox, oldest first, one at a time, until none is left. Files still being written
 * (changed in the last settleMs) are waited for, up to maxWaitMs, so a file copied in while a job runs is not missed.
 * Returns { done, failed }.
 */
export async function runQueue({ s = transcribeSettings(), settleMs = 30000, pollMs = 5000, maxWaitMs = 6 * 3600 * 1000, sleep = wait, log = stamp, notifyDone = quietSend, ...opts } = {}) {
  const t = opts.t || translator();
  const counts = { done: 0, failed: 0 }, ignored = new Set();
  let waited = 0;
  for (;;) {
    const q = scanInbox(s, { settleMs });
    for (const n of q.ignored) if (!ignored.has(n)) { ignored.add(n); log(`transcribe: ignored ${n} (not an audio or video file)`); }
    if (q.ready.length) {
      waited = 0;
      const item = q.ready[0];
      const r = await transcribeFile(item.file, { s, fromInbox: true, log, t, ...opts });
      if (r.ok) { counts.done++; await notifyDone(t('tr.ready', { name: item.name, duration: clock(r.result.duration), lang: r.result.language || '?', dir: path.basename(r.dir) })); }
      else counts.failed++;
      continue;
    }
    if (q.settling.length && waited < maxWaitMs) { waited += pollMs; await sleep(pollMs); continue; }
    break;
  }
  return counts;
}

// ---------- bench ----------
/** One bench row from a transcriber result: { model, load, transcribe, duration, rtf, per_hour, peak_mb }. */
export function benchRow(model, r) {
  const j = r.json || {};
  const transcribe = Number.isFinite(Number(j.transcribe_seconds)) ? Number(j.transcribe_seconds) : r.wall;
  const f = rtf(transcribe, j.duration);
  return { model, ok: r.code === 0 && !!r.json, error: r.code === 0 && r.json ? null : reason(r, `exit ${r.code}`).slice(0, 200), load: j.load_seconds ?? null, transcribe: Math.round(transcribe * 10) / 10,
    duration: Number(j.duration) || null, rtf: f, per_hour: f == null ? null : Math.round(f * 3600), peak_mb: j.peak_rss_mb ?? null };
}
const minutes = sec => (sec == null ? '?' : sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`);
/** The bench as a plain table. */
export function benchReport(rows, { file, threads, compute }) {
  const dur = rows.find(r => r.duration)?.duration;
  const head = ['model', 'load', 'transcribe', 'real-time factor', '1 h of audio takes', 'peak memory'];
  const body = rows.map(r => (r.ok ? [r.model, r.load == null ? '?' : `${r.load} s`, `${r.transcribe} s`, r.rtf ?? '?', minutes(r.per_hour), r.peak_mb == null ? '?' : `${Math.round(r.peak_mb)} MB`]
    : [r.model, `failed: ${r.error}`, '', '', '', '']));
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => String(b[i]).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  return [`Bench: ${path.basename(file)}, ${dur ? `${dur} s of audio` : 'length unknown'}, ${threads} thread(s), ${compute}, CPU ${os.cpus()[0]?.model?.trim() || '?'} (${os.cpus().length} logical cores)`,
    '', line(head), ...body.map(line), '',
    'Real-time factor: transcription seconds per second of audio (load time not counted; the first run of a model also downloads it).'].join('\n');
}

// ---------- status for the workspace ----------
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** GET /api/transcribe: { enabled, installed, max_upload_mb, waiting, running, failed, done }. */
export function queueStatus({ s = transcribeSettings(), limit = 10 } = {}) {
  const q = scanInbox(s, { settleMs: 0 });
  const cur = readJson(STATUS(), {})?.current;
  const running = cur && alive(cur.pid) ? { name: cur.file, started: cur.started } : null;
  const done = [];
  let dirs = []; try { dirs = fs.readdirSync(s.transcripts).filter(d => isFile(path.join(s.transcripts, d, 'segments.json'))).sort().reverse().slice(0, limit); } catch { /* none yet */ }
  for (const d of dirs) {
    const j = readJson(path.join(s.transcripts, d, 'segments.json'), {}) || {};
    done.push({ dir: d, name: j.source || d, at: j.at || null, duration: j.duration ?? null, language: j.language || null,
      files: ['transcript.md', 'transcript.srt', 'segments.json'].filter(f => isFile(path.join(s.transcripts, d, f))).map(f => ({ name: f, url: `/files/transcripts/${encodeURIComponent(d)}/${f}` })) });
  }
  return {
    enabled: s.enabled, installed: installed(s), max_upload_mb: s.max_upload_mb, model: s.model,
    waiting: [...q.ready, ...q.settling].filter(x => x.name !== running?.name).map(x => ({ name: x.name, size: x.size, at: new Date(x.mtime).toISOString() })),
    running,
    failed: q.failed.map(x => ({ name: x.name, error: String(x.note || '').split('\n')[1] || '', at: String(x.note || '').split('\n')[0] || null })),
    done,
  };
}

/** The file a /files/transcripts/<dir>/<file> URL names (rest still percent-encoded), or null. Same rules as pack files. */
export const TRANSCRIPT_TYPES = { '.md': 'text/markdown; charset=utf-8', '.srt': 'application/x-subrip; charset=utf-8', '.json': 'application/json; charset=utf-8' };
export function resolveTranscriptFile(rest, s = transcribeSettings()) {
  const parts = String(rest || '').split('/');
  if (parts.length !== 2) return null;
  let names; try { names = parts.map(decodeURIComponent); } catch { return null; }
  if (names.some(n => !n || n === '.' || n === '..' || /[/\\:\0]/.test(n) || path.isAbsolute(n))) return null;
  const type = TRANSCRIPT_TYPES[path.extname(names[1]).toLowerCase()];
  if (!type) return null;
  let rootReal, real;
  try { rootReal = fs.realpathSync(s.transcripts); real = fs.realpathSync(path.join(s.transcripts, names[0], names[1])); } catch { return null; }
  const rel = path.relative(rootReal, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).length !== 2 || !isFile(real)) return null;
  return { path: real, name: names[1], type };
}

// ---------- getting audio in ----------
/** Put a staged file into the inbox under a safe, unused name. Returns the name it got. */
export function intoInbox(staged, name, s = transcribeSettings()) {
  fs.mkdirSync(s.inbox, { recursive: true });
  const to = unique(s.inbox, name);
  moveFile(staged, to);
  return path.basename(to);
}
/** A new staging file for an upload or a download (outside the inbox, so the queue never sees half a file). */
export function stagingFile(s = transcribeSettings()) {
  fs.mkdirSync(s.staging, { recursive: true });
  return path.join(s.staging, `.part-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
}

const onSystemd = () => process.platform === 'linux' && fs.existsSync('/run/systemd/system');
const userUnitDir = () => path.join(os.homedir(), '.config', 'systemd', 'user');
/**
 * Start the queue now: through the systemd unit when cli.mjs timer installed it (so a restart of the bot or the
 * workspace never kills a job), otherwise as a detached `cli.mjs transcribe --queue`. The lock keeps it to one.
 */
export function kickQueue({ systemd = onSystemd(), dir = userUnitDir(), run = spawnSync, start = spawn, log = stamp } = {}) {
  if (systemd && fs.existsSync(path.join(dir, UNIT_PATH))) {
    const r = run('systemctl', ['--user', 'start', '--no-block', UNIT_SERVICE], { stdio: 'ignore' });
    if (!r?.error && r?.status === 0) return 'systemd';
  }
  try {
    const out = fs.openSync(STATE('transcribe.log'), 'a');
    const p = start(process.execPath, [path.join(CODE_DIR, 'cli.mjs'), 'transcribe', '--queue'], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
    p.unref?.(); fs.closeSync(out);
    return 'spawned';
  } catch (e) { log(`transcribe: could not start the queue: ${e.message}`); return 'failed'; }
}

// ---------- systemd ----------
/** The path unit (starts the queue when something lands in the inbox) and its service, for cli.mjs timer. "/" paths. */
export function transcribeUnitFiles({ root, code = root, node, envPath, inbox, home = '' }) {
  const slash = p => String(p).replace(/\\/g, '/');
  return {
    [UNIT_PATH]: `[Unit]\nDescription=CometScout transcription: start the queue when audio lands in the inbox\n[Path]\nPathChanged=${slash(inbox)}\nMakeDirectory=yes\nUnit=${UNIT_SERVICE}\n[Install]\nWantedBy=default.target\n`,
    [UNIT_SERVICE]: `[Unit]\nDescription=CometScout transcription queue\nOnFailure=cometscout-failure@%n.service\n[Service]\nType=oneshot\nWorkingDirectory=${root}\n` +
      `Environment="PATH=${envPath}"\n${home}ExecStart=${node} ${code}/cli.mjs transcribe --queue\nTimeoutStartSec=13h\n`,
  };
}

// ---------- doctor ----------
/** "faster-whisper 1.2.1" from the venv's dist-info folder, or null. */
export function installedVersion(s) {
  const libs = [path.join(venvDir(s), 'Lib', 'site-packages')];
  try { for (const d of fs.readdirSync(path.join(venvDir(s), 'lib'))) libs.push(path.join(venvDir(s), 'lib', d, 'site-packages')); } catch { /* Windows layout or none */ }
  for (const l of libs) {
    let names; try { names = fs.readdirSync(l); } catch { continue; }
    const m = names.map(n => n.match(/^faster_whisper-([\w.]+)\.dist-info$/i)).find(Boolean);
    if (m) return m[1];
  }
  return null;
}
const gb = bytes => `${(bytes / 1e9).toFixed(1)} GB`;
/**
 * The downloaded model in the cache (Hugging Face layout: models--<org>--faster-whisper-<model>/snapshots/<rev>/) and
 * its size, or null. Only a snapshot with model.bin counts, so a download cut half-way is not reported as there.
 */
export function cachedModel(s) {
  const sizeOf = d => { let n = 0; try { for (const f of fs.readdirSync(d)) { try { const st = fs.statSync(path.join(d, f)); if (st.isFile()) n += st.size; } catch { /* broken link */ } } } catch { /* none */ } return n; };
  if (path.isAbsolute(s.model)) return isFile(path.join(s.model, 'model.bin')) ? { dir: s.model, bytes: sizeOf(s.model) } : null;
  const re = new RegExp(`^models--[^/\\\\]+--faster-whisper-${s.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  let names; try { names = fs.readdirSync(modelsDir(s)); } catch { return null; }
  const d = names.find(n => re.test(n));
  if (!d) return null;
  const snaps = path.join(modelsDir(s), d, 'snapshots');
  let revs; try { revs = fs.readdirSync(snaps); } catch { return null; }
  for (const r of revs) if (isFile(path.join(snaps, r, 'model.bin'))) return { dir: path.join(snaps, r), bytes: sizeOf(path.join(snaps, r)) };
  return null;
}
const existingParent = p => { let d = p; while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d); return d; };

/** Doctor lines { level: ok|todo|warn, text, fix } for the module. */
export function transcribeDoctor({ settings = SETTINGS, root = ROOT, data = DATA, has = onPath, statfs = p => fs.statfsSync(p), systemd = onSystemd(), unitDir = userUnitDir() } = {}) {
  const s = transcribeSettings(settings, root, data);
  if (!s.enabled) return [{ level: 'ok', text: `transcription: off (optional: ${INSTALL_COMMAND}, README: Transcription)` }];
  const out = [];
  const py = isFile(venvPython(s));
  out.push({ level: py ? 'ok' : 'todo', text: `transcription: ${py ? `Python environment in ${venvDir(s)}` : `not installed at ${s.path}`}`, fix: INSTALL_COMMAND });
  if (py) {
    const v = installedVersion(s);
    out.push(v ? { level: 'ok', text: `faster-whisper ${v}${v === FASTER_WHISPER_VERSION ? '' : ` (this CometScout pins ${FASTER_WHISPER_VERSION}; the installer switches to it)`}` }
      : { level: 'todo', text: 'faster-whisper: not installed in the module\'s Python', fix: INSTALL_COMMAND });
  }
  const m = cachedModel(s), need = m ? 0 : (MODEL_GB[s.model] ?? 3) * 1e9;
  out.push({ level: 'ok', text: m ? `model ${s.model}: downloaded (${gb(m.bytes)})` : `model ${s.model}: not downloaded yet (about ${MODEL_GB[s.model] ?? '?'} GB; the first job downloads it into ${modelsDir(s)})` });
  try {
    const f = statfs(existingParent(s.path)), free = Number(f.bavail) * Number(f.bsize), want = need + 1e9;
    out.push({ level: free >= want ? 'ok' : 'todo', text: `free disk for the module: ${gb(free)}${need ? `, the model needs about ${gb(need)}` : ''}`, fix: `free at least ${gb(want)} on the disk of ${s.path}, or choose a smaller model (modules.transcribe.model)` });
  } catch { out.push({ level: 'warn', text: `free disk at ${s.path}: could not be read` }); }
  // faster-whisper decodes audio with the FFmpeg libraries in PyAV, so the ffmpeg command is optional
  out.push({ level: 'ok', text: has('ffmpeg') ? 'ffmpeg on the PATH (optional: faster-whisper decodes audio itself)' : 'ffmpeg not on the PATH (optional: faster-whisper decodes audio itself)' });
  out.push({ level: 'ok', text: `transcription inbox: ${s.inbox}; audio kept ${s.keep_audio_days} day(s) after it is transcribed` });
  if (systemd) out.push({ level: fs.existsSync(path.join(unitDir, UNIT_PATH)) ? 'ok' : 'todo', text: `${UNIT_PATH}: ${fs.existsSync(path.join(unitDir, UNIT_PATH)) ? 'installed (a file in the inbox starts the queue)' : 'not installed'}`, fix: 'node cli.mjs timer' });
  return out;
}

// ---------- install ----------
/** The Python to build the venv with: [command, leading args], from PYTHON, else python3 (py -3 on Windows). */
export function pythonCommand(env = process.env, platform = process.platform) {
  if (env.PYTHON) return [env.PYTHON, []];
  return platform === 'win32' ? ['py', ['-3']] : ['python3', []];
}
const pyHint = WIN ? 'install Python 3 (winget install Python.Python.3.12), or set PYTHON to a python.exe' : 'sudo apt-get install -y python3 python3-venv';

/** Create the venv and install the pinned faster-whisper. No model is downloaded here. Returns the exit code. */
export function installTranscribe({ settings = SETTINGS, root = ROOT, data = DATA, run = spawnSync, log = console.log, env = process.env } = {}) {
  const s = transcribeSettings(settings, root, data);
  let [py, pre] = pythonCommand(env);
  const ver = run(py, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
  if (ver.error || ver.status !== 0) {
    if (WIN && !env.PYTHON) { [py, pre] = ['python', []]; const v2 = run(py, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }); if (!v2.error && v2.status === 0) Object.assign(ver, v2, { error: null }); }
    if (ver.error || ver.status !== 0) { log(`Python 3 is needed for the transcription module: ${pyHint}`); return 1; }
  }
  const [maj, min] = String(ver.stdout).trim().split('.').map(Number);
  if (maj !== 3 || min < 9) { log(`faster-whisper needs Python 3.9 or newer; ${py} is ${String(ver.stdout).trim()}. Set PYTHON to a newer one.`); return 1; }
  fs.mkdirSync(s.path, { recursive: true });
  if (!isFile(venvPython(s))) {
    log(`Creating a Python ${maj}.${min} environment in ${venvDir(s)}`);
    const r = run(py, [...pre, '-m', 'venv', venvDir(s)], { stdio: 'inherit' });
    if (r.error || r.status !== 0 || !isFile(venvPython(s))) {
      fs.rmSync(venvDir(s), { recursive: true, force: true });
      log(`Could not create the environment.${WIN ? '' : ' On Debian and Ubuntu: sudo apt-get install -y python3-venv'}`);
      return 1;
    }
  }
  log(`Installing faster-whisper ${FASTER_WHISPER_VERSION} into it (about 300 MB with its libraries)`);
  const pip = run(venvPython(s), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `faster-whisper==${FASTER_WHISPER_VERSION}`], { stdio: 'inherit' });
  if (pip.error || pip.status !== 0) {
    log(`pip could not install faster-whisper ${FASTER_WHISPER_VERSION} for Python ${maj}.${min}. If no wheel exists for this Python yet, set PYTHON to an older Python 3 and run the installer again.`);
    return 1;
  }
  fs.writeFileSync(path.join(s.path, 'installed.json'), `${JSON.stringify({ faster_whisper: FASTER_WHISPER_VERSION, python: `${maj}.${min}`, installed: new Date().toISOString() }, null, 1)}\n`);
  log(`Transcription module: ${s.path} (faster-whisper ${FASTER_WHISPER_VERSION}, Python ${maj}.${min})`);
  const m = cachedModel(s);
  log(m ? `Model ${s.model}: downloaded (${gb(m.bytes)}).` : `No model is downloaded yet: the first job downloads ${s.model} (small about 0.5 GB, medium 1.5 GB, large-v3 3 GB) into ${modelsDir(s)}.`);
  log('Pick a model for this machine: node cli.mjs transcribe --bench <a short recording> --models small,medium');
  // systemd watches the inbox on Linux; elsewhere an upload from the workspace or the bot starts the queue
  const watcher = WIN ? 'files the workspace or the bot receive start the queue; for files copied in, run node cli.mjs transcribe --queue' : 'run node cli.mjs timer so a file in the inbox starts the queue';
  log(s.enabled ? `Then ${watcher}.` : `Then set modules.transcribe.enabled to true in settings.json; ${watcher}.`);
  return 0;
}

// ---------- cli.mjs transcribe ----------
const USAGE = 'Usage: node cli.mjs transcribe <file> | --queue | --bench <file> [--models small,medium] [--threads N]';
/** cli.mjs transcribe: returns the exit code. */
export async function transcribeCommand(args, { s = transcribeSettings(), log = console.log, ...opts } = {}) {
  const opt = n => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; const v = args[i + 1]; return v === undefined || v.startsWith('--') ? '' : v; };
  const queue = args.includes('--queue'), bench = opt('bench');
  const file = bench ?? args.find((a, i) => !a.startsWith('--') && !['--models', '--threads'].includes(args[i - 1]));
  if (bench === '' || (!queue && !file)) { log(USAGE); return 1; }
  if (!installed(s)) { log(`The transcription module is not installed at ${s.path}. Install it: ${INSTALL_COMMAND}`); return 1; }
  if (!queue && !isFile(path.resolve(file))) { log(`No such file: ${file}`); return 1; }
  const lock = takeTranscribeLock(LOCK(s));
  if (lock.busy) {
    // the running queue scans the inbox again after each job, so a file dropped now is not missed
    log(queue ? `transcribe: a job is already running (pid ${lock.busy}); it picks up new files in the inbox` : `A transcription is already running (pid ${lock.busy}); try again when it finishes.`);
    return queue ? 0 : 1;
  }
  try {
    const gone = pruneAudio(s); if (gone.length) log(`transcribe: deleted ${gone.length} audio file(s) older than ${s.keep_audio_days} day(s) from ${s.done}`);
    if (bench !== undefined) {
      const models = (opt('models') || 'small,medium').split(',').map(x => x.trim()).filter(Boolean);
      const threads = opt('threads') ? Math.floor(num(opt('threads'), s.threads, 1, 256)) : s.threads;
      const rows = [];
      for (const m of models) { log(`bench: ${m} ...`); rows.push(benchRow(m, await runTranscriber(s, { audio: path.resolve(bench), model: m, threads, has: opts.has }))); }
      log(benchReport(rows, { file: bench, threads, compute: s.compute_type }));
      return rows.every(r => r.ok) ? 0 : 1;
    }
    if (queue) {
      const r = await runQueue({ s, log, ...opts });
      log(`transcribe: queue done (${r.done} transcribed, ${r.failed} failed)`);
      return 0;   // a failure is already noted and alerted once; a non-zero exit would alert again (OnFailure)
    }
    const abs = path.resolve(file);
    const fromInbox = path.dirname(abs) === path.resolve(s.inbox);
    const r = await transcribeFile(abs, { s, fromInbox, log, ...opts });
    if (r.ok) log(`Transcript: ${path.join(r.dir, 'transcript.md')}${r.coach ? `\nFor the coach: ${r.coach} (say analyze and give it this file)` : ''}`);
    return r.ok ? 0 : 1;
  } finally { lock.release(); }
}

if (isMain(import.meta.url)) {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'install') process.exitCode = installTranscribe();
  else { console.log('Usage: node lib/transcribe.mjs install   (or bash deploy/modules/transcribe.sh)'); process.exitCode = 1; }
}

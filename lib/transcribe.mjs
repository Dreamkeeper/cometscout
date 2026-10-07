// The transcription module (optional): speech to text on the server's own CPU with faster-whisper, in a Python virtual
// environment of its own next to the home. Audio never leaves the server; the model is downloaded once from Hugging Face.
//   bash deploy/modules/transcribe.sh | deploy/modules/transcribe.ps1   # install (both run: node lib/transcribe.mjs install)
//   node cli.mjs transcribe <file>                                       # one file now
//   node cli.mjs transcribe --queue                                      # every file in the inbox, oldest first, one at a time
//   node cli.mjs transcribe --bench <file> [--models small,large-v3-turbo] [--threads N]   # speed and memory per model, nothing written
//   node cli.mjs transcribe --bench <file> --engines whisper,gigaam,gigaam+whisper [--reference text.txt]   # per engine, with WER
// settings.modules.transcribe = { enabled: false, path: null, model: "large-v3-turbo", compute_type: "int8", threads: 2, nice: 10,
//   language: null, inbox: "data/audio/inbox", keep_audio_days: 30, max_upload_mb: 500, telegram_attach: true,
//   engines: { "ru": "gigaam+whisper", "default": "whisper" }, language_floor: 0.6, language_fallback: "auto", vad: "silero",
//   vad_options: { threshold: 0.4, min_silence_duration_ms: 400, speech_pad_ms: 250 }, keep_cyrillic: [], glossary: [] }
//   path: null means <home>/../cometscout-transcribe (the venv in venv/, models in models/). language: null detects it.
//   engines: per language (and "default"): whisper, gigaam, or gigaam+whisper (GigaAM's text with Whisper's Latin terms
//   and numbers, lib/transcribe-merge.mjs). Without a fixed language (and unless every language uses the same engine),
//   the Whisper run detects it on the first 30 seconds of speech, picks the engine and transcribes in the same process;
//   a detection under language_floor follows language_fallback ("auto": Whisper alone, detecting on its own over the file,
//   or a language code). GigaAM needs the extra (transcribe.sh --with-gigaam); without it, or
//   when it fails, the job uses Whisper alone and the transcript says so. vad: how GigaAM finds speech in long audio
//   ("silero", the VAD faster-whisper ships, is the only one now); vad_options tune it for cutting 15 to 22 s pieces at
//   pauses (faster-whisper's defaults wait for 2 s of silence). keep_cyrillic: more brand forms the merge keeps in
//   Cyrillic. glossary: more terms (lib/transcribe-glossary.mjs), like lines of profile/glossary.txt.
//   inbox: a relative path starting with data/ is inside the data folder (COMETSCOUT_DATA), others are relative to the home.
//   telegram_attach: the "transcript ready" message carries transcript.md as a document (up to the 50 MB bot upload limit).
// The installer pins faster-whisper and its compiled dependencies with deploy/modules/transcribe/constraints.txt.
// One job at a time across the machine: transcribe.lock in the module's folder, separate from the run lock. The model runs as
// deploy/modules/transcribe/transcribe.py under nice and ionice with `threads` CPU threads. COMETSCOUT_TRANSCRIBE_CMD
// replaces it (an executable, or a .mjs/.js script run with node) and takes the same arguments: tests use a fake one.
// Output: data/transcripts/<date>--<name>/ with transcript.md, transcript.srt and segments.json. An inbox file then moves
// to data/audio/done/ (deleted after keep_audio_days; 0 deletes it at once). A file elsewhere is left where it is.
// A failure leaves the audio in the inbox with a <name>.failed note and sends one alert; delete the note to try again.
// With the module enabled but not installed, the queue alerts once (data/state/transcribe-not-installed.json remembers it
// until the module is installed), leaves the audio waiting and exits 0, so OnFailure does not fire for every new file.
// Transcripts travel with exports and backups (lib/archive.mjs DATA_DIRS); the audio folders do not.
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
import { sendText, sendFile, telegramOn } from './telegram.mjs';
import { mergeWords, buildSegments, wordsOf, prepare } from './transcribe-merge.mjs';
import { buildGlossary, applyGlossary, renderGlossary, hotwords as glossaryHotwords, hotwordCount, knownWords, GLOSSARY_FILE } from './transcribe-glossary.mjs';

export const FASTER_WHISPER_VERSION = '1.2.1';
// The GigaAM extra: gigaam 0.2.0 is not on PyPI, so it is pinned to its commit on GitHub (MIT); PyTorch for the CPU comes
// from the PyTorch CPU index, never the CUDA wheels (the torch and torchaudio pins are in constraints.txt).
export const GIGAAM_VERSION = '0.2.0';
export const GIGAAM_COMMIT = '7447938d791c4f3e643386ee22c33777004293a5';
export const GIGAAM_URL = `https://github.com/salute-developers/GigaAM/archive/${GIGAAM_COMMIT}.zip`;
export const GIGAAM_MODEL = 'v3_e2e_rnnt';   // not ctc: no faster on the CPU, and it glues words together
export const GIGAAM_MODEL_GB = 0.45;
export const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';
export const GIGAAM_PYTHON = [[3, 10], [3, 14]];   // CPU wheels of torch and torchaudio 2.11 exist for these
// What the extra imports, installed with the pins from constraints.txt (gigaam itself goes in with --no-deps: its own
// pins would downgrade onnxruntime under faster-whisper).
export const GIGAAM_LIBS = ['hydra-core', 'omegaconf', 'sentencepiece', 'soundfile', 'tqdm'];
// The pins in constraints.txt that only the extra uses (left out of the base install's message).
const EXTRA_PINS = new Set(['torch', 'torchaudio', 'hydra-core', 'omegaconf', 'antlr4-python3-runtime', 'sentencepiece', 'soundfile', 'cffi',
  'sympy', 'mpmath', 'networkx', 'jinja2', 'markupsafe', 'setuptools']);
export const ENGINES = ['whisper', 'gigaam', 'gigaam+whisper'];
export const VADS = ['silero'];
export const DEFAULT_ENGINES = { ru: 'gigaam+whisper', default: 'whisper' };
export const LANGUAGE_FLOOR = 0.6;   // a detection less sure than this follows language_fallback
// Silero tuned for cutting long audio into GigaAM's pieces (faster-whisper's defaults wait for 2 s of silence, which
// leaves long segments that would be cut inside speech): [default, min, max] per option.
export const VAD_OPTIONS = { threshold: [0.4, 0.05, 0.95], min_silence_duration_ms: [400, 50, 5000], speech_pad_ms: [250, 0, 2000] };
// Download sizes in GB, for doctor and the installer (faster-whisper's CTranslate2 conversions on Hugging Face).
export const MODEL_GB = { tiny: 0.08, base: 0.15, small: 0.5, medium: 1.5, 'large-v1': 3, 'large-v2': 3, 'large-v3': 3, 'large-v3-turbo': 1.6, turbo: 1.6 };
// What the queue and the uploads take: audio, and video files whose sound track faster-whisper reads.
export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.opus', '.flac', '.aac', '.wma', '.amr', '.3gp', '.webm', '.mp4', '.mkv', '.mov', '.m4v']);
export const BOT_MAX_MB = 20;   // the Bot API lets bots download files up to 20 MB
export const TELEGRAM_UPLOAD_MAX = 50 * 1048576;   // and send (sendDocument) files up to 50 MB
const WIN = process.platform === 'win32';
/** The installer command for a platform. */
export const installCommand = (platform = process.platform) => (platform === 'win32' ? 'powershell -ExecutionPolicy Bypass -File deploy\\modules\\transcribe.ps1' : 'bash deploy/modules/transcribe.sh');
export const INSTALL_COMMAND = installCommand();
export const SCRIPT = path.join(CODE_DIR, 'deploy', 'modules', 'transcribe', 'transcribe.py');
// The versions the installer pins with pip -c: one set with wheels for Python 3.10 to 3.14 on Linux (x86_64, aarch64)
// and Windows x64. faster-whisper itself is pinned on the command line (FASTER_WHISPER_VERSION).
export const CONSTRAINTS = path.join(CODE_DIR, 'deploy', 'modules', 'transcribe', 'constraints.txt');
export const MIN_PYTHON = [3, 10];   // 3.10 (Ubuntu 22.04) gets older pins through markers in constraints.txt
/** { package: version } from constraints.txt ("name==version" lines; comments and markers ignored). */
export function pinnedVersions(file = CONSTRAINTS) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const m = line.replace(/#.*/, '').trim().match(/^([A-Za-z0-9._-]+)==([^\s;]+)/); if (m) out[m[1].toLowerCase()] = m[2]; }
  return out;
}
// in the module's folder, so every CometScout home that shares the module (and its CPU) shares the one lock
export const LOCK = (s = transcribeSettings()) => path.join(s.path, 'transcribe.lock');
const STATUS = () => STATE('transcribe.json');
const NOT_INSTALLED = () => STATE('transcribe-not-installed.json');
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
  // engines per language: a value that is not one of ENGINES is reported (problems, doctor) and that language uses the default
  const engines = { ...DEFAULT_ENGINES }, problems = [];
  if (c.engines != null && (typeof c.engines !== 'object' || Array.isArray(c.engines))) problems.push('modules.transcribe.engines must be an object such as { "ru": "gigaam+whisper", "default": "whisper" }');
  else for (const [k, v] of Object.entries(c.engines || {})) {
    const lang = String(k).toLowerCase(), val = String(v ?? '').trim().toLowerCase();
    if (lang !== 'default' && !/^[a-z]{2,3}$/.test(lang)) problems.push(`modules.transcribe.engines: "${k}" is not a language code (ru, en) or "default"`);
    else if (!ENGINES.includes(val)) problems.push(`modules.transcribe.engines.${k}: "${v}" is not one of ${ENGINES.join(', ')}`);
    else engines[lang] = val;
  }
  const vad = str(c.vad)?.toLowerCase() || 'silero';
  if (!VADS.includes(vad)) problems.push(`modules.transcribe.vad: "${c.vad}" is not one of ${VADS.join(', ')}`);
  const vadOpts = {};
  const vo = c.vad_options;
  if (vo != null && (typeof vo !== 'object' || Array.isArray(vo))) problems.push('modules.transcribe.vad_options must be an object such as { "threshold": 0.4, "min_silence_duration_ms": 400, "speech_pad_ms": 250 }');
  for (const [k, [def, min, max]] of Object.entries(VAD_OPTIONS)) {
    const v = vo && typeof vo === 'object' ? vo[k] : undefined;
    if (v != null && !(Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max)) problems.push(`modules.transcribe.vad_options.${k}: ${JSON.stringify(v)} is not a number from ${min} to ${max}`);
    vadOpts[k] = num(v, def, min, max);
  }
  for (const k of Object.keys(vo && typeof vo === 'object' && !Array.isArray(vo) ? vo : {})) if (!(k in VAD_OPTIONS)) problems.push(`modules.transcribe.vad_options: "${k}" is not one of ${Object.keys(VAD_OPTIONS).join(', ')}`);
  const list = (v, key) => { if (v == null) return []; if (!Array.isArray(v)) { problems.push(`modules.transcribe.${key} must be a list of words`); return []; } return v.map(x => String(x).trim()).filter(Boolean); };
  // how sure the detection must be, and what an unsure one does: "auto" (Whisper alone, detecting on its own) or a language
  if (c.language_floor != null && !(Number.isFinite(Number(c.language_floor)) && Number(c.language_floor) >= 0 && Number(c.language_floor) <= 1)) problems.push(`modules.transcribe.language_floor: ${JSON.stringify(c.language_floor)} is not a number from 0 to 1`);
  const fallback = str(c.language_fallback)?.toLowerCase() || 'auto';
  if (fallback !== 'auto' && !/^[a-z]{2,3}$/.test(fallback)) problems.push(`modules.transcribe.language_fallback: "${c.language_fallback}" is not "auto" or a language code such as ru`);
  return {
    enabled: c.enabled === true,
    path: dir,
    model: str(c.model) || 'large-v3-turbo',   // best accuracy per CPU minute in the 2026-10-07 bench (English and Russian)
    compute_type: str(c.compute_type) || 'int8',
    threads: Math.floor(num(c.threads, 2, 1, 256)),
    nice: Math.floor(num(c.nice, 10, 0, 19)),
    language: language && /^[a-z]{2,3}$/.test(language) ? language : null,
    language_floor: num(c.language_floor, LANGUAGE_FLOOR, 0, 1),
    language_fallback: fallback === 'auto' || /^[a-z]{2,3}$/.test(fallback) ? fallback : 'auto',
    inbox,
    keep_audio_days: num(c.keep_audio_days, 30, 0, 36500),
    max_upload_mb: num(c.max_upload_mb, 500, 1, 100000),
    telegram_attach: c.telegram_attach !== false,
    engines,
    vad: VADS.includes(vad) ? vad : 'silero',
    vad_options: vadOpts,
    keep_cyrillic: list(c.keep_cyrillic, 'keep_cyrillic'),
    glossary: list(c.glossary, 'glossary'),
    problems,
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

/** The engine for a language: settings.modules.transcribe.engines[language], else its "default". */
export const engineFor = (s, language) => (language && s.engines[language]) || s.engines.default || 'whisper';
export const usesGigaam = engine => String(engine).startsWith('gigaam');
/** Whether a job must detect the language first: none is fixed and the languages do not all use one engine. */
export const needsDetection = s => !s.language && new Set(Object.values(s.engines)).size > 1;
/** The engines map a job can use: without the GigaAM extra, every language goes to Whisper. */
export const effectiveEngines = (s, gigaamReady) => Object.fromEntries(Object.entries(s.engines).map(([k, v]) => [k, usesGigaam(v) && !gigaamReady ? 'whisper' : v]));

/**
 * The transcriber for one run: [command, args]. COMETSCOUT_TRANSCRIBE_CMD replaces the module's Python. engine: whisper
 * or gigaam; engines: the map per language, so the Whisper run detects the language itself (on the first 30 s of speech,
 * with s.language_floor and s.language_fallback), picks the engine and transcribes in the same process (it only detects
 * when the language goes to GigaAM alone); words: Whisper's word times; hotwords: the glossary for Whisper.
 */
export function transcriberCommand(s, { audio, out, model = s.model, threads = s.threads, env = process.env, engine = 'whisper', engines = null, words = false, hotwords = '', language = s.language } = {}) {
  const gigaam = engine === 'gigaam', whisper = !gigaam, auto = whisper && !!engines;
  const args = ['--out', out, ...(gigaam ? ['--engine', 'gigaam', '--gigaam-model', GIGAAM_MODEL, '--vad', s.vad, '--vad-options', JSON.stringify(s.vad_options || {})] : []),
    ...(auto ? ['--engines', JSON.stringify(engines), '--language-floor', String(s.language_floor ?? LANGUAGE_FLOOR), '--language-fallback', s.language_fallback || 'auto', '--vad-options', JSON.stringify(s.vad_options || {})] : []),
    ...(words && whisper && !auto ? ['--words'] : []), ...(hotwords && whisper ? ['--hotwords', hotwords] : []),
    '--model', model, '--compute-type', s.compute_type, '--threads', String(threads), '--models-dir', modelsDir(s),
    ...(language && !auto ? ['--language', language] : []), audio];
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
  const merged = usesGigaam(r.engine || 'whisper');
  const engineLine = r.engine === 'gigaam+whisper' ? t('tr.engines_merged', { gigaam: r.gigaam_model || GIGAAM_MODEL, model: modelLabel(r.model), compute: r.compute_type, threads: r.threads })
    : r.engine === 'gigaam' ? t('tr.engines_gigaam', { gigaam: r.gigaam_model || GIGAAM_MODEL, threads: r.threads }) : null;
  const subs = r.substitutions || [], review = r.review || [];
  return [
    `# ${t('tr.title', { name: r.source })}`,
    '',
    `- ${t('tr.language')}: ${lang}`,
    ...(r.language_unsure ? [`- ${t('tr.language_unsure', { p: Math.round((r.language_unsure.probability || 0) * 100), floor: Math.round((r.language_unsure.floor ?? LANGUAGE_FLOOR) * 100) })}, ${r.language_unsure.fallback && r.language_unsure.fallback !== 'auto' ? t('tr.unsure_assumed', { lang: r.language_unsure.fallback }) : t('tr.unsure_auto')}`] : []),
    `- ${t('tr.duration')}: ${clock(r.duration)} (${spoken(r.duration, t)})`,
    engineLine ? `- ${t('tr.engines')}: ${engineLine}` : `- ${t('tr.model')}: ${t('tr.model_line', { model: modelLabel(r.model), compute: r.compute_type, threads: r.threads })}`,
    ...(r.fallback ? [`- ${t(`tr.fallback_${r.fallback.kind}`, { error: r.fallback.error || '', install: `${INSTALL_COMMAND} --with-gigaam` })}`] : []),
    ...(r.glossary_size != null ? [`- ${t('tr.glossary')}: ${r.glossary_size ? t('tr.glossary_line', { n: r.glossary_size, hot: r.hotwords_size ?? 0 }) : t('tr.glossary_none')}`] : []),
    ...(merged ? [`- ${t('tr.changes')}: ${t('tr.changes_line', { subs: subs.length, review: review.length })}`] : []),
    `- ${t('tr.took')}: ${t('tr.took_line', { took: spoken(r.seconds, t), rtf: rtf(r.transcribe_seconds ?? r.seconds, r.duration) ?? '?', at: r.at })}`,
    `- ${t('tr.speakers')}`,
    '',
    ...(paras.length ? paras.flatMap(p => [`[${clock(p.start)}] ${p.text}`, '']) : [t('tr.empty'), '']),
    ...(review.length ? [`## ${t('tr.check_title')}`, '', t('tr.check_intro'), '', ...review.map(x => `- [${clock(x.time)}] ${t('tr.check_item', { gigaam: x.gigaam, whisper: x.whisper, p: Math.round((x.probability || 0) * 100) })}`), ''] : []),
    ...(subs.length ? [`## ${t('tr.changes_title')}`, '', ...subs.map(x => `- [${clock(x.time)}] ${x.before} -> ${x.after} (${x.source})`), ''] : []),
  ].join('\n');
}

/** The words of an engine's result as plain text (for the bench's word error rate). */
export const plainText = result => (result?.segments || []).map(x => String(x?.text || '').trim()).filter(Boolean).join(' ');
/** Lowercase words without punctuation, ё as е: what the word error rate compares. */
export const werWords = text => String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
/** Word error rate of `hyp` against `ref`, as a fraction (null without a reference). */
export function wer(ref, hyp) {
  const r = werWords(ref), h = werWords(hyp);
  if (!r.length) return null;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[h.length] / r.length;
}

/**
 * The merged transcript from the engines' results: { segments, words, substitutions, review, stats }. gigaam alone: its
 * words with the glossary pass; with whisper too: the targeted merge (lib/transcribe-merge.mjs), then the glossary pass.
 */
export function combine({ gigaam, whisper, glossary = [], keep = [] }) {
  let words, substitutions = [], review = [], stats = null;
  if (gigaam && whisper) {
    const m = mergeWords(wordsOf(gigaam), wordsOf(whisper), { keep, known: knownWords(glossary) });
    ({ words, substitutions, review, stats } = m);
  } else words = prepare(wordsOf(gigaam), { lookalike: true }).map(w => ({ text: w.t, start: Math.round(w.s * 100) / 100, end: Math.round(w.e * 100) / 100, source: 'gigaam', ...(w.hy ? { hy: true } : {}) }));
  const g = applyGlossary(words, glossary);
  words = g.words;
  substitutions = [...substitutions, ...g.substitutions].sort((a, b) => a.time - b.time);
  const segments = buildSegments(words).map(x => ({ start: x.start, end: x.end, text: x.text, words: x.words.map(w => ({ text: w.text, start: w.start, end: w.end, source: w.source, ...(w.hy ? { hy: true } : {}) })) }));
  return { segments, words, substitutions, review, stats };
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
// Windows device names: "nul.mp3" or "con.backup.m4a" open the device, not a file (also as "com1 .wav" and with ¹²³)
const WIN_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(\.|$)/i;
/**
 * A safe file name for the inbox from a name a client or Telegram sent, or null: the last path part only, no control
 * or reserved characters, no leading dot, an audio or video extension, at most 120 characters. A Windows device name
 * gets a "_" in front ("_nul.mp3") on every platform, since the files may move to Windows later (export, Syncthing).
 */
export function safeAudioName(raw) {
  let n = String(raw ?? '');
  n = n.split(/[/\\]/).pop().normalize('NFC').replace(/[\p{Cc}<>:"|?*]/gu, '').replace(/^[\s.]+/, '').replace(/\s+$/, '');
  const ext = path.extname(n).toLowerCase();
  if (!n || !AUDIO_EXT.has(ext) || n.length === ext.length) return null;
  const base = n.slice(0, n.length - ext.length).slice(0, 120 - ext.length).replace(/[\s.]+$/, '');
  if (!base) return null;
  return WIN_DEVICE.test(base + ext) ? `_${base}${ext}` : base + ext;
}
/** Move a file, across file systems too (an inbox on another disk). */
export function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(from, to); fs.rmSync(from); }
}
/**
 * Move `from` into `dir` as `name`, or name-2, name-3 ... and never over a file that is there: the name is taken with an
 * exclusive create (two uploads with the same name at the same moment get different names), then the file is renamed
 * over that empty placeholder, which is ours. Across file systems the bytes are copied into it. Returns the path.
 */
export function claimInto(dir, name, from) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const to = path.join(dir, i === 1 ? name : `${base}-${i}${ext}`);
    let fd; try { fd = fs.openSync(to, 'wx'); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    fs.closeSync(fd);
    try {
      try { fs.renameSync(from, to); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(from, to); fs.rmSync(from); }
    } catch (e) { fs.rmSync(to, { force: true }); throw e; }
    return to;
  }
  throw new Error(`no free name for ${name} in ${dir}`);
}
const failedNote = file => `${file}.failed`;
const failedText = (date, why) => `${date.toISOString()}\n${why}\nThe audio stays here. Delete this note to try again (node cli.mjs transcribe --queue).\n`;
/** The file's full path in a message (also as Python prints it on Windows, with doubled backslashes) becomes its name. */
const scrub = (text, file) => [file, file.replace(/\\/g, '\\\\')].reduce((w, p) => w.split(p).join(path.basename(file)), String(text)).replace(/\.$/, '').slice(0, 300);

// A clock that is wrong somewhere (a phone, a NAS, a mount) can stamp a file in the future: it would never settle, so a
// time ahead of ours (beyond a second of rounding) counts as ready.
const FUTURE_SLACK_MS = 1000;
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
    if (fs.existsSync(failedNote(file))) { let note = ''; try { note = fs.readFileSync(failedNote(file), 'utf8'); } catch { /* not a readable file: still a note */ } out.failed.push({ ...item, note }); }
    else (now - st.mtimeMs >= settleMs || st.mtimeMs - now > FUTURE_SLACK_MS ? out.ready : out.settling).push(item);
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
export function runTranscriber(s, { audio, model, threads = s.threads, has = onPath, timeoutMs = JOB_TIMEOUT_MS, echo = true, start = spawn, ...run } = {}) {
  fs.mkdirSync(s.staging, { recursive: true });
  const out = path.join(s.staging, `.job-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  const { cmd, args, renice } = lowPriority(transcriberCommand(s, { audio, out, model, threads, ...run }), { nice: s.nice, has });
  const t0 = Date.now();
  return new Promise(resolve => {
    let err = '', settled = false, timer = null;   // timer first: a spawn that throws at once calls done() before it is set
    const done = code => {
      if (settled) return; settled = true; clearTimeout(timer);
      let json = null; try { json = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* none */ }
      for (const f of [out, `${out}.tmp`]) fs.rmSync(f, { force: true });
      resolve({ code, json, err: err.trim(), wall: (Date.now() - t0) / 1000 });
    };
    let p;
    try { p = start(cmd, args, { env: jobEnv(threads), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); } catch (e) { err = e.message; return done(null); }
    if (renice && p.pid) try { os.setPriority(p.pid, renice); } catch { /* not allowed here: it runs at normal priority */ }
    timer = setTimeout(() => { err += `\nstopped after ${timeoutMs / 3600000} h`; p.kill('SIGTERM'); }, timeoutMs);
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

/** The glossary for a job (lib/transcribe-glossary.mjs) from <home>/profile (never the example profile); [] when it fails. */
export function jobGlossary(s, { settings = SETTINGS, root = ROOT, data = DATA, log = stamp } = {}) {
  const profileDir = isDir(path.join(root, 'profile')) ? path.join(root, 'profile') : null;
  try { return buildGlossary({ data, profileDir, settings: { ...settings, modules: { ...settings?.modules, transcribe: { ...settings?.modules?.transcribe, glossary: s.glossary } } } }); }
  catch (e) { log(`transcribe: the glossary could not be built (${e.message}); going on without it`); return []; }
}

/**
 * The runs for one file. Without a fixed language, one Whisper process detects the language on the first 30 s of speech,
 * picks the engine for it (transcribe.py, with the engines map) and transcribes in the same process, so a language that
 * stays on Whisper costs one model load; GigaAM then runs for a language that uses it. A detection under
 * s.language_floor follows s.language_fallback ("auto": Whisper alone, detecting on its own). GigaAM missing or failing
 * falls back to Whisper alone, Whisper failing after the detection to GigaAM alone (plan.fallback says why). Resolves to
 * { engine, language, language_probability, unsure, glossary, hotwords, gigaam, whisper, first, main, fallback, wall };
 * main is the run whose failure fails the job.
 */
export async function runEngines(s, file, { settings = SETTINGS, root = ROOT, data = DATA, has = onPath, start = spawn, log = stamp, gigaamReady = gigaamInstalled, threads } = {}) {
  const t0 = Date.now();
  const glossary = jobGlossary(s, { settings, root, data, log });
  const hot = glossaryHotwords(glossary);
  const plan = { glossary, hotwords: hot ? hotwordCount(glossary) : 0, language: s.language, language_probability: null, fallback: null, unsure: null };
  const finish = (main, engine) => Object.assign(plan, { main, engine, wall: (Date.now() - t0) / 1000 });
  const ok = r => r && r.code === 0 && Array.isArray(r.json?.segments);
  const ready = Object.values(s.engines).some(usesGigaam) && !!gigaamReady(s);
  const missing = () => { plan.fallback = { kind: 'gigaam_missing' }; log(`transcribe: GigaAM is not installed (${INSTALL_COMMAND} --with-gigaam), so Whisper alone`); };
  let engine;
  if (needsDetection(s)) {
    plan.first = await runTranscriber(s, { audio: file, has, start, threads, engines: effectiveEngines(s, ready), hotwords: hot });
    const j = plan.first.json, route = j?.route;
    if (!route) return finish(plan.first, 'whisper');   // the detection itself failed
    const det = j.detected || {};
    plan.language = route.language ? String(route.language).toLowerCase() : null;
    plan.language_probability = route.sure ? det.probability ?? null : null;
    if (!route.sure) plan.unsure = { probability: det.probability ?? null, floor: s.language_floor, fallback: s.language_fallback };
    engine = ENGINES.includes(route.engine) ? route.engine : 'whisper';
    log(`transcribe: language ${det.language || '?'} (${Math.round((det.probability || 0) * 100)}%${route.sure ? '' : `, under ${Math.round(s.language_floor * 100)}%: ${plan.language || 'Whisper alone'}`}), engine ${engine}`);
    if (plan.language && usesGigaam(engineFor(s, plan.language)) && !ready) missing();
    if (engine !== 'gigaam') plan.whisper = plan.first;   // Whisper has run (or failed after the detection)
    if (engine === 'whisper') return finish(plan.first, 'whisper');
  } else {
    engine = engineFor(s, plan.language);
    if (usesGigaam(engine) && !ready) { missing(); engine = 'whisper'; }
  }
  if (usesGigaam(engine)) {
    plan.gigaam = await runTranscriber(s, { audio: file, has, start, threads, engine: 'gigaam' });
    if (!ok(plan.gigaam)) {
      plan.fallback = { kind: 'gigaam_failed', error: scrub(reason(plan.gigaam, `exit ${plan.gigaam.code}`), file).slice(0, 200) };
      log(`transcribe: GigaAM failed (${plan.fallback.error}), so Whisper alone`);
      plan.gigaam = null; engine = 'whisper';
      if (plan.whisper) return finish(plan.whisper, 'whisper');
    } else if (engine === 'gigaam') return finish(plan.gigaam, engine);
  }
  // Whisper: with word times for the merge, the glossary as hotwords, and the detected language
  if (!plan.whisper) plan.whisper = await runTranscriber(s, { audio: file, has, start, threads, words: engine === 'gigaam+whisper', hotwords: hot, language: plan.language || s.language });
  if (engine === 'gigaam+whisper' && !ok(plan.whisper)) {
    plan.fallback = { kind: 'whisper_failed', error: scrub(reason(plan.whisper, `exit ${plan.whisper.code}`), file).slice(0, 200) };
    log(`transcribe: Whisper failed (${plan.fallback.error}), so GigaAM alone`);
    plan.whisper = null;
    return finish(plan.gigaam, 'gigaam');
  }
  return finish(plan.whisper, engine);
}

/**
 * Transcribe one file and write the outputs. fromInbox: move the audio to done/ after, or leave a .failed note and send
 * one alert when it fails. Resolves to { ok, dir?, result?, error? }.
 */
export async function transcribeFile(file, { s = transcribeSettings(), settings = SETTINGS, root = ROOT, data = DATA, fromInbox = false, t = translator(), log = stamp,
  alert = defaultAlert, date = new Date(), has = onPath, start = spawn, gigaamReady = gigaamInstalled } = {}) {
  const name = path.basename(file);
  writeStatus({ file: name, started: date.toISOString(), pid: process.pid });
  log(`transcribe: ${name} (model ${s.model}, ${s.threads} threads)`);
  let r, plan;
  try { plan = await runEngines(s, file, { settings, root, data, has, start, log, gigaamReady }); r = plan.main; } finally { writeStatus(null); }
  const j = r.json;
  const fail = async reasonText => {
    const why = scrub(reasonText, file);
    log(`transcribe: ${name} failed: ${why}`);
    if (fromInbox) {
      fs.writeFileSync(failedNote(file), failedText(date, why));
      await alert(t('tr.failed', { name, error: why }));
    }
    return { ok: false, error: why };
  };
  if (r.code !== 0 || !j) return fail(reason(r, r.code === null ? 'the transcriber did not start' : `the transcriber exited with ${r.code}`));
  if (!Array.isArray(j.segments)) return fail('the transcriber wrote no segments');

  const day = date.toISOString().slice(0, 10);
  const base = `${day}--${slug(path.basename(name, path.extname(name)))}`;
  fs.mkdirSync(s.transcripts, { recursive: true });
  const dir = unique(s.transcripts, base);   // under the lock, so no other job takes the name meanwhile
  const g = plan.gigaam?.json, w = plan.whisper?.json, sum = k => [...new Set([g, w, plan.first?.json])].reduce((n, x) => n + (Number(x?.[k]) || 0), 0);
  const merged = plan.engine !== 'whisper' ? combine({ gigaam: g, whisper: plan.engine === 'gigaam+whisper' ? w : null, glossary: plan.glossary, keep: s.keep_cyrillic }) : null;
  const result = {
    source: name, at: `${day} ${date.toISOString().slice(11, 16)} UTC`, language: plan.language || j.language || s.language || null, language_set: !!s.language,
    language_probability: plan.language_probability ?? j.language_probability ?? null, ...(plan.unsure ? { language_unsure: plan.unsure } : {}),
    duration: Number(j.duration) || 0, model: w?.model || s.model, compute_type: w?.compute_type || s.compute_type,
    threads: j.threads || s.threads, engine: plan.engine, ...(g ? { gigaam_model: g.model || GIGAAM_MODEL, vad: g.vad || s.vad } : {}), ...(plan.fallback ? { fallback: plan.fallback } : {}),
    seconds: Math.round(plan.wall * 10) / 10, load_seconds: sum('load_seconds') || null, transcribe_seconds: sum('transcribe_seconds') + sum('detect_seconds') || null,
    peak_rss_mb: Math.max(...[g, w].map(x => Number(x?.peak_rss_mb) || 0)) || null, speakers: 'not separated', glossary_size: plan.glossary.length,
    hotwords_size: plan.whisper ? plan.hotwords : 0,
    ...(merged ? { substitutions: merged.substitutions, review: merged.review, merge: merged.stats } : {}),
    segments: merged ? merged.segments : j.segments.map(x => ({ start: Number(x.start) || 0, end: Number(x.end) || 0, text: String(x.text || '').trim() })),
  };
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'transcript.md'), renderMarkdown(result, t));
  fs.writeFileSync(path.join(dir, 'transcript.srt'), renderSrt(result.segments));
  fs.writeFileSync(path.join(dir, 'segments.json'), `${JSON.stringify(result, null, 1)}\n`);
  if (plan.glossary.length) fs.writeFileSync(path.join(dir, 'glossary-used.txt'), renderGlossary(plan.glossary));
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

/**
 * "Transcript ready" in Telegram (only when it is on, without a log line when it is off). With attach, transcript.md
 * goes as a document with the text as its caption; a file over the bot upload limit, or a failed upload, falls back to
 * the text message. tg = { on, send, sendDoc, max } is injected by tests. Returns 'document', 'text' or false. Never throws.
 */
export async function sendReady(text, { file = null, attach = true, log = stamp, tg = {} } = {}) {
  const { on = telegramOn, send = sendText, sendDoc = sendFile, max = TELEGRAM_UPLOAD_MAX } = tg;
  if (!on()) return false;
  if (attach && file) {
    let size = null; try { size = fs.statSync(file).size; } catch { /* gone: send the text */ }
    if (size != null && size <= max) {
      try { await sendDoc(file, text); return 'document'; } catch (e) { log(`transcribe: Telegram could not take ${path.basename(file)} (${e.message}); sending the text only`); }
    } else if (size != null) log(`transcribe: ${path.basename(file)} is ${(size / 1048576).toFixed(1)} MB, over the ${Math.round(max / 1048576)} MB a bot can send; sending the text only`);
  }
  try { await send(text); return 'text'; } catch (e) { log(`transcribe: Telegram failed: ${e.message}`); return false; }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
/**
 * The queue: every ready file in the inbox, oldest first, one at a time, until none is left. Files still being written
 * (changed in the last settleMs) are waited for, up to maxWaitMs, so a file copied in while a job runs is not missed.
 * A file whose job throws (a full disk, a folder that cannot be made) gets the .failed note and the one alert, like any
 * failure, and the queue goes on with the next. notifyDone(text, { file: transcript.md }) sends "Transcript ready".
 * Returns { done, failed }.
 */
export async function runQueue({ s = transcribeSettings(), settleMs = 30000, pollMs = 5000, maxWaitMs = 6 * 3600 * 1000, sleep = wait, log = stamp, tg, notifyDone, ...opts } = {}) {
  const t = opts.t || translator();
  const alert = opts.alert || defaultAlert;
  const notify = notifyDone || ((text, { file }) => sendReady(text, { file, attach: s.telegram_attach, log, tg }));
  const counts = { done: 0, failed: 0 }, ignored = new Set(), tried = new Set();
  let waited = 0;
  for (;;) {
    const q = scanInbox(s, { settleMs });
    for (const n of q.ignored) if (!ignored.has(n)) { ignored.add(n); log(`transcribe: ignored ${n} (not an audio or video file)`); }
    // a file whose note could not be written is not tried again in this run
    const ready = q.ready.filter(x => !tried.has(x.file));
    if (ready.length) {
      waited = 0;
      const item = ready[0];
      let r;
      try { r = await transcribeFile(item.file, { s, fromInbox: true, log, t, ...opts }); } catch (e) {
        counts.failed++; tried.add(item.file);
        const why = scrub(e?.message || e, item.file), date = opts.date || new Date();
        log(`transcribe: ${item.name} failed: ${why}`);
        try { if (fs.existsSync(item.file)) fs.writeFileSync(failedNote(item.file), failedText(date, why)); } catch (e2) { log(`transcribe: could not write ${item.name}.failed: ${e2.message}`); }
        try { await alert(t('tr.failed', { name: item.name, error: why })); } catch { /* the log line stays */ }
        continue;
      }
      if (r.ok) { counts.done++; try { await notify(t('tr.ready', { name: item.name, duration: clock(r.result.duration), lang: r.result.language || '?', dir: r.dir }), { file: path.join(r.dir, 'transcript.md') }); } catch (e) { log(`transcribe: the ready message failed: ${e.message}`); } }
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
/** The bench as a plain table (a word error rate column when the rows have one). */
export function benchReport(rows, { file, threads, compute, first = 'model' }) {
  const dur = rows.find(r => r.duration)?.duration;
  const withWer = rows.some(r => r.wer !== undefined);
  const head = [first, 'load', 'transcribe', 'real-time factor', '1 h of audio takes', 'peak memory', ...(withWer ? ['WER'] : [])];
  const werCell = r => (withWer ? [r.wer == null ? '?' : `${(r.wer * 100).toFixed(1)}%`] : []);
  const body = rows.map(r => (r.ok ? [r.model, r.load == null ? '?' : `${r.load} s`, `${r.transcribe} s`, r.rtf ?? '?', minutes(r.per_hour), r.peak_mb == null ? '?' : `${Math.round(r.peak_mb)} MB`, ...werCell(r)]
    : [r.model, `failed: ${r.error}`, '', '', '', '', ...(withWer ? [''] : [])]));
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => String(b[i]).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  return [`Bench: ${path.basename(file)}, ${dur ? `${dur} s of audio` : 'length unknown'}, ${threads} thread(s), ${compute}, CPU ${os.cpus()[0]?.model?.trim() || '?'} (${os.cpus().length} logical cores)`,
    '', line(head), ...body.map(line), '',
    'Real-time factor: transcription seconds per second of audio (load time not counted; the first run of a model also downloads it).',
    ...(withWer ? ['WER: word error rate against the reference text (lowercase, punctuation stripped, ё as е).'] : [])].join('\n');
}

/** A short name for a model setting: "large-v3-turbo", also for a path to a downloaded faster-whisper model. */
export const modelLabel = m => (path.isAbsolute(String(m)) ? (String(m).match(/faster-whisper-([\w.-]+?)[\\/]/)?.[1] || path.basename(String(m))) : String(m));

/**
 * The bench per engine: whisper, gigaam and gigaam+whisper (GigaAM, Whisper with word times, and the merge), each with
 * its time per audio hour and, with a reference text, its word error rate. Whisper and GigaAM run once each and the
 * merged row adds their times and the merge's. Returns the rows.
 */
export async function benchEngines(s, file, { engines, threads = s.threads, language = s.language, reference = null, has = onPath, log = stamp, settings = SETTINGS, root = ROOT, data = DATA, run = runTranscriber } = {}) {
  const glossary = jobGlossary(s, { settings, root, data, log });
  const lang = language || (engines.some(usesGigaam) ? 'ru' : null);
  const needW = engines.some(e => e.includes('whisper')), needG = engines.some(usesGigaam);
  let wr = null, gr = null;
  if (needG) { log('bench: gigaam ...'); gr = await run(s, { audio: file, threads, has, engine: 'gigaam' }); }
  if (needW) { log(`bench: whisper ${modelLabel(s.model)} ...`); wr = await run(s, { audio: file, threads, has, words: engines.includes('gigaam+whisper'), hotwords: glossaryHotwords(glossary), language: lang }); }
  const ok = r => r && r.code === 0 && Array.isArray(r.json?.segments);
  const werOf = text => (reference == null ? undefined : wer(reference, text));
  const textOf = words => buildSegments(words).map(x => x.text).join(' ');
  return engines.map(e => {
    if (e === 'whisper') return { ...benchRow(`whisper ${modelLabel(s.model)}`, wr), wer: ok(wr) ? werOf(plainText(wr.json)) : undefined };
    const cuts = ok(gr) ? { chunks: gr.json.chunks ?? null, forced_cuts: gr.json.forced_cuts ?? null } : {};
    if (e === 'gigaam') return { ...benchRow(`gigaam ${GIGAAM_MODEL}`, gr), ...cuts, wer: ok(gr) ? werOf(textOf(combine({ gigaam: gr.json, glossary, keep: s.keep_cyrillic }).words)) : undefined };
    if (!ok(gr) || !ok(wr)) return { ...benchRow('gigaam+whisper', ok(gr) ? wr : gr), ok: false };
    const t0 = process.hrtime.bigint();
    const m = combine({ gigaam: gr.json, whisper: wr.json, glossary, keep: s.keep_cyrillic });
    const mergeSec = Number(process.hrtime.bigint() - t0) / 1e9;
    const g = benchRow('g', gr), w = benchRow('w', wr), transcribe = g.transcribe + w.transcribe + mergeSec, f = rtf(transcribe, g.duration || w.duration);
    return { model: 'gigaam+whisper', ok: true, error: null, load: g.load != null && w.load != null ? Math.round((g.load + w.load) * 10) / 10 : null, transcribe: Math.round(transcribe * 10) / 10,
      duration: g.duration || w.duration, rtf: f, per_hour: f == null ? null : Math.round(f * 3600), peak_mb: Math.max(g.peak_mb || 0, w.peak_mb || 0) || null,
      wer: werOf(textOf(m.words)), changes: m.substitutions.length, review: m.review.length, ...cuts };
  });
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
      files: ['transcript.md', 'transcript.srt', 'segments.json', 'glossary-used.txt'].filter(f => isFile(path.join(s.transcripts, d, f))).map(f => ({ name: f, url: `/files/transcripts/${encodeURIComponent(d)}/${f}` })) });
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
export const TRANSCRIPT_TYPES = { '.md': 'text/markdown; charset=utf-8', '.srt': 'application/x-subrip; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
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
/** Put a staged file into the inbox under a safe, unused name (never over another file, claimInto). Returns the name it got. */
export function intoInbox(staged, name, s = transcribeSettings()) {
  return path.basename(claimInto(s.inbox, name, staged));
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
/** The version of a package in the venv from its dist-info folder ("faster_whisper", "torch"), or null. */
export function installedVersion(s, pkg = 'faster_whisper') {
  const libs = [path.join(venvDir(s), 'Lib', 'site-packages')];
  try { for (const d of fs.readdirSync(path.join(venvDir(s), 'lib'))) libs.push(path.join(venvDir(s), 'lib', d, 'site-packages')); } catch { /* Windows layout or none */ }
  const re = new RegExp(`^${pkg}-([\\w.+]+)\\.dist-info$`, 'i');
  for (const l of libs) {
    let names; try { names = fs.readdirSync(l); } catch { continue; }
    const m = names.map(n => n.match(re)).find(Boolean);
    if (m) return m[1];
  }
  return null;
}
/** True when GigaAM can run: the extra is in the venv (gigaam and torch), or a fake transcriber stands in. */
export const gigaamInstalled = s => !!fakeCmd() || (!!installedVersion(s, 'gigaam') && !!installedVersion(s, 'torch'));
/** The venv's Python version [major, minor] from pyvenv.cfg, or null. */
export function venvPythonVersion(s) {
  let txt = ''; try { txt = fs.readFileSync(path.join(venvDir(s), 'pyvenv.cfg'), 'utf8'); } catch { return null; }
  const m = txt.match(/^\s*version(?:_info)?\s*=\s*(\d+)\.(\d+)/mi);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
const inRange = ([maj, min], [[a, b], [c, d]]) => (maj > a || (maj === a && min >= b)) && (maj < c || (maj === c && min <= d));
const pyRange = ([[a, b], [c, d]]) => `${a}.${b} to ${c}.${d}`;
/** The GigaAM model in the module's models/gigaam folder: { file, bytes } or null. */
export function cachedGigaam(s) {
  const f = path.join(modelsDir(s), 'gigaam', `${GIGAAM_MODEL}.ckpt`);
  try { const st = fs.statSync(f); return st.isFile() ? { file: f, bytes: st.size } : null; } catch { return null; }
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
  for (const p of s.problems) out.push({ level: 'todo', text: `transcription settings: ${p}`, fix: 'fix it in settings.json (README: Transcription)' });
  const langs = Object.entries(s.engines).filter(([k]) => k !== 'default').map(([k, v]) => `${k} ${v}`);
  out.push({ level: 'ok', text: `transcription engines: ${[...langs, `other languages ${s.engines.default}`].join(', ')}${s.language ? ` (language fixed to ${s.language})` : ''}` });
  if (Object.values(s.engines).some(usesGigaam) && py) {
    const gv = installedVersion(s, 'gigaam'), tv = installedVersion(s, 'torch'), pv = venvPythonVersion(s);
    if (pv && !inRange(pv, GIGAAM_PYTHON)) out.push({ level: 'todo', text: `GigaAM extra: needs Python ${pyRange(GIGAAM_PYTHON)} (PyTorch has CPU wheels for those), the module's Python is ${pv.join('.')}, so Russian recordings use Whisper alone`, fix: `PYTHON=<a Python ${pyRange(GIGAAM_PYTHON)}> and remove ${venvDir(s)}, then ${INSTALL_COMMAND} --with-gigaam` });
    else if (!gv || !tv) out.push({ level: 'todo', text: 'GigaAM extra: not installed, so Russian recordings use Whisper alone (about 0.2 GB of CPU-only PyTorch to download, plus the 0.45 GB model on the first job)', fix: `${INSTALL_COMMAND} --with-gigaam` });
    else {
      out.push({ level: /\+cu|\+rocm/i.test(tv) ? 'warn' : 'ok', text: `GigaAM extra: gigaam ${gv}, torch ${tv}${/\+cu|\+rocm/i.test(tv) ? ' (a GPU build: the installer switches it to the CPU one)' : ''}` });
      const gm = cachedGigaam(s);
      out.push({ level: 'ok', text: gm ? `GigaAM model ${GIGAAM_MODEL}: downloaded (${gb(gm.bytes)})` : `GigaAM model ${GIGAAM_MODEL}: not downloaded yet (about ${GIGAAM_MODEL_GB} GB from Sber's model server; the first Russian job downloads it into ${path.join(modelsDir(s), 'gigaam')})` });
    }
  }
  const gloss = path.join(root, 'profile', GLOSSARY_FILE);
  out.push({ level: 'ok', text: `transcription glossary: built before each job from applications, recent queue files, the CV library and profile.md${isFile(gloss) ? `, plus ${gloss}` : ` (add your own terms in ${gloss})`}` });
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

/**
 * The GigaAM extra into an existing venv: CPU-only torch and torchaudio from the PyTorch CPU index, GigaAM at its pinned
 * commit without its own pins, then the libraries it imports with the pins from constraints.txt. Returns the exit code.
 */
export function installGigaam(s, { run = spawnSync, log = console.log, python = '?' } = {}) {
  const pins = pinnedVersions();
  const pip = (...args) => run(venvPython(s), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-c', CONSTRAINTS, ...args], { stdio: 'inherit' });
  log(`Installing the GigaAM extra: PyTorch ${pins.torch} and torchaudio ${pins.torchaudio} built for the CPU only, from ${TORCH_CPU_INDEX} (no CUDA; about 115 MB to download on Windows, 150 to 190 MB on Linux), then GigaAM ${GIGAAM_VERSION} (commit ${GIGAAM_COMMIT.slice(0, 7)}) and ${GIGAAM_LIBS.join(', ')}`);
  const steps = [
    [['--index-url', TORCH_CPU_INDEX, 'torch', 'torchaudio'], `PyTorch for the CPU from ${TORCH_CPU_INDEX}`],
    [['--no-deps', `gigaam @ ${GIGAAM_URL}`], `GigaAM from ${GIGAAM_URL}`],
    [GIGAAM_LIBS, `GigaAM's libraries (${GIGAAM_LIBS.join(', ')})`],
  ];
  for (const [args, what] of steps) {
    const r = pip(...args);
    if (r.error || r.status !== 0) { log(`pip could not install ${what} for Python ${python} with the pins in ${CONSTRAINTS}. Faster-whisper still works; Russian recordings use Whisper alone until the extra installs.`); return 1; }
  }
  log('pip may warn that gigaam asks for onnx and an older onnxruntime: those are only for its ONNX export, which CometScout does not use.');
  return 0;
}

/** Create the venv and install the pinned faster-whisper (and with withGigaam the GigaAM extra). No model is downloaded here. Returns the exit code. */
export function installTranscribe({ settings = SETTINGS, root = ROOT, data = DATA, run = spawnSync, log = console.log, env = process.env, withGigaam = false } = {}) {
  const s = transcribeSettings(settings, root, data);
  let [py, pre] = pythonCommand(env);
  const ver = run(py, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
  if (ver.error || ver.status !== 0) {
    if (WIN && !env.PYTHON) { [py, pre] = ['python', []]; const v2 = run(py, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }); if (!v2.error && v2.status === 0) Object.assign(ver, v2, { error: null }); }
    if (ver.error || ver.status !== 0) { log(`Python 3 is needed for the transcription module: ${pyHint}`); return 1; }
  }
  const [maj, min] = String(ver.stdout).trim().split('.').map(Number);
  if (maj !== MIN_PYTHON[0] || min < MIN_PYTHON[1]) { log(`The transcription module needs Python ${MIN_PYTHON.join('.')} or newer (its pinned libraries have no wheels for older ones); ${py} is ${String(ver.stdout).trim()}. Set PYTHON to a newer one.`); return 1; }
  if (withGigaam && !inRange([maj, min], GIGAAM_PYTHON)) { log(`The GigaAM extra needs Python ${pyRange(GIGAAM_PYTHON)} (PyTorch has CPU wheels only for those); ${py} is ${maj}.${min}. Set PYTHON to one of them, or install without --with-gigaam.`); return 1; }
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
  // the constraints pin ctranslate2, av, tokenizers, onnxruntime and the rest to the set that was benchmarked, so a new
  // release of one of them cannot change speed or break decoding under an install that worked
  const pins = pinnedVersions();
  log(`Installing faster-whisper ${FASTER_WHISPER_VERSION} into it with pinned libraries (${Object.entries(pins).filter(([k]) => !EXTRA_PINS.has(k)).map(([k, v]) => `${k} ${v}`).join(', ')}; about 300 MB)`);
  const pip = run(venvPython(s), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-c', CONSTRAINTS, `faster-whisper==${FASTER_WHISPER_VERSION}`], { stdio: 'inherit' });
  if (pip.error || pip.status !== 0) {
    log(`pip could not install faster-whisper ${FASTER_WHISPER_VERSION} with the pinned libraries (${CONSTRAINTS}) for Python ${maj}.${min}. If no wheel exists for this Python yet, set PYTHON to a Python from ${MIN_PYTHON.join('.')} to 3.14 and run the installer again.`);
    return 1;
  }
  if (withGigaam) {
    const vp = venvPythonVersion(s);
    if (vp && !inRange(vp, GIGAAM_PYTHON)) { log(`The GigaAM extra needs Python ${pyRange(GIGAAM_PYTHON)}; the existing environment in ${venvDir(s)} has ${vp.join('.')}. Remove that folder and run the installer again with PYTHON set to one of them.`); return 1; }
    if (installGigaam(s, { run, log, python: `${maj}.${min}` }) !== 0) return 1;
  }
  const extra = withGigaam ? { gigaam: { version: GIGAAM_VERSION, commit: GIGAAM_COMMIT, torch: pins.torch, index: TORCH_CPU_INDEX } } : {};
  let before = {}; try { before = JSON.parse(fs.readFileSync(path.join(s.path, 'installed.json'), 'utf8')) || {}; } catch { /* first install */ }
  fs.writeFileSync(path.join(s.path, 'installed.json'), `${JSON.stringify({ faster_whisper: FASTER_WHISPER_VERSION, pinned: pins, python: `${maj}.${min}`, ...(before.gigaam && !withGigaam ? { gigaam: before.gigaam } : {}), ...extra, installed: new Date().toISOString() }, null, 1)}\n`);
  log(`Transcription module: ${s.path} (faster-whisper ${FASTER_WHISPER_VERSION}${withGigaam ? `, GigaAM ${GIGAAM_VERSION} with PyTorch ${pins.torch}` : ''}, Python ${maj}.${min})`);
  if (withGigaam) log(`GigaAM's model (${GIGAAM_MODEL}, about ${GIGAAM_MODEL_GB} GB) is downloaded from Sber's model server by the first Russian job, into ${path.join(modelsDir(s), 'gigaam')}. Russian recordings then go to GigaAM merged with Whisper (modules.transcribe.engines).`);
  else if (Object.values(s.engines).some(usesGigaam) && !gigaamInstalled(s)) log(`Russian recordings use Whisper alone until the GigaAM extra is installed: ${INSTALL_COMMAND} --with-gigaam`);
  const m = cachedModel(s);
  log(m ? `Model ${s.model}: downloaded (${gb(m.bytes)}).` : `No model is downloaded yet: the first job downloads ${s.model} (small about 0.5 GB, large-v3-turbo 1.6 GB, medium 1.5 GB, large-v3 3 GB) into ${modelsDir(s)}.`);
  log('Pick a model for this machine: node cli.mjs transcribe --bench <a short recording> --models small,large-v3-turbo');
  // systemd watches the inbox on Linux; elsewhere an upload from the workspace or the bot starts the queue
  const watcher = WIN ? 'files the workspace or the bot receive start the queue; for files copied in, run node cli.mjs transcribe --queue' : 'run node cli.mjs timer so a file in the inbox starts the queue';
  log(s.enabled ? `Then ${watcher}.` : `Then set modules.transcribe.enabled to true in settings.json; ${watcher}.`);
  return 0;
}

// ---------- cli.mjs transcribe ----------
/**
 * The queue with the module enabled but not installed (the path unit and the uploads still start it): one log line and
 * one alert, remembered in data/state/transcribe-not-installed.json until the module is installed; the audio waits in
 * the inbox and the exit is 0, so systemd's OnFailure does not fire for every new file. doctor shows the TODO.
 */
export async function notInstalledOnce(s, { log = console.log, alert = defaultAlert, t = translator(), now = new Date() } = {}) {
  const msg = `transcribe: the module is not installed at ${s.path}, so the audio waits in the inbox. Install it: ${INSTALL_COMMAND}`;
  if (fs.existsSync(NOT_INSTALLED())) { log(`${msg} (alerted on ${readJson(NOT_INSTALLED(), {})?.since || 'an earlier run'})`); return 0; }
  log(msg);
  try { fs.mkdirSync(path.dirname(NOT_INSTALLED()), { recursive: true }); fs.writeFileSync(NOT_INSTALLED(), `${JSON.stringify({ since: now.toISOString(), path: s.path })}
`); } catch (e) { log(`transcribe: could not remember the alert: ${e.message}`); }
  try { await alert(t('tr.not_installed', { path: s.path, install: INSTALL_COMMAND })); } catch { /* the log line stays */ }
  return 0;
}
const USAGE = 'Usage: node cli.mjs transcribe <file> | --queue | --bench <file> [--models small,large-v3-turbo | --engines whisper,gigaam,gigaam+whisper] [--reference text.txt] [--language ru] [--threads N]';
const VALUE_OPTS = ['--models', '--threads', '--engines', '--reference', '--language'];
/** cli.mjs transcribe: returns the exit code. */
export async function transcribeCommand(args, { s = transcribeSettings(), log = console.log, ...opts } = {}) {
  const opt = n => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; const v = args[i + 1]; return v === undefined || v.startsWith('--') ? '' : v; };
  const queue = args.includes('--queue'), bench = opt('bench');
  const file = bench ?? args.find((a, i) => !a.startsWith('--') && !VALUE_OPTS.includes(args[i - 1]));
  if (bench === '' || (!queue && !file)) { log(USAGE); return 1; }
  if (!installed(s)) {
    if (queue) return notInstalledOnce(s, { log, alert: opts.alert, t: opts.t });
    log(`The transcription module is not installed at ${s.path}. Install it: ${INSTALL_COMMAND}`); return 1;
  }
  fs.rmSync(NOT_INSTALLED(), { force: true });   // installed now: a later removal alerts again
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
      const models = (opt('models') || 'small,large-v3-turbo').split(',').map(x => x.trim()).filter(Boolean);
      const threads = opt('threads') ? Math.floor(num(opt('threads'), s.threads, 1, 256)) : s.threads;
      let reference = null;
      if (opt('reference') !== undefined) { try { reference = fs.readFileSync(path.resolve(opt('reference')), 'utf8'); } catch { log(`No such reference file: ${opt('reference')}`); return 1; } }
      if (opt('engines') !== undefined) {
        const engines = opt('engines').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
        const bad = engines.filter(e => !ENGINES.includes(e));
        if (!engines.length || bad.length) { log(`--engines takes ${ENGINES.join(', ')}${bad.length ? `, not ${bad.join(', ')}` : ''}`); return 1; }
        const language = (opt('language') || '').toLowerCase() || s.language;
        const rows = await benchEngines(s, path.resolve(bench), { engines, threads, language, reference, has: opts.has, log });
        log(benchReport(rows, { file: bench, threads, compute: s.compute_type, first: 'engine' }));
        const g = rows.find(r => r.ok && r.chunks != null);
        if (g) log(`GigaAM's pieces: ${g.chunks} chunk(s) cut at pauses by the ${s.vad} VAD, ${g.forced_cuts ?? '?'} cut inside speech (no pause found).`);
        const m = rows.find(r => r.model === 'gigaam+whisper' && r.ok);
        if (m) log(`The merge made ${m.changes} change(s) and left ${m.review} word(s) to check.`);
        return rows.every(r => r.ok) ? 0 : 1;
      }
      const rows = [];
      for (const m of models) {
        log(`bench: ${m} ...`);
        const r = await runTranscriber(s, { audio: path.resolve(bench), model: m, threads, has: opts.has });
        rows.push({ ...benchRow(m, r), ...(reference != null ? { wer: r.code === 0 && r.json ? wer(reference, plainText(r.json)) : null } : {}) });
      }
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
  const rest = process.argv.slice(3);
  const unknown = rest.filter(a => a !== '--with-gigaam');
  if (cmd === 'install' && !unknown.length) process.exitCode = installTranscribe({ withGigaam: rest.includes('--with-gigaam') });
  else { console.log('Usage: node lib/transcribe.mjs install [--with-gigaam]   (or bash deploy/modules/transcribe.sh [--with-gigaam])'); process.exitCode = 1; }
}

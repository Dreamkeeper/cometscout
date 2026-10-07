// Task 20 in the transcription module (lib/transcribe.mjs) with the fake transcriber (COMETSCOUT_TRANSCRIBE_CMD): engines
// per language and the language detection, GigaAM merged with Whisper, the glossary from the user's data (hotwords and
// the sound match), the transcript's new lines and sections, segments.json word sources, the fallbacks, the bench per
// engine with WER, the installer's GigaAM extra with a fake pip, doctor lines and Russian labels. No Python, model,
// network or systemctl; synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-engines-'));
const FAKE = path.join(tmp, 'fake-transcriber.mjs');
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'transcribe', 'fake-transcriber.mjs.txt'), FAKE);
const HOME = path.join(tmp, 'home'), DATA = path.join(HOME, 'data'), MOD = path.join(tmp, 'module'), FAKE_LOG = path.join(tmp, 'fake.log');
fs.mkdirSync(path.join(HOME, 'profile'), { recursive: true }); fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
Object.assign(process.env, { COMETSCOUT_HOME: HOME, COMETSCOUT_DATA: DATA, COMETSCOUT_SETTINGS: path.join(HOME, 'settings.json'), COMETSCOUT_TRANSCRIBE_CMD: FAKE, FAKE_TRANSCRIBE_LOG: FAKE_LOG });
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC', locale: 'en', modules: { transcribe: { enabled: true, path: MOD, threads: 2 } } }));
// the user's own data the glossary reads: a glossary.txt and one application
fs.writeFileSync(path.join(HOME, 'profile', 'glossary.txt'), 'Brightgrid\nKPI = кейпиай\n');
fs.writeFileSync(path.join(DATA, 'state', 'applications.json'), JSON.stringify({ a: { company: 'Northwind Robotics GmbH', role: 'PM', status: 'interview', updated: '2026-09-30' } }));

const T = await import('../lib/transcribe.mjs');
const { translator } = await import('../lib/i18n.mjs');

const quiet = () => {};
const cli = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env: process.env, timeout: 120000 });
const fakeCalls = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
// "auto": one Whisper process that detects the language and then transcribes (unless the language goes to GigaAM alone)
const kind = c => (c.args.includes('--engines') ? 'auto' : c.args.includes('--engine') ? c.args[c.args.indexOf('--engine') + 1] : 'whisper');
const settingsOf = cfg => ({ modules: { transcribe: { enabled: true, path: MOD, threads: 2, ...cfg } } });
/** A synthetic "recording" (a text file the fake reads) outside the inbox, through transcribeFile: { r, md, j, srt, calls, raw }. */
async function job(text, cfg = {}, opts = {}) {
  fs.rmSync(FAKE_LOG, { force: true }); fs.rmSync(path.join(DATA, 'transcripts'), { recursive: true, force: true });
  const s = T.transcribeSettings(settingsOf(cfg), HOME, DATA);
  const dir = path.join(tmp, 'in'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'call.m4a'); fs.writeFileSync(f, text);
  const r = await T.transcribeFile(f, { s, settings: settingsOf(cfg), root: HOME, data: DATA, log: quiet, ...opts });
  const read = n => fs.readFileSync(path.join(r.dir, n), 'utf8');
  return { r, md: r.ok ? read('transcript.md') : '', j: r.ok ? JSON.parse(read('segments.json')) : null, srt: r.ok ? read('transcript.srt') : '', dir: r.dir, calls: fakeCalls().map(kind), raw: fakeCalls() };
}
const arg = (c, n) => c.args[c.args.indexOf(`--${n}`) + 1];

test('routing: one Whisper process detects the language and transcribes; Russian then goes to GigaAM and is merged', async () => {
  const ru = await job('RUSSIAN synthetic call');
  assert.ok(ru.r.ok, ru.r.error);
  assert.deepEqual(ru.calls, ['auto', 'gigaam'], 'no separate detection process');
  const w = ru.raw[0];
  assert.deepEqual(JSON.parse(arg(w, 'engines')), { ru: 'gigaam+whisper', default: 'whisper' }, 'the engines map goes to transcribe.py');
  assert.deepEqual([arg(w, 'language-floor'), arg(w, 'language-fallback')], ['0.6', 'auto']);
  assert.ok(!w.args.includes('--language') && !w.args.includes('--words'), 'transcribe.py picks the language and the word times');
  assert.match(arg(w, 'hotwords'), /^Brightgrid, KPI, Northwind Robotics$/, 'the glossary as hotwords, the user\'s own terms first');
  assert.deepEqual([arg(ru.raw[1], 'gigaam-model'), arg(ru.raw[1], 'vad')], ['v3_e2e_rnnt', 'silero']);
  assert.deepEqual(JSON.parse(arg(ru.raw[1], 'vad-options')), { threshold: 0.4, min_silence_duration_ms: 400, speech_pad_ms: 250 });
  assert.deepEqual([ru.j.engine, ru.j.language, ru.j.language_probability], ['gigaam+whisper', 'ru', 0.93]);
  assert.ok(ru.j.substitutions.some(x => x.after === 'roadmap'), 'Whisper\'s word times reached the merge');
  const en = await job('synthetic English call');
  assert.deepEqual(en.calls, ['auto'], 'English: one process, one model load');
  assert.equal(en.j.language, 'en');
  assert.match(en.md, /^- Language: en \(detected, 97%\)$/m);
  assert.match(en.md, /^- Model: large-v3-turbo \(int8, CPU, 2 threads\)$/m);
  assert.match(en.md, /^- Glossary: 3 terms from your data \(glossary-used\.txt\), 3 sent to Whisper as hints$/m);
  assert.ok(!/^- (Changes|Engines)/m.test(en.md), 'Whisper alone: no merge lines');
});

test('routing: an unsure detection (under language_floor) follows language_fallback and the transcript says so', async () => {
  const auto = await job('RUSSIAN UNSURE call');
  assert.ok(auto.r.ok, auto.r.error);
  assert.deepEqual(auto.calls, ['auto'], '"auto": Whisper alone, detecting the language itself');
  assert.equal(auto.j.engine, 'whisper');
  assert.deepEqual(auto.j.language_unsure, { probability: 0.45, floor: 0.6, fallback: 'auto' });
  assert.match(auto.md, /^- Language detection on the first 30 s of speech was unsure \(45%, under 60%\), so this is Whisper alone \(modules\.transcribe\.language_fallback: auto\)$/m);
  const ru = await job('RUSSIAN UNSURE call', { language_fallback: 'ru' });
  assert.deepEqual(ru.calls, ['auto', 'gigaam']);
  assert.equal(arg(ru.raw[0], 'language-fallback'), 'ru');
  assert.deepEqual([ru.j.engine, ru.j.language], ['gigaam+whisper', 'ru']);
  assert.match(ru.md, /^- Language detection on the first 30 s of speech was unsure \(45%, under 60%\), so ru was assumed \(modules\.transcribe\.language_fallback\)$/m);
  assert.match(T.renderMarkdown(ru.j, translator('ru')), /^- Язык не удалось уверенно определить по первым 30 с речи \(45%, порог 60%\), поэтому выбран ru \(modules\.transcribe\.language_fallback\)$/m);
  const floor = await job('RUSSIAN UNSURE call', { language_floor: 0.4 });
  assert.equal(arg(floor.raw[0], 'language-floor'), '0.4');
  assert.deepEqual(floor.calls, ['auto', 'gigaam'], 'over a lower floor the detection is sure');
  assert.ok(!floor.j.language_unsure);
});

test('hotwords: at most 50 glossary terms go to Whisper; the GigaAM sound match and glossary-used.txt keep them all', async () => {
  const many = Array.from({ length: 60 }, (_, i) => `Synthterm${i}`);
  const en = await job('synthetic English call', { glossary: many });
  const hw = arg(en.raw[0], 'hotwords').split(', ');
  assert.equal(hw.length, 50);
  assert.deepEqual(hw.slice(0, 2), ['Brightgrid', 'KPI'], 'most important first');
  assert.match(en.md, /^- Glossary: 63 terms from your data \(glossary-used\.txt\), 50 sent to Whisper as hints$/m);
  assert.deepEqual([en.j.glossary_size, en.j.hotwords_size], [63, 50]);
  assert.equal(fs.readFileSync(path.join(en.dir, 'glossary-used.txt'), 'utf8').trim().split('\n').length, 63);
  assert.match(T.renderMarkdown(en.j, translator('ru')), /^- Словарь: терминов из ваших данных: 63 \(glossary-used\.txt\), подсказок для Whisper: 50$/m);
});

test('routing: a fixed language skips detection, so does one engine for every language; a failed detection fails the job', async () => {
  assert.deepEqual((await job('RUSSIAN call', { language: 'ru' })).calls, ['gigaam', 'whisper']);
  assert.deepEqual((await job('RUSSIAN call', { language: 'en' })).calls, ['whisper']);
  assert.deepEqual((await job('RUSSIAN call', { engines: { ru: 'whisper' } })).calls, ['whisper'], 'every language uses Whisper');
  const only = await job('RUSSIAN call', { engines: { ru: 'gigaam' } });
  assert.deepEqual(only.calls, ['auto', 'gigaam'], 'GigaAM alone: the Whisper process only detects the language');
  assert.equal(only.j.engine, 'gigaam');
  assert.match(only.md, /^- Engines: GigaAM v3_e2e_rnnt \(CPU, 2 threads\)$/m);
  assert.match(only.md, /^\[00:00:00\] Добрый день\. Расскажите про роадмап для зигби датчеков\./m, 'GigaAM\'s own text');
  assert.ok(only.j.substitutions.some(x => x.source === 'glossary' && x.after === 'Brightgrid'), 'the glossary pass still runs');
  const bad = await job('RUSSIAN DETECTFAIL call');
  assert.equal(bad.r.ok, false); assert.match(bad.r.error, /synthetic detection failure/);
  const d = T.transcribeSettings({}, '/r', '/d');
  assert.deepEqual([T.engineFor(d, 'ru'), T.engineFor(d, 'de'), T.engineFor(d, null)], ['gigaam+whisper', 'whisper', 'whisper']);
});

test('the merged transcript: text, Check these words, Changes made, per-word sources, SRT and glossary-used.txt', async () => {
  const { md, j, srt, dir } = await job('RUSSIAN synthetic call');
  assert.match(md, /^- Language: ru \(detected, 93%\)$/m);
  assert.match(md, /^- Engines: GigaAM v3_e2e_rnnt merged with Whisper large-v3-turbo \(int8, CPU, 2 threads\)$/m);
  assert.match(md, /^- Glossary: 3 terms from your data \(glossary-used\.txt\), 3 sent to Whisper as hints$/m);
  assert.match(md, /^- Changes: 4 made, 1 to check \(listed at the end\)$/m);
  assert.match(md, /^\[00:00:00\] Добрый день\. Расскажите про roadmap для Zigbee датчеков\. Мы запустили 25 устройств за второй квартал, какие-то на базе E27\./m);
  assert.match(md, /Я работал в Brightgrid и в Сбере\. Это было семь лет назад\.$/m, 'the glossary spelling; the brand stays Cyrillic; 7 stays a word');
  assert.match(md, /^## Check these words\n\nThe two engines heard these words differently\..*\n\n- \[00:00:03\] GigaAM "датчеков", Whisper "датчиков" \(97%\)$/m);
  assert.match(md, /^## Changes made\n\n- \[00:00:01\] роадмап -> roadmap \(whisper\)\n- \[00:00:02\] зигби -> Zigbee \(whisper\)\n- \[00:00:05\] двадцать пять -> 25 \(whisper\)\n- \[00:00:11\] брайтгрид -> Brightgrid \(glossary\)$/m);
  const ws = j.segments.flatMap(x => x.words);
  assert.deepEqual([...new Set(ws.map(w => w.source))].sort(), ['gigaam', 'glossary', 'whisper']);
  assert.equal(ws.find(w => w.text === 'roadmap').source, 'whisper');
  assert.equal(ws.find(w => w.text === 'Brightgrid').source, 'glossary');
  assert.equal(ws.find(w => w.text === 'датчеков.').source, 'gigaam', 'a review item is never applied');
  assert.deepEqual([j.substitutions.length, j.review.length, j.glossary_size], [4, 1, 3]);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.ok(srt.includes('roadmap') && srt.includes('25 устройств') && !srt.includes('роадмап'), 'the SRT is the merged text');
  assert.equal(fs.readFileSync(path.join(dir, 'glossary-used.txt'), 'utf8'), 'Brightgrid\nKPI = кейпиай\nNorthwind Robotics\n');
  const ruMd = T.renderMarkdown(j, translator('ru'));
  assert.match(ruMd, /^- Движки: GigaAM v3_e2e_rnnt, сверенный с Whisper/m);
  assert.match(ruMd, /^- Словарь: терминов из ваших данных: 3 \(glossary-used\.txt\), подсказок для Whisper: 3$/m);
  assert.match(ruMd, /^- Правки: внесено: 4, проверить: 1/m);
  assert.match(ruMd, /^## Проверьте эти слова$/m); assert.match(ruMd, /^## Внесённые правки$/m);
  assert.match(ruMd, /GigaAM «датчеков», Whisper «датчиков» \(97%\)/);
});

test('fallbacks: GigaAM missing or failing gives Whisper alone, Whisper failing gives GigaAM alone, and the transcript says so', async () => {
  const missing = await job('RUSSIAN call', {}, { gigaamReady: () => false });
  assert.deepEqual(missing.calls, ['auto']);
  assert.equal(JSON.parse(arg(missing.raw[0], 'engines')).ru, 'whisper', 'Russian routed to Whisper without the extra');
  assert.ok(!missing.raw[0].args.includes('--words'));
  assert.match(missing.md, /^- GigaAM is not installed, so this is Whisper alone \(install it: .*--with-gigaam\)$/m);
  assert.equal(missing.j.engine, 'whisper');
  const failed = await job('RUSSIAN NOGIGAAM call');
  assert.ok(failed.r.ok);
  assert.deepEqual(failed.calls, ['auto', 'gigaam'], 'Whisper already ran: no second Whisper run');
  assert.match(failed.md, /^- GigaAM failed \(RuntimeError: GigaAM is not installed in this Python \(No module named gigaam\)\), so this is Whisper alone$/m);
  assert.match(failed.md, /Расскажите про roadmap для Zigbee датчиков\./, 'Whisper\'s text');
  const noW = await job('RUSSIAN NOWHISPER call');
  assert.ok(noW.r.ok);
  assert.deepEqual(noW.calls, ['auto', 'gigaam'], 'the language came through although Whisper failed after detecting it');
  assert.equal(noW.j.engine, 'gigaam');
  assert.match(noW.md, /^- Whisper failed \(RuntimeError: synthetic Whisper failure\), so this is GigaAM alone$/m);
  assert.equal(T.gigaamInstalled({ path: path.join(tmp, 'nothing') }), true, 'a fake transcriber stands in for the extra');
});

test('settings: engines, vad, keep_cyrillic and glossary; a wrong value is reported and the default used', () => {
  const d = T.transcribeSettings({}, '/r', '/d');
  assert.deepEqual([d.engines, d.vad, d.keep_cyrillic, d.glossary, d.problems], [{ ru: 'gigaam+whisper', default: 'whisper' }, 'silero', [], [], []]);
  assert.deepEqual([d.language_floor, d.language_fallback], [0.6, 'auto']);
  const lf = T.transcribeSettings({ modules: { transcribe: { language_floor: 2, language_fallback: 'Russian' } } }, '/r', '/d');
  assert.deepEqual([lf.language_floor, lf.language_fallback], [0.6, 'auto']);
  assert.match(lf.problems.join('\n'), /language_floor: 2 is not a number from 0 to 1/);
  assert.match(lf.problems.join('\n'), /language_fallback: "Russian" is not "auto" or a language code such as ru/);
  assert.equal(T.transcribeSettings({ modules: { transcribe: { language_fallback: 'RU' } } }, '/r', '/d').language_fallback, 'ru');
  const c = T.transcribeSettings({ modules: { transcribe: { engines: { RU: 'GIGAAM', en: 'gigaam+whisper', default: 'whisper' }, keep_cyrillic: ['Тинькофф'], glossary: ['Acme = экми'] } } }, '/r', '/d');
  assert.deepEqual([c.engines, c.keep_cyrillic, c.glossary, c.problems], [{ ru: 'gigaam', en: 'gigaam+whisper', default: 'whisper' }, ['Тинькофф'], ['Acme = экми'], []]);
  const bad = T.transcribeSettings({ modules: { transcribe: { engines: { ru: 'vosk', english: 'whisper' }, vad: 'pyannote', glossary: 'Acme' } } }, '/r', '/d');
  assert.deepEqual([bad.engines, bad.vad], [{ ru: 'gigaam+whisper', default: 'whisper' }, 'silero'], 'the defaults stay');
  assert.equal(bad.problems.length, 4);
  assert.match(bad.problems.join('\n'), /engines\.ru: "vosk" is not one of whisper, gigaam, gigaam\+whisper/);
  assert.match(bad.problems.join('\n'), /vad: "pyannote" is not one of silero/);
  assert.equal(T.transcribeSettings({ modules: { transcribe: { engines: 'gigaam' } } }, '/r', '/d').problems.length, 1);
  // Silero tuned for cutting, not faster-whisper's defaults (2 s of silence)
  assert.deepEqual(d.vad_options, { threshold: 0.4, min_silence_duration_ms: 400, speech_pad_ms: 250 });
  const vo = T.transcribeSettings({ modules: { transcribe: { vad_options: { threshold: 0.5, speech_pad_ms: 'lots', window: 3 } } } }, '/r', '/d');
  assert.deepEqual(vo.vad_options, { threshold: 0.5, min_silence_duration_ms: 400, speech_pad_ms: 250 });
  assert.match(vo.problems.join('\n'), /vad_options\.speech_pad_ms: "lots" is not a number from 0 to 2000/);
  assert.match(vo.problems.join('\n'), /vad_options: "window" is not one of threshold, min_silence_duration_ms, speech_pad_ms/);
  assert.equal(T.needsDetection(d), true); assert.equal(T.needsDetection({ ...d, language: 'ru' }), false);
  assert.equal(T.needsDetection({ ...d, engines: { ru: 'whisper', default: 'whisper' } }), false);
  // the command: GigaAM's arguments, Whisper's words and hotwords, detection without them
  const [, ga] = T.transcriberCommand(d, { audio: 'a.mp3', out: 'o.json', engine: 'gigaam', language: 'ru' });
  assert.deepEqual(ga.slice(1, 8), ['--out', 'o.json', '--engine', 'gigaam', '--gigaam-model', 'v3_e2e_rnnt', '--vad']);
  const [, wa] = T.transcriberCommand(d, { audio: 'a.mp3', out: 'o.json', words: true, hotwords: 'KPI, Zigbee', language: 'ru' });
  assert.deepEqual(wa.slice(3, 7), ['--words', '--hotwords', 'KPI, Zigbee', '--model']);
  const [, da] = T.transcriberCommand(d, { audio: 'a.mp3', out: 'o.json', engines: { ru: 'gigaam+whisper', default: 'whisper' }, hotwords: 'x', language: 'ru' });
  assert.deepEqual(da.slice(3, 9), ['--engines', '{"ru":"gigaam+whisper","default":"whisper"}', '--language-floor', '0.6', '--language-fallback', 'auto']);
  assert.ok(da.includes('--hotwords') && !da.includes('--language') && !da.includes('--words'), 'transcribe.py picks the language');
  assert.deepEqual(T.effectiveEngines(d, false), { ru: 'whisper', default: 'whisper' }, 'GigaAM missing: every language to Whisper');
  assert.deepEqual(T.effectiveEngines(d, true), d.engines);
});

test('bench per engine: time per audio hour for whisper, gigaam and the merge, and WER against a reference', () => {
  fs.rmSync(FAKE_LOG, { force: true });
  fs.rmSync(path.join(DATA, 'transcripts'), { recursive: true, force: true });
  const f = path.join(tmp, 'ru-sample.wav'), ref = path.join(tmp, 'ref.txt');
  fs.writeFileSync(f, 'RUSSIAN sample');
  fs.writeFileSync(ref, 'Добрый день! Расскажите про roadmap для Zigbee датчиков. Мы запустили 25 устройств за второй квартал, какие-то на базе E27. Я работал в Брайтгрид и в Сбере. Это было семь лет назад.');
  const r = cli(['transcribe', '--bench', f, '--engines', 'whisper,gigaam,gigaam+whisper', '--reference', ref]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^engine\s+load\s+transcribe\s+real-time factor\s+1 h of audio takes\s+peak memory\s+WER$/m);
  assert.match(r.stdout, /^whisper large-v3-turbo\s+1\.5 s\s+8 s\s+0\.5\s+30 min\s+1530 MB\s+\d+\.\d%$/m);
  assert.match(r.stdout, /^gigaam v3_e2e_rnnt\s+2 s\s+4 s\s+0\.25\s+15 min\s+1100 MB\s+\d+\.\d%$/m);
  assert.match(r.stdout, /^gigaam\+whisper\s+3\.5 s\s+12 s\s+0\.75\s+45 min\s+1530 MB\s+\d+\.\d%$/m);
  assert.match(r.stdout, /^WER: word error rate against the reference text/m);
  assert.match(r.stdout, /The merge made 4 change\(s\) and left 1 word\(s\) to check\./);
  assert.match(r.stdout, /^GigaAM's pieces: 1 chunk\(s\) cut at pauses by the silero VAD, 0 cut inside speech \(no pause found\)\.$/m);
  const wers = Object.fromEntries([...r.stdout.matchAll(/^(\S+)[^\n]*?(\d+\.\d)%$/gm)].map(m => [m[1], Number(m[2])]));
  assert.ok(wers['gigaam+whisper'] < wers.gigaam, 'the merge has fewer errors than GigaAM alone on this sample');
  const calls = fakeCalls();
  assert.deepEqual(calls.map(c => (c.args.includes('--engine') ? 'gigaam' : c.args.includes('--words') ? 'whisper+words' : 'whisper')), ['gigaam', 'whisper+words'], 'each engine runs once');
  assert.equal(arg(calls[1], 'language'), 'ru', 'GigaAM is for Russian, so Whisper is told so');
  assert.ok(fs.existsSync(f) && !fs.existsSync(path.join(DATA, 'transcripts')), 'nothing written, nothing moved');
  assert.equal(T.wer('Ёлка, стоит!', 'елка стоит'), 0); assert.equal(T.wer('a b c d', 'a x c'), 0.5); assert.equal(T.wer('', 'a'), null);
  assert.match(cli(['transcribe', '--bench', f, '--engines', 'vosk']).stdout, /--engines takes whisper, gigaam, gigaam\+whisper, not vosk/);
  assert.match(cli(['transcribe', '--bench', f, '--engines', 'whisper', '--reference', path.join(tmp, 'none.txt')]).stdout, /No such reference file/);
  assert.match(cli(['transcribe', '--bench', f, '--models', 'small', '--reference', ref]).stdout, /^small\s+.*\s+\d+\.\d%$/m, 'the model bench takes a reference too');
});

// transcribe.py's chunking is plain Python (the VAD is passed in), so it runs wherever a python3 is installed
const PY = ['python3', 'python'].find(p => { const r = spawnSync(p, ['--version'], { encoding: 'utf8' }); return r.status === 0 && /Python 3/.test(r.stdout + r.stderr); });
const chunking = code => spawnSync(PY, ['-c', `import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location("t", sys.argv[1]); t = importlib.util.module_from_spec(spec); spec.loader.exec_module(t)\n${code}`, T.SCRIPT], { encoding: 'utf8' });
test('GigaAM chunks: 15 to 22 seconds cut at pauses; a long speech region with short pauses is cut at those pauses, not at 25 s', t => {
  if (!PY) return t.skip('no python3 here');
  const r = chunking(`
# 40 short segments of 1.8 s with 0.5 s pauses: grouped into chunks of 15 to 22 s, every cut at a pause
segs = [(i * 2.3, i * 2.3 + 1.8) for i in range(40)]
chunks, forced = t.chunk_speech(segs)
ends = {round(e, 3) for _, e in segs}
# one 70 s region the main VAD saw as one segment; the finer pass finds 0.2 s pauses every 6 s
def finer(s, e):
    out, x = [], s
    while x < e:
        out.append((x, min(e, x + 5.8))); x += 6.0
    return out
long_chunks, long_forced = t.chunk_speech([(100.0, 170.0)], finer)
pauses = {round(100.0 + k * 6.0 + 5.8, 3) for k in range(12)}
# the same region with no pause at all: equal parts, each cut forced
flat, flat_forced = t.chunk_speech([(0.0, 70.0)], lambda s, e: [(s, e)])
print(json.dumps({"n": len(chunks), "lens": [round(e - s, 2) for s, e in chunks], "at_pauses": all(round(e, 3) in ends for _, e in chunks), "forced": forced,
  "long_lens": [round(e - s, 2) for s, e in long_chunks], "long_at_pauses": all(round(e, 3) in pauses or round(e, 3) == 170.0 for _, e in long_chunks), "long_forced": long_forced,
  "flat_lens": [round(e - s, 2) for s, e in flat], "flat_forced": flat_forced, "defaults": t.VAD_DEFAULTS, "limits": [t.CHUNK_MIN_S, t.CHUNK_MAX_S, t.CHUNK_HARD_S]}))
`);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.limits, [15, 22, 25]);
  assert.deepEqual(j.defaults, { threshold: 0.4, min_silence_duration_ms: 400, speech_pad_ms: 250 });
  assert.ok(j.lens.slice(0, -1).every(l => l >= 15 && l <= 22), `chunks of 15 to 22 s: ${j.lens}`);
  assert.equal(j.at_pauses, true); assert.equal(j.forced, 0);
  assert.ok(j.long_lens.every(l => l <= 22), `the long region in pieces up to 22 s: ${j.long_lens}`);
  assert.equal(j.long_at_pauses, true, 'cut at the short pauses'); assert.equal(j.long_forced, 0);
  assert.ok(!j.long_lens.includes(25), 'not at 25 s');
  assert.deepEqual([j.flat_lens.length, j.flat_forced], [4, 3], 'speech with no pause: cut in equal parts, each cut counted');
  assert.ok(j.flat_lens.every(l => l <= 25));
});

test('transcribe.py: the language from the first 30 s of speech, and the route under the floor', t => {
  if (!PY) return t.skip('no python3 here');
  const r = chunking(`
engines = {"ru": "gigaam+whisper", "default": "whisper"}
routes = [t.choose_route("ru", 0.93, engines), t.choose_route("en", 0.97, engines), t.choose_route("ru", 0.45, engines),
  t.choose_route("ru", 0.45, engines, 0.6, "ru"), t.choose_route("ru", 0.45, engines, 0.4), t.choose_route("de", 0.9, {"ru": "gigaam"})]
# 40 s of hold music, then speech in 12 s turns with pauses: 30 s of speech, the last turn cut short
window = t.speech_window([(40.0, 52.0), (53.0, 65.0), (66.0, 78.0), (79.0, 91.0)])
print(json.dumps({"routes": routes, "window": window, "short": t.speech_window([(0.0, 5.0)]), "floor": t.LANGUAGE_FLOOR, "speech": t.DETECT_SPEECH_S}))
`);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.routes, [
    { language: 'ru', engine: 'gigaam+whisper', sure: true }, { language: 'en', engine: 'whisper', sure: true },
    { language: null, engine: 'whisper', sure: false }, { language: 'ru', engine: 'gigaam+whisper', sure: false },
    { language: 'ru', engine: 'gigaam+whisper', sure: true }, { language: 'de', engine: 'whisper', sure: true }]);
  assert.deepEqual(j.window, [[40, 52], [53, 65], [66, 72]], 'speech only, 30 s of it');
  assert.deepEqual(j.short, [[0, 5]]);
  assert.deepEqual([j.floor, j.speech], [0.6, 30]);
});

test('the installer with --with-gigaam: CPU-only PyTorch from its index, GigaAM at its commit, its libraries pinned', () => {
  const settings = { modules: { transcribe: { path: path.join(tmp, 'giga-mod') } } };
  const is = T.transcribeSettings(settings, HOME, DATA);
  const runs = [], logs = [];
  const fakeRun = ({ version = '3.12', failOn = null } = {}) => (cmd, args) => {
    runs.push(args.map(a => (a === T.CONSTRAINTS ? '<c>' : a)).join(' '));
    if (args.some(a => String(a).startsWith('import sys'))) return { status: 0, stdout: `${version}\n` };
    if (args.includes('venv')) { fs.mkdirSync(path.dirname(T.venvPython(is)), { recursive: true }); fs.writeFileSync(T.venvPython(is), ''); fs.writeFileSync(path.join(is.path, 'venv', 'pyvenv.cfg'), `version = ${version}.1\n`); return { status: 0 }; }
    if (failOn && args.includes(failOn)) return { status: 1 };
    return { status: 0 };
  };
  const env = { PYTHON: 'python3' }, log = l => logs.push(l);
  assert.equal(T.installTranscribe({ settings, root: HOME, data: DATA, run: fakeRun({ version: '3.15' }), log, env, withGigaam: true }), 1);
  assert.match(logs.at(-1), /The GigaAM extra needs Python 3\.10 to 3\.14 \(PyTorch has CPU wheels only for those\); python3 is 3\.15/);
  runs.length = 0; logs.length = 0;
  assert.equal(T.installTranscribe({ settings, root: HOME, data: DATA, run: fakeRun(), log, env, withGigaam: true }), 0);
  assert.deepEqual(runs.filter(r => r.startsWith('-m pip')), [
    `-m pip install --disable-pip-version-check --no-input -c <c> faster-whisper==${T.FASTER_WHISPER_VERSION}`,
    '-m pip install --disable-pip-version-check --no-input -c <c> --index-url https://download.pytorch.org/whl/cpu torch torchaudio',
    `-m pip install --disable-pip-version-check --no-input -c <c> --no-deps gigaam @ https://github.com/salute-developers/GigaAM/archive/${T.GIGAAM_COMMIT}.zip`,
    '-m pip install --disable-pip-version-check --no-input -c <c> hydra-core omegaconf sentencepiece soundfile tqdm',
  ]);
  const pins = T.pinnedVersions();
  assert.match(pins.torch, /^\d+\.\d+\.\d+\+cpu$/); assert.match(pins.torchaudio, /^\d+\.\d+\.\d+\+cpu$/, 'CPU builds only');
  for (const p of ['hydra-core', 'omegaconf', 'sentencepiece', 'soundfile', 'antlr4-python3-runtime']) assert.ok(pins[p], `${p} pinned`);
  // torch's own dependencies come from the PyTorch index too: pinned, with markers where the Python range differs
  for (const p of ['sympy', 'mpmath', 'networkx', 'jinja2', 'markupsafe', 'filelock', 'fsspec', 'typing-extensions', 'setuptools']) assert.ok(pins[p], `${p} pinned`);
  const lines = fs.readFileSync(T.CONSTRAINTS, 'utf8').split('\n').filter(l => /^networkx==/.test(l));
  assert.deepEqual(lines.map(l => l.split(';')[1]?.trim()), ['python_version >= "3.11"', 'python_version < "3.11"'], 'networkx 3.5 and newer need Python 3.11');
  assert.ok(Number(pins.mpmath.split('.')[1]) < 4, 'sympy 1.14 takes mpmath below 1.4');
  assert.ok(Number(pins.setuptools.split('.')[0]) < 82, 'torch 2.11 takes setuptools below 82');
  assert.ok(!logs.some(l => /^Installing faster-whisper .*sympy/.test(l)), 'torch\'s libraries are the extra\'s');
  assert.match(T.GIGAAM_COMMIT, /^[0-9a-f]{40}$/);
  assert.ok(logs.some(l => /PyTorch 2\.\d+\.\d+\+cpu .*built for the CPU only, from https:\/\/download\.pytorch\.org\/whl\/cpu \(no CUDA; about 115 MB to download on Windows/.test(l)));
  assert.ok(logs.some(l => /GigaAM's model \(v3_e2e_rnnt, about 0\.45 GB\) is downloaded .* by the first Russian job/.test(l)));
  assert.ok(!logs.some(l => /^Installing faster-whisper .*torch/.test(l)), 'the base message lists only its own pins');
  const inst = JSON.parse(fs.readFileSync(path.join(is.path, 'installed.json'), 'utf8'));
  assert.deepEqual([inst.gigaam.version, inst.gigaam.commit, inst.gigaam.torch], [T.GIGAAM_VERSION, T.GIGAAM_COMMIT, pins.torch]);
  // a failing step stops the extra with a message
  logs.length = 0;
  assert.equal(T.installTranscribe({ settings, root: HOME, data: DATA, run: fakeRun({ failOn: '--no-deps' }), log, env, withGigaam: true }), 1);
  assert.match(logs.at(-1), /pip could not install GigaAM from .* Russian recordings use Whisper alone until the extra installs/);
  // without the flag the extra is not touched, and installed.json keeps what was there
  runs.length = 0;
  assert.equal(T.installTranscribe({ settings, root: HOME, data: DATA, run: fakeRun(), log, env }), 0);
  assert.ok(!runs.some(r => r.includes('torch')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(is.path, 'installed.json'), 'utf8')).gigaam.commit, T.GIGAAM_COMMIT);
  // both installers pass their arguments on, so --with-gigaam reaches lib/transcribe.mjs
  assert.match(fs.readFileSync(path.join(ROOT, 'deploy', 'modules', 'transcribe.sh'), 'utf8'), /install "\$@"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'deploy', 'modules', 'transcribe.ps1'), 'utf8'), /install @args/);
});

test('doctor: the engines, the GigaAM extra (missing, a GPU build, installed, a too new Python), its model and the glossary', () => {
  const settings = { modules: { transcribe: { enabled: true, path: path.join(tmp, 'doc-giga') } } };
  const base = { root: HOME, data: DATA, has: () => false, statfs: () => ({ bavail: 100, bsize: 1e9 }), systemd: false, settings };
  const ds = T.transcribeSettings(settings, HOME, DATA);
  const site = path.join(ds.path, 'venv', 'lib', 'python3.12', 'site-packages');
  fs.mkdirSync(path.join(site, 'faster_whisper-1.2.1.dist-info'), { recursive: true });
  fs.mkdirSync(path.dirname(T.venvPython(ds)), { recursive: true }); fs.writeFileSync(T.venvPython(ds), '');
  fs.writeFileSync(path.join(ds.path, 'venv', 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.12.3\n');
  const lines = (b = base) => T.transcribeDoctor(b).map(l => `${l.level} ${l.text}${l.fix ? `  -> ${l.fix}` : ''}`).join('\n');
  assert.match(lines(), /^ok transcription engines: ru gigaam\+whisper, other languages whisper$/m);
  assert.match(lines(), /^todo GigaAM extra: not installed, so Russian recordings use Whisper alone .*-> .*transcribe\.(sh|ps1) --with-gigaam$/m);
  assert.match(lines(), /^ok transcription glossary: built before each job .*, plus .*glossary\.txt$/m);
  fs.mkdirSync(path.join(site, 'gigaam-0.2.0.dist-info')); fs.mkdirSync(path.join(site, 'torch-2.11.0+cu126.dist-info'));
  assert.match(lines(), /^warn GigaAM extra: gigaam 0\.2\.0, torch 2\.11\.0\+cu126 \(a GPU build: the installer switches it to the CPU one\)$/m);
  fs.renameSync(path.join(site, 'torch-2.11.0+cu126.dist-info'), path.join(site, 'torch-2.11.0+cpu.dist-info'));
  assert.match(lines(), /^ok GigaAM extra: gigaam 0\.2\.0, torch 2\.11\.0\+cpu$/m);
  assert.match(lines(), /^ok GigaAM model v3_e2e_rnnt: not downloaded yet \(about 0\.45 GB from Sber's model server/m);
  fs.mkdirSync(path.join(ds.path, 'models', 'gigaam'), { recursive: true }); fs.writeFileSync(path.join(ds.path, 'models', 'gigaam', 'v3_e2e_rnnt.ckpt'), Buffer.alloc(3000));
  assert.match(lines(), /^ok GigaAM model v3_e2e_rnnt: downloaded \(0\.0 GB\)$/m);
  fs.writeFileSync(path.join(ds.path, 'venv', 'pyvenv.cfg'), 'version_info = 3.15.0\n');
  assert.match(lines(), /^todo GigaAM extra: needs Python 3\.10 to 3\.14 \(PyTorch has CPU wheels for those\), the module's Python is 3\.15/m);
  // nothing about GigaAM when no language uses it; a wrong setting is a TODO
  const w = lines({ ...base, settings: { modules: { transcribe: { ...settings.modules.transcribe, engines: { ru: 'whisper' }, vad: 'pyannote' } } } });
  assert.ok(!/GigaAM/.test(w));
  assert.match(w, /^todo transcription settings: modules\.transcribe\.vad: "pyannote" is not one of silero  -> /m);
});

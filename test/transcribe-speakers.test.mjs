// Task 21 in the transcription module: speaker separation with a fake diarizer and fake embeddings
// (COMETSCOUT_TRANSCRIBE_CMD, test/fixtures/transcribe/fake-transcriber.mjs.txt): the word to speaker assignment
// (overlap, the midpoint rule), segments and SRT cues broken at speaker changes, "Me" above and below the threshold and
// never twice, the voice sample's cached embedding, renaming (CLI and workspace) rewriting md and srt, overlap marks,
// the transcript's header, the coach hand-off text, the installer extra with a fake pip and fake downloads (sha256
// checked, a wrong hash refused), doctor lines, the bench's synthetic calls and DER on hand-made turns, Russian labels.
// No Python, model or network; synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-speakers-'));
const FAKE = path.join(tmp, 'fake-transcriber.mjs');
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'transcribe', 'fake-transcriber.mjs.txt'), FAKE);
const HOME = path.join(tmp, 'home'), DATA = path.join(HOME, 'data'), MOD = path.join(tmp, 'module'), COACH = path.join(tmp, 'coach'), FAKE_LOG = path.join(tmp, 'fake.log');
fs.mkdirSync(path.join(HOME, 'profile'), { recursive: true }); fs.mkdirSync(COACH, { recursive: true });
Object.assign(process.env, { COMETSCOUT_HOME: HOME, COMETSCOUT_DATA: DATA, COMETSCOUT_SETTINGS: path.join(HOME, 'settings.json'), COMETSCOUT_TRANSCRIBE_CMD: FAKE, FAKE_TRANSCRIBE_LOG: FAKE_LOG });
const SPK = { enabled: true };
const settingsOf = (sp = SPK, extra = {}) => ({ timezone: 'UTC', locale: 'en', modules: { coach: { enabled: true, path: COACH }, transcribe: { enabled: true, path: MOD, threads: 2, engines: { default: 'whisper' }, speakers: sp, ...extra } } });
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify(settingsOf()));

const T = await import('../lib/transcribe.mjs');
const SP = await import('../lib/transcribe-speakers.mjs');
const B = await import('../lib/transcribe-speakers-bench.mjs');
const { translator, LABELS } = await import('../lib/i18n.mjs');
const { coachHandoff } = await import('../lib/coach.mjs');
const { postRenameSpeakers, startServer } = await import('../lib/server.mjs');
const W = await import('../web/lib/transcribe.js');

const quiet = () => {};
const en = translator('en'), ru = translator('ru');
const SAMPLE = path.join(HOME, 'profile', 'my-voice.wav');
const fakeCalls = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const cli = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env: process.env, timeout: 120000 });
/** One synthetic call through transcribeFile: { r, md, srt, j, dir, calls }. sample: the voice sample's text, or null for none. */
async function job(text, { sp = SPK, sample = 'VEC 0.2,0.9,0', t = en, extra = {}, name = 'call.m4a' } = {}) {
  fs.rmSync(FAKE_LOG, { force: true });
  fs.rmSync(path.join(DATA, 'transcripts'), { recursive: true, force: true });
  if (sample == null) fs.rmSync(SAMPLE, { force: true }); else fs.writeFileSync(SAMPLE, sample);
  const settings = settingsOf(sp, extra);
  const s = T.transcribeSettings(settings, HOME, DATA);
  const dir = path.join(tmp, 'in'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name); fs.writeFileSync(f, text);
  const r = await T.transcribeFile(f, { s, settings, root: HOME, data: DATA, log: quiet, t });
  const read = n => fs.readFileSync(path.join(r.dir, n), 'utf8');
  return { r, s, md: r.ok ? read('transcript.md') : '', srt: r.ok ? read('transcript.srt') : '', j: r.ok ? JSON.parse(read('segments.json')) : null, dir: r.dir, calls: fakeCalls() };
}
const turns = (...xs) => xs.map(([start, end, speaker]) => ({ start, end, speaker }));

test('settings: off by default, the documented defaults, every value checked', () => {
  const d = T.transcribeSettings({}, '/srv/home', '/srv/home/data').speakers;
  assert.deepEqual({ ...d, me_sample: null }, { enabled: false, embedding: '3dspeaker', num_speakers: null, min_speakers: 1, max_speakers: 4, threshold: null, me_sample: null, me_sample_setting: 'profile/my-voice.wav', me_threshold: null });
  assert.equal(d.me_sample, path.resolve('/srv/home', 'profile/my-voice.wav'));
  const problems = [];
  const odd = SP.speakerSettings({ embedding: 'pyannote', num_speakers: 0, min_speakers: 5, max_speakers: 3, threshold: 'x', me_threshold: 2 }, { root: '/r', problems });
  assert.deepEqual([odd.embedding, odd.num_speakers, odd.min_speakers, odd.max_speakers, odd.threshold, odd.me_threshold], ['3dspeaker', null, 3, 5, null, null]);
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.match(problems.join('\n'), /embedding: "pyannote" is not one of titanet-small, 3dspeaker/);
  assert.equal(SP.meThreshold({ embedding: '3dspeaker', me_threshold: null }), SP.ME_THRESHOLD['3dspeaker']);
  assert.equal(SP.meThreshold({ embedding: 'titanet-small', me_threshold: 0.7 }), 0.7);
  assert.match(T.transcribeSettings({ modules: { transcribe: { speakers: [] } } }, '/r', '/x').problems.join(), /speakers must be an object/);
});

test('words to speakers: the most overlap; on a boundary the turn holding the midpoint; between turns the nearest', () => {
  const tt = turns([0, 5, 'A'], [5.2, 9, 'B'], [8, 9.5, 'A']);
  assert.equal(SP.speakerFor(1, 1.5, tt), 'A');
  assert.equal(SP.speakerFor(4.6, 5.7, tt), 'B', 'midpoint 5.15 is in no turn (the gap): the larger overlap, B 0.5 against A 0.4');
  assert.equal(SP.speakerFor(4.2, 5.4, tt), 'A', 'across the boundary, the midpoint 4.8 is in A\'s turn although B overlaps too');
  assert.equal(SP.speakerFor(4.9, 6, tt), 'B', 'midpoint 5.45 is in B\'s turn');
  assert.equal(SP.speakerFor(8.2, 8.6, tt), 'A', 'overlapping speech: both hold the midpoint and overlap equally; the earlier key wins without prev');
  assert.equal(SP.speakerFor(8.2, 8.6, tt, 'B'), 'B', '... and the previous word\'s speaker wins a tie');
  assert.equal(SP.speakerFor(9.6, 9.8, tt), 'A', 'after every turn: the nearest');
  assert.equal(SP.speakerFor(5.05, 5.1, turns([0, 5, 'A'], [5.2, 9, 'B'])), 'A', 'in a gap: the nearer turn');
  assert.equal(SP.speakerFor(1, 2, []), null);
  const ws = SP.assignWords([{ text: 'какие', start: 4.6, end: 4.9 }, { text: 'то', start: 5.3, end: 5.5, hy: true }, { text: 'да', start: 6, end: 6.3 }], tt);
  assert.deepEqual(ws.map(w => w.speaker), ['A', 'A', 'B'], 'the second part of a hyphenated word keeps the first part\'s speaker');
});

test('words to speakers: where the midpoint and the most overlap disagree, the midpoint rule decides (as documented)', () => {
  // a short turn of B holds the word's midpoint (5.15) and overlaps it 0.2 s; A overlaps it 0.5 s
  const tt = turns([0, 5, 'A'], [5, 5.2, 'B']);
  assert.equal(SP.speakerFor(4.5, 5.8, tt), 'B', 'the turn holding the midpoint, although A overlaps the word more');
  assert.equal(SP.speakerFor(4.5, 5.8, tt, 'A'), 'B', 'the previous word\'s speaker does not outvote the midpoint');
  // the same with A's speech on both sides of B's short turn: A overlaps 0.7 s in all, B 0.2 s
  assert.equal(SP.speakerFor(4.6, 5.6, turns([0, 5, 'A'], [5.05, 5.25, 'B'], [5.3, 9, 'A'])), 'B');
  assert.deepEqual(SP.splitBySpeaker([{ start: 4.5, end: 5.8, text: 'yes', words: [{ text: 'yes', start: 4.5, end: 5.8 }] }], tt).map(x => x.speaker), ['B']);
  // the README says so
  assert.ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('holding its middle, even when another speaker\'s turn overlaps it more'), 'the README says so');
});

test('segments break where the speaker changes, with their text rebuilt from the words; whole segments keep their text', () => {
  const seg = { start: 0, end: 6, text: 'Is that right? Yes, it is.', words: [{ text: 'Is', start: 0, end: 0.5 }, { text: 'that', start: 0.5, end: 1 }, { text: 'right?', start: 1, end: 2 },
    { text: 'Yes,', start: 3, end: 3.6 }, { text: 'it', start: 3.6, end: 4 }, { text: 'is.', start: 4, end: 5 }] };
  const out = SP.splitBySpeaker([seg, { start: 7, end: 8, text: 'No words here.' }], turns([0, 2.4, 'Speaker 1'], [2.8, 6, 'Me'], [6.5, 9, 'Speaker 1']));
  assert.deepEqual(out.map(x => [x.start, x.end, x.speaker, x.text]), [[0, 2, 'Speaker 1', 'Is that right?'], [3, 5, 'Me', 'Yes, it is.'], [7, 8, 'Speaker 1', 'No words here.']]);
  assert.deepEqual(out[1].words.map(w => w.speaker), ['Me', 'Me', 'Me']);
  const one = SP.splitBySpeaker([{ ...seg, text: 'Original  text.' }], turns([0, 6, 'Me']));
  assert.equal(one[0].text, 'Original  text.', 'one speaker: the engine\'s text stays as it was');
});

test('"Me": the closest speaker above the threshold, nobody below it, never two', () => {
  const embs = { 0: [1, 0, 0], 1: [0, 1, 0], 2: [0.9, 0.1, 0] };
  const a = SP.identifyMe(embs, [1, 0, 0], 0.5);
  assert.equal(a.me, '0'); assert.equal(a.similarity, 1);
  assert.ok(a.sims['2'] > 0.5, 'a second speaker above the threshold is still not "Me"');
  const b = SP.identifyMe(embs, [0, 0, 1], 0.5);
  assert.deepEqual([b.me, b.similarity], [null, 0]);
  assert.equal(SP.identifyMe({}, [1, 0], 0.5).me, null);
  assert.equal(SP.cosine([1, 2], [1, 2, 3]), 0);
  const labels = SP.labelSpeakers(turns([3, 4, 1], [0, 2, 0], [5, 6, 2], [7, 9, 0]), '1', en);
  assert.deepEqual(labels.map(x => [x.key, x.label, x.me, x.seconds]), [['0', 'Speaker 1', false, 4], ['1', 'Me', true, 1], ['2', 'Speaker 3', false, 1]]);
  assert.deepEqual(SP.labelSpeakers(turns([0, 2, 0], [3, 4, 1]), '0', ru).map(x => x.label), ['Я', 'Говорящий 2'], 'Russian labels');
});

test('overlap regions: two speakers at once for more than a second', () => {
  assert.deepEqual(SP.overlapRegions(turns([0, 10, 'A'], [8, 9.6, 'B'], [12, 20, 'B'], [19.5, 22, 'A'])), [{ start: 8, end: 9.6 }]);
  assert.deepEqual(SP.overlapRegions(turns([0, 10, 'A'], [2, 4, 'A'])), [], 'one speaker\'s own turns do not overlap');
});

test('a call with a voice sample: "Me" and "Speaker 2" paragraphs, the header, the marker, SRT prefixes, speakers in segments.json', async () => {
  const { r, md, srt, j, calls, s } = await job('synthetic interview');
  assert.ok(r.ok, r.error);
  assert.deepEqual(calls.map(c => (c.args.includes('--diarize') ? 'diarize' : 'whisper')), ['whisper', 'diarize'], 'diarization once, after the transcription');
  assert.ok(calls[0].args.includes('--words'), 'Whisper gives word times for the assignment');
  const d = calls[1].args, arg = n => d[d.indexOf(`--${n}`) + 1];
  assert.equal(arg('segmentation'), SP.segmentationPath(MOD)); assert.equal(arg('embedding-model'), SP.embeddingPath(MOD, '3dspeaker'));
  assert.equal(arg('cluster-threshold'), '0.9', 'the calibrated clustering threshold for the model');
  assert.deepEqual([arg('min-speakers'), arg('max-speakers')], ['1', '4'], 'by default one voice found stays one speaker');
  assert.deepEqual(JSON.parse(arg('samples')), [SAMPLE], 'the sample is embedded with the same model');
  assert.match(md, /^- Speakers: 2 found \(Speaker 1, Me\); "Me" identified by your voice sample \(similarity 0\.98\); separated in \d+ s$/m);
  assert.match(md, /^<!-- cometscout-speakers: me="Me" -->$/m);
  assert.match(md, /^\*\*Speaker 1:\*\* \[00:00:00\] Hello, thanks for joining the call today\. Could you walk me through your last product launch\?$/m);
  assert.match(md, /^\*\*Me:\*\* \[00:00:13\] Sure\. We shipped a synthetic billing feature in six weeks\.$/m);
  assert.match(md, /^\*\*Speaker 1:\*\* \[01:02:05\] Thank you, that is all from me\.$/m);
  assert.match(srt, /^3\n00:00:13,100 --> 00:00:20,400\nMe: Sure\. We shipped/m);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:04,200\nSpeaker 1: Hello/m);
  assert.equal(j.speakers, 'separated');
  assert.deepEqual(j.segments.map(x => x.speaker), ['Speaker 1', 'Speaker 1', 'Me', 'Speaker 1']);
  assert.ok(j.segments.every(x => x.words.every(w => w.speaker === x.speaker)), 'a speaker on every word');
  assert.deepEqual(j.diarization.speakers.map(x => [x.label, x.me, x.similarity]), [['Speaker 1', false, 0.217], ['Me', true, 0.976]]);
  assert.deepEqual([j.diarization.me.identified, j.diarization.me.threshold, j.diarization.embedding], [true, SP.ME_THRESHOLD['3dspeaker'], '3dspeaker']);
  // the sample's embedding is kept by its hash: the next job does not embed it again
  const hash = crypto.createHash('sha256').update('VEC 0.2,0.9,0').digest('hex');
  assert.deepEqual(JSON.parse(fs.readFileSync(T.meCacheFile(s, hash), 'utf8')).embedding, [0.2, 0.9, 0]);
  const again = await job('synthetic interview');
  assert.ok(!again.calls[1].args.includes('--samples'), 'cached');
  assert.match(again.md, /"Me" identified/);
});

test('below the threshold, without a sample, a split segment, overlapping speech, a failure, the extra missing', async () => {
  const low = await job('synthetic interview', { sp: { enabled: true, me_threshold: 0.99 } });
  assert.match(low.md, /^- Speakers: 2 found \(Speaker 1, Speaker 2\); "Me" not identified \(best similarity 0\.98, under 0\.99\); separated in/m);
  assert.match(low.md, /^<!-- cometscout-speakers: me="" -->$/m);
  assert.ok(!/\*\*Me:\*\*/.test(low.md));
  const none = await job('synthetic interview', { sample: null });
  assert.match(none.md, /; no voice sample at profile\/my-voice\.wav, so no "Me"; /);
  assert.ok(!none.calls[1].args.includes('--samples'));
  const split = await job('synthetic interview SPLIT', { sp: { enabled: true, num_speakers: 2 } });
  assert.ok(split.calls[1].args.includes('--num-speakers') && !split.calls[1].args.includes('--min-speakers'), 'num_speakers fixes the count');
  const two = split.j.segments.filter(x => x.start >= 4.5 && x.end <= 9.8);
  assert.deepEqual(two.map(x => [x.speaker, x.text]), [['Speaker 1', 'Could you walk me'], ['Me', 'through your last product launch?']], 'the segment breaks at the change');
  assert.match(split.srt, /\nSpeaker 1: Could you walk me\n/); assert.match(split.srt, /\nMe: through your last product launch\?\n/);
  const ov = await job('synthetic interview OVERLAP');
  assert.match(ov.md, /^\*\*Speaker 1:\*\* \[00:00:00\] Hello, .* launch\? _\(overlapping speech\)_$/m);
  assert.deepEqual(ov.j.diarization.overlaps, [{ start: 8, end: 9.6 }]);
  const failed = await job('synthetic interview DIARBROKEN');
  assert.ok(failed.r.ok, 'the transcript is still written');
  assert.match(failed.md, /^- Speakers: not separated \(the separation failed: RuntimeError: synthetic separation failure\)$/m);
  assert.equal(failed.j.speakers, 'not separated');
  // the extra missing (no fake transcriber standing in): the transcript says how to install it
  const s = T.transcribeSettings(settingsOf(), HOME, DATA);
  const saved = process.env.COMETSCOUT_TRANSCRIBE_CMD; delete process.env.COMETSCOUT_TRANSCRIBE_CMD;
  try { assert.deepEqual(await T.separateSpeakers(s, 'x.m4a', [], { log: quiet }), { diarization: { status: 'missing' } }); } finally { process.env.COMETSCOUT_TRANSCRIBE_CMD = saved; }
  const md = T.renderMarkdown({ source: 'a.m4a', duration: 1, seconds: 1, segments: [], diarization: { status: 'missing' } }, en);
  assert.match(md, /^- Speakers: not separated \(the speakers extra is not installed: .*transcribe\.(sh|ps1) --with-speakers\)$/m);
  const off = await job('synthetic interview', { sp: { enabled: false } });
  assert.match(off.md, /^- Speakers: not separated$/m); assert.equal(off.calls.length, 1, 'off: no diarization');
});

test('Russian: the merged words get speakers; labels and header in Russian', async () => {
  const { md, j } = await job('RUSSIAN synthetic call', { t: ru, extra: { engines: { ru: 'gigaam+whisper', default: 'whisper' } }, sample: 'VEC 0,1,0' });
  assert.equal(j.engine, 'gigaam+whisper');
  assert.match(md, /^- Говорящие: найдено 2 \(Говорящий 1, Я\); «Я» узнан по образцу голоса \(сходство 1\.00\); разделено за/m);
  assert.match(md, /^\*\*Говорящий 1:\*\* \[00:00:00\] Добрый день\./m);
  assert.match(md, /^\*\*Я:\*\* \[00:00:10\] Я работал/m);
  assert.ok(j.segments.every(x => x.words.every(w => w.speaker === x.speaker && w.source)), 'speaker and source on every merged word');
});

test('renaming: speakers.json, md and srt written again, the coach copy too; refusals; the workspace form', async () => {
  const { dir, md } = await job('synthetic interview', { name: 'Final round.m4a' });
  const coachCopy = path.join(COACH, 'materials', 'transcripts', `${path.basename(dir)}.md`);
  assert.equal(fs.readFileSync(coachCopy, 'utf8'), md);
  const r = cli(['transcribe', '--rename', path.basename(dir), 'Speaker 1=Interviewer']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /written again: Speaker 1 is Interviewer/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'speakers.json'), 'utf8')), { 'Speaker 1': 'Interviewer' });
  const md2 = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8');
  assert.match(md2, /^\*\*Interviewer:\*\* \[00:00:00\] Hello/m); assert.match(md2, /\(Interviewer, Me\)/);
  assert.match(fs.readFileSync(path.join(dir, 'transcript.srt'), 'utf8'), /\nInterviewer: Hello/);
  assert.equal(fs.readFileSync(coachCopy, 'utf8'), md2, 'the coach\'s copy follows');
  // by the name shown now, a second rename; "Me" can get the user's name, and the marker follows it
  assert.equal(T.renameSpeakers(dir, ['Interviewer=Hiring manager', 'Me=Alex Example'], { log: quiet }).ok, true);
  const md3 = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8');
  assert.match(md3, /^\*\*Alex Example:\*\* \[00:00:13\]/m); assert.match(md3, /^<!-- cometscout-speakers: me="Alex Example" -->$/m);
  assert.match(md3, /"Alex Example" identified by your voice sample/);
  // refusals: two speakers never show one name, an unknown label, not label=name
  const bad = T.renameSpeakers(dir, ['Hiring manager=Alex Example', 'Speaker 7=X', 'nonsense'], { log: quiet });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map(e => e.replace(/\(.*\)/, '()')), ['"Alex Example" is already another speaker\'s name', 'no speaker "Speaker 7" in this transcript ()', '"nonsense" is not label=name']);
  assert.equal(cli(['transcribe', '--rename', path.basename(dir)]).status, 1, 'no pairs: usage');
  assert.match(cli(['transcribe', '--rename', 'no-such-folder', 'a=b']).stdout, /No transcript at no-such-folder/);
  // names are cleaned: no Markdown emphasis, one line, 40 characters
  assert.equal(SP.cleanName('  **Bold**\nname_with [link] '), 'Bold name with link');
  // the workspace: the queue lists the speakers, the form posts the changed names, an empty name goes back to the label
  const s = T.transcribeSettings(settingsOf(), HOME, DATA);
  const item = T.queueStatus({ s }).done.find(x => x.dir === path.basename(dir));
  assert.deepEqual(item.speakers, [{ label: 'Speaker 1', name: 'Hiring manager', me: false }, { label: 'Me', name: 'Alex Example', me: true }]);
  assert.deepEqual(W.renames(item.speakers, { 'Speaker 1': 'Hiring manager', Me: ' ' }), { Me: '' });
  assert.deepEqual(W.renames(item.speakers, { 'Speaker 1': 'Recruiter', Me: 'Alex Example' }), { 'Speaker 1': 'Recruiter' });
  const out = postRenameSpeakers({ dir: path.basename(dir), names: { Me: '' } }, s);
  assert.equal(out.ok, true); assert.deepEqual(out.names, { 'Speaker 1': 'Hiring manager' });
  assert.match(fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8'), /^\*\*Me:\*\* \[00:00:13\]/m);
  for (const body of [{ dir: '../x', names: {} }, { dir: path.basename(dir), names: ['a'] }, { dir: path.basename(dir), names: { 'Speaker 9': 'X' } }]) assert.throws(() => postRenameSpeakers(body, s), e => e.status === 400);
  assert.throws(() => postRenameSpeakers({ dir: 'missing', names: {} }, s), e => e.status === 404);
  const srv = await startServer({ port: 0, log: quiet });
  after(() => srv.close());
  const res = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ dir: path.basename(dir), names: { 'Speaker 1': 'Recruiter' } });
    const q = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/transcribe/rename', headers: { Host: `127.0.0.1:${srv.port}`, 'X-CometScout': '1', 'Content-Type': 'application/json' } }, rr => {
      const c = []; rr.on('data', x => c.push(x)); rr.on('end', () => resolve({ status: rr.statusCode, json: JSON.parse(Buffer.concat(c)) }));
    });
    q.on('error', reject); q.end(body);
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status.done.find(x => x.dir === path.basename(dir)).speakers[0].name, 'Recruiter');
});

test('the coach hand-off says which transcripts have speakers and which lines are the candidate\'s', async () => {
  fs.rmSync(path.join(COACH, 'materials'), { recursive: true, force: true });
  await job('synthetic interview', { name: 'Screen call.m4a' });
  const first = fs.readdirSync(path.join(COACH, 'materials', 'transcripts'))[0];
  await job('synthetic interview', { name: 'Panel.m4a', sp: { enabled: true, me_threshold: 0.99 } });
  await job('synthetic interview', { name: 'Old call.m4a', sp: { enabled: false } });
  assert.equal(coachHandoff({ profileDir: path.join(ROOT, 'profile.example'), log: quiet }), 0);
  const text = fs.readFileSync(path.join(COACH, 'materials', 'cometscout-handoff.md'), 'utf8');
  assert.match(text, /Where the speakers are separated, the lines marked as mine are the candidate's answers: score those, and read the other speakers as the interviewers\. Speakers are not separated in the others\./);
  assert.ok(text.includes(`- materials/transcripts/${first} (${first.slice(0, 10)}), speakers separated: the lines marked "Me" are mine, ready for analyze`), text.slice(-900));
  assert.match(text, /panel\.md \(\d{4}-\d\d-\d\d\), speakers separated, but my voice was not identified: ask me which speaker is me, ready for analyze/);
  assert.match(text, /old-call\.md \(\d{4}-\d\d-\d\d\), ready for analyze/);
});

test('the installer extra: sherpa-onnx pinned, the models downloaded with their sha256 checked, a wrong hash refused', async () => {
  const settings = { modules: { transcribe: { path: path.join(tmp, 'inst-mod'), speakers: { embedding: 'titanet-small' } } } };
  const is = T.transcribeSettings(settings, HOME, DATA);
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  const seg = Buffer.from('synthetic segmentation archive'), segModel = Buffer.from('synthetic segmentation model'), emb = Buffer.from('synthetic embedding model');
  const models = { SEGMENTATION: { ...SP.SEGMENTATION, url: 'https://releases.example/seg.tar.bz2', sha256: sha(seg), model_sha256: sha(segModel), bytes: seg.length },
    EMBEDDINGS: { 'titanet-small': { ...SP.EMBEDDINGS['titanet-small'], url: 'https://releases.example/emb.onnx', sha256: sha(emb), bytes: emb.length } } };
  const served = { 'https://releases.example/seg.tar.bz2': seg, 'https://releases.example/emb.onnx': emb };
  const fetches = [];
  const fetchImpl = async url => { fetches.push(url); return served[url] ? new Response(served[url]) : new Response('no', { status: 404 }); };
  const runs = [];
  const run = (cmd, args) => {
    runs.push(args.map(a => (a === T.CONSTRAINTS ? '<c>' : a)).join(' '));
    if (args[0] === '-c' && args[1].includes('tarfile')) { const [, , tar, dest, prefix] = args; assert.ok(fs.existsSync(tar)); fs.mkdirSync(path.join(dest, prefix), { recursive: true }); fs.writeFileSync(path.join(dest, prefix, 'model.onnx'), segModel); return { status: 0 }; }
    return { status: 0 };
  };
  const logs = [];
  assert.equal(await T.installSpeakers(is, { run, log: l => logs.push(l), fetchImpl, models }), 1, 'no venv yet');
  fs.mkdirSync(path.dirname(T.venvPython(is)), { recursive: true }); fs.writeFileSync(T.venvPython(is), '');
  fs.writeFileSync(path.join(is.path, 'venv', 'pyvenv.cfg'), 'version = 3.15.0\n');
  assert.equal(await T.installSpeakers(is, { run, log: l => logs.push(l), fetchImpl, models }), 1);
  assert.match(logs.at(-1), /needs Python 3\.10 to 3\.14/);
  fs.writeFileSync(path.join(is.path, 'venv', 'pyvenv.cfg'), 'version = 3.12.3\n');
  assert.equal(await T.installSpeakers(is, { run, log: l => logs.push(l), fetchImpl, models }), 0, logs.join('\n'));
  assert.deepEqual(runs.filter(x => x.startsWith('-m pip')), ['-m pip install --disable-pip-version-check --no-input -c <c> sherpa-onnx']);
  assert.match(fs.readFileSync(T.CONSTRAINTS, 'utf8'), new RegExp(`^sherpa-onnx==${SP.SHERPA_ONNX_VERSION.replace(/\./g, '\\.')}$`, 'm'));
  assert.deepEqual(fetches, ['https://releases.example/seg.tar.bz2', 'https://releases.example/emb.onnx']);
  assert.ok(!fs.existsSync(path.join(SP.speakerModelsDir(is.path), SP.SEGMENTATION.file)), 'the archive is removed once unpacked');
  assert.deepEqual(fs.readFileSync(SP.embeddingPath(is.path, 'titanet-small')), emb);
  const rec = JSON.parse(fs.readFileSync(path.join(is.path, 'installed.json'), 'utf8')).speakers;
  assert.equal(rec.sherpa_onnx, SP.SHERPA_ONNX_VERSION); assert.equal(rec.embeddings['titanet-small'].sha256, sha(emb));
  // again: nothing downloaded
  fetches.length = 0;
  assert.equal(await T.installSpeakers(is, { run, log: quiet, fetchImpl, models }), 0);
  assert.deepEqual(fetches, []);
  // a wrong hash is refused and nothing is kept
  fs.rmSync(SP.speakerModelsDir(is.path), { recursive: true });
  served['https://releases.example/emb.onnx'] = Buffer.from('tampered');
  logs.length = 0;
  assert.equal(await T.installSpeakers(is, { run, log: l => logs.push(l), fetchImpl, models }), 1);
  assert.match(logs.at(-1), /Could not download https:\/\/releases\.example\/emb\.onnx: sha256 [0-9a-f]{64} is not the pinned/);
  assert.ok(!fs.existsSync(SP.embeddingPath(is.path, 'titanet-small')) && !fs.existsSync(`${SP.embeddingPath(is.path, 'titanet-small')}.part`));
  // a failing pip stops before any download
  fetches.length = 0;
  assert.equal(await T.installSpeakers(is, { run: () => ({ status: 1 }), log: quiet, fetchImpl, models }), 1);
  assert.deepEqual(fetches, []);
  // both installers pass --with-speakers on; the pinned files are real k2-fsa release URLs with a sha256 each
  assert.match(fs.readFileSync(path.join(ROOT, 'deploy', 'modules', 'transcribe.sh'), 'utf8'), /--with-speakers/);
  assert.match(fs.readFileSync(path.join(ROOT, 'deploy', 'modules', 'transcribe.ps1'), 'utf8'), /--with-speakers/);
  for (const m of [SP.SEGMENTATION, ...Object.values(SP.EMBEDDINGS)]) { assert.match(m.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//); assert.match(m.sha256, /^[0-9a-f]{64}$/); assert.ok(m.licence); }
});

test('doctor: off, the extra, the models and their sha256, the voice sample and its length', () => {
  const settings = { modules: { transcribe: { enabled: true, path: path.join(tmp, 'doc-mod'), speakers: { enabled: true, me_sample: 'profile/doc-voice.wav' } } } };
  const ds = T.transcribeSettings(settings, HOME, DATA);
  const lines = () => T.speakersDoctor(ds, true).map(l => `${l.level} ${l.text}${l.fix ? `  -> ${l.fix}` : ''}`).join('\n');
  assert.match(T.speakersDoctor(T.transcribeSettings({ modules: { transcribe: { enabled: true } } }, HOME, DATA))[0].text, /^speaker separation: off \(optional: .* --with-speakers/);
  assert.match(lines(), /^todo speakers extra: not installed, so transcripts have no speakers {2}-> .*--with-speakers$/m);
  assert.match(lines(), /^todo speaker segmentation model \(pyannote-segmentation-3-0\): not downloaded/m);
  assert.match(lines(), /^todo voice sample: none at .*doc-voice\.wav, so speakers stay numbered/m);
  const site = path.join(ds.path, 'venv', 'lib', 'python3.12', 'site-packages');
  fs.mkdirSync(path.join(site, `sherpa_onnx-${SP.SHERPA_ONNX_VERSION}.dist-info`), { recursive: true });
  fs.mkdirSync(path.dirname(SP.segmentationPath(ds.path)), { recursive: true });
  fs.writeFileSync(SP.segmentationPath(ds.path), 'not the model');
  // a WAV of 8 s, then of 25 s
  fs.writeFileSync(ds.speakers.me_sample, B.writeWav(new Float32Array(8 * 16000)));
  let l = lines();
  assert.match(l, new RegExp(`^ok speakers extra: sherpa-onnx ${SP.SHERPA_ONNX_VERSION.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(l, /^todo speaker segmentation model \(pyannote-segmentation-3-0\): .* has sha256 [0-9a-f]{12}\.\.\., not the pinned 220ad67ca923\.\.\. {2}-> delete it/m);
  assert.match(l, /^todo voice sample: .*doc-voice\.wav \(8 s, under 20 s\)/m);
  fs.writeFileSync(ds.speakers.me_sample, B.writeWav(new Float32Array(25 * 16000)));
  assert.equal(SP.wavSeconds(ds.speakers.me_sample), 25);
  assert.match(lines(), /^ok voice sample: .*doc-voice\.wav \(25 s\)$/m);
  assert.match(lines(), /^ok speakers: 1 to 4 \(clustering threshold 0\.9\), "Me" at similarity 0\.6 or more \(calibrated for 3dspeaker\)$/m);
  fs.writeFileSync(ds.speakers.me_sample, 'VEC 1,0,0');
  assert.match(lines(), /^ok voice sample: .* \(not a WAV file, so its length was not checked/m);
  // through transcribeDoctor too
  assert.ok(T.transcribeDoctor({ settings, root: HOME, data: DATA, has: () => false, statfs: () => ({ bavail: 100, bsize: 1e9 }), systemd: false }).some(x => /^voice sample:/.test(x.text)));
});

test('bench: WAV round trip, silence trimmed, the synthetic call plan and its mix, DER on hand-made turns', () => {
  const tone = (sec, amp = 0.5) => Float32Array.from({ length: sec * 16000 }, (_, i) => amp * Math.sin(i / 5));
  const w = B.readWav(B.writeWav(tone(1)));
  assert.equal(w.rate, 16000); assert.equal(w.samples.length, 16000); assert.ok(Math.abs(w.samples[100] - 0.5 * Math.sin(20)) < 1e-4);
  const padded = new Float32Array(3 * 16000); padded.set(tone(1), 16000);
  const trimmed = B.trimSilence(padded);
  assert.ok(trimmed.length > 16000 && trimmed.length < 1.2 * 16000, `trimmed to about 1 s (${trimmed.length})`);
  // the plan: alternating speakers, turns of 3 to 20 s (longer utterances cut), pauses, an overlap, utterances used once
  const pools = { a: [{ id: 'a1', seconds: 5 }, { id: 'a2', seconds: 2 }, { id: 'a3', seconds: 30 }], b: [{ id: 'b1', seconds: 4 }, { id: 'b2', seconds: 6 }] };
  const plan = B.buildMixPlan(pools, 'a', 'b', { random: B.rng(7), turns: 6, overlapRate: 0 });
  assert.deepEqual(plan.items.map(x => [x.id, x.speaker, x.seconds]), [['a1', 'a', 5], ['b1', 'b', 4], ['a3', 'a', 20], ['b2', 'b', 6]], 'the 2 s utterance is skipped, the 30 s one cut to 20 s, it stops when a speaker runs out');
  for (let k = 1; k < plan.items.length; k++) { const gap = plan.items[k].at - (plan.items[k - 1].at + plan.items[k - 1].seconds); assert.ok(gap >= 0.2 - 1e-9 && gap <= 1 + 1e-9, `pause ${gap}`); }
  const ov = B.buildMixPlan(pools, 'a', 'b', { random: B.rng(7), turns: 4, overlapRate: 1, overlap: [1, 1] });
  assert.equal(ov.items[1].at, 4, 'the second turn starts 1 s before the first ends');
  const mix = B.renderMix({ items: [{ id: 'x', at: 0, seconds: 1 }, { id: 'y', at: 0.5, seconds: 1 }], duration: 1.5 }, () => Float32Array.from({ length: 16000 }, () => 0.6));
  assert.equal(mix.length, 24001); assert.equal(mix[100], Math.fround(0.6)); assert.equal(mix[12000], 1, 'overlap added and clipped');
  assert.equal(B.joinSample([new Float32Array(16000), new Float32Array(16000)]).length, 2 * 16000 + 4800);
  // DER: a perfect answer, a missed turn, a false alarm, a confusion; the collar and the speaker mapping
  const ref = turns([0, 10, 'A'], [10, 20, 'B']);
  assert.equal(B.der(ref, turns([0, 10, 0], [10, 20, 1])).der, 0);
  const swapped = B.der(ref, turns([0, 10, 'x'], [10, 20, 'y']));
  assert.deepEqual([swapped.der, swapped.mapping], [0, { x: 'A', y: 'B' }], 'labels are mapped, not compared');
  const miss = B.der(ref, turns([0, 10, 0]));
  assert.ok(Math.abs(miss.miss - 9.5) < 0.02 && miss.fa === 0, JSON.stringify(miss));
  const fa = B.der(turns([0, 10, 'A']), turns([0, 10, 0], [12, 14, 1]));
  assert.ok(Math.abs(fa.fa - 2) < 0.02 && Math.abs(fa.der - 2 / 9.5) < 0.01, JSON.stringify(fa));
  const conf = B.der(ref, turns([0, 15, 0], [15, 20, 1]));
  assert.ok(Math.abs(conf.confusion - 4.75) < 0.02, JSON.stringify(conf));
  const shifted = B.der(ref, turns([0, 10.2, 0], [10.2, 20, 1]));
  assert.equal(shifted.der, 0, 'a boundary 0.2 s off is inside the 0.25 s collar');
  const overlap = B.der(turns([0, 10, 'A'], [8, 12, 'B']), turns([0, 12, 0]));
  assert.ok(Math.abs(overlap.total - 12) < 0.05 && Math.abs(overlap.miss - 1.5) < 0.02 && Math.abs(overlap.confusion - 1.5) < 0.02, 'overlapping reference speech counts twice; one speaker found misses the other');
  assert.equal(B.suggestThreshold([0.7, 0.8], [0.2, 0.4]), 0.55);
  assert.equal(B.suggestThreshold([0.3, 0.8], [0.4]), 0.8);
  assert.equal(B.suggestThreshold([], [0.1]), null);
});

test('bench: the calls, "Me" found and a stranger refused, the report; the CLI with a fake datasets server', async () => {
  // utterances: four speakers, each a synthetic tone of its own pitch (a stand-in for read speech)
  const dir = path.join(tmp, 'utts'); fs.mkdirSync(dir, { recursive: true });
  const utterances = {};
  for (const [k, sp] of ['s1', 's2', 's3', 's4'].entries()) {
    utterances[sp] = Array.from({ length: 7 }, (_, i) => { const f = path.join(dir, `${sp}-${i}.wav`); fs.writeFileSync(f, B.writeWav(Float32Array.from({ length: (4 + i) * 16000 }, (_, n) => 0.3 * Math.sin(n / (3 + k))))); return { id: `${sp}-${i}`, file: f }; });
  }
  // a fake diarizer that knows the answer: the reference turns of the call it is given, embeddings by speaker
  const plans = new Map();
  const runDiarize = async (audio, { samples, embedding }) => {
    const p = plans.get(audio);
    const keys = [...new Set(p.turns.map(x => x.speaker))];
    const vec = sp => ['s1', 's2', 's3', 's4'].map(x => (x === sp ? 1 : 0.1));
    return { ok: true, json: { duration: p.duration, cpu_seconds: p.duration / 10, turns: p.turns.map(x => ({ ...x, speaker: keys.indexOf(x.speaker) })),
      speakers: Object.fromEntries(keys.map((k, i) => [String(i), { embedding: vec(k) }])), samples: samples.map(f => ({ embedding: vec(path.basename(f).includes('absent') ? p.absent : p.a) })), embedding } };
  };
  const rows = await B.benchSpeakers({ lang: 'en', embeddings: ['titanet-small'], utterances, workDir: path.join(tmp, 'calls'), mixes: 3, log: quiet,
    runDiarize, onPlan: (audio, plan, a, absent) => plans.set(audio, { ...plan, a, absent }) });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.mixes, r.der, r.found, r.falseMe, r.twoFound], [3, 0, 3, 0, 3], JSON.stringify(r));
  assert.ok(r.cpu_per_hour === 360, 'CPU per audio hour from cpu_seconds / duration');
  const text = B.speakersReport(rows, { lang: 'en', dataset: B.DATASETS.en.name, threads: 2, cpu: 'synthetic CPU' });
  assert.match(text, /^Speaker bench \(en\): 3 synthetic two-speaker calls, .* from LibriSpeech test-clean \(CC BY 4\.0\), 2 thread\(s\), CPU synthetic CPU/);
  assert.match(text, /^titanet-small +0\.0% +0\.0% +0\.0% +0\.0% +3\/3 +3\/3 +0\/3 +1\.00 +0\.21 +6 min/m);
  assert.match(B.speakersReport([{ embedding: '3dspeaker', error: 'boom' }], { lang: 'ru', dataset: 'x', threads: 1, cpu: 'c' }), /^3dspeaker +failed: boom/m);
  await assert.rejects(B.benchSpeakers({ lang: 'en', embeddings: ['titanet-small'], utterances: { s1: utterances.s1 }, workDir: tmp, runDiarize }), /needs 3 speakers/);

  // the CLI end to end: a fake datasets server, the fake converter and diarizer; nothing outside the module folder
  const wav = sp => B.writeWav(Float32Array.from({ length: 6 * 16000 }, (_, n) => 0.3 * Math.sin(n / (3 + Number(sp)))));
  const rowsFor = offset => ({ rows: [1, 2, 3, 4].flatMap(sp => Array.from({ length: 3 }, (_, i) => ({ row: { speaker_id: sp, id: `${sp}-${offset}-${i}`, audio: [{ src: `https://data.example/${sp}.wav`, type: 'audio/wav' }] } }))) });
  const fetched = [];
  const fetchImpl = async url => { fetched.push(url); const u = new URL(url); return u.hostname === 'datasets-server.huggingface.co' ? new Response(JSON.stringify(rowsFor(u.searchParams.get('offset')))) : new Response(wav(u.pathname.match(/(\d)\.wav/)[1])); };
  const logs = [];
  const s = T.transcribeSettings(settingsOf(), HOME, DATA);
  const code = await T.transcribeCommand(['--bench-speakers', '--lang', 'en', '--embeddings', 'titanet-small', '--mixes', '2'], { s, log: l => logs.push(l), fetchImpl });
  assert.equal(code, 0, logs.join('\n'));
  assert.ok(fetched[0].startsWith('https://datasets-server.huggingface.co/rows?dataset=openslr%2Flibrispeech_asr&config=clean&split=test&offset=0&length=40'), fetched[0]);
  assert.match(logs.join('\n'), /Speaker bench \(en\): 2 synthetic two-speaker calls/);
  assert.ok(fs.existsSync(path.join(MOD, 'bench-speakers', 'en', 'manifest.json')), 'downloads stay in the module folder');
  const calls = fakeCalls().filter(c => c.args.includes('--convert'));
  assert.ok(calls.length >= 1, 'converted with transcribe.py --convert');
  assert.equal(await T.transcribeCommand(['--bench-speakers', '--embeddings', 'pyannote'], { s, log: quiet }), 1);
  assert.equal(await T.transcribeCommand(['--bench-speakers', '--lang', 'de'], { s, log: quiet }), 1);
});

test('the diarizer command: the models, the count or its range, the threshold, the samples; the Python script has the modes', () => {
  const s = T.transcribeSettings(settingsOf({ enabled: true, threshold: 0.6, num_speakers: 3, embedding: '3dspeaker' }), HOME, DATA);
  const [cmd, args] = T.diarizerCommand(s, { audio: 'a.wav', out: 'o.json', env: {}, samples: ['v.wav'] });
  assert.equal(cmd, T.venvPython(s));
  assert.deepEqual(args.slice(1), ['--diarize', '--out', 'o.json', '--segmentation', SP.segmentationPath(MOD), '--embedding-model', SP.embeddingPath(MOD, '3dspeaker'), '--threads', '2',
    '--num-speakers', '3', '--cluster-threshold', '0.6', '--samples', '["v.wav"]', 'a.wav']);
  const py = fs.readFileSync(T.SCRIPT, 'utf8');
  for (const x of ['--diarize', '--samples', '--convert', 'OfflineSpeakerDiarization', 'SpeakerEmbeddingExtractor', 'set_config']) assert.ok(py.includes(x), x);
  const p3 = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', T.SCRIPT], { encoding: 'utf8' });
  if (!p3.error && p3.status !== null) assert.equal(p3.status, 0, p3.stderr);
});

test('a rename to "Me" (in either locale) makes that speaker the user: the marker, segments.json, the workspace, the coach hand-off', async () => {
  fs.rmSync(path.join(COACH, 'materials'), { recursive: true, force: true });
  // the voice sample does not match (threshold 0.99): Speaker 1 and Speaker 2, nobody is "Me"
  const { dir } = await job('synthetic interview', { name: 'Named me.m4a', sp: { enabled: true, me_threshold: 0.99 } });
  const read = n => fs.readFileSync(path.join(dir, n), 'utf8');
  const meOf = () => JSON.parse(read('segments.json')).diarization.speakers.map(x => [x.label, x.me]);
  const r = T.renameSpeakers(dir, ['Speaker 2=Me'], { log: quiet });
  assert.equal(r.ok, true, r.errors.join());
  assert.match(read('transcript.md'), /^<!-- cometscout-speakers: me="Me" -->$/m);
  assert.match(read('transcript.md'), /^\*\*Me:\*\* \[00:00:13\] Sure\./m);
  assert.match(read('transcript.md'), /^- Speakers: 2 found \(Speaker 1, Me\); "Me" set by a rename; separated in/m);
  assert.deepEqual(meOf(), [['Speaker 1', false], ['Speaker 2', true]]);
  assert.equal(JSON.parse(read('segments.json')).diarization.me.named, 'Speaker 2');
  const s = T.transcribeSettings(settingsOf(), HOME, DATA);
  assert.deepEqual(T.queueStatus({ s }).done.find(x => x.dir === path.basename(dir)).speakers.map(x => [x.label, x.me]), [['Speaker 1', false], ['Speaker 2', true]]);
  // the coach's copy follows, and the hand-off says which lines are the candidate's
  assert.equal(coachHandoff({ profileDir: path.join(ROOT, 'profile.example'), log: quiet }), 0);
  assert.match(fs.readFileSync(path.join(COACH, 'materials', 'cometscout-handoff.md'), 'utf8'), /named-me\.md \(\d{4}-\d\d-\d\d\), speakers separated: the lines marked "Me" are mine, ready for analyze/);
  // never two "Me": not in another case, not in the other locale
  for (const n of ['Me', 'me', 'ME', 'Я', 'я']) {
    const bad = T.renameSpeakers(dir, [`Speaker 1=${n}`], { log: quiet });
    assert.equal(bad.ok, false, n); assert.match(bad.errors[0], /is already another speaker's name/);
  }
  assert.deepEqual(meOf(), [['Speaker 1', false], ['Speaker 2', true]], 'a refused rename changes nothing');
  // back to the label: nobody is "Me" again
  assert.equal(T.renameSpeakers(dir, ['Me='], { log: quiet }).ok, true);
  assert.match(read('transcript.md'), /^<!-- cometscout-speakers: me="" -->$/m);
  assert.deepEqual(meOf(), [['Speaker 1', false], ['Speaker 2', false]]);
  assert.equal(JSON.parse(read('segments.json')).diarization.me.named, null);
  // the Russian "Я" counts on an English transcript too
  assert.equal(T.renameSpeakers(dir, ['Speaker 1=я'], { log: quiet }).ok, true);
  assert.match(read('transcript.md'), /^<!-- cometscout-speakers: me="я" -->$/m);
  assert.deepEqual(meOf(), [['Speaker 1', true], ['Speaker 2', false]]);
  // the label tables and the list of "Me" names agree
  assert.deepEqual([...new Set(Object.values(LABELS).map(l => l['sp.me']))].sort(), [...SP.ME_NAMES].sort());
});

test('never two "Me" across locales: "Me" is refused next to "Я" and "Я" next to "Me", in any case', async () => {
  const ruJob = await job('RUSSIAN synthetic call', { t: ru, extra: { engines: { ru: 'gigaam+whisper', default: 'whisper' } }, sample: 'VEC 0,1,0' });
  assert.deepEqual(ruJob.j.diarization.speakers.map(x => x.label), ['Говорящий 1', 'Я']);
  for (const n of ['Me', 'me', 'ME', 'я']) assert.equal(T.renameSpeakers(ruJob.dir, [`Говорящий 1=${n}`], { log: quiet, t: ru }).ok, false, n);
  const ok = T.renameSpeakers(ruJob.dir, ['Me=Алекс'], { log: quiet, t: ru });
  assert.equal(ok.ok, true, 'the user\'s "Me" finds the Russian "Я"'); assert.deepEqual(ok.names, { 'Я': 'Алекс' });
  const enJob = await job('synthetic interview');
  for (const n of ['Я', 'я', 'mE']) assert.equal(T.renameSpeakers(enJob.dir, [`Speaker 1=${n}`], { log: quiet }).ok, false, n);
  // the pure rule
  assert.deepEqual(SP.applyRenames([{ label: 'Speaker 1' }, { label: 'Speaker 2' }], { 'Speaker 2': 'Я' }, ['Speaker 1=ME']).errors, ['"ME" is already another speaker\'s name']);
  assert.deepEqual([SP.isMeName(' me '), SP.isMeName('Я'), SP.isMeName('Mei'), SP.isMeName('')], [true, true, false, false]);
});

test('Whisper gives word times only when the speakers are on and their extra is installed', async () => {
  const f = path.join(tmp, 'in', 'words.m4a'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'synthetic interview');
  const words = async (sp, ready) => {
    fs.rmSync(FAKE_LOG, { force: true });
    const settings = settingsOf(sp), s = T.transcribeSettings(settings, HOME, DATA);
    await T.runEngines(s, f, { settings, root: HOME, data: DATA, log: quiet, speakersReady: () => ready });
    const calls = fakeCalls();
    assert.ok(calls.length >= 1);
    return calls.some(c => c.args.includes('--words'));
  };
  assert.equal(await words({ enabled: true }, true), true, 'on and installed');
  assert.equal(await words({ enabled: true }, false), false, 'on, but the extra is missing: no word times to pay for');
  assert.equal(await words({ enabled: false }, true), false, 'off');
});

test('min_speakers 1 by default; one voice found is never clustered up to two; num_speakers stays exact', t => {
  assert.equal(T.transcribeSettings({}, HOME, DATA).speakers.min_speakers, 1);
  const py = fs.readFileSync(T.SCRIPT, 'utf8');
  assert.match(py, /add_argument\("--min-speakers", type=int, default=1\)/);
  const s = T.transcribeSettings(settingsOf({ enabled: true, num_speakers: 2 }), HOME, DATA);
  const [, args] = T.diarizerCommand(s, { audio: 'a.wav', out: 'o.json', env: {} });
  assert.deepEqual(args.slice(args.indexOf('--num-speakers'), args.indexOf('--num-speakers') + 2), ['--num-speakers', '2']);
  assert.ok(!args.includes('--min-speakers'), 'an exact count, not a range');
  const PY = ['python3', 'python'].find(p => { const r = spawnSync(p, ['--version'], { encoding: 'utf8' }); return r.status === 0 && /Python 3/.test(r.stdout + r.stderr); });
  if (!PY) return t.skip('no python3 here');
  const r = spawnSync(PY, ['-c', 'import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location("t", sys.argv[1]); t = importlib.util.module_from_spec(spec); spec.loader.exec_module(t)\n' +
    'f = t.recluster_target\nprint(json.dumps([f(1, 0, 2, 4), f(1, 0, 1, 4), f(0, 0, 2, 4), f(2, 0, 3, 4), f(6, 0, 1, 4), f(3, 0, 1, 4), f(1, 2, 2, 4), f(5, 2, 1, 4), [t.MIN_DURATION_ON_S, t.MIN_DURATION_OFF_S]]))', T.SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [null, null, null, 3, 4, null, null, null, [0.3, B.MIN_OFF_S]],
    'one found stays one even with min_speakers 2; two found go up to min_speakers; more than max come down; an exact count is never redone');
});

test('bench: the reference is the speech inside each utterance, split at pauses longer than the diarizer bridges', () => {
  const r = B.RATE, tone = sec => Float32Array.from({ length: Math.round(sec * r) }, (_, i) => 0.5 * Math.sin(i / 5));
  const withPause = (a, gap, b) => { const out = new Float32Array(Math.round((a + gap + b) * r)); out.set(tone(a), 0); out.set(tone(b), Math.round((a + gap) * r)); return out; };
  assert.deepEqual(B.speechSpans(withPause(2, 1, 2)), [[0, 2], [3, 5]], 'a 1 s pause splits the utterance');
  assert.deepEqual(B.speechSpans(withPause(2, 0.3, 2)), [[0, 4.3]], 'a 0.3 s pause is bridged, like the diarizer does');
  assert.deepEqual(B.speechSpans(new Float32Array(r)), [], 'silence: no speech');
  // the plan's reference turns follow the spans, cut where the turn is cut
  const pools = { a: [{ id: 'a1', seconds: 5, spans: [[0, 2], [3, 5]] }, { id: 'a2', seconds: 30, spans: [[0, 18], [19, 30]] }], b: [{ id: 'b1', seconds: 4 }] };
  const plan = B.buildMixPlan(pools, 'a', 'b', { random: B.rng(3), turns: 3, overlapRate: 0 });
  const [x1, x2, x3] = plan.items;
  const rel = (t, x) => [Math.round((t.start - x.at) * 100) / 100, Math.round((t.end - x.at) * 100) / 100];
  const aTurns = plan.turns.filter(t => t.speaker === 'a');
  assert.deepEqual([...aTurns.slice(0, 2).map(t => rel(t, x1)), ...aTurns.slice(2).map(t => rel(t, x3))], [[0, 2], [3, 5], [0, 18], [19, 20]]);
  assert.deepEqual(plan.turns.filter(t => t.speaker === 'b').map(t => rel(t, x2)), [[0, 4]], 'no spans: the whole utterance');
  assert.ok(plan.items.every(x => !('spans' in x)));
  // the gate splits at the diarizer's own min_duration_off
  assert.match(fs.readFileSync(T.SCRIPT, 'utf8'), new RegExp(`MIN_DURATION_OFF_S = 0\\.3, ${String(B.MIN_OFF_S).replace('.', '\\.')}`));
});

test('bench: a call\'s reference leaves out the pauses inside its utterances', async () => {
  const dir = path.join(tmp, 'utts-pauses'); fs.mkdirSync(dir, { recursive: true });
  const utterances = {};
  for (const [k, sp] of ['p1', 'p2', 'p3'].entries()) {
    utterances[sp] = Array.from({ length: 6 }, (_, i) => {
      const f = path.join(dir, `${sp}-${i}.wav`), n = 16000, out = new Float32Array((4 + i) * n);
      for (let j = 0; j < out.length; j++) out[j] = j >= 2 * n && j < 3 * n ? 0 : 0.3 * Math.sin(j / (3 + k));   // a 1 s pause after 2 s
      fs.writeFileSync(f, B.writeWav(out)); return { id: `${sp}-${i}`, file: f };
    });
  }
  const plans = [];
  const runDiarize = async (audio, { samples }) => { const p = plans.at(-1); return { ok: true, json: { duration: p.duration, turns: p.turns, speakers: {}, samples: samples.map(() => ({})) } }; };
  await B.benchSpeakers({ lang: 'en', embeddings: ['3dspeaker'], utterances, workDir: path.join(tmp, 'calls-pauses'), mixes: 1, log: quiet,
    runDiarize, onPlan: (audio, plan) => plans.push(plan) });
  const p = plans[0];
  assert.ok(p.turns.length >= 2 * p.items.length, `two reference turns per utterance (${p.turns.length} for ${p.items.length})`);
  const speech = p.turns.reduce((a, t) => a + t.end - t.start, 0), whole = p.items.reduce((a, x) => a + x.seconds, 0);
  assert.ok(Math.abs(whole - speech - p.items.length) < 0.2 * p.items.length, `about 1 s less per utterance (${whole} s of turns, ${speech} s of speech)`);
});

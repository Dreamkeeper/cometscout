// Speaker separation for the transcription module (optional, off by default): who said what, and which speaker is the
// user. Pure Node except the downloads: the diarization itself runs in the module's Python venv (transcribe.py
// --diarize, sherpa-onnx with a converted pyannote segmentation model and a speaker-embedding model, both from k2-fsa's
// GitHub releases, no account). This file holds the settings, the pinned models and their download and check, the word
// to speaker assignment, the "Me" match, the labels and names, and the overlap marks. lib/transcribe.mjs wires it in.
// settings.modules.transcribe.speakers = { enabled: false, embedding: "3dspeaker", num_speakers: null, min_speakers: 1,
//   max_speakers: 4, threshold: null, me_sample: "profile/my-voice.wav", me_threshold: null }
//   num_speakers: an exact count (2 for a one-to-one call). Without it the clustering finds the count: more than
//   max_speakers is clustered again down to max_speakers; fewer than min_speakers is clustered again up to min_speakers
//   only when two or more voices were found (one voice found stays one speaker, so a solo voice memo is never split).
//   threshold: the clustering threshold (null: CLUSTER_THRESHOLD; lower finds more speakers).
//   me_sample: 20 to 60 s of the user speaking alone (any format the transcriber reads; relative to the home).
//   me_threshold: how similar a speaker must be to the sample to be labelled "Me" (null: ME_THRESHOLD for the model).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// sherpa-onnx 1.13.8 (2026-09-10, Apache-2.0): wheels for CPython 3.10 to 3.14 on Linux x86_64 and aarch64 (manylinux2014)
// and Windows x64, and sherpa-onnx-core the same (py3-none, it carries its own onnxruntime): no markers needed.
export const SHERPA_ONNX_VERSION = '1.13.8';
export const SPEAKERS_PYTHON = [[3, 10], [3, 14]];
const REL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
// Each file with its pinned URL and sha256 (checked 2026-10-07 against the release's checksum.txt where it has one).
export const SEGMENTATION = {
  id: 'pyannote-segmentation-3-0', file: 'sherpa-onnx-pyannote-segmentation-3-0.tar.bz2', bytes: 6958444,
  url: `${REL}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
  sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
  // what is kept from the archive, with its own sha256 (doctor checks it)
  dir: 'sherpa-onnx-pyannote-segmentation-3-0', model: 'model.onnx', model_sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
  keep: ['model.onnx', 'LICENSE'], licence: 'MIT (pyannote segmentation-3.0, converted to ONNX by k2-fsa)',
};
export const EMBEDDINGS = {
  'titanet-small': {
    file: 'nemo_en_titanet_small.onnx', bytes: 40257283, url: `${REL}/speaker-recongition-models/nemo_en_titanet_small.onnx`,
    sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e', licence: 'CC-BY-4.0 (NVIDIA NeMo TitaNet-small)',
  },
  '3dspeaker': {
    file: '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx', bytes: 28281164, url: `${REL}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
    sha256: 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2', licence: 'Apache-2.0 (3D-Speaker CAM++, Chinese and English)',
  },
};
// 3D-Speaker CAM++ beat TitaNet-small on every number of the 2026-10-07 bench (16 calls per language): DER 3.7% against
// 4.3% in English and 19.2% against 21.0% in Russian, less confusion, and a wider gap between the true "Me" and a stranger.
export const DEFAULT_EMBEDDING = '3dspeaker';
// The "Me" threshold per embedding model (cosine similarity of a speaker's turns to the voice sample), calibrated on the
// bench (node cli.mjs transcribe --bench-speakers, 2026-10-07, 16 calls per language in English and Russian): the middle
// between the lowest true match and the highest stranger over both languages (titanet-small 0.69 and 0.46, 3dspeaker
// 0.76 and 0.42).
export const ME_THRESHOLD = { 'titanet-small': 0.58, '3dspeaker': 0.6 };
// The clustering threshold per embedding model when the setting is null, from the bench (sherpa-onnx's own default, 0.5,
// split one voice into two or three speakers in most of the bench's two-speaker calls).
export const CLUSTER_THRESHOLD = { 'titanet-small': 0.7, '3dspeaker': 0.9 };
/** The clustering threshold in force: the setting, else the one for the model. */
export const clusterThreshold = sp => sp.threshold ?? CLUSTER_THRESHOLD[sp.embedding] ?? 0.7;
export const OVERLAP_MARK_S = 1;     // a line is marked where two speakers overlap for longer than this
export const ME_SAMPLE_MIN_S = 20;   // doctor: a shorter sample is flagged
export const SPEAKERS_DIR = 'speakers';   // models/speakers in the module folder; the "Me" cache in <module>/speakers
export const NAMES_FILE = 'speakers.json';
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** settings.modules.transcribe.speakers with defaults; problems are pushed to `problems`. root resolves me_sample. */
export function speakerSettings(c, { root = '.', problems = [] } = {}) {
  if (c != null && (typeof c !== 'object' || Array.isArray(c))) { problems.push('modules.transcribe.speakers must be an object such as { "enabled": true }'); c = {}; }
  c = c || {};
  const emb = str(c.embedding)?.toLowerCase() || DEFAULT_EMBEDDING;
  if (!EMBEDDINGS[emb]) problems.push(`modules.transcribe.speakers.embedding: "${c.embedding}" is not one of ${Object.keys(EMBEDDINGS).join(', ')}`);
  const count = (k, def, min, max) => {
    const v = c[k];
    if (v == null) return def;
    if (!(Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max)) { problems.push(`modules.transcribe.speakers.${k}: ${JSON.stringify(v)} is not a whole number from ${min} to ${max}`); return def; }
    return Number(v);
  };
  const frac = (k, min, max) => {
    const v = c[k];
    if (v == null) return null;
    if (!(Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max)) { problems.push(`modules.transcribe.speakers.${k}: ${JSON.stringify(v)} is not a number from ${min} to ${max}`); return null; }
    return Number(v);
  };
  let min = count('min_speakers', 1, 1, 20), max = count('max_speakers', 4, 1, 20);
  if (min > max) { problems.push(`modules.transcribe.speakers: min_speakers (${min}) is above max_speakers (${max})`); [min, max] = [Math.min(min, max), Math.max(min, max)]; }
  const sample = str(c.me_sample) || 'profile/my-voice.wav';
  return {
    enabled: c.enabled === true,
    embedding: EMBEDDINGS[emb] ? emb : DEFAULT_EMBEDDING,
    num_speakers: count('num_speakers', null, 1, 20),
    min_speakers: min, max_speakers: max,
    threshold: frac('threshold', 0.01, 2),
    me_sample: path.resolve(root, sample),
    me_sample_setting: sample,
    me_threshold: frac('me_threshold', 0, 1),
  };
}
/** The "Me" threshold in force: the setting, else the calibrated one for the model. */
export const meThreshold = sp => sp.me_threshold ?? ME_THRESHOLD[sp.embedding] ?? 0.5;

// ---------- models: where they live, download, check ----------
export const speakerModelsDir = modulePath => path.join(modulePath, 'models', SPEAKERS_DIR);
export const segmentationPath = modulePath => path.join(speakerModelsDir(modulePath), SEGMENTATION.dir, SEGMENTATION.model);
export const embeddingPath = (modulePath, emb) => path.join(speakerModelsDir(modulePath), EMBEDDINGS[emb].file);

/** sha256 of a file (hex), or null when it cannot be read. */
export function sha256File(file) {
  try {
    const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20);
    try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
    return h.digest('hex');
  } catch { return null; }
}

/**
 * Download url to dest through dest.part, hashing on the way; keeps it only when the sha256 matches (a wrong one is
 * deleted and refused). fetchImpl is injected by tests. Resolves to { ok, sha256, error? }.
 */
export async function downloadVerified(url, dest, sha256, { fetchImpl = globalThis.fetch } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    const res = await fetchImpl(url, { redirect: 'follow' });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    const h = crypto.createHash('sha256');
    const body = typeof res.body.getReader === 'function' ? Readable.fromWeb(res.body) : Readable.from(res.body);
    body.on('data', c => h.update(c));
    await pipeline(body, fs.createWriteStream(part));
    const got = h.digest('hex');
    if (got !== sha256) { fs.rmSync(part, { force: true }); return { ok: false, sha256: got, error: `sha256 ${got} is not the pinned ${sha256}` }; }
    fs.renameSync(part, dest);
    return { ok: true, sha256: got };
  } catch (e) { fs.rmSync(part, { force: true }); return { ok: false, error: e.message }; }
}

// Extracts only the files we keep from the segmentation archive, with tarfile's data filter where Python has it.
const EXTRACT_PY = 'import sys, tarfile, os\nsrc, dest, prefix = sys.argv[1], sys.argv[2], sys.argv[3]\nkeep = sys.argv[4:]\n' +
  'with tarfile.open(src, "r:bz2") as t:\n  ms = [m for m in t.getmembers() if m.isfile() and m.name in [prefix + "/" + k for k in keep]]\n' +
  '  if len(ms) != len(keep): sys.exit("the archive does not hold " + ", ".join(keep))\n' +
  '  kw = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}\n  t.extractall(dest, members=ms, **kw)\n';

/**
 * The speaker models into <module>/models/speakers: the segmentation archive (downloaded, checked, the model and its
 * licence extracted with the venv's Python, the archive removed) and the embedding models named. A file already there
 * with the pinned sha256 is not downloaded again. Returns { ok, lines } (what was done, or why not).
 */
export async function ensureSpeakerModels(modulePath, { embeddings = [DEFAULT_EMBEDDING], python, run, fetchImpl, log = () => {}, models = { SEGMENTATION, EMBEDDINGS } } = {}) {
  const dir = speakerModelsDir(modulePath), seg = models.SEGMENTATION;
  fs.mkdirSync(dir, { recursive: true });
  const segModel = path.join(dir, seg.dir, seg.model);
  if (sha256File(segModel) === seg.model_sha256) log(`Speaker segmentation model: already there (${segModel})`);
  else {
    log(`Downloading the speaker segmentation model (${(seg.bytes / 1e6).toFixed(1)} MB, ${seg.licence}) from ${seg.url}`);
    const tar = path.join(dir, seg.file);
    const d = await downloadVerified(seg.url, tar, seg.sha256, { fetchImpl });
    if (!d.ok) { log(`Could not download ${seg.url}: ${d.error}. Nothing was kept; run the installer again.`); return { ok: false }; }
    const r = run(python, ['-c', EXTRACT_PY, tar, dir, seg.dir, ...seg.keep], { encoding: 'utf8' });
    fs.rmSync(tar, { force: true });
    if (r.error || r.status !== 0) { log(`Could not unpack ${seg.file}: ${String(r.stderr || r.error?.message || '').trim().split('\n').pop()}`); return { ok: false }; }
    const got = sha256File(segModel);
    if (got !== seg.model_sha256) { fs.rmSync(path.join(dir, seg.dir), { recursive: true, force: true }); log(`The unpacked ${seg.model} has sha256 ${got}, not the pinned ${seg.model_sha256}; removed.`); return { ok: false }; }
    log(`Speaker segmentation model: ${segModel} (sha256 checked)`);
  }
  for (const id of embeddings) {
    const m = models.EMBEDDINGS[id], file = path.join(dir, m.file);
    if (sha256File(file) === m.sha256) { log(`Speaker embedding model ${id}: already there (${file})`); continue; }
    log(`Downloading the speaker embedding model ${id} (${(m.bytes / 1e6).toFixed(1)} MB, ${m.licence}) from ${m.url}`);
    const d = await downloadVerified(m.url, file, m.sha256, { fetchImpl });
    if (!d.ok) { log(`Could not download ${m.url}: ${d.error}. Nothing was kept; run the installer again.`); return { ok: false }; }
    log(`Speaker embedding model ${id}: ${file} (sha256 checked)`);
  }
  return { ok: true };
}

/** { segmentation, embedding }: each { file, ok, sha256 } (ok when present with the pinned sha256). */
export function speakerModelState(modulePath, emb = DEFAULT_EMBEDDING, models = { SEGMENTATION, EMBEDDINGS }) {
  const seg = path.join(speakerModelsDir(modulePath), models.SEGMENTATION.dir, models.SEGMENTATION.model);
  const e = path.join(speakerModelsDir(modulePath), models.EMBEDDINGS[emb].file);
  const st = (file, want) => { const got = fs.existsSync(file) ? sha256File(file) : null; return { file, present: !!got, ok: got === want, sha256: got, want }; };
  return { segmentation: st(seg, models.SEGMENTATION.model_sha256), embedding: st(e, models.EMBEDDINGS[emb].sha256) };
}

/** The length of a PCM WAV file in seconds from its header, or null (not a WAV, or unreadable). */
export function wavSeconds(file) {
  let b; try { const fd = fs.openSync(file, 'r'); b = Buffer.alloc(4096); fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd); } catch { return null; }
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12, rate = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(at + 16);   // byte rate
    if (id === 'data') { let len = size; try { len = Math.min(size, fs.statSync(file).size - at - 8); } catch { /* the header's size */ } return rate ? Math.round((len / rate) * 10) / 10 : null; }
    at += 8 + size + (size % 2);
  }
  return null;
}

// ---------- words to speakers ----------
/**
 * The speaker for a span [start, end] from diarization turns [{ start, end, speaker }]: the one whose turns overlap it,
 * when only one speaker's do. When turns of two or more speakers overlap it (a word on a boundary, or in overlapping
 * speech), the midpoint rule decides: the speaker whose turn holds its midpoint, even when another speaker's turns
 * overlap it more (the larger overlap only breaks a tie among the speakers holding the midpoint, then `prev`; with no
 * turn at the midpoint, the larger overlap). A span between turns takes the nearest turn (`prev` on a tie). null
 * without turns.
 */
export function speakerFor(start, end, turns, prev = null) {
  if (!turns?.length) return null;
  const s = Number(start) || 0, e = Math.max(s, Number(end) || s), mid = (s + e) / 2;
  const ov = new Map();
  for (const t of turns) { const o = Math.min(e, t.end) - Math.max(s, t.start); if (o > 0) ov.set(t.speaker, (ov.get(t.speaker) || 0) + o); }
  const best = cands => cands.sort((a, b) => (ov.get(b) || 0) - (ov.get(a) || 0) || (a === prev ? -1 : b === prev ? 1 : 0) || String(a).localeCompare(String(b), undefined, { numeric: true }))[0];
  if (ov.size === 1) return [...ov.keys()][0];
  const holders = [...new Set(turns.filter(t => t.start <= mid && mid <= t.end).map(t => t.speaker))];
  if (ov.size > 1) { const h = holders.filter(x => ov.has(x)); return best(h.length ? h : [...ov.keys()]); }
  if (holders.length) return best(holders);   // a word with no length on a turn
  let near = null, dist = Infinity;
  for (const t of turns) {
    const d = mid < t.start ? t.start - mid : mid > t.end ? mid - t.end : 0;
    if (d < dist - 1e-9 || (Math.abs(d - dist) <= 1e-9 && t.speaker === prev)) { dist = d; near = t.speaker; }
  }
  return near;
}

/** Every word gets a speaker (a second part of a hyphenated word keeps the first part's). Returns new word objects. */
export function assignWords(words, turns) {
  let prev = null;
  return (words || []).map(w => { const sp = w.hy && prev != null ? prev : speakerFor(w.start, w.end, turns, prev); prev = sp; return { ...w, speaker: sp }; });
}

const joinText = ws => { let out = ''; for (const w of ws) { const t = String(w.text || '').trim(); if (!t) continue; out += w.hy && out ? `-${t}` : `${out ? ' ' : ''}${t}`; } return out; };
/**
 * Segments with speakers: each segment's words get speakers, and a segment breaks where the speaker changes (its text
 * rebuilt from the words of each part). A segment without words takes the speaker of its whole span.
 */
export function splitBySpeaker(segments, turns) {
  const out = [];
  let prev = null;
  for (const seg of segments || []) {
    if (!Array.isArray(seg.words) || !seg.words.length) {
      prev = speakerFor(seg.start, seg.end, turns, prev);
      out.push({ ...seg, speaker: prev });
      continue;
    }
    const ws = [];
    for (const w of seg.words) { const sp = w.hy && prev != null ? prev : speakerFor(w.start, w.end, turns, prev); prev = sp; ws.push({ ...w, speaker: sp }); }
    const runs = [];
    for (const w of ws) { if (runs.length && runs.at(-1).speaker === w.speaker) runs.at(-1).words.push(w); else runs.push({ speaker: w.speaker, words: [w] }); }
    if (runs.length === 1) { out.push({ ...seg, speaker: runs[0].speaker, words: ws }); continue; }
    for (const r of runs) out.push({ start: r.words[0].start, end: r.words.at(-1).end, text: joinText(r.words), speaker: r.speaker, words: r.words });
  }
  return out;
}

/** The diarization's speaker numbers in order of first appearance: Map(raw speaker -> 1, 2, ...). */
export function speakerOrder(turns) {
  const order = new Map();
  for (const t of [...(turns || [])].sort((a, b) => a.start - b.start || a.end - b.end)) if (!order.has(t.speaker)) order.set(t.speaker, order.size + 1);
  return order;
}

/** Cosine similarity of two vectors (0 when either is empty or zero). */
export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

/**
 * "Me" among the speakers: { me: the speaker key or null, similarity: the best one, sims: { key: similarity } }. The
 * speaker with the closest embedding is "Me" when its similarity is at least `threshold`; only that one, never two.
 */
export function identifyMe(embeddings, sample, threshold) {
  const sims = {};
  let me = null, best = -Infinity;
  for (const [k, e] of Object.entries(embeddings || {})) { const s = Math.round(cosine(e, sample) * 1000) / 1000; sims[k] = s; if (s > best) { best = s; me = k; } }
  if (me == null) return { me: null, similarity: null, sims };
  return { me: best >= threshold ? me : null, similarity: best, sims };
}

/** Times where turns of two or more speakers overlap for longer than `min` seconds: [{ start, end }]. */
export function overlapRegions(turns, min = OVERLAP_MARK_S) {
  const ev = [];
  for (const t of turns || []) if (t.end > t.start) { ev.push([t.start, 1, t.speaker]); ev.push([t.end, -1, t.speaker]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const active = new Map(), out = [];
  let from = null;
  for (const [time, d, sp] of ev) {
    active.set(sp, (active.get(sp) || 0) + d);
    if (!active.get(sp)) active.delete(sp);
    const n = active.size;
    if (n >= 2 && from == null) from = time;
    else if (n < 2 && from != null) { if (time - from > min) out.push({ start: Math.round(from * 100) / 100, end: Math.round(time * 100) / 100 }); from = null; }
  }
  return out;
}

// ---------- labels and names ----------
/**
 * The speakers of a job, labelled: [{ key, label, me, seconds }] in order of first appearance, "Me" for the matched
 * one, "Speaker N" (its number by first appearance) for the others. t is the translator.
 */
export function labelSpeakers(turns, meKey, t) {
  const order = speakerOrder(turns), secs = new Map();
  for (const x of turns || []) secs.set(x.speaker, (secs.get(x.speaker) || 0) + Math.max(0, x.end - x.start));
  return [...order].map(([key, n]) => ({ key: String(key), label: String(key) === String(meKey) ? t('sp.me') : t('sp.speaker', { n }), me: String(key) === String(meKey), seconds: Math.round((secs.get(key) || 0) * 10) / 10 }));
}

// "Me" in every locale (sp.me in lib/i18n.mjs; test/transcribe-speakers.test.mjs keeps the two lists equal). A speaker
// shown under any of them is the user, whichever locale the transcript was written in.
export const ME_NAMES = ['Me', 'Я'];
const fold = x => String(x ?? '').normalize('NFC').trim().toLowerCase();
const ME_FOLDED = new Set(ME_NAMES.map(fold));
/** True for a name that means the user in any locale ("Me", "me", "Я", "я"). */
export const isMeName = n => ME_FOLDED.has(fold(n));
// names compared case-insensitively, every locale's "Me" as one name (a control character no cleaned name can hold)
const nameKey = x => (isMeName(x) ? '\u0000me' : fold(x));

/** A name a user gave: one line, no Markdown emphasis or brackets, at most 40 characters ('' when nothing is left). */
export const cleanName = v => String(v ?? '').normalize('NFC').replace(/[\p{Cc}*_`[\]<>|\\]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();

/** speakers.json next to a transcript: { label: name }; {} when there is none or it is not an object. */
export function readNames(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, NAMES_FILE), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? Object.fromEntries(Object.entries(j).map(([k, v]) => [k, cleanName(v)]).filter(([, v]) => v)) : {}; } catch { return {}; }
}
/** The name shown for a label: speakers.json's, else the label. */
export const shownName = (label, names = {}) => names[label] || label;

/**
 * The speaker who is the user, or null: the one the voice sample matched (labelled "Me" in the transcript's locale),
 * else the one a rename named "Me" or "Я" (any case). There is never more than one (applyRenames refuses a second).
 */
export function meSpeaker(speakers, names = {}) {
  const list = speakers || [];
  return list.find(x => isMeName(x.label)) || list.find(x => isMeName(shownName(x.label, names))) || null;
}

/**
 * Apply "label=name" pairs to the speakers [{ label }] and the names so far: { names, changed, errors }. A pair's left
 * side is a label ("Speaker 2"), or the name it shows now; an empty name removes the name (back to the label). A name
 * another speaker already shows or has as its label is refused, so two speakers never show the same name; names are
 * compared case-insensitively and "Me" and "Я" count as one name, so there is never a second "Me" in either locale.
 */
export function applyRenames(speakers, names, pairs) {
  const out = { ...names }, errors = [], changed = [];
  for (const raw of pairs) {
    const i = String(raw).indexOf('=');
    if (i < 0) { errors.push(`"${raw}" is not label=name`); continue; }
    const key = String(raw).slice(0, i).trim(), name = cleanName(String(raw).slice(i + 1));
    const sp = speakers.find(x => nameKey(x.label) === nameKey(key)) || speakers.find(x => nameKey(shownName(x.label, out)) === nameKey(key));
    if (!sp) { errors.push(`no speaker "${key}" in this transcript (${speakers.map(x => shownName(x.label, out)).join(', ')})`); continue; }
    if (name && speakers.some(x => x !== sp && (nameKey(shownName(x.label, out)) === nameKey(name) || nameKey(x.label) === nameKey(name)))) { errors.push(`"${name}" is already another speaker's name`); continue; }
    if (!name || name === sp.label) delete out[sp.label]; else out[sp.label] = name;
    changed.push(sp.label);
  }
  return { names: out, changed, errors };
}

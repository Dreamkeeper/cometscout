// The speaker-separation bench (node cli.mjs transcribe --bench-speakers): synthetic two-speaker calls built from public
// read speech with known speakers, so the answer is known. LibriSpeech test-clean (English) and Russian LibriSpeech
// (both CC BY 4.0) are read through the Hugging Face datasets server (no account) into <module>/bench-speakers, never
// into the repository. Each call alternates two speakers in turns of 3 to 20 s with short pauses and a few short
// overlaps. The reference counts only the speech inside each utterance (a frame-energy gate on the clean source audio,
// split at pauses longer than the diarizer's min_duration_off), so a pause between lines of verse is not missed speech.
// The diarization (transcribe.py --diarize) is scored with the diarization error rate (missed speech, false
// alarm, speaker confusion; 0.25 s collar), "Me" is tried with other utterances of one speaker as the voice sample (and
// a third speaker's, who is not in the call, which must not be found), and the CPU time per audio hour is reported.
// Everything here is pure Node except fetchUtterances (the network) and the injected runDiarize and convert (Python).
import fs from 'node:fs';
import path from 'node:path';
import { identifyMe, EMBEDDINGS, ME_THRESHOLD } from './transcribe-speakers.mjs';

export const RATE = 16000;
// The diarizer's min_duration_off (MIN_DURATION_OFF_S in deploy/modules/transcribe/transcribe.py; a test keeps them
// equal): it bridges shorter pauses, so the reference splits an utterance only at longer ones.
export const MIN_OFF_S = 0.5;
export const DATASETS = {
  en: { dataset: 'openslr/librispeech_asr', config: 'clean', split: 'test', total: 2620, name: 'LibriSpeech test-clean (CC BY 4.0)',
    speaker: r => String(r.speaker_id ?? ''), id: r => String(r.id ?? '') },
  ru: { dataset: 'istupakov/russian_librispeech', config: 'default', split: 'test', total: 1352, name: 'Russian LibriSpeech test (CC BY 4.0)',
    speaker: r => String(r.audio_filepath ?? '').split('/')[1] || '', id: r => path.basename(String(r.audio_filepath ?? ''), path.extname(String(r.audio_filepath ?? ''))) },
};
export const DATASETS_SERVER = 'https://datasets-server.huggingface.co';

/** A seeded random number generator (mulberry32): () => [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (r, [lo, hi]) => lo + (hi - lo) * r();

// ---------- WAV (16-bit PCM, mono) ----------
/** { rate, samples: Float32Array } from a 16-bit PCM WAV (the first channel when there are more). */
export function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let at = 12, fmt = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4), size = buf.readUInt32LE(at + 4), body = at + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error('only 16-bit PCM WAV is read here');
      const n = Math.floor(Math.min(size, buf.length - body) / (2 * fmt.channels)), out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(body + i * 2 * fmt.channels) / 32768;
      return { rate: fmt.rate, samples: out };
    }
    at = body + size + (size % 2);
  }
  throw new Error('no data in the WAV file');
}
/** A 16-bit PCM mono WAV from samples in [-1, 1] (clipped). */
export function writeWav(samples, rate = RATE) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}
/** The samples without the silence before and after the speech (20 ms frames under 5% of the loudest frame), 50 ms kept. */
export function trimSilence(samples, rate = RATE) {
  const frame = Math.round(rate * 0.02), n = Math.floor(samples.length / frame);
  if (!n) return samples;
  const rms = Array.from({ length: n }, (_, f) => { let e = 0; for (let i = f * frame; i < (f + 1) * frame; i++) e += samples[i] * samples[i]; return Math.sqrt(e / frame); });
  const floor = Math.max(...rms) * 0.05;
  const first = rms.findIndex(x => x > floor), last = n - 1 - [...rms].reverse().findIndex(x => x > floor);
  if (first < 0) return samples.subarray(0, 0);
  const pad = Math.round(rate * 0.05);
  return samples.subarray(Math.max(0, first * frame - pad), Math.min(samples.length, (last + 1) * frame + pad));
}

/**
 * The speech inside one clean utterance: [[start, end]] in seconds from its first sample. 20 ms frames louder than
 * `floor` of the loudest frame are speech (the gate trimSilence uses); speech either side of a quieter stretch longer
 * than `minOff` seconds becomes two spans, shorter pauses stay inside one span (the diarizer bridges them too).
 */
export function speechSpans(samples, { rate = RATE, minOff = MIN_OFF_S, floor = 0.05 } = {}) {
  const frame = Math.round(rate * 0.02), n = Math.floor(samples.length / frame);
  if (!n) return [];
  const rms = Array.from({ length: n }, (_, f) => { let e = 0; for (let i = f * frame; i < (f + 1) * frame; i++) e += samples[i] * samples[i]; return Math.sqrt(e / frame); });
  const gate = Math.max(...rms) * floor;
  if (!(gate > 0)) return [];
  const spans = [];
  let from = -1, last = -1;
  for (let f = 0; f < n; f++) {
    if (rms[f] <= gate) continue;
    if (from < 0) from = f;
    else if ((f - last - 1) * 0.02 > minOff) { spans.push([from, last + 1]); from = f; }
    last = f;
  }
  if (from >= 0) spans.push([from, last + 1]);
  const sec = f => Math.round(((f * frame) / rate) * 100) / 100;
  return spans.map(([a, b]) => [sec(a), Math.min(sec(b), Math.round((samples.length / rate) * 100) / 100)]);
}

// ---------- the synthetic calls ----------
/**
 * The plan for one synthetic call: two speakers taking turns, starting with `a`. pools: { speaker: [{ id, seconds,
 * spans? }] } (utterances of 3 s or more, each used once, cut to `turn[1]` seconds); pauses of `pause` seconds between
 * turns, and with probability `overlapRate` a turn starts `overlap` seconds before the last one ends (never in its first
 * second). Returns { items: [{ id, speaker, at, seconds }], turns: [{ start, end, speaker }] (the reference), duration }.
 * The reference holds an utterance's speech spans (speechSpans) where it has them, else the whole utterance.
 */
export function buildMixPlan(pools, a, b, { random = rng(1), turns = 10, turn = [3, 20], pause = [0.2, 1], overlapRate = 0.2, overlap = [0.4, 1.5] } = {}) {
  const left = { [a]: (pools[a] || []).filter(u => u.seconds >= turn[0]), [b]: (pools[b] || []).filter(u => u.seconds >= turn[0]) };
  const items = [];
  let end = 0, prevStart = 0;
  for (let k = 0; k < turns; k++) {
    const who = k % 2 ? b : a, u = left[who].shift();
    if (!u) break;
    const seconds = Math.round(Math.min(u.seconds, turn[1]) * 100) / 100;
    let at = items.length ? end + between(random, pause) : 0;
    if (items.length && random() < overlapRate) at = Math.max(prevStart + 1, end - between(random, overlap));
    at = Math.round(at * 100) / 100;
    items.push({ id: u.id, speaker: who, at, seconds, ...(Array.isArray(u.spans) ? { spans: u.spans } : {}) });
    prevStart = at; end = Math.max(end, at + seconds);
  }
  const r2 = x => Math.round(x * 100) / 100;
  const refTurns = items.flatMap(x => (x.spans ? x.spans.filter(([s0]) => s0 < x.seconds).map(([s0, e0]) => ({ start: r2(x.at + s0), end: r2(x.at + Math.min(e0, x.seconds)), speaker: x.speaker })).filter(t => t.end > t.start)
    : [{ start: x.at, end: r2(x.at + x.seconds), speaker: x.speaker }]));
  return { items: items.map(({ spans, ...x }) => x), turns: refTurns, duration: r2(end) };
}
/** The call's samples: every item's utterance (load(id) -> Float32Array) added at its time, clipped to [-1, 1]. */
export function renderMix(plan, load, rate = RATE) {
  const out = new Float32Array(Math.ceil(plan.duration * rate) + 1);
  for (const x of plan.items) {
    const s = load(x.id), from = Math.round(x.at * rate), n = Math.min(s.length, Math.round(x.seconds * rate), out.length - from);
    for (let i = 0; i < n; i++) out[from + i] += s[i];
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
  return out;
}
/** A voice sample: utterances one after another with 0.3 s between them, up to `max` seconds. */
export function joinSample(list, { rate = RATE, max = 40 } = {}) {
  const gap = Math.round(rate * 0.3), parts = [];
  let n = 0;
  for (const s of list) { if (n >= max * rate) break; const take = s.subarray(0, Math.min(s.length, max * rate - n)); parts.push(take); n += take.length + gap; }
  const out = new Float32Array(Math.max(0, n - gap));
  let at = 0;
  for (const p of parts) { out.set(p.subarray(0, Math.min(p.length, out.length - at)), at); at += p.length + gap; }
  return out;
}

// ---------- scoring ----------
const perms = (hs, rs) => {
  // every injective map from hs to rs or null (hs and rs are small: a few speakers)
  if (!hs.length) return [{}];
  const [h, ...rest] = hs, out = [];
  for (const m of perms(rest, rs)) {
    out.push({ ...m, [h]: null });
    for (const r of rs) if (!Object.values(m).includes(r)) out.push({ ...m, [h]: r });
  }
  return out;
};
/**
 * The diarization error rate of hyp against ref (both [{ start, end, speaker }]), in 10 ms frames: missed speech
 * (reference speakers the hypothesis does not cover), false alarm (hypothesis speakers beyond the reference) and
 * confusion (covered, but by a hypothesis speaker mapped to another reference speaker), over the reference speech
 * (overlap counts twice). The hypothesis speakers are mapped one to one to the reference speakers for the most
 * overlap. Times within `collar` seconds of a reference turn boundary are not scored. Seconds, and der as a fraction.
 */
export function der(ref, hyp, { collar = 0.25, step = 0.01 } = {}) {
  const last = Math.max(0, ...ref.map(t => t.end), ...hyp.map(t => t.end));
  const n = Math.ceil(last / step) + 1;
  const skip = new Uint8Array(n);
  for (const t of ref) for (const b of [t.start, t.end]) for (let i = Math.max(0, Math.ceil((b - collar) / step - 0.5)); i < n && (i + 0.5) * step < b + collar; i++) skip[i] = 1;
  const active = (turns, i) => { const c = (i + 0.5) * step, set = new Set(); for (const t of turns) if (t.start <= c && c < t.end) set.add(String(t.speaker)); return set; };
  const frames = [];
  for (let i = 0; i < n; i++) if (!skip[i]) frames.push([active(ref, i), active(hyp, i)]);
  const R = [...new Set(ref.map(t => String(t.speaker)))], H = [...new Set(hyp.map(t => String(t.speaker)))];
  const co = {};
  for (const [r, h] of frames) for (const x of h) for (const y of r) co[`${x}|${y}`] = (co[`${x}|${y}`] || 0) + 1;
  let mapping = {}, bestScore = -1;
  if (H.length <= 7) for (const m of perms(H, R)) { const sc = Object.entries(m).reduce((a, [h, r]) => a + (r == null ? 0 : co[`${h}|${r}`] || 0), 0); if (sc > bestScore) { bestScore = sc; mapping = m; } }
  else { const used = new Set(); for (const h of H) { const r = R.filter(x => !used.has(x)).sort((p, q) => (co[`${h}|${q}`] || 0) - (co[`${h}|${p}`] || 0))[0] ?? null; mapping[h] = r; if (r != null) used.add(r); } }
  let total = 0, miss = 0, fa = 0, conf = 0;
  for (const [r, h] of frames) {
    const correct = [...h].filter(x => mapping[x] != null && r.has(mapping[x])).length;
    total += r.size; miss += Math.max(0, r.size - h.size); fa += Math.max(0, h.size - r.size); conf += Math.min(r.size, h.size) - correct;
  }
  const sec = x => Math.round(x * step * 100) / 100;
  return { total: sec(total), miss: sec(miss), fa: sec(fa), confusion: sec(conf), der: total ? (miss + fa + conf) / total : 0, mapping };
}

/**
 * The "Me" threshold the bench suggests: halfway between the lowest similarity of the true speaker and the highest
 * best similarity when the sample's speaker is not in the call, when those two do not overlap; otherwise the value
 * that gets the most of both right. null without data.
 */
export function suggestThreshold(trueSims, absentSims) {
  if (!trueSims.length) return null;
  const lo = Math.min(...trueSims), hi = absentSims.length ? Math.max(...absentSims) : 0;
  if (lo > hi) return Math.round(((lo + hi) / 2) * 100) / 100;
  // on a tie the higher one: a stranger labelled "Me" misleads the coach more than a missed "Me"
  let best = null, score = -1;
  for (const c of [...trueSims, ...absentSims].map(x => Math.round(x * 100) / 100).sort((p, q) => p - q)) {
    const sc = trueSims.filter(x => x >= c).length + absentSims.filter(x => x < c).length;
    if (sc >= score) { score = sc; best = c; }
  }
  return best;
}

/** One embedding's numbers from its runs: [{ ref, plan, j, a, absentKey? }]. */
export function scoreRuns(runs, threshold) {
  const sum = { total: 0, miss: 0, fa: 0, confusion: 0 }, trueSims = [], absentSims = [];
  let found = 0, falseMe = 0, twoFound = 0, cpu = 0, audio = 0;
  for (const r of runs) {
    const hyp = r.j.turns || [];
    const d = der(r.plan.turns, hyp);
    for (const k of Object.keys(sum)) sum[k] += d[k];
    if (new Set(hyp.map(t => t.speaker)).size === 2) twoFound++;
    const embs = Object.fromEntries(Object.entries(r.j.speakers || {}).filter(([, v]) => Array.isArray(v?.embedding)).map(([k, v]) => [k, v.embedding]));
    const [me, absent] = r.j.samples || [];
    if (me?.embedding) {
      const id = identifyMe(embs, me.embedding, threshold);
      const target = Object.keys(embs).find(k => d.mapping[k] === r.a);
      if (target != null) trueSims.push(id.sims[target]);
      if (id.me != null && id.me === target) found++;
    }
    if (absent?.embedding) {
      const id = identifyMe(embs, absent.embedding, threshold);
      if (id.similarity != null) absentSims.push(id.similarity);
      if (id.me != null) falseMe++;
    }
    cpu += Number(r.j.cpu_seconds) || 0; audio += Number(r.j.duration) || r.plan.duration;
  }
  return { mixes: runs.length, ...sum, der: sum.total ? (sum.miss + sum.fa + sum.confusion) / sum.total : null, found, falseMe, twoFound,
    cpu_per_hour: audio ? Math.round((cpu / audio) * 3600) : null, audio: Math.round(audio), threshold, suggested: suggestThreshold(trueSims, absentSims),
    true_min: trueSims.length ? Math.min(...trueSims) : null, absent_max: absentSims.length ? Math.max(...absentSims) : null };
}

const pct = (x, total) => (total ? `${((x / total) * 100).toFixed(1)}%` : '?');
const mins = sec => (sec == null ? '?' : sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`);
/** The bench as a plain table. */
export function speakersReport(rows, { lang, dataset, threads, cpu, numSpeakers, threshold = null }) {
  const head = ['embedding', 'DER', 'missed', 'false alarm', 'confusion', '2 speakers found', '"Me" found', 'false "Me"', 'lowest true', 'highest stranger', 'CPU per audio hour', 'me_threshold (suggested)'];
  const sim = v => (v == null ? '?' : Number(v).toFixed(2));
  const body = rows.map(r => (r.error ? [r.embedding, `failed: ${r.error}`, '', '', '', '', '', '', '', '', '', '']
    : [r.embedding, pct(r.miss + r.fa + r.confusion, r.total), pct(r.miss, r.total), pct(r.fa, r.total), pct(r.confusion, r.total), `${r.twoFound}/${r.mixes}`,
      `${r.found}/${r.mixes}`, `${r.falseMe}/${r.mixes}`, sim(r.true_min), sim(r.absent_max), mins(r.cpu_per_hour), `${r.threshold} (${r.suggested ?? '?'})`]));
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => String(b[i]).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  const r0 = rows.find(r => !r.error);
  return [`Speaker bench (${lang}): ${r0 ? `${r0.mixes} synthetic two-speaker calls, ${mins(r0.audio)} of audio` : 'no calls'} from ${dataset}, ${threads} thread(s), CPU ${cpu}${numSpeakers ? `, num_speakers ${numSpeakers}` : `, speakers found between min_speakers and max_speakers (clustering threshold ${threshold ?? '?'})`}`,
    '', line(head), ...body.map(line), '',
    'DER: diarization error rate (missed speech + false alarm + speaker confusion, over the reference speech; 0.25 s collar).',
    '"Me" found: the voice sample (other utterances of one speaker) picked that speaker. False "Me": a speaker not in the call was labelled "Me".',
    'Lowest true: the lowest similarity of a sample to its own speaker in the call. Highest stranger: the highest similarity of a sample whose speaker is not in the call.',
    'me_threshold: the one used, and the bench\'s suggestion (halfway between the lowest true match and the highest stranger).'].join('\n');
}

// ---------- the data ----------
/**
 * Utterances of one language's test set, cached in cacheDir (manifest.json, the raw files, 16 kHz WAVs): rows from the
 * datasets server at offsets spread over the split, grouped by speaker, at most perSpeaker each. convert(pairs) turns
 * the raw files into 16 kHz mono WAVs (transcribe.py --convert). Resolves to { speaker: [{ id, file }] }.
 */
export async function fetchUtterances(lang, { cacheDir, fetchImpl = globalThis.fetch, convert, log = () => {}, perSpeaker = 12, pages = 12, rows = 40 } = {}) {
  const ds = DATASETS[lang];
  if (!ds) throw new Error(`--lang takes ${Object.keys(DATASETS).join(' or ')}`);
  const dir = path.join(cacheDir, lang), manifestFile = path.join(dir, 'manifest.json');
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true }); fs.mkdirSync(path.join(dir, 'wav'), { recursive: true });
  let manifest = null; try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* first run */ }
  if (!manifest?.every?.(u => fs.existsSync(path.join(dir, 'wav', `${u.id}.wav`)))) {
    log(`bench: reading ${ds.name} from the Hugging Face datasets server`);
    const by = new Map();
    for (let p = 0; p < pages; p++) {
      const offset = Math.floor((p * ds.total) / pages);
      const url = `${DATASETS_SERVER}/rows?dataset=${encodeURIComponent(ds.dataset)}&config=${ds.config}&split=${ds.split}&offset=${offset}&length=${rows}`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`the datasets server answered ${res.status} for ${ds.dataset}`);
      for (const { row } of (await res.json()).rows || []) {
        const sp = ds.speaker(row), id = ds.id(row), src = row.audio?.[0]?.src;
        if (!sp || !id || !src) continue;
        if (!by.has(sp)) by.set(sp, []);
        if (by.get(sp).length < perSpeaker) by.get(sp).push({ speaker: sp, id: `${sp}-${id}`.replace(/[^\w.-]/g, '_'), src, ext: (row.audio[0].type || '').includes('flac') ? '.flac' : '.wav' });
      }
    }
    manifest = [...by.values()].flat();
    const todo = [];
    for (const u of manifest) {
      const raw = path.join(dir, 'raw', `${u.id}${u.ext}`), wav = path.join(dir, 'wav', `${u.id}.wav`);
      if (fs.existsSync(wav)) continue;
      if (!fs.existsSync(raw)) {
        const res = await fetchImpl(u.src);
        if (!res.ok) throw new Error(`could not download an utterance (${res.status})`);
        fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
      }
      todo.push([raw, wav]);
    }
    if (todo.length) { log(`bench: converting ${todo.length} utterance(s) to 16 kHz WAV`); await convert(todo); }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest.map(({ speaker, id }) => ({ speaker, id })), null, 1));
  }
  const out = {};
  for (const u of manifest) (out[u.speaker] ||= []).push({ id: u.id, file: path.join(dir, 'wav', `${u.id}.wav`) });
  return out;
}

/**
 * The bench for one language: `mixes` synthetic calls (speakers and their order picked with a seeded random), each with
 * a voice sample of its first speaker (utterances not used in the call) and one of a speaker who is not in it; each
 * embedding model separates every call (runDiarize(audio, { samples, embedding, numSpeakers }) -> the --diarize JSON).
 * Returns the rows for speakersReport. onPlan(audio, plan, a, c) sees each call's plan (tests).
 */
export async function benchSpeakers({ lang, embeddings, utterances, workDir, runDiarize, mixes = 8, seed = 21, numSpeakers = null, thresholds = {}, log = () => {}, onPlan = () => {} }) {
  const cache = new Map();
  const load = file => { if (!cache.has(file)) cache.set(file, trimSilence(readWav(fs.readFileSync(file)).samples)); return cache.get(file); };
  const spanCache = new Map();
  const spansOf = file => { if (!spanCache.has(file)) spanCache.set(file, speechSpans(load(file))); return spanCache.get(file); };
  const speakers = Object.keys(utterances).filter(k => utterances[k].length >= 6).sort();
  if (speakers.length < 3) throw new Error(`the bench needs 3 speakers with 6 utterances or more; ${lang} has ${speakers.length}`);
  const random = rng(seed + (lang === 'ru' ? 1000 : 0));
  fs.mkdirSync(workDir, { recursive: true });
  const calls = [];
  for (let i = 0; i < mixes; i++) {
    const pick = [...speakers].sort(() => random() - 0.5);
    const [a, b, c] = pick;
    const pool = sp => utterances[sp].map(u => ({ id: u.file, seconds: load(u.file).length / RATE, spans: spansOf(u.file) })).sort(() => random() - 0.5);
    const pa = pool(a), sample = [], rest = [];
    let have = 0;
    for (const u of pa) { if (have < 20) { sample.push(u); have += u.seconds; } else rest.push(u); }
    const plan = buildMixPlan({ [a]: rest, [b]: pool(b) }, a, b, { random });
    const audio = path.join(workDir, `${lang}-${i + 1}.wav`), me = path.join(workDir, `${lang}-${i + 1}-me.wav`), absent = path.join(workDir, `${lang}-${i + 1}-absent.wav`);
    fs.writeFileSync(audio, writeWav(renderMix(plan, id => load(id))));
    fs.writeFileSync(me, writeWav(joinSample(sample.map(u => load(u.id)))));
    fs.writeFileSync(absent, writeWav(joinSample(pool(c).map(u => load(u.id)))));
    calls.push({ plan, a, audio, samples: [me, absent] });
    onPlan(audio, plan, a, c);
  }
  const rows = [];
  for (const embedding of embeddings) {
    log(`bench: ${embedding} on ${calls.length} ${lang} call(s) ...`);
    const runs = [];
    let error = null;
    for (const c of calls) {
      const r = await runDiarize(c.audio, { samples: c.samples, embedding, numSpeakers });
      if (!r.ok) { error = r.error; break; }
      runs.push({ plan: c.plan, a: c.a, j: r.json });
    }
    rows.push(error ? { embedding, error } : { embedding, ...scoreRuns(runs, thresholds[embedding] ?? ME_THRESHOLD[embedding] ?? 0.5) });
  }
  return rows;
}
export const EMBEDDING_IDS = Object.keys(EMBEDDINGS);

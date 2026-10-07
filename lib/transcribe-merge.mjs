// The targeted merge of two speech engines' words for Russian recordings (task 20): GigaAM's Russian text and punctuation
// are the base, and Whisper's word replaces GigaAM's only where Whisper heard a Latin-script term, an abbreviation or a
// number at the same moment and GigaAM's word is a transliteration or garble of it. Pure functions, no I/O:
//   mergeWords(gigaamWords, whisperWords, { keep, known }) -> { words, substitutions, review, stats }
//   buildSegments(words) -> subtitle segments from GigaAM's sentence punctuation and pauses
// Words in: { text, start, end, probability? } in seconds (wordsOf(result) flattens an engine's segments). Words out:
// { text, start, end, source: gigaam|whisper|glossary, hy? } where hy marks the second part of a hyphenated word.
// Substitutions: { time, before, after, source, similarity, probability, kind }. Review items (listed, never applied):
// Cyrillic words where the engines disagree and Whisper is confident (or the glossary knows its word): { time, gigaam,
// whisper, probability }.
// Thresholds follow the prototype that was tried on real recordings: replace at a transliterated distance of 0.45 or
// less, up to 0.6 when Whisper's probability is 0.85 or more; numbers only when the values match exactly, are 10 or more,
// and an ordinal keeps its suffix.

// Punctuation a word may carry; the dashes are written as escapes.
const PUNCT_CHARS = `"'«»“”„()[]{}.,!?;:…\u2014\u2013-`;
const PUNCT = new Set([...PUNCT_CHARS]);
const DASHES = new Set(['\u2014', '\u2013']);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
const PUNCT_CLASS = `[${escapeRe(PUNCT_CHARS)}]`;
const LEAD_RE = new RegExp(`^${PUNCT_CLASS}*`), TRAIL_RE = new RegExp(`${PUNCT_CLASS}*$`);

/** The word without punctuation around it. */
export const core = tok => String(tok || '').trim().replace(LEAD_RE, '').replace(TRAIL_RE, '').trim();
export const hasLat = s => /[A-Za-z]/.test(s);
export const hasCyr = s => /[Ѐ-ӿ]/.test(s);
export const hasDig = s => /\d/.test(s);
const lowerE = s => String(s).toLowerCase().replace(/ё/g, 'е');   // ё as е

const CYR = Object.fromEntries([...'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'].map((c, i) => [c,
  ['a', 'b', 'v', 'g', 'd', 'e', 'e', 'zh', 'z', 'i', 'i', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f', 'h', 'c', 'ch', 'sh', 'sh', '', 'y', '', 'e', 'u', 'ya'][i]]));
/** Cyrillic to Latin, lowercase. */
export const translit = s => [...String(s).toLowerCase()].map(c => CYR[c] ?? c).join('');
// How English letters are read out in Russian, for abbreviations ("KPI" heard as "кей пи ай").
export const LETTER_RU = { A: 'эй', B: 'би', C: 'си', D: 'ди', E: 'и', F: 'эф', G: 'джи', H: 'эйч', I: 'ай', J: 'джей', K: 'кей', L: 'эл', M: 'эм',
  N: 'эн', O: 'оу', P: 'пи', Q: 'кью', R: 'ар', S: 'эс', T: 'ти', U: 'ю', V: 'ви', W: 'дабл ю', X: 'икс', Y: 'уай', Z: 'зед' };
const SQUASH_RULES = [['tion', 'shn'], ['igh', 'ai'], ['ph', 'f'], ['ck', 'k'], ['ee', 'i'], ['ea', 'i'], ['oo', 'u'], ['ou', 'au'], ['th', 't'], ['qu', 'kv'], ['x', 'ks'],
  ['q', 'k'], ['w', 'v'], ['y', 'i'], ['j', 'dzh'], ['ch', 'ч'], ['c', 'k'], ['ч', 'ch'], ['zh', 'dzh'], ['ei', 'i'], ['ai', 'ei']];
/** A rough sound key for a word in either script: "роадмап" and "roadmap" get the same one. */
export function squash(s) {
  let x = translit(s).replace(/[^a-z0-9]/g, '');
  for (const [a, b] of SQUASH_RULES) x = x.split(a).join(b);
  return x.replace(/(.)\1+/g, '$1');
}
/** Levenshtein distance. */
export function lev(a, b) {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    prev = cur;
  }
  return prev[b.length];
}
/** Distance divided by the longer length: 0 is the same, 1 is nothing in common. */
export const dratio = (a, b) => (!a && !b ? 0 : lev(a, b) / Math.max(a.length, b.length));

/** Sound keys for a Whisper Latin span, with the letter-by-letter reading of abbreviations and the letters of "B2B". */
export function latinKeys(text) {
  const out = new Set([squash(text)]);
  const toks = String(text).split(/\s+/).map(core).filter(Boolean);
  if (toks.length && toks.every(t => /^[A-Z]{2,6}s?$/.test(t))) out.add(squash(toks.flatMap(t => [...t].map(c => LETTER_RU[c] ?? c)).join('')));
  if (hasDig(text) && hasLat(text)) out.add(squash(String(text).replace(/\d/g, '')));
  return out;
}

// Cyrillic capitals that look like Latin ones: "Е27" typed with a Cyrillic Е is the code E27.
const LOOKALIKE = { 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X' };
/** A code of Cyrillic look-alike capitals and digits ("Е27") in Latin letters; any other word unchanged. */
export function latinLookalike(word) {
  const c = core(word);
  if (!/\d/.test(c) || !/^[АВЕКМНОРСТХ0-9]+$/.test(c) || !/[АВЕКМНОРСТХ]/.test(c)) return word;
  return word.replace(c, [...c].map(ch => LOOKALIKE[ch] ?? ch).join(''));
}

// ---------- numbers ----------
const NUMS = Object.entries({
  ноль: 0, нул: 0, один: 1, одн: 1, перв: 1, два: 2, двух: 2, двум: 2, двое: 2, две: 2, втор: 2, три: 3, трех: 3, трем: 3, трет: 3,
  четыре: 4, четырех: 4, четырьм: 4, четверт: 4, пять: 5, пяти: 5, пят: 5, шесть: 6, шести: 6, шест: 6, семь: 7, семи: 7, седьм: 7,
  восемь: 8, восьми: 8, восьм: 8, девять: 9, девяти: 9, девят: 9, десят: 10, одиннадцат: 11, двенадцат: 12, тринадцат: 13,
  четырнадцат: 14, пятнадцат: 15, шестнадцат: 16, семнадцат: 17, восемнадцат: 18, девятнадцат: 19, двадцат: 20, тридцат: 30,
  сорок: 40, пятьдесят: 50, пятидесят: 50, шестьдесят: 60, шестидесят: 60, семьдесят: 70, семидесят: 70, восемьдесят: 80,
  восьмидесят: 80, девяност: 90, сто: 100, ста: 100, сот: 100, двест: 200, двухсот: 200, трист: 300, трехсот: 300, четырест: 400,
  пятьсот: 500, пятисот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900, тысяч: 1000, миллион: 1e6,
}).sort((a, b) => b[0].length - a[0].length);
// Words that start like a numeral but are not one.
const NONNUM = ['сотрудн', 'стои', 'стол', 'стор', 'сторон', 'стат', 'стал', 'стан', 'стар', 'пятн', 'семей', 'семья', 'семьи', 'семью', 'двер', 'двиг', 'трен'];
/** The value of one Russian numeral word, or null. */
export function numValue(word) {
  const w = lowerE(word);
  if (NONNUM.some(p => w.startsWith(p))) return null;
  for (const [stem, v] of NUMS) if (w.startsWith(stem) && w.length - stem.length <= 4) return v;
  return null;
}
const isNumWord = c => numValue(c) != null;
/** The values a run of Russian numeral words can mean: "двадцать пять" {25}; "два пять" also {25} (digits read out). */
export function parseRuNumber(words) {
  const vals = words.map(numValue);
  if (!vals.length || vals.some(v => v == null)) return new Set();
  let total = 0, cur = 0;
  for (const v of vals) { if (v >= 1000) { total += (cur || 1) * v; cur = 0; } else cur += v; }
  const out = new Set([total + cur]);
  if (vals.every(v => v < 10)) out.add(Number(vals.join('')));
  return out;
}
/** Whisper's digits as a number ("1 200", "25-го" -> 25), or null. */
export function digitsValue(text) {
  const m = String(text).replace(/[\s ]/g, '').match(/^(\d[\d]*)(-[\p{L}]+)?$/u);
  return m ? Number(m[1]) : null;
}
const ORDINAL = /(ый|ой|ий|ого|ому|ым|ом|ая|ую|ые|ых|ыми|ье|ья|ьего|ьей|ьем)$/;

// Russian brand names that stay in Cyrillic even when Whisper writes them in Latin letters (settings add more).
export const KEEP_CYRILLIC = ['сбер', 'сбера', 'сберу', 'сбером', 'сбере', 'яндекс', 'яндекса', 'яндексу', 'яндексом', 'яндексе', 'алиса', 'алисы', 'алисе', 'алисой', 'алису'];

// ---------- words in ----------
/** An engine's segments as one list of words. */
export function wordsOf(result) {
  const out = [];
  for (const seg of result?.segments || []) for (const w of seg?.words || []) {
    const text = String(w?.text ?? w?.word ?? '').trim();
    if (text) out.push({ text, start: Number(w.start) || 0, end: Number(w.end) || 0, probability: w.probability == null ? null : Number(w.probability) });
  }
  return out;
}
/**
 * Words for the alignment: split at inner hyphens ("какие-то" -> "какие" + "то" with hy), bare punctuation glued to
 * the word before, a leading "-то" right after a word joined to it. Each: { t, c, s, e, p, hy }.
 */
export function prepare(words, { lookalike = false } = {}) {
  const out = [];
  for (const w of words || []) {
    let t = String(w.text || '').trim();
    const s0 = Number(w.start) || 0, e0 = Number(w.end) || 0, p = w.probability == null ? 1 : Number(w.probability);
    if (!t) continue;
    if (!core(t) && !hasDig(t)) { if (out.length) out.at(-1).t += DASHES.has(t) ? ` ${t}` : t; continue; }
    if (lookalike) t = latinLookalike(t);
    let hy0 = false;
    if (t.startsWith('-') && out.length && s0 - out.at(-1).e < 0.6 && /^-[\p{L}\p{N}_]/u.test(t)) { hy0 = true; t = t.slice(1); }
    const parts = t.split(/(?<=\p{L})-(?=[\p{L}\p{N}_])|(?<=\d)-(?=\p{L})/u);
    const total = parts.reduce((n, x) => n + x.length, 0) || 1;
    let cur = s0;
    parts.forEach((x, k) => {
      const dur = ((e0 - s0) * x.length) / total;
      out.push({ t: x, c: core(x), s: cur, e: cur + dur, p, hy: k === 0 ? hy0 : true });
      cur += dur;
    });
  }
  return out;
}
/** Words back to text: spaces between words, a hyphen before the second part of a hyphenated word. */
export function joinWords(ws, key = 't') {
  let out = '';
  for (const w of ws) out += w.hy && out ? `-${w[key]}` : `${out ? ' ' : ''}${w[key]}`;
  return out;
}

// ---------- alignment ----------
/** Stretches of time cut at pauses of 0.25 s or at 25 s, each as [g0, g1, w0, w1] index ranges. */
function windows(G, W, maxLen = 25, minGap = 0.25) {
  const iv = [...G, ...W].map(w => [w.s, w.e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cuts = [];
  if (iv.length) {
    let curStart = iv[0][0], lastEnd = iv[0][1];
    for (const [s, e] of iv.slice(1)) {
      if (s - lastEnd >= minGap) { cuts.push((lastEnd + s) / 2); curStart = s; }
      else if (s - curStart > maxLen) { cuts.push(s); curStart = s; }
      lastEnd = Math.max(lastEnd, e);
    }
  }
  const bounds = [-1e9, ...cuts, 1e9], out = [];
  let gi = 0, wi = 0;
  for (let k = 0; k < bounds.length - 1; k++) {
    const hi = bounds[k + 1], g0 = gi, w0 = wi;
    while (gi < G.length && (G[gi].s + G[gi].e) / 2 < hi) gi++;
    while (wi < W.length && (W[wi].s + W[wi].e) / 2 < hi) wi++;
    if (gi > g0 || wi > w0) out.push([g0, gi, w0, wi]);
  }
  return out;
}
function subCost(g, w) {
  const a = lowerE(g.c), b = lowerE(w.c);
  let d = a === b ? 0 : Math.min(dratio(squash(a), squash(b)), 1);
  if (hasDig(a) !== hasDig(b) && (isNumWord(a) || isNumWord(b))) d = Math.min(d, 0.5);   // let "два" pair with "2"
  const dt = Math.abs((g.s + g.e) / 2 - (w.s + w.e) / 2);
  if (dt > 6) return 99;
  return 2 * d + (dt > 2.5 ? 0.4 : 0);
}
/** Pairs [gIndex|null, wIndex|null] in time order: an edit-distance alignment inside each window. */
export function align(G, W) {
  const ops = [];
  for (const [g0, g1, w0, w1] of windows(G, W)) {
    const n = g1 - g0, m = w1 - w0;
    const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1)), B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
    for (let i = 1; i <= n; i++) { D[i][0] = i; B[i][0] = 1; }
    for (let j = 1; j <= m; j++) { D[0][j] = j; B[0][j] = 2; }
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const c0 = D[i - 1][j - 1] + subCost(G[g0 + i - 1], W[w0 + j - 1]), c1 = D[i - 1][j] + 1, c2 = D[i][j - 1] + 1;
      if (c0 <= c1 && c0 <= c2) { D[i][j] = c0; B[i][j] = 0; } else if (c1 <= c2) { D[i][j] = c1; B[i][j] = 1; } else { D[i][j] = c2; B[i][j] = 2; }
    }
    const rev = [];
    for (let i = n, j = m; i > 0 || j > 0;) {
      const b = B[i][j];
      if (b === 0) { rev.push([g0 + i - 1, w0 + j - 1]); i--; j--; } else if (b === 1) { rev.push([g0 + i - 1, null]); i--; } else { rev.push([null, w0 + j - 1]); j--; }
    }
    ops.push(...rev.reverse());
  }
  return ops;
}

// ---------- the merge ----------
const round2 = x => Math.round(x * 100) / 100;
const flat = s => String(s).toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
/** Engines disagree only in an ending ("сделал" / "сделали"): not worth a review line. */
const endingOnly = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i >= 4 && i >= Math.max(a.length, b.length) - 2; };

/**
 * Merge GigaAM's words (the base) with Whisper's. opts: keep (more Cyrillic brand forms to keep), known (a Set of
 * lowercase words the glossary knows, so a disagreement on one of them is listed for review), and the thresholds.
 */
export function mergeWords(gigaamWords, whisperWords, { keep = [], known = new Set(), T = 0.45, T_HI = 0.6, P_HI = 0.85, REVIEW_P = 0.85 } = {}) {
  const G = prepare(gigaamWords, { lookalike: true }), W = prepare(whisperWords);
  const keepSet = new Set([...KEEP_CYRILLIC, ...keep].map(k => flat(k)).filter(Boolean));
  const ops = align(G, W);
  const isTarget = w => hasLat(w.c) || hasDig(w.c);
  const wclass = w => (hasDig(w.c) && !hasLat(w.c) ? 'num' : 'lat');
  const replace = new Map(), used = new Set(), misses = [];
  const recOf = (gidx, widx, d, kind) => ({ time: round2(W[widx[0]].s), before: gidx.length ? joinWords(gidx.map(x => G[x])) : '',
    whisper: joinWords(widx.map(x => W[x])), similarity: round2(1 - d), probability: round2(widx.reduce((n, x) => n + W[x].p, 0) / widx.length), kind });
  const take = (gidx, widx, rec) => {
    if (gidx.some(x => used.has(x))) { misses.push({ ...rec, why: 'overlaps another change' }); return; }
    gidx.forEach(x => used.add(x)); replace.set(gidx[0], { gidx, widx, rec });
  };
  const score = (gidx, keys) => (gidx.length ? Math.min(...[...keys].map(k => dratio(squash(gidx.map(x => G[x].c).join('')), k))) : 1);

  const decideLatin = (gidx, widx, d) => {
    const rec = recOf(gidx, widx, d, 'latin');
    if (!gidx.length) { misses.push({ ...rec, why: 'no GigaAM word there' }); return; }
    const gcore = gidx.map(x => G[x].c).join(' '), wcore = widx.map(x => W[x].c).join(' ');
    if (flat(gcore) === flat(wcore)) return;
    if (keepSet.has(flat(gcore))) { misses.push({ ...rec, why: 'Cyrillic brand kept' }); return; }
    if (d <= T || (d <= T_HI && rec.probability >= P_HI)) take(gidx, widx, rec);
    else misses.push({ ...rec, why: `too different (${round2(d)})` });
  };
  const extend = (ka, kb, gidx, keys) => {
    let bestG = [...gidx].sort((a, b) => a - b), bestD = score(gidx, keys);
    let lstop = null; for (let x = ka - 1; x > Math.max(-1, ka - 4); x--) if (ops[x][1] != null) { lstop = x; break; }
    const left = []; for (let x = ka - 1; x > (lstop ?? Math.max(-1, ka - 4)); x--) left.push(ops[x][0]);
    let rstop = null; for (let x = kb; x < Math.min(ops.length, kb + 3); x++) if (ops[x][1] != null) { rstop = x; break; }
    const right = []; for (let x = kb; x < (rstop ?? Math.min(ops.length, kb + 3)); x++) right.push(ops[x][0]);
    for (let nl = 0; nl <= left.length; nl++) for (let nr = 0; nr <= right.length; nr++) {
      const cand = [...left.slice(0, nl), ...gidx, ...right.slice(0, nr)].sort((a, b) => a - b);
      if (!cand.length) continue;
      const d = score(cand, keys);
      if (d < bestD - 0.05) { bestG = cand; bestD = d; }
    }
    return [bestG, bestD];
  };

  for (let k = 0; k < ops.length;) {
    const wi = ops[k][1];
    if (wi == null || !isTarget(W[wi])) { k++; continue; }
    const cls = wclass(W[wi]);
    const run = [];
    let k1 = k;
    while (k1 < ops.length) {
      const w_ = ops[k1][1];
      const nextW = k1 + 1 < ops.length ? ops[k1 + 1][1] : null;
      if (w_ != null && isTarget(W[w_]) && wclass(W[w_]) === cls) { run.push(k1); k1++; }
      else if (w_ == null && nextW != null && isTarget(W[nextW]) && wclass(W[nextW]) === cls) { run.push(k1); k1++; }
      else if (cls === 'num' && w_ != null && W[w_].hy && !isTarget(W[w_]) && run.length) { run.push(k1); k1++; break; }   // "25-го" keeps its suffix
      else break;
    }
    const runW = run.map(x => ops[x][1]).filter(x => x != null), runG = run.map(x => ops[x][0]).filter(x => x != null);
    if (cls === 'num') {
      let gidx = [...runG].sort((a, b) => a - b);
      if (gidx.length) {
        let lo = gidx[0], hi = gidx.at(-1);
        while (lo - 1 >= 0 && isNumWord(G[lo - 1].c) && !hasDig(G[lo - 1].c) && G[lo].s - G[lo - 1].e < 1) lo--;
        while (hi + 1 < G.length && isNumWord(G[hi + 1].c) && !hasDig(G[hi + 1].c) && G[hi + 1].s - G[hi].e < 1) hi++;
        gidx = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      }
      const wtxt = joinWords(runW.map(x => W[x]), 'c'), wv = digitsValue(wtxt);
      const rec = recOf(gidx, runW, 0, 'number');
      const gc = gidx.map(x => G[x].c);
      const values = parseRuNumber(gc);
      if (!gidx.length) misses.push({ ...rec, why: 'no GigaAM word there' });
      else if (runW.filter(x => hasDig(W[x].c)).length > 1) misses.push({ ...rec, why: 'a list of numbers, words kept' });
      else if (gc.some(hasDig)) { if (gc.join('').replace(/\D/g, '') !== wtxt.replace(/\D/g, '')) misses.push({ ...rec, why: 'both in digits, different' }); }
      else if (wv != null && values.has(wv)) {
        if (wv < 10) misses.push({ ...rec, why: 'below 10, words kept' });
        else if (ORDINAL.test(lowerE(gc.at(-1))) && !W[runW.at(-1)].hy) misses.push({ ...rec, why: 'an ordinal, and Whisper gave no suffix' });
        else take(gidx, runW, rec);
      } else misses.push({ ...rec, why: values.size ? `the value differs (${[...values].join(', ')})` : 'GigaAM has no numeral there' });
      k = Math.max(k1, k + 1);
      continue;
    }
    const pairs = run.map(x => ops[x]);
    if (pairs.every(([g_, w_]) => g_ != null && w_ != null)) {
      for (const x of run) { const [g_, w_] = ops[x]; const [bg, bd] = extend(x, x + 1, [g_], latinKeys(W[w_].c)); decideLatin(bg, [w_], bd); }
    } else {
      const [bg, bd] = extend(k, k1, runG, latinKeys(runW.map(x => W[x].c).join(' ')));
      decideLatin(bg, runW, bd);
    }
    k = Math.max(k1, k + 1);
  }

  // the merged words
  const skip = new Set(); for (const { gidx } of replace.values()) gidx.slice(1).forEach(x => skip.add(x));
  const words = [], substitutions = [];
  for (let gi = 0; gi < G.length; gi++) {
    if (skip.has(gi)) continue;
    const r = replace.get(gi);
    if (!r) { words.push({ text: G[gi].t, start: round2(G[gi].s), end: round2(G[gi].e), source: 'gigaam', ...(G[gi].hy ? { hy: true } : {}) }); continue; }
    const first = G[r.gidx[0]].t, last = G[r.gidx.at(-1)].t;
    const lead = first.match(LEAD_RE)[0], trail = last.match(new RegExp(`[${escapeRe(PUNCT_CHARS)}\\s]*$`))[0];
    let txt = joinWords(r.widx.map(x => W[x]), 'c');
    if (/^\p{Lu}/u.test(first.replace(LEAD_RE, '')) && /^\p{Ll}/u.test(txt)) txt = txt[0].toUpperCase() + txt.slice(1);
    const after = lead + txt + trail;
    substitutions.push({ time: r.rec.time, before: joinWords(r.gidx.map(x => G[x])), after, source: 'whisper', similarity: r.rec.similarity, probability: r.rec.probability, kind: r.rec.kind });
    words.push({ text: after, start: round2(Math.min(W[r.widx[0]].s, G[r.gidx[0]].s)), end: round2(Math.max(W[r.widx.at(-1)].e, G[r.gidx.at(-1)].e)), source: 'whisper', ...(G[r.gidx[0]].hy ? { hy: true } : {}) });
  }

  // review: Cyrillic words the engines heard differently, where Whisper is confident or the glossary knows its word
  const review = [];
  for (const [gi, wi] of ops) {
    if (gi == null || wi == null || used.has(gi)) continue;
    const a = G[gi].c, b = W[wi].c;
    if (!hasCyr(a) || !hasCyr(b) || hasLat(b) || hasLat(a)) continue;
    const al = lowerE(a), bl = lowerE(b);
    if (al === bl || endingOnly(al, bl) || (al.includes(bl) && bl.length < al.length)) continue;
    const d = dratio(squash(al), squash(bl));
    const glossary = known.has(bl);
    if (d > 0.45 && !glossary) continue;
    if (W[wi].p >= REVIEW_P || glossary) review.push({ time: round2(G[gi].s), gigaam: a, whisper: b, probability: round2(W[wi].p), ...(glossary ? { glossary: true } : {}) });
  }
  const stats = { gigaam_words: G.length, whisper_words: W.length, aligned: ops.filter(([a, b]) => a != null && b != null).length,
    substitutions: substitutions.length, kept: misses.length, review: review.length };
  return { words, substitutions, review, misses, stats };
}

/**
 * Subtitle segments from merged words: a segment ends at GigaAM's sentence punctuation once it is 2 seconds long, at a
 * pause of a second, at a comma after 8 seconds, and never runs past about 12 seconds. Each: { start, end, text, words }.
 */
export function buildSegments(words, { minDur = 2, maxDur = 8, hardMax = 12, gap = 1 } = {}) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0].start, end: cur.at(-1).end, text: joinWords(cur.map(w => ({ ...w, t: w.text }))), words: cur }); cur = []; };
  for (const w of words || []) {
    if (cur.length && !w.hy) {
      const lastText = cur.at(-1).text, pause = w.start - cur.at(-1).end, dur = cur.at(-1).end - cur[0].start;
      const sentence = /[.?!…]["'»)]*$/.test(lastText.replace(/[\s\u2014\u2013]+$/, ''));
      if (pause >= gap || (sentence && dur >= minDur) || (dur >= maxDur && /[,;:\u2014\u2013]$/.test(lastText)) || w.end - cur[0].start > hardMax) flush();
    }
    cur.push(w);
  }
  flush();
  return out;
}

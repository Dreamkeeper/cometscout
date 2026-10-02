#!/usr/bin/env node
// Lint rules from the profile: profile/lint-rules.json (optional) holds the claims that must never be written.
//   { "banned_claims": [{ "id", "pattern", "why" }], "warn_claims": [...], "limits": { "bullet_max_words", "summary_max_words" } }
// Patterns compile with flags "giu"; a pattern that does not compile is skipped and reported by doctor.
// banned_claims are errors, warn_claims and limits are warnings. The pack lints the rendered CV (WordprocessingML),
// the cover letter and every answer; doctor lints the vetted CV library.
// Usage: node lib/lint.mjs <file.docx|document.xml|file.txt> [--rules lint-rules.json] [--json]   (exit 1 on errors)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PROFILE, readConfig, num } from './config.mjs';

export const RULES_FILE = 'lint-rules.json';

/** True when a pattern relies on \b next to Cyrillic: in JavaScript \b only sees ASCII word characters. */
export const cyrillicBoundary = pattern => /\\b/.test(String(pattern)) && /[\u0400-\u04ff]/.test(String(pattern));

/** Compile a lint-rules object. Bad patterns are skipped and listed in `problems`. */
export function compileRules(cfg) {
  const out = { banned: [], warn: [], limits: {}, problems: [], present: !!cfg };
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  for (const [key, list] of [['banned_claims', out.banned], ['warn_claims', out.warn]]) {
    if (c[key] != null && !Array.isArray(c[key])) { out.problems.push(`${key}: not a list`); continue; }
    (c[key] || []).forEach((r, i) => {
      const id = r?.id || `${key}[${i}]`;
      if (!r?.pattern) { out.problems.push(`${id}: no pattern`); return; }
      try { list.push({ id, pattern: String(r.pattern), re: new RegExp(r.pattern, 'giu'), why: r.why || '' }); } catch (e) { out.problems.push(`${id}: ${e.message}`); }
    });
  }
  const lim = c.limits || {};
  out.limits = { bullet_max_words: num(lim.bullet_max_words, null, 1), summary_max_words: num(lim.summary_max_words, null, 1) };
  return out;
}

/** The profile's rules (profile/lint-rules.json), compiled once. A missing file means no rules. */
let cached = null;
export function profileRules(dir = PROFILE.dir) {
  if (dir === PROFILE.dir && cached) return cached;
  const r = compileRules(readConfig(path.join(dir, RULES_FILE), null));
  if (dir === PROFILE.dir) cached = r;
  return r;
}

// ---------- paragraphs ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); try { return String.fromCodePoint(n); } catch { return m; } }
  return ENT[e.toLowerCase()] ?? m;
});
const words = t => (t.match(/\S+/g) || []).length;
const BOLD = /<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/;

/** WordprocessingML to [{ text, kind, words }]: bullet (numPr), heading (bold, short), summary (over 60 words), line. */
export function paragraphsFromXml(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    // runs in order; a tab or a line break between runs reads as a space
    const text = decodeEntities([...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)\s*\/>/g)].map(x => x[1] ?? ' ').join(''))
      .replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const bullet = /<w:numPr>/.test(pPr);
    const kind = bullet ? 'bullet' : BOLD.test(p) && text.length < 140 ? 'heading' : words(text) > 60 ? 'summary' : 'line';
    out.push({ text, kind, words: words(text) });
  }
  return out;
}
/** Plain text (a cover letter, a form answer): paragraphs split on blank lines, all of kind "line". */
export const paragraphsFromText = text => String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n/)
  .map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).map(t => ({ text: t, kind: 'line', words: words(t) }));

// ---------- lint ----------
const cut = t => (t.length > 120 ? `${t.slice(0, 119)}…` : t);
/** { errors, warns, info }: one hit per rule per paragraph, { id, para, kind, match, why, text }; para counts from 1. */
export function lintParagraphs(paras, rules) {
  const errors = [], warns = [];
  const hit = (list, id, i, p, match, why) => list.push({ id, para: i + 1, kind: p.kind, match, why, text: cut(p.text) });
  paras.forEach((p, i) => {
    for (const r of rules.banned) { const m = p.text.match(r.re); if (m) hit(errors, r.id, i, p, m[0], r.why); }
    for (const r of rules.warn) { const m = p.text.match(r.re); if (m) hit(warns, r.id, i, p, m[0], r.why); }
    const { bullet_max_words: bmax, summary_max_words: smax } = rules.limits || {};
    if (bmax && p.kind === 'bullet' && p.words > bmax) hit(warns, 'bullet-length', i, p, `${p.words} words`, `a bullet over ${bmax} words`);
    if (smax && p.kind === 'summary' && p.words > smax) hit(warns, 'summary-length', i, p, `${p.words} words`, `a summary over ${smax} words`);
  });
  const bullets = paras.filter(p => p.kind === 'bullet');
  const summary = Math.max(0, ...paras.filter(p => p.kind === 'summary').map(p => p.words));
  const info = `${paras.length} paragraphs, ${bullets.length} bullets, longest bullet ${Math.max(0, ...bullets.map(p => p.words))} words, summary ${summary} words`;
  return { errors, warns, info };
}
export const lintDocumentXml = (xml, rules) => lintParagraphs(paragraphsFromXml(xml), rules);
export const lintText = (text, rules) => lintParagraphs(paragraphsFromText(text), rules);

/** Every vetted text in a CV library as [{ item, text, kind }], with the kind it has in a rendered CV: bullets,
 *  highlights and awards are list items, a summary over 60 words is a summary, the rest are lines. */
export function libraryTexts(lib) {
  const out = []; const add = (x, text, kind) => { if (x?.id && text) out.push({ item: x.id, text: String(text).replace(/\s+/g, ' ').trim(), kind }); };
  for (const x of lib?.taglines || []) add(x, x.text, 'line');
  for (const x of lib?.summaries || []) add(x, x.text, words(String(x.text || '')) > 60 ? 'summary' : 'line');
  for (const e of lib?.experience || []) { if (e.blurb) add({ id: `${e.key || e.company} (blurb)` }, e.blurb, 'line'); for (const r of e.roles || []) for (const b of r.bullets || []) add(b, b.text, 'bullet'); }
  for (const x of lib?.ai_work?.items || []) add(x, `${x.lead || ''}${x.text || ''}`, 'bullet');
  for (const x of lib?.skills || []) add(x, `${x.label ? `${x.label}: ` : ''}${x.text || ''}`, 'line');
  for (const x of lib?.awards || []) add(x, x.text, 'bullet');
  return out;
}
/** True when `re` matches all of `text` (a pronoun inside a longer banned claim does not make the claim a duplicate). */
export const matchesWhole = (re, text) => new RegExp(`^(?:${re.source})$`, re.flags.replace(/[gy]/g, '')).test(String(text ?? ''));
/** Lint the vetted library: { errors, warns } as [{ item, id, match, why }], one per item and rule (limits included). */
export function lintLibrary(lib, rules) {
  const out = { errors: [], warns: [] };
  for (const { item, text, kind } of libraryTexts(lib)) {
    const r = lintParagraphs([{ text, kind, words: words(text) }], rules);
    for (const k of ['errors', 'warns']) out[k].push(...r[k].map(h => ({ item, id: h.id, match: h.match, why: h.why })));
  }
  return out;
}

/** A short report for the CLI and answers.md. */
export function formatReport(result, label = 'Lint') {
  const line = (lvl, h) => `- ${lvl} ${h.id} (paragraph ${h.para}, ${h.kind}): "${h.match}"${h.why ? `: ${h.why}` : ''}\n  ${h.text}`;
  return [`${label}: ${result.errors.length} error(s), ${result.warns.length} warning(s). ${result.info}`,
    ...result.errors.map(h => line('error', h)), ...result.warns.map(h => line('warning', h))].join('\n');
}

// ---------- reading a .docx without dependencies ----------
/** One file out of a zip (stored or deflated), found through the central directory. */
export function unzipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10); let at = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    if (buf.toString('utf8', at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`zip method ${method} is not supported`);
    }
    at += 46 + nameLen + extra + comment;
  }
  throw new Error(`${name} is not in the file`);
}
/** Lint a file: .docx (its word/document.xml), .xml (WordprocessingML) or anything else as plain text. */
export function lintFile(file, rules) {
  if (/\.docx$/i.test(file)) return lintDocumentXml(unzipEntry(fs.readFileSync(file), 'word/document.xml').toString('utf8'), rules);
  const txt = fs.readFileSync(file, 'utf8');
  return /\.xml$/i.test(file) || /<w:document[\s>]/.test(txt) ? lintDocumentXml(txt, rules) : lintText(txt, rules);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--rules'); const rulesFile = ri >= 0 ? args[ri + 1] : null;
  const file = args.find((a, i) => !a.startsWith('--') && (ri < 0 || i !== ri + 1));
  if (!file) { console.log('Usage: node lib/lint.mjs <file.docx|document.xml|file.txt> [--rules lint-rules.json] [--json]'); process.exit(2); }
  const rules = rulesFile ? compileRules(readConfig(rulesFile, null)) : profileRules();
  if (rulesFile && !rules.present) { console.log(`${rulesFile} not found`); process.exit(2); }
  for (const p of rules.problems) console.error(`lint rule skipped: ${p}`);
  let res; try { res = lintFile(file, rules); } catch (e) { console.log(`cannot read ${file}: ${e.message}`); process.exit(2); }
  console.log(args.includes('--json') ? JSON.stringify(res, null, 2) : formatReport(res, path.basename(file)));
  process.exit(res.errors.length ? 1 : 0);
}

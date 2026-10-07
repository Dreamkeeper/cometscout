// Reading application packs for the pack and voice evals: a pack is a folder with answers.md, usually pack.json and
// the CV as DOCX (pack/pack.mjs). A folder of packs (data/packs, or a copy made by another prompt) is read as a list.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, STATE, read, readJson } from '../lib/config.mjs';
import { unzipEntry, paragraphsFromXml, paragraphsFromText, lintParagraphs, profileRules } from '../lib/lint.mjs';
import { mdSection, parseAnswersMd } from '../lib/workspace.mjs';
import { jobText } from './sets.mjs';

const isPack = d => fs.existsSync(path.join(d, 'answers.md')) || fs.existsSync(path.join(d, 'pack.json'));
/** The pairing key of a pack folder: its name without the leading date ("<date>--company--role" -> "company--role"). */
export const packKey = name => String(name).replace(/^\d{4}-\d{2}-\d{2}--/, '');
/** Pack folders under `dir` (or `dir` itself when it is one pack): [{ key, name, dir }], newest name last per key. */
export function listPacks(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
  if (isPack(dir)) return [{ key: packKey(path.basename(dir)), name: path.basename(dir), dir }];
  return fs.readdirSync(dir).sort().map(n => ({ key: packKey(n), name: n, dir: path.join(dir, n) })).filter(p => fs.statSync(p.dir).isDirectory() && isPack(p.dir));
}

/**
 * What a pack holds: { title, cv: { text, paras }, coverLetter, answers: [{ field, answer }] }. The CV is read from its
 * DOCX (" CV - " in the name, else the first DOCX that is not a cover letter); the cover letter from answers.md
 * when pasted as text, else from its DOCX; the answers from pack.json, else from answers.md.
 */
export function readPack(dir) {
  const md = read(path.join(dir, 'answers.md')), pj = readJson(path.join(dir, 'pack.json'), null);
  const docx = fs.readdirSync(dir).filter(f => /\.docx$/i.test(f));
  const docText = f => paragraphsFromXml(unzipEntry(fs.readFileSync(path.join(dir, f)), 'word/document.xml').toString('utf8'));
  const cvFile = docx.find(f => / CV - /.test(f)) || docx.find(f => !/ CL - /.test(f));
  let paras = []; try { if (cvFile) paras = docText(cvFile); } catch { paras = []; }
  let cl = mdSection(md, 'Cover letter (paste as text)') || '';
  const clFile = docx.find(f => / CL - /.test(f));
  if (!cl && clFile) try { cl = docText(clFile).map(p => p.text).join('\n\n'); } catch { /* unreadable */ }
  const answers = (Array.isArray(pj?.answers) ? pj.answers : parseAnswersMd(md).answers || []).filter(a => a && typeof a.answer === 'string' && a.answer.trim())
    .map(a => ({ field: String(a.field || ''), answer: a.answer.trim() }));
  return { title: (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() || path.basename(dir), cv: { text: paras.map(p => p.text).join('\n'), paras }, coverLetter: cl.trim(), answers };
}

/** Lint errors (banned claims) and warnings in a pack's CV, cover letter and answers, with the profile's rules. */
export function lintPack(p, rules = profileRules()) {
  const parts = [['CV', lintParagraphs(p.cv.paras, rules)], ['Cover letter', lintParagraphs(paragraphsFromText(p.coverLetter), rules)],
    ...p.answers.map(a => [`Answer "${a.field}"`, lintParagraphs(paragraphsFromText(a.answer), rules)])];
  const errors = parts.flatMap(([where, r]) => r.errors.map(h => ({ where, id: h.id, match: h.match })));
  const warns = parts.flatMap(([where, r]) => r.warns.map(h => ({ where, id: h.id, match: h.match })));
  return { errors, warns };
}

/**
 * The job a pack was built for: packs.json's entry naming this folder, else the queue file with the same
 * company--role name; its text without the decode block. Null when neither is found.
 */
export function packJob(name) {
  const packs = readJson(STATE('packs.json'), {}) || {};
  const byState = Object.entries(packs).find(([, v]) => v?.dir === name)?.[0];
  const key = packKey(name);
  for (const d of ['decoded', 'rejected', 'inbox']) {
    const files = fs.readdirSync(DIRS[d]).filter(f => f === byState || (f.endsWith('.md') && packKey(f.slice(0, -3)) === key)).sort();
    const f = files.includes(byState) ? byState : files.pop();
    if (f) return { file: f, text: jobText(read(path.join(DIRS[d], f))) };
  }
  return null;
}

/** A pack as the judge reads it. */
export const packText = p => [`### CV\n${p.cv.text || '(no CV text: the pack has no readable DOCX)'}`, p.coverLetter ? `### Cover letter\n${p.coverLetter}` : null,
  p.answers.length ? `### Form answers\n${p.answers.map(a => `Q: ${a.field}\nA: ${a.answer}`).join('\n\n')}` : null].filter(Boolean).join('\n\n');

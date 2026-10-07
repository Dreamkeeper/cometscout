// Voice eval: does the generated text sound like the user?
//   node cli.mjs evals voice --dir <packs> [--judge-model <model>]
// A model judge gets profile/voice.md and the user's own writing (profile/voice-samples/*.md), then each generated
// cover letter and form answer, one at a time, and scores it 1 to 5 with the phrases that sound least like the user.
// Short answers (under MIN_WORDS: a notice period, a yes) say nothing about voice and are skipped. The lint rules'
// banned and warning phrases are counted on the same texts.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, PROFILE, SETTINGS, read, today } from '../lib/config.mjs';
import { callJson } from '../lib/llm.mjs';
import { profileRules, lintText } from '../lib/lint.mjs';
import { listPacks, readPack } from './packs.mjs';

export const MIN_WORDS = 15;
const SAMPLES_MAX = 30000;
export const VOICE_SCHEMA = { type: 'object', required: ['score', 'phrases', 'reason'], properties: {
  score: { type: 'integer', minimum: 1, maximum: 5 }, phrases: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } }, reason: { type: 'string', maxLength: 400 } } };

/** The user's voice: { card: voice.md, samples: the voice-samples files joined (capped) }. */
export function voiceReference(dir = PROFILE.dir) {
  const sd = path.join(dir, 'voice-samples'); let samples = '';
  if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd).filter(x => x.endsWith('.md')).sort()) samples += `### ${f}\n${read(path.join(sd, f)).trim()}\n\n`;
  return { card: read(path.join(dir, 'voice.md')).trim(), samples: samples.slice(0, SAMPLES_MAX).trim() };
}
export function voicePrompt(ref, kind, text) {
  return ['You check whether a text sounds like a specific person wrote it. Below are their own description of how they write and samples of their own writing.',
    'Score the text 1 to 5: 5 reads like the samples, 3 is neutral and could be anyone, 1 sounds clearly unlike them (slogans, filler, a register they never use).',
    'Judge the voice only, not whether the content is good. List up to five exact phrases from the text that sound least like them (copied word for word), and one sentence as the reason.',
    '', '## How they write', ref.card || '(no voice card)', '', '## Their own writing', ref.samples || '(no samples)', '', `## The text to score (${kind})`, text].join('\n');
}

const words = t => (String(t).match(/\S+/g) || []).length;
/** The texts to score in one pack: [{ pack, kind, field, text }]. */
export const packTexts = (name, p) => [...(p.coverLetter ? [{ pack: name, kind: 'cover letter', field: null, text: p.coverLetter }] : []),
  ...p.answers.map(a => ({ pack: name, kind: 'answer', field: a.field, text: a.answer }))];

/** Mean, distribution 1-5, the worst five, lint counts. items: [{ score, phrases, lint: { banned, warn } }]. */
export function aggregate(items) {
  const scored = items.filter(i => Number.isInteger(i.score));
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; for (const i of scored) dist[i.score]++;
  const mean = scored.length ? scored.reduce((s, i) => s + i.score, 0) / scored.length : null;
  const worst = scored.map((x, i) => ({ x, i })).sort((p, q) => p.x.score - q.x.score || p.i - q.i).slice(0, 5).map(p => p.x);
  const lint = { banned: {}, warn: {} };
  for (const i of items) for (const k of ['banned', 'warn']) for (const id of i.lint?.[k] || []) lint[k][id] = (lint[k][id] || 0) + 1;
  return { scored: scored.length, mean, distribution: dist, worst, lint };
}

export async function voiceEval({ dir, judgeModel = null, call = callJson, date = today(), write = true, log = () => {} }) {
  const ref = voiceReference();
  if (!ref.card && !ref.samples) throw new Error('nothing to compare with: add profile/voice.md or your own texts in profile/voice-samples/*.md');
  const rules = profileRules(), model = judgeModel || SETTINGS.llm.pack_model || SETTINGS.llm.model;
  const items = [], skipped = [];
  for (const p of listPacks(dir)) for (const t of packTexts(p.name, readPack(p.dir))) {
    if (words(t.text) < MIN_WORDS) { skipped.push(t); continue; }
    const r = lintText(t.text, rules), item = { ...t, lint: { banned: [...new Set(r.errors.map(h => h.id))], warn: [...new Set(r.warns.map(h => h.id))] } };
    try {
      const { value } = await call({ prompt: voicePrompt(ref, t.field ? `${t.kind}: ${t.field}` : t.kind, t.text), schema: VOICE_SCHEMA, model });
      const s = Number(value?.score);
      if (!Number.isInteger(s) || s < 1 || s > 5) throw new Error(`the judge gave no score from 1 to 5 (${JSON.stringify(value).slice(0, 120)})`);
      Object.assign(item, { score: s, phrases: Array.isArray(value.phrases) ? value.phrases.map(String).slice(0, 5) : [], reason: String(value.reason || '') });
    } catch (e) { item.error = e.message; }
    items.push(item); log(`${t.pack} ${t.field || t.kind}: ${item.score ?? 'error'}`);
  }
  if (!items.length) throw new Error(`no cover letter or answer of ${MIN_WORDS}+ words in ${dir}`);
  const report = { date, dir, model, items, skipped: skipped.length, errors: items.filter(i => i.error).length, ...aggregate(items) };
  if (write) {
    const base = path.join(DATA, 'evals', `voice-report-${date}`); fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(`${base}.md`, voiceReportMd(report), 'utf8'); fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 1) + '\n', 'utf8');
    Object.assign(report, { md: `${base}.md`, json: `${base}.json` });
  }
  return report;
}

const cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
export function voiceReportMd(r) {
  const lintRows = k => Object.entries(r.lint[k]).sort((a, b) => b[1] - a[1]).map(([id, n]) => `- ${id}: ${n}`);
  return [`# Voice eval`, '', `${r.date}. Packs: ${r.dir}. Judge model: ${r.model || 'default'}. ${r.scored} texts scored, ${r.skipped} under ${MIN_WORDS} words skipped, ${r.errors} errors.`, '',
    `Mean score: ${r.mean == null ? 'n/a' : r.mean.toFixed(2)} of 5`, '', '| Score | Texts |', '|---|---|', ...[5, 4, 3, 2, 1].map(s => `| ${s} | ${r.distribution[s]} |`), '',
    '## The five least like you', '', r.worst.length ? r.worst.map(i => `- ${i.score}: ${cell(i.pack)}, ${cell(i.field || i.kind)}. ${cell(i.reason)}${i.phrases.length ? `\n  Phrases: ${i.phrases.map(p => `"${cell(p)}"`).join('; ')}` : ''}`).join('\n') : 'None.', '',
    '## Lint phrases in the same texts', '', 'Banned:', ...(lintRows('banned').length ? lintRows('banned') : ['- none']), '', 'Warnings:', ...(lintRows('warn').length ? lintRows('warn') : ['- none']), ''].join('\n');
}

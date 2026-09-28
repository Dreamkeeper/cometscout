#!/usr/bin/env node
// Application pack: for each of today's picks (or --file), build a targeted CV (PDF + DOCX) chosen from the
// candidate's vetted CV library, a cover letter when the form asks for one, and draft answers for every
// non-personal field of the application form (Ashby, Greenhouse, Lever forms are read automatically).
// The model selects CV items by id and writes only the tagline, summary, cover letter and answers; this script
// validates ids, checks text against profile/fact-rules.json, falls back to vetted text, renders, converts to PDF
// (LibreOffice, or Word on Windows) and sends to Telegram.
// Usage: node pack/pack.mjs [--file <queue file>]... [--force] [--no-telegram] [--rerender-dir <pack>] [--send-dir <pack>]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SETTINGS, PROFILE, DIRS, STATE, read, readJson, log, today as runDate } from '../lib/config.mjs';
import { callJson } from '../lib/llm.mjs';
import { loadJob, slug } from '../lib/queue.mjs';
import { sendText, sendFile, telegramOn } from '../lib/telegram.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const multi = n => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : []));
const OUT_ROOT = DIRS.packs;
const MODEL = SETTINGS.llm.pack_model || SETTINGS.llm.model;
const NO_TG = flag('no-telegram');
const today = runDate();   // the run's date in settings.timezone (pinned by cli.mjs run), same as the decoder's
const LIB = PROFILE.cvLibrary;
if (!LIB) { log('pack: profile/cv-library.json is missing; run the onboarding first'); process.exit(2); }
LIB.ai_work = LIB.ai_work || { heading: 'HIGHLIGHTS', items: [] };
// Check the library once, so a missing field is named here instead of printing "undefined" inside a CV.
{
  const miss = []; const need = (o, keys, where) => { for (const k of keys) if (o?.[k] == null || o[k] === '') miss.push(`${where}.${k}`); };
  need(LIB, ['name', 'contact'], 'cv-library');
  if (!Array.isArray(LIB.experience) || !LIB.experience.length) miss.push('cv-library.experience (a list)');
  (LIB.experience || []).forEach((e, i) => { need(e, ['key', 'company', 'dates'], `experience[${i}]`); if (!e.roles?.length) miss.push(`experience[${i}].roles`); (e.roles || []).forEach((r, j) => { need(r, ['title'], `experience[${i}].roles[${j}]`); (r.bullets || []).forEach((b, k) => need(b, ['id', 'text'], `experience[${i}].roles[${j}].bullets[${k}]`)); }); });
  (LIB.skills || []).forEach((x, i) => need(x, ['id', 'label', 'text'], `skills[${i}]`));
  (LIB.awards || []).forEach((x, i) => need(x, ['id', 'text'], `awards[${i}]`));
  (LIB.taglines || []).forEach((x, i) => need(x, ['id', 'text'], `taglines[${i}]`)); (LIB.summaries || []).forEach((x, i) => need(x, ['id', 'text'], `summaries[${i}]`));
  (LIB.ai_work.items || []).forEach((x, i) => need(x, ['id', 'text'], `ai_work.items[${i}]`));
  if (miss.length) { log(`pack: profile/cv-library.json is missing required fields: ${miss.join(', ')}`); process.exit(2); }
}
// Optional sections. education: an object {left, right}, a list of them, or absent/null for no EDUCATION section.
// awards: certifications, courses and awards; items with "required": true always appear; the heading is
// awards_heading (default "AWARDS & CERTIFICATIONS", e.g. "CERTIFICATIONS" if there are no awards).
LIB.awards = LIB.awards || [];
const EDU = (Array.isArray(LIB.education) ? LIB.education : LIB.education ? [LIB.education] : []).filter(e => e && (e.left || e.right));
const AWARDS_HEADING = LIB.awards_heading || 'AWARDS & CERTIFICATIONS';
const SCHEMA = JSON.parse(read(path.join(HERE, 'pack.schema.json')));
const VOICE = PROFILE.voice ? `## The candidate's voice (applies to every form answer and cover letter)\n\n${PROFILE.voice}` : '';
const PROMPT = read(path.join(HERE, 'prompt.md')).replace('{{NAME}}', SETTINGS.candidate_name).replace('{{PROFILE}}', PROFILE.facts || '').replace('{{VOICE}}', VOICE)
  .replace('{{CL_TEMPLATE}}', PROFILE.coverLetter ? `### Cover letter template\n\n${PROFILE.coverLetter}` : '');
const PERSON = String(LIB.file_name || LIB.name || 'Candidate').toLowerCase().replace(/(^|\s|-)\S/g, s => s.toUpperCase());
const PACKS_FILE = STATE('packs.json');

// ---------- application form readers ----------
const strip = h => String(h || '').replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
async function readForm(url) {
  try {
    let m = String(url).match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
    if (m) {
      const query = 'query ApiJobPosting($o: String!, $j: String!) { jobPosting(organizationHostedJobsPageName: $o, jobPostingId: $j) { title descriptionHtml applicationForm { sections { title fieldEntries { ... on FormFieldEntry { field isRequired descriptionHtml isHidden } } } } } }';
      const r = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: 'ApiJobPosting', variables: { o: m[1], j: m[2] }, query }), signal: AbortSignal.timeout(20000) });
      const p = (await r.json()).data?.jobPosting; if (!p) return null;
      const fields = p.applicationForm.sections.flatMap(s => s.fieldEntries.filter(e => e.field && !e.isHidden).map(e => ({
        label: e.field.title, type: e.field.type, required: !!e.isRequired, options: (e.field.selectableValues || []).map(v => v.label), description: strip(e.descriptionHtml).slice(0, 400) })));
      return { ats: 'ashby', fields, jd: strip(p.descriptionHtml) };
    }
    m = String(url).match(/greenhouse\.io\/(?:embed\/job_app\?for=|)([^/?#]+)\/jobs\/(\d+)/i) || String(url).match(/[?&]for=([^&]+).*[?&]token=(\d+)/) ;
    const gh = String(url).match(/[?&]gh_jid=(\d+)/);
    if (m || gh) {
      const board = m ? m[1] : null, id = m ? m[2] : gh[1];
      if (!board) return null;
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null; const j = await r.json();
      const fields = (j.questions || []).map(q => ({ label: q.label, type: (q.fields || []).map(f => f.type).join('/'), required: !!q.required,
        options: (q.fields || []).flatMap(f => (f.values || []).map(v => v.label)), description: strip(q.description).slice(0, 400) }));
      return { ats: 'greenhouse', fields, jd: strip(j.content ? j.content.replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '') };
    }
    m = String(url).match(/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i);
    if (m) {
      const r = await fetch(`https://jobs.lever.co/${m[1]}/${m[2]}/apply`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null; const h = await r.text();
      const fields = [...h.matchAll(/<div class="application-label[^"]*">([\s\S]*?)<\/div>[\s\S]*?<(input|textarea|select)[^>]*?(?:type="([a-z]+)")?/gi)]
        .map(x => ({ label: strip(x[1]).replace(/✱|\*/g, '').trim(), type: x[2] === 'textarea' ? 'LongText' : x[3] === 'file' ? 'File' : x[2], required: /✱|required/.test(x[1]), options: [], description: '' }))
        .filter(f => f.label);
      return { ats: 'lever', fields, jd: '' };
    }
  } catch (e) { log(`form read failed for ${url}: ${e.message}`); }
  return null;
}
function coverLetterNeed(form) {
  if (!form) return 'unknown-form';
  const f = form.fields.find(x => /cover letter|motivation letter|anschreiben|lettre de motivation/i.test(x.label));
  if (!f) return 'no';
  return /file/i.test(f.type) ? 'file' : 'text';
}

// ---------- model ----------
async function callModel(input) {
  const { value, cost } = await callJson({ prompt: input, schema: SCHEMA, model: MODEL, timeoutSec: 600 });
  if (!value || !value.cv) throw new Error('no CV in the model output');
  return { pack: value, cost };
}

// ---------- validation ----------
const index = (() => {
  const m = new Map();
  for (const a of LIB.ai_work.items) m.set(a.id, { ...a, where: 'ai' });
  for (const e of LIB.experience) e.roles.forEach((r, ri) => r.bullets.forEach(b => m.set(b.id, { ...b, where: e.key, role: ri })));
  for (const s of LIB.skills) m.set(s.id, { ...s, where: 'skills' });
  for (const a of LIB.awards) m.set(a.id, { ...a, where: 'awards' });
  return m;
})();
function validateCv(cv, flags) {
  const used = new Set(), groups = new Set();
  const keep = (id, where) => {
    const it = index.get(id);
    if (!it || (where && it.where !== where)) { flags.push(`Dropped unknown CV item "${id}".`); return false; }
    if (used.has(id)) return false;
    if (it.group && groups.has(it.group)) { flags.push(`Dropped "${id}": another variant of "${it.group}" is already used.`); return false; }
    used.add(id); if (it.group) groups.add(it.group); return true;
  };
  cv.ai_work_ids = (cv.ai_work_ids || []).filter(id => keep(id, 'ai'));
  const exp = [];
  for (const e of LIB.experience) {
    const sel = (cv.experience || []).find(x => x.key === e.key);
    const ids = (sel ? sel.bullet_ids : []).filter(id => keep(id, e.key));
    if (!ids.length && e.required) { const first = e.roles.flatMap(r => r.bullets).filter(b => !b.group || !groups.has(b.group)).slice(0, 2).map(b => b.id); first.forEach(id => keep(id, e.key)); ids.push(...first); flags.push(`${e.key}: no bullets chosen, used the first two vetted ones.`); }
    if (ids.length) exp.push({ key: e.key, bullet_ids: ids });
  }
  cv.experience = exp.sort((a, b) => LIB.experience.findIndex(e => e.key === a.key) - LIB.experience.findIndex(e => e.key === b.key));
  cv.skill_ids = (cv.skill_ids || []).filter(id => keep(id, 'skills'));
  for (const s of LIB.skills.filter(x => x.required)) if (!cv.skill_ids.includes(s.id)) cv.skill_ids.push(s.id);
  cv.award_ids = (cv.award_ids || []).filter(id => keep(id, 'awards'));
  for (const a of LIB.awards.filter(x => x.required)) if (!cv.award_ids.includes(a.id) && keep(a.id, 'awards')) cv.award_ids.push(a.id);
  const order = (cv.order || []).filter((x, i, a) => a.indexOf(x) === i && (x !== 'education' || EDU.length));
  for (const s of ['experience', 'skills', ...(EDU.length ? ['education'] : [])]) if (!order.includes(s)) order.push(s);
  if (cv.ai_work_ids.length && !order.includes('ai_work')) order.splice(order.indexOf('experience'), 0, 'ai_work');
  if (cv.award_ids.length && !order.includes('awards')) { const at = order.indexOf('education'); order.splice(at < 0 ? order.length : at, 0, 'awards'); }
  cv.order = order;
  return cv;
}

// ---------- text checks: profile/fact-rules.json plus two universal ones ----------
const BANNED = [[/\u2014/, 'em dash'], [/\b(he|his|him|she|her)\b/i, 'third person']];
function textIssues(t) {
  const out = [];
  for (const r of PROFILE.factRules) if (r.re.test(t)) out.push(`fact rule ${r.id}: ${r.why}`);
  for (const [re, what] of BANNED) if (re.test(t)) out.push(what);
  return out;
}
const dedash = t => String(t).replace(/\s*—\s*/g, ', ');

// ---------- rendering (same WordprocessingML as the master CV builds) ----------
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const P = (pPr, runs) => `<w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p>`;
const R = (rPr, t) => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const TAB = '<w:r><w:tab/></w:r>', TABS = '<w:tabs><w:tab w:val="right" w:pos="10512"/></w:tabs>';
const NAVY = '<w:color w:val="1F3D6B"/>', B = '<w:b/><w:bCs/>', SZ = n => `<w:sz w:val="${n}"/><w:szCs w:val="${n}"/>`;
const LI = '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="30"/>';
const cvx = {
  name: t => P('<w:spacing w:after="40"/>', R(B + NAVY + SZ(36), t)),
  tagline: t => P('<w:spacing w:after="40"/>', R(B + '<w:color w:val="444444"/>' + SZ(22), t)),
  contact: t => P('<w:spacing w:after="100"/>', R('<w:color w:val="1155CC"/>', t)),
  section: t => P('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="2E5C8A"/></w:pBdr><w:spacing w:before="120" w:after="60"/>', R(B + NAVY + SZ(22), t)),
  plain: t => P('<w:spacing w:after="60"/>', R('', t)),
  skill: (l, t) => P('<w:spacing w:after="30"/>', R(B, l + ':  ') + R('', t)),
  company: (l, r) => P(TABS + '<w:spacing w:before="70" w:after="30"/>', R(B + NAVY + SZ(22), l) + TAB + R(B + NAVY + SZ(22), r)),
  blurb: t => P('<w:spacing w:after="30"/>', R('<w:i/><w:iCs/><w:color w:val="444444"/>', t)),
  role: t => P('<w:spacing w:after="30"/>', R(B, t)),
  bullet: t => P(LI, R('', t)),
  bulletLead: (l, t) => P(LI, R(B, l) + R('', t)),
  edu: (l, r) => P(TABS + '<w:spacing w:after="30"/>', R('', l) + TAB + R('', r)),
};
function docXml(tplDir, paras, sect) {
  const raw = read(path.join(tplDir, 'word', 'document.xml'));
  return raw.substring(0, raw.indexOf('<w:body>') + 8) + paras.join('') + sect + '</w:body></w:document>';
}
// Layout rule: never split a CV section, or one company's experience, across pages when two pages have room.
// Every paragraph of a block gets keepNext (except the last) and keepLines, so Word and LibreOffice move the
// whole block to the next page instead of breaking it. keepNext goes right after pStyle (schema order).
// Levels: 2 = sections + company blocks whole, 1 = company blocks only, 0 = normal flow; layoutCv picks the
// strictest level that fits two pages. A section heading always stays with what follows it.
const keep = (p, next) => p.replace(/<w:pPr>(<w:pStyle [^>]*\/>)?/, (m, s) => `<w:pPr>${s || ''}${next ? '<w:keepNext/>' : ''}<w:keepLines/>`);
const keepBlock = paras => paras.map((p, i) => keep(p, i < paras.length - 1));
function renderCv(cv, { level = 2 } = {}) {
  const out = [cvx.name(LIB.name), cvx.tagline(cv.tagline), cvx.contact(LIB.contact)];
  const add = block => out.push(...(level >= 2 ? keepBlock(block) : [keep(block[0], true), ...block.slice(1)]));
  add([cvx.section('PROFESSIONAL SUMMARY'), cvx.plain(cv.summary)]);
  for (const sec of cv.order) {
    if (sec === 'ai_work' && cv.ai_work_ids.length) add([cvx.section(LIB.ai_work.heading), ...cv.ai_work_ids.map(id => { const it = index.get(id); return cvx.bulletLead(it.lead, it.text); })]);
    if (sec === 'experience') {
      out.push(keep(cvx.section('PROFESSIONAL EXPERIENCE'), true));
      for (const e of cv.experience) {
        const lib = LIB.experience.find(x => x.key === e.key);
        const block = [cvx.company(lib.company, lib.dates)]; if (lib.blurb) block.push(cvx.blurb(lib.blurb));
        lib.roles.forEach((r, ri) => { const ids = e.bullet_ids.filter(id => index.get(id).role === ri); if (!ids.length) return; block.push(cvx.role(r.title)); ids.forEach(id => block.push(cvx.bullet(index.get(id).text))); });
        out.push(...(level >= 1 ? keepBlock(block) : block));
      }
    }
    if (sec === 'skills') add([cvx.section('SKILLS'), ...cv.skill_ids.map(id => { const s = index.get(id); return cvx.skill(s.label, s.text); })]);
    if (sec === 'awards' && cv.award_ids.length) add([cvx.section(AWARDS_HEADING), ...cv.award_ids.map(id => cvx.bullet(index.get(id).text))]);
    if (sec === 'education' && EDU.length) add([cvx.section('EDUCATION'), ...EDU.map(e => cvx.edu(e.left || '', e.right || ''))]);
  }
  const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="620" w:right="864" w:bottom="620" w:left="864" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';
  return docXml(path.join(HERE, 'templates', 'tpl_cv'), out, sect);
}
function renderCl(blocks) {
  const FONT = '<w:rFonts w:ascii="Roboto Light" w:hAnsi="Roboto Light" w:cs="Roboto Light"/>', S = '<w:sz w:val="22"/><w:szCs w:val="22"/>';
  const r = (x, t) => `<w:r><w:rPr>${FONT}${x}${S}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const PARA = '<w:jc w:val="both"/><w:spacing w:before="40" w:after="100" w:line="260" w:lineRule="auto"/>';
  const BUL = '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:jc w:val="both"/><w:spacing w:before="20" w:after="20" w:line="260" w:lineRule="auto"/>';
  const paras = blocks.map(b => b.kind === 'bullet' ? `<w:p><w:pPr>${BUL}</w:pPr>${r('', b.text)}</w:p>` : `<w:p><w:pPr>${PARA}</w:pPr>${r(b.kind === 'sign' ? '<w:b/><w:bCs/>' : '', b.text)}</w:p>`);
  const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';
  return docXml(path.join(HERE, 'templates', 'tpl_cl'), paras, sect);
}
function writeDocx(tpl, xml, outPath) {
  const tmp = path.join(os.tmpdir(), `apply-pack-${process.pid}-${Date.now()}.xml`); fs.writeFileSync(tmp, xml, 'utf8');
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const r = spawnSync(py, [path.join(HERE, 'pack.py'), path.join(HERE, 'templates', tpl), tmp, outPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.rmSync(tmp, { force: true });
  if (r.status !== 0) throw new Error(`pack.py failed: ${r.stderr || r.stdout}`);
}
function toPdf(docx) {
  const pdf = docx.replace(/\.docx$/, '.pdf');
  if (process.platform === 'win32' && !process.env.SOFFICE && SETTINGS.pack.pdf !== 'libreoffice') {
    const ps = `$ErrorActionPreference='Stop'; $w=New-Object -ComObject Word.Application; $w.Visible=$false; $w.DisplayAlerts=0; try { $d=$w.Documents.Open('${docx.replace(/'/g, "''")}', $false, $true); $d.SaveAs2('${pdf.replace(/'/g, "''")}', 17); $d.Close($false) } finally { $w.Quit() }`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0 || !fs.existsSync(pdf)) throw new Error(`Word PDF export failed: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
  } else {
    const bin = process.env.SOFFICE || SETTINGS.pack.soffice || 'soffice';
    // one LibreOffice profile per process: two runs at once must not fight over one locked profile
    const prof = `file://${path.join(os.tmpdir(), `jobpilot-lo-profile-${process.pid}`)}`;
    const r = spawnSync(bin, [`-env:UserInstallation=${prof}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', path.dirname(docx), docx], { encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0 || !fs.existsSync(pdf)) throw new Error(`LibreOffice PDF export failed: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
  }
  const pages = (fs.readFileSync(pdf, 'latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
  return { pdf, pages };
}

// ---------- one pack ----------
// File-name part: at most 80 bytes (ext4 allows 255 bytes per name; Cyrillic takes 2 bytes a letter).
const safe = s => { let t = String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim(); while (Buffer.byteLength(t) > 80) t = t.slice(0, -1); return t.trim(); };
async function buildPack(file) {
  const job = loadJob(file);
  const { fm } = job;
  const form = await readForm(fm.url);
  const clNeed = coverLetterNeed(form);
  const personal = /^(name|full name|first name|last name|e-?mail|phone|phone number|mobile|resume|cv|linkedin|your linkedin|linkedin profile|address|date of birth|gender|pronouns)\b/i;
  const fields = form ? form.fields.filter(f => !personal.test(f.label.trim()) && !/file/i.test(f.type)) : [];
  const jd = job.body.length >= 600 ? job.body : (form?.jd || job.body);
  const request = [
    PROMPT, '', '## CV library (select ids from here)', JSON.stringify(LIB),
    '', '## Request', `Company: ${fm.company}`, `Role: ${fm.role}`, `Location on the posting: ${fm.location || '?'}`, `Link: ${fm.url}`,
    `cover_letter_needed: ${clNeed}`,
    '', '## Decode (the pipeline\'s assessment of this role)', job.decode.slice(0, 3000),
    '', '## Application form fields to answer', form ? (fields.length ? fields.map(f => `- ${f.label} [${f.type}${f.required ? ', required' : ''}]${f.options.length ? ` options: ${f.options.join(' / ')}` : ''}${f.description ? `\n  guidance: ${f.description}` : ''}`).join('\n') : '(none beyond personal data and uploads)') : '(the form could not be read: answer nothing, set answers to [])',
    '', '## Job description', jd.slice(0, 14000),
  ].join('\n');
  log(`${file}: form ${form ? `${form.ats}, ${form.fields.length} fields` : 'unreadable'}, cover letter ${clNeed}; calling ${MODEL}`);
  const t0 = Date.now();
  const { pack, cost } = await callModel(request);
  const modelMs = Date.now() - t0;
  const raw = JSON.parse(JSON.stringify(pack));
  const flags = [...(pack.flags || [])];

  // CV: validate selection, check the two model-written texts, fall back to vetted text on problems
  const cv = validateCv(pack.cv, flags);
  // The model sometimes returns a library id ("t-ai", "s-hw") instead of text: resolve it to the vetted text.
  const byId = (list, v) => (list.find(x => x.id === String(v || '').trim()) || {}).text;
  cv.tagline = byId(LIB.taglines, cv.tagline) || cv.tagline; cv.summary = byId(LIB.summaries, cv.summary) || cv.summary;
  if (/^[a-z]{1,3}-[a-z-]+$/.test(String(cv.tagline).trim())) { flags.push(`Tagline was an unknown id (${cv.tagline}); vetted tagline used.`); cv.tagline = ''; }
  cv.tagline = dedash(cv.tagline || ''); cv.summary = dedash(cv.summary || '');
  const aiFirst = cv.order.indexOf('ai_work') >= 0 && cv.order.indexOf('ai_work') < cv.order.indexOf('experience');
  const pick = list => (list.find(x => !!x.ai === aiFirst) || list[0] || {}).text || '';
  for (const [k, fb] of [['tagline', pick(LIB.taglines)], ['summary', pick(LIB.summaries)]]) {
    const issues = textIssues(cv[k]);
    if (!cv[k] || issues.length) { flags.push(`CV ${k} replaced with the vetted version (${issues.join('; ') || 'empty'}).`); cv[k] = fb; }
  }
  const xml = renderCv(cv);
  // one folder per role (two roles at one company must not share answers.md / pack.json)
  const dir = path.join(OUT_ROOT, `${today}--${slug(fm.company)}--${slug(fm.role)}`); fs.mkdirSync(dir, { recursive: true });
  const base = `${PERSON} CV - ${safe(fm.company)} (${safe(fm.role)})`;
  const cvDocx = path.join(dir, `${base}.docx`); writeDocx('tpl_cv', xml, cvDocx);
  // PACK_NO_PDF=1 (evals): keep the DOCX only; page counts are taken later in one pass.
  const NO_PDF = !!process.env.PACK_NO_PDF;
  // A PDF failure (no LibreOffice, a locked profile) must not lose the drafted answers: keep the DOCX and flag it.
  let cvPdf = { pdf: null, pages: null };
  if (!NO_PDF) try { cvPdf = layoutCv(cv, cvDocx); } catch (e) { flags.push(`CV PDF export failed, send the DOCX or export it yourself: ${e.message.slice(0, 160)}`); }
  if (cvPdf.level === 1) flags.push('A CV section splits across pages: keeping every section whole would have made a third page.');
  if (cvPdf.level === 0) flags.push('A company block splits across pages: keeping it whole would have made a third page.');
  if (cvPdf.pages > 2) flags.push(`CV is ${cvPdf.pages} pages: trim before sending.`);
  const files = cvPdf.pdf ? [cvPdf.pdf] : [];

  // Cover letter
  let clText = '';
  if (clNeed !== 'no' && pack.cover_letter?.blocks?.length) {
    const blocks = pack.cover_letter.blocks.map(b => ({ ...b, text: dedash(b.text) }));
    const issues = [...new Set(blocks.flatMap(b => textIssues(b.text)))];
    if (issues.length) flags.push(`Cover letter needs a look: ${issues.join('; ')}.`);
    clText = blocks.map(b => (b.kind === 'bullet' ? `- ${b.text}` : b.text)).join('\n\n');
    if (clNeed !== 'text') {
      const clDocx = path.join(dir, `${PERSON} CL - ${safe(fm.company)} (${safe(fm.role)}).docx`);
      writeDocx('tpl_cl', renderCl(blocks), clDocx); let cl = { pdf: null, pages: 0 }; if (!NO_PDF) try { cl = toPdf(clDocx); } catch (e) { flags.push(`Cover letter PDF export failed, use the DOCX: ${e.message.slice(0, 160)}`); } if (cl.pages > 1) flags.push(`Cover letter is ${cl.pages} pages.`); if (cl.pdf) files.push(cl.pdf);
    }
  } else if (clNeed !== 'no') flags.push('The model returned no cover letter.');

  // Answers
  const answers = (pack.answers || []).map(a => ({ ...a, answer: dedash(a.answer) }));
  for (const a of answers) { const iss = textIssues(a.answer); if (iss.length) flags.push(`Answer "${a.field}": ${iss.join('; ')}.`); }
  const md = [`# ${fm.company}: ${fm.role}`, '', `Link: ${fm.url}`, `Built ${today} by jobpilot (${SETTINGS.llm.provider}/${MODEL}${cost ? `, USD ${cost.toFixed(2)}` : ''}). Form: ${form ? form.ats : 'not readable, open the link'}. Cover letter: ${clNeed}.`, '',
    `**CV leads with:** ${pack.positioning}`, '', '## Check before sending', ...(flags.length ? flags.map(f => `- ${f}`) : ['- nothing flagged']), '',
    '## Form answers (drafts)', ...(answers.length ? answers.flatMap(a => [`### ${a.field}${a.own_words ? ' (rewrite in your own words)' : ''}`, '', a.answer, ...(a.note ? [`_${a.note}_`] : []), '']) : ['(no fields to draft)', '']),
    ...(clNeed === 'text' && clText ? ['## Cover letter (paste as text)', clText, ''] : []),
    `Files: ${files.map(f => path.basename(f)).join(', ')}`].join('\n');
  fs.writeFileSync(path.join(dir, 'answers.md'), md, 'utf8');
  // Machine-readable record for evals and debugging: what the model returned, what was kept, what was flagged.
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ model: MODEL, built: new Date().toISOString(), model_ms: modelMs, cost_usd: cost, form: form ? form.ats : null, cover_letter: clNeed,
    pages: cvPdf.pages, raw, cv, flags, answers }, null, 2), 'utf8');
  return { file, fm, dir, files, md, flags, answers, clNeed, clText, form };
}

// answers.md -> plain Telegram text: headings become marked lines, each question separated from its answer by a blank line.
function mdToText(md) {
  return md.replace(/\r\n/g, '\n').replace(/^# (.*)$/m, 'Application pack: $1')
    .replace(/^## (.*)$/gm, '■ $1').replace(/^### (.*)\n(?!\n)/gm, '▸ $1\n\n').replace(/^### (.*)$/gm, '▸ $1')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/^_(.+)_$/gm, '($1)').replace(/\n{3,}/g, '\n\n');
}

// Render the CV with the strictest keep level that still fits two pages; ties go to the stricter level.
function layoutCv(cv, docx) {
  let best = null, last = null;
  for (const level of [2, 1, 0]) {
    writeDocx('tpl_cv', renderCv(cv, { level }), docx); const r = toPdf(docx); last = level;
    if (!best || r.pages < best.pages) best = { ...r, level };
    if (r.pages <= 2) break;
  }
  if (last !== best.level) { writeDocx('tpl_cv', renderCv(cv, { level: best.level }), docx); best = { ...toPdf(docx), level: best.level }; }
  return best;
}

// ---------- main ----------
// --rerender-dir <pack dir>: rebuild the CV DOCX + PDF from the pack's saved pack.json (same content, current layout rules)
for (const d of multi('rerender-dir')) {
  const dir = path.isAbsolute(d) ? d : path.join(OUT_ROOT, d);
  const pj = JSON.parse(read(path.join(dir, 'pack.json')));
  const docx = path.join(dir, fs.readdirSync(dir).find(f => f.startsWith(`${PERSON} CV`) && f.endsWith('.docx')));
  const r = layoutCv(pj.cv, docx);
  log(`re-rendered ${path.basename(docx)}: ${r.pages} page(s), keep level ${r.level}`);
}
if (multi('rerender-dir').length && !multi('send-dir').length) process.exit(0);
const sendDirs = multi('send-dir');
if (sendDirs.length) {
  if (!telegramOn()) { log('Telegram is not configured (settings.delivery.telegram + .env)'); process.exit(2); }
  for (const d of sendDirs) {
    const dir = path.isAbsolute(d) ? d : path.join(OUT_ROOT, d);
    await sendText('📎 ' + mdToText(read(path.join(dir, 'answers.md'))));
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.pdf')).sort()) await sendFile(path.join(dir, f), f);
    log(`sent ${dir}`);
  }
  process.exit(0);
}
const packs = readJson(PACKS_FILE, {});
let targets = multi('file');
if (!targets.length) {
  const picks = readJson(STATE('picks.json'), {});
  targets = Object.entries(picks).filter(([, v]) => v.last === today).map(([f]) => f);
}
targets = targets.filter(f => flag('force') || !packs[f]);
if (!targets.length) { log('no picks to pack'); process.exit(0); }
let failed = 0;
for (const f of targets) {
  try {
    const r = await buildPack(f);
    packs[f] = { built: today, dir: path.basename(r.dir) };
    fs.writeFileSync(PACKS_FILE, JSON.stringify(packs, null, 2), 'utf8');
    log(`${f}: pack in ${r.dir} (${r.files.length} file(s), ${r.answers.length} answer(s), ${r.flags.length} flag(s))`);
    if (!NO_TG && telegramOn()) {
      const head = [`📎 Application pack: ${r.fm.company}, ${r.fm.role}`, r.fm.url, '', ...(r.flags.length ? ['Check before sending:', ...r.flags.map(x => `• ${x}`), ''] : [])];
      const ans = r.answers.map(a => `▸ ${a.field}${a.own_words ? ' (your words)' : ''}\n\n${a.answer}`);
      await sendText([...head, ...(ans.length ? ['Form answers:', '', ans.join('\n\n')] : [r.form ? 'No form questions beyond personal data.' : 'Form not readable: open the link.']), ...(r.clNeed === 'text' && r.clText ? ['', 'Cover letter (paste as text):', '', r.clText] : [])].join('\n'));
      for (const file of r.files) await sendFile(file, path.basename(file));
    }
  } catch (e) { failed++; log(`${f}: FAILED ${e.message}`); }
}
process.exitCode = failed ? 1 : 0;

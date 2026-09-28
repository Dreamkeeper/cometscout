// The queue: one Markdown file per job in data/inbox -> decoded/ or rejected/ (with a "## Decode Result" block appended).
// Sources write files with writeJob(); the decoder reads them with loadJob().
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, read, today } from './config.mjs';

export const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9а-яё]+/g, ' ').trim();
export const slug = s => norm(s).replace(/\s+/g, '-').slice(0, 60) || 'unknown';

export function frontMatter(txt) {
  const m = txt.match(/^---\n([\s\S]*?)\n---/); const fm = {};
  if (m) for (const l of m[1].split('\n')) { const k = l.match(/^([a-z_]+):\s*(.*)$/i); if (k) fm[k[1]] = k[2].replace(/^"|"$/g, '').replace(/\\"/g, '"'); }
  return fm;
}
/**
 * Whole-word, case-insensitive match of any term in `list` against `hay` (titles, locations).
 * "soc" matches "SOC Analyst" but not "Associate"; phrases match as a unit ("product manager").
 * A trailing * matches word prefixes: "engineer*" matches "engineering". Works for Cyrillic too.
 */
export function matchesAny(hay, list) {
  const h = String(hay || '');
  return (list || []).some(t => {
    const term = String(t || '').trim(); if (!term) return false;
    const star = term.endsWith('*');
    const body = (star ? term.slice(0, -1) : term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}${star ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu').test(h);
  });
}
const q = v => `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;

/** Company + role seen before in any queue folder (same company, most role words shared)? */
export function alreadyQueued(company, role) {
  const c = norm(company), words = new Set(norm(role).split(' ').filter(w => w.length > 2));
  for (const dir of ['inbox', 'decoded', 'rejected']) for (const f of fs.readdirSync(DIRS[dir])) {
    if (!f.endsWith('.md') || !f.includes(`--${slug(company)}--`)) continue;
    const fm = frontMatter(read(path.join(DIRS[dir], f)));
    if (norm(fm.company) !== c) continue;
    const w2 = new Set(norm(fm.role).split(' ').filter(w => w.length > 2)); let hit = 0; for (const w of words) if (w2.has(w)) hit++;
    if (!words.size || hit / Math.max(1, Math.min(words.size, w2.size)) >= 0.7) return `${dir}/${f}`;
  }
  return null;
}

/** Write one job to the inbox. job: { company, role, url, source, location, headcount?, salary?, posted?, notes?, text } */
export function writeJob(job) {
  const dup = alreadyQueued(job.company, job.role);
  if (dup) return { written: false, reason: `already in ${dup}` };
  let file = `${today()}--${slug(job.company)}--${slug(job.role)}.md`;
  for (let i = 2; fs.existsSync(path.join(DIRS.inbox, file)); i++) file = file.replace(/(-\d+)?\.md$/, `-${i}.md`);
  const fields = ['company', 'role', 'url', 'source', 'location', 'headcount', 'salary', 'posted', 'notes'];
  const body = ['---', ...fields.filter(f => job[f] != null && job[f] !== '').map(f => `${f}: ${q(job[f])}`), `found: ${today()}`, ...(job.text ? [] : ['full_text: "missing"']), '---', '',
    `# ${job.company} - ${job.role}`, '', (job.text || '_No job text could be fetched; open the link._').trim(), ''].join('\n');
  fs.writeFileSync(path.join(DIRS.inbox, file), body, 'utf8');
  return { written: true, file };
}

export function loadJob(file) {
  const p = ['inbox', 'decoded', 'rejected'].map(d => path.join(DIRS[d], file)).find(fs.existsSync);
  if (!p) throw new Error(`queue file not found: ${file}`);
  const txt = read(p); const fm = frontMatter(txt);
  const rest = txt.replace(/^---\n[\s\S]*?\n---\n?/, ''); const cut = rest.lastIndexOf('## Decode Result');
  return { file, path: p, fm, text: txt, body: (cut >= 0 ? rest.slice(0, cut) : rest).trim(), decode: cut >= 0 ? rest.slice(cut) : '' };
}

export function parseResult(txt) {
  const b = txt.slice(txt.lastIndexOf('## Decode Result'));
  const g = k => (b.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1];
  const vm = (g('verdict') || '').match(/^([a-z-]+)(?: \((.*)\))?$/) || [];
  return { verdict: vm[1], gate: vm[2], confidence: g('confidence'), apply_priority: g('apply_priority') ? Number(g('apply_priority')) : undefined,
    rationale: g('rationale') || '', action: g('action') || '', hold_reason: g('hold_reason'), decoded_on: (b.match(/Decoded (\d{4}-\d{2}-\d{2})/) || [])[1] };
}

/** Strip HTML to readable text. */
export const htmlText = h => String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|li|div|h\d|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

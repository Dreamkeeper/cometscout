// A small, valid PDF made of text lines (Helvetica, A4), for the workspace demo data and test fixtures.
// No imports. Characters outside Latin-1 become "?"; lines longer than the page are wrapped at spaces.

const esc = s => String(s).replace(/[\\()]/g, m => `\\${m}`).replace(/[^\x20-\x7e]/g, c => { const n = c.charCodeAt(0); return n >= 0xa0 && n <= 0xff ? `\\${n.toString(8).padStart(3, '0')}` : '?'; });
/** Wrap one line to at most `max` characters, at spaces. */
export function wrap(text, max) {
  const out = []; let line = '';
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + w).length > max) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  return line || !out.length ? [...out, line] : out;
}

/**
 * lines: [{ text, size = 10, bold = false, gap = 0 }] (gap: extra space above, in points). Returns a Buffer.
 * Pages break by themselves; every offset in the cross-reference table is exact, so viewers open it without repair.
 */
export function textPdf(lines, { title = 'Document' } = {}) {
  const W = 595, H = 842, M = 56;
  const pages = [[]]; let y = H - M;
  for (const l of lines) {
    const size = l.size || 10, lead = size * 1.35, max = Math.floor((W - 2 * M) / (size * 0.5));
    y -= l.gap || 0;
    for (const part of wrap(l.text ?? '', max)) {
      if (y - lead < M) { pages.push([]); y = H - M; }
      y -= lead;
      pages[pages.length - 1].push(`BT /${l.bold ? 'F2' : 'F1'} ${size} Tf ${M} ${y.toFixed(1)} Td (${esc(part)}) Tj ET`);
    }
  }
  const objs = [];   // index + 1 = object number
  const add = s => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const ops of pages) {
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(title)}) /Producer (CometScout) >>`);
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// tools/workspace-demo.mjs and tools/text-pdf.mjs: the demo writes a complete data folder (decodes, today's picks,
// packs with valid PDFs) only into an empty folder; the PDF writer's cross-reference offsets are exact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { textPdf, wrap } from '../tools/text-pdf.mjs';
import { writeDemo } from '../tools/workspace-demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every object the xref table lists starts at its offset ("N 0 obj"); startxref points at "xref". */
function checkPdf(buf) {
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.endsWith('%%EOF\n'));
  const start = Number(s.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  assert.equal(s.slice(start, start + 4), 'xref');
  const [, count] = s.slice(start).match(/^xref\n0 (\d+)\n/);
  const rows = s.slice(start).split('\n').slice(3, 2 + Number(count));
  rows.forEach((row, i) => { const off = Number(row.slice(0, 10)); assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1}`); });
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) assert.equal(s.slice(m.index + m[0].length + Number(m[1]), m.index + m[0].length + Number(m[1]) + 10), '\nendstream');
  return s;
}

test('textPdf: a valid PDF; pages break by themselves; Latin-1 is kept, other characters become "?"', () => {
  const one = checkPdf(textPdf([{ text: 'Café (draft) \\ test', bold: true }, { text: 'Привет' }], { title: 'T' }));
  assert.match(one, /\(Caf\\351 \\\(draft\\\) \\\\ test\) Tj/);
  assert.match(one, /\(\?\?\?\?\?\?\) Tj/);
  assert.match(one, /\/Count 1 >>/);
  const many = checkPdf(textPdf(Array.from({ length: 120 }, (_, i) => ({ text: `Line ${i}` }))));
  assert.match(many, /\/Count 3 >>/);
  assert.deepEqual(wrap('aa bb cc dd', 5), ['aa bb', 'cc dd']);
  assert.deepEqual(wrap('', 5), ['']);
  checkPdf(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'workspace', 'tiny.pdf')));
});

test('writeDemo: decodes, two picks for today, packs with valid PDFs; refuses a folder that is not empty', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-demo-'));
  const now = new Date('2026-10-02T09:00:00Z');
  const r = await writeDemo(out, { now });
  assert.equal(Object.keys(r.files).length, 6);
  assert.equal(r.picks.length, 2);
  const picks = JSON.parse(fs.readFileSync(path.join(out, 'state', 'picks.json'), 'utf8'));
  assert.deepEqual(Object.entries(picks).filter(([, v]) => v.last === '2026-10-02').map(([f]) => f), [r.files.voltaic, r.files.cargolane]);
  for (const f of Object.values(r.files)) {
    const t = fs.readFileSync(path.join(out, 'decoded', f), 'utf8');
    assert.match(t, /^---\ncompany: "/);
    assert.match(t, /\n## Decode Result\nDecoded \d{4}-\d{2}-\d{2} by CometScout/);
    assert.doesNotMatch(t, /\u2014/, 'no em dashes');
  }
  const packs = JSON.parse(fs.readFileSync(path.join(out, 'state', 'packs.json'), 'utf8'));
  assert.deepEqual(Object.keys(packs).sort(), [r.files.cargolane, r.files.voltaic].sort());
  for (const { dir } of Object.values(packs)) {
    const files = fs.readdirSync(path.join(out, 'packs', dir));
    assert.ok(files.includes('answers.md') && files.includes('pack.json'));
    const pdf = files.find(f => f.endsWith('.pdf'));
    assert.match(pdf, /^Alex Rivera CV - /, 'the example candidate, from profile.example');
    assert.match(checkPdf(fs.readFileSync(path.join(out, 'packs', dir, pdf))), /\(ALEX RIVERA\) Tj/);
  }
  const old = r.packs.find(d => d.endsWith('--meshwork-systems'));
  assert.ok(old, 'an older-style pack: <date>--<company>');
  assert.deepEqual(fs.readdirSync(path.join(out, 'packs', old)), ['answers.md'], 'answers.md only, no pack.json');
  const apps = JSON.parse(fs.readFileSync(path.join(out, 'state', 'applications.json'), 'utf8'));
  assert.equal(apps[r.files.tidewater].events[0].until, '2026-10-05');
  await assert.rejects(writeDemo(out, { now }), /is not empty/);
  await writeDemo(out, { now, force: true });
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'workspace-demo.mjs')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /^Usage: node tools\/workspace-demo\.mjs --out/);
});

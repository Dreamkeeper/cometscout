// lib/zip.mjs: CRC-32, round trips (binary, UTF-8 names, empty, streamed, ZIP64), the system unzip / PowerShell
// opening our zips, our reader opening the system zip's, and refusals (CRC, zip slip, symlinks, methods).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ZipWriter, readZip, readEntry, extractEntry, extractZip, entryPath, crc32, unsafeName, CP437_HIGH } from '../lib/zip.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-zip-'));
const at = (...p) => path.join(tmp, ...p);
// Names are compared as zip names, always with "/"
const NAMES = { bin: 'data/packs/2026-09-01--acme/cv.pdf', ru: 'data/packs/Резюме/письмо.md', ja: 'profile/日本語/メモ.txt', empty: 'data/state/empty.json' };
const BIN = crypto.randomBytes(200000);                                  // does not shrink: STORE
const TEXT = Buffer.from('Строка текста, line of text, 行のテキスト\n'.repeat(3000));   // shrinks: DEFLATE
fs.writeFileSync(at('bin'), BIN); fs.writeFileSync(at('text'), TEXT); fs.writeFileSync(at('empty'), '');

async function build(file, opts) {
  const z = await ZipWriter.open(file, opts);
  await z.addFile(NAMES.bin, at('bin')); await z.addFile(NAMES.ru, at('text')); await z.addFile(NAMES.empty, at('empty'));
  z.addBuffer(NAMES.ja, 'メモ'); await z.close();
  return file;
}
const has = (cmd, args = ['--version']) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return !r.error && r.status === 0; };
const UTF8_ENV = { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' };
function checkTree(dir) {
  assert.ok(fs.readFileSync(path.join(dir, ...NAMES.bin.split('/'))).equals(BIN));
  assert.ok(fs.readFileSync(path.join(dir, ...NAMES.ru.split('/'))).equals(TEXT));
  assert.equal(fs.readFileSync(path.join(dir, ...NAMES.ja.split('/')), 'utf8'), 'メモ');
  assert.equal(fs.statSync(path.join(dir, ...NAMES.empty.split('/'))).size, 0);
}

test('CRC-32 matches the standard check value, also in chunks', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.from('6789'), crc32(Buffer.from('12345'))), 0xCBF43926);
  assert.equal(CP437_HIGH.length, 128);
});

for (const [label, opts] of [['in memory', {}], ['streamed', { streamOver: 0 }]]) {
  test(`round trip, ${label}: binary, Cyrillic and Japanese names, an empty file`, async () => {
    const f = await build(at(`rt-${label}.zip`), opts);
    const zip = readZip(f);
    assert.deepEqual(zip.entries.map(e => e.name), [NAMES.bin, NAMES.ru, NAMES.empty, NAMES.ja]);
    const by = Object.fromEntries(zip.entries.map(e => [e.name, e]));
    assert.equal(by[NAMES.bin].method, 0, 'random bytes are stored');
    assert.equal(by[NAMES.ru].method, 8, 'text is deflated');
    assert.ok(by[NAMES.ru].csize < TEXT.length / 4);
    const out = at(`rt-${label}`); await extractZip(f, out); checkTree(out);
  });
}

test('ZIP64 records are written past the (lowered) limits and read back', async () => {
  const f = await build(at('z64.zip'), { streamOver: 0, limit32: 64, limit16: 2 });
  const raw = fs.readFileSync(f);
  const sig = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return raw.indexOf(b) >= 0; };
  assert.ok(sig(0x06064b50) && sig(0x07064b50), 'ZIP64 end record and locator');
  const end = raw.subarray(raw.length - 22);
  assert.equal(end.readUInt16LE(10), 0xFFFF); assert.equal(end.readUInt32LE(16), 0xFFFFFFFF);
  assert.equal(readZip(f).entries.length, 4);
  const out = at('z64'); await extractZip(f, out); checkTree(out);
  if (has('unzip', ['-v'])) { const r = spawnSync('unzip', ['-t', f], { encoding: 'utf8', env: UTF8_ENV }); assert.equal(r.status, 0, r.stdout + r.stderr); }
});

test('the system unzip opens a zip written here', async t => {
  if (!has('unzip', ['-v'])) { t.skip('no unzip on this system'); return; }
  const f = await build(at('sys.zip'), {});
  const out = at('sys-unzip');
  const r = spawnSync('unzip', ['-q', '-o', f, '-d', out], { encoding: 'utf8', env: UTF8_ENV });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  checkTree(out);
});

test('PowerShell Expand-Archive opens a zip written here', async t => {
  const ps = process.platform === 'win32' ? 'powershell' : 'pwsh';
  if (!has(ps, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'])) { t.skip(`no ${ps} on this system`); return; }
  const f = await build(at('ps.zip'), {}); const out = at('ps-expand');
  const r = spawnSync(ps, ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${f}' -DestinationPath '${out}' -Force`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  checkTree(out);
});

test('a zip made by the system zip tool reads back', async t => {
  const src = at('sysmade'); fs.mkdirSync(path.join(src, 'docs'), { recursive: true });
  const win = process.platform === 'win32';
  // Windows: tar.exe (bsdtar) writes zips with "/" names; ASCII names only, its name encoding depends on the code page
  const files = win ? { 'docs/notes.txt': TEXT, 'bin.dat': BIN } : { 'docs/Заметки.txt': TEXT, 'bin.dat': BIN, 'docs/日本.txt': Buffer.from('日本') };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(src, ...n.split('/')), b);
  const f = at('sysmade.zip');
  const r = win ? spawnSync('tar', ['-a', '-c', '-f', f, ...Object.keys(files)], { cwd: src, encoding: 'utf8' })
    : has('zip', ['-v']) ? spawnSync('zip', ['-q', '-r', f, ...Object.keys(files)], { cwd: src, encoding: 'utf8', env: UTF8_ENV }) : null;
  if (!r || r.error || r.status !== 0) { t.skip(win ? 'tar.exe could not write a zip here' : 'no zip on this system'); return; }
  const zip = readZip(f);
  assert.deepEqual(zip.entries.filter(e => !e.dir).map(e => e.name).sort(), Object.keys(files).sort());
  for (const e of zip.entries.filter(x => !x.dir)) assert.ok((await readEntry(zip, e)).equals(files[e.name]), e.name);
});

test('a damaged entry is refused by its CRC and leaves no file behind', async () => {
  const f = at('crc.zip'); const z = await ZipWriter.open(f); z.addBuffer('a.bin', BIN.subarray(0, 1000)); await z.close();
  const raw = fs.readFileSync(f); raw[30 + 'a.bin'.length + 500] ^= 0xFF; fs.writeFileSync(f, raw);
  const zip = readZip(f); const to = at('crc-out', 'a.bin');
  await assert.rejects(extractEntry(zip, zip.entries[0], to), /CRC mismatch/);
  assert.ok(!fs.existsSync(to));
  assert.deepEqual(fs.existsSync(path.dirname(to)) ? fs.readdirSync(path.dirname(to)) : [], [], 'no temporary file left');
});

test('zip slip names, symlinks, encryption and unknown methods are refused before anything is written', async () => {
  const make = async (name, opts = {}) => { const f = at(`bad-${crypto.randomBytes(4).toString('hex')}.zip`); const z = await ZipWriter.open(f); z.addBuffer(name, 'x', opts); await z.close(); return f; };
  const patch = (f, from, to) => { const raw = fs.readFileSync(f); let i; while ((i = raw.indexOf(Buffer.from(from))) >= 0) Buffer.from(to).copy(raw, i); fs.writeFileSync(f, raw); return f; };
  for (const [evil, why] of [['../evil.txt', /"\.\."/], ['/a/evil.txt', /absolute/], ['aa\\evil.txt', /backslash/], ['C:/evil.txt', /drive letter/]]) {
    const f = patch(await make('aa/evil.txt'), 'aa/evil.txt', evil);
    assert.throws(() => readZip(f), why, evil);
    await assert.rejects(extractZip(f, at('slip-out')), why);
  }
  assert.ok(!fs.existsSync(at('slip-out')) && !fs.existsSync(path.join(tmp, 'evil.txt')));
  const link = await make('link', { mode: 0o120777 });
  assert.throws(() => readZip(link), /symlink/);
  // method 12 (bzip2) in the central directory
  const m = await make('m.txt'); const raw = fs.readFileSync(m); const cd = raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  raw.writeUInt16LE(12, cd + 10); fs.writeFileSync(m, raw);
  assert.throws(() => readZip(m), /compression method 12; only STORE \(0\) and DEFLATE \(8\)/);
  raw.writeUInt16LE(0, cd + 10); raw.writeUInt16LE(raw.readUInt16LE(cd + 8) | 1, cd + 8); fs.writeFileSync(m, raw);
  assert.throws(() => readZip(m), /encrypted/);
});

test('the writer refuses unsafe and duplicate names; entryPath stays inside the folder', async () => {
  for (const n of ['../x', '/x', 'a\\b', 'C:x', '', 'a/../../b']) assert.ok(unsafeName(n), n);
  for (const n of ['a/b.md', 'Резюме.pdf', 'a..b/c', '.hidden']) assert.equal(unsafeName(n), null, n);
  const z = await ZipWriter.open(at('w.zip'));
  assert.throws(() => z.addBuffer('../x', 'x'), /refusing/);
  z.addBuffer('a.txt', 'x'); assert.throws(() => z.addBuffer('a.txt', 'y'), /already/);
  await z.close();
  assert.equal(entryPath(tmp, 'a/b.txt'), path.join(tmp, 'a', 'b.txt'));
  assert.throws(() => entryPath(tmp, 'a/../../b'), /refusing/);
});

test('a name without the UTF-8 flag is read as UTF-8 when valid, else as code page 437', async () => {
  const f = at('cp437.zip'); const z = await ZipWriter.open(f); z.addBuffer('x_.txt', 'a'); z.addBuffer('я.txt', 'b'); await z.close();
  const raw = fs.readFileSync(f);
  for (let i = 0; (i = raw.indexOf(Buffer.from('x_.txt'), i)) >= 0; i++) raw[i + 1] = 0x81;      // 0x81 alone is not UTF-8
  for (const sig of [[0x50, 0x4b, 0x01, 0x02]]) for (let i = 0; (i = raw.indexOf(Buffer.from(sig), i)) >= 0; i++) raw.writeUInt16LE(raw.readUInt16LE(i + 8) & ~0x0800, i + 8);
  fs.writeFileSync(f, raw);
  assert.deepEqual(readZip(f).entries.map(e => e.name), ['xü.txt', 'я.txt']);
});

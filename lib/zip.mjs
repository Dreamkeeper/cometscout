// ZIP reader and writer on node:zlib, no dependency. Used by export, import and backups (lib/archive.mjs).
// Writer: DEFLATE (STORE when a file does not shrink), UTF-8 names (flag bit 11), CRC-32, ZIP64 when an entry or the
// archive passes 4 GiB or the archive has 65,535 entries or more. Files over `streamOver` bytes are streamed, so a
// large PDF is never held in memory whole; smaller ones are compressed in one go.
// Reader: central directory first; STORE and DEFLATE only; every entry's CRC and size are checked while it is read.
// Names that are absolute, contain "..", backslashes or a drive letter (zip slip), symlinks and encrypted entries are
// refused before anything is written. Two Windows habits are read as meant: a zip made on a FAT/NTFS host whose names
// use "\" and no "/" (PowerShell 5.1 Compress-Archive) has "\" read as "/", and a name without the UTF-8 flag that is
// not valid UTF-8 is read in the OEM code page (Explorer, tar.exe: CP866 on a Russian machine) before CP437.
//   const z = await ZipWriter.open('out.zip'); await z.addFile('data/a.md', '/abs/a.md'); z.addBuffer('x.json', buf); await z.close();
//   const zip = readZip('in.zip'); for (const e of zip.entries) await extractEntry(zip, e, '/abs/target');
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

// ---------- CRC-32 (IEEE, the table form) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
/** CRC-32 of buf, continuing from crc (pass the previous result to checksum data in chunks). */
export function crc32(buf, crc = 0) {
  let c = (crc ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- names ----------
/** Why a name may not be written or extracted, or null when it is safe. Names are POSIX ("dir/file"), never "\". */
export function unsafeName(name) {
  const n = String(name ?? '');
  if (!n) return 'empty name';
  if (n.includes('\0')) return 'name contains a NUL byte';
  if (n.includes('\\')) return 'name contains a backslash';
  if (n.startsWith('/')) return 'absolute name';
  if (/^[A-Za-z]:/.test(n)) return 'name starts with a drive letter';
  if (n.split('/').some(s => s === '..')) return 'name contains ".."';
  return null;
}
const SYMLINK = 0o120000, TYPE_MASK = 0o170000;
// "version made by" host bytes whose own separator is "\\": MS-DOS and FAT (0), Windows NTFS (10), the NTFS value of older
// tables (11) and VFAT (14). .NET Framework's ZipArchive (PowerShell 5.1 Compress-Archive) writes host 0.
const DOS_HOSTS = new Set([0, 10, 11, 14]);
/** A name as stored, with "\" read as "/" when a DOS/Windows host wrote it and it has no "/" at all. */
export function normalizeSeparators(name, host) {
  return DOS_HOSTS.has(host) && !name.includes('/') ? name.replace(/\\/g, '/') : name;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Why a "/"-separated name cannot be a file on Windows, or null. */
export function windowsNameProblem(name) {
  for (const seg of String(name).split('/')) {
    const bad = seg.match(/[<>:"|?*\x00-\x1f]/);
    if (bad) return `"${seg}" contains ${bad[0] < ' ' ? 'a control character' : `"${bad[0]}"`}, which Windows does not allow in file names`;
    if (/[. ]$/.test(seg)) return `"${seg}" ends with a dot or a space, which Windows does not allow`;
    if (WIN_RESERVED.test(seg)) return `"${seg}" is a reserved name on Windows`;
  }
  return null;
}

// IBM code page 437, bytes 0x80 to 0xFF: names in zips that set neither the UTF-8 flag nor a Unicode path field.
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
export const CP437_HIGH = CP437;
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
// Windows code page numbers that TextDecoder knows; 437 (and others it does not know) use the table above
const CODEPAGE_LABELS = { 866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250',
  1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258' };
/** A decoder for a code page number, or null for 437 and pages TextDecoder does not know. */
export function codepageDecoder(cp) {
  const label = CODEPAGE_LABELS[Number(cp)];
  try { return label ? new TextDecoder(label, { fatal: true }) : null; } catch { return null; }
}
/** The code page number in the output of chcp ("Active code page: 866", or the same in the system's language). */
export const parseChcp = text => { const m = String(text || '').match(/(\d{3,5})\s*\.?\s*$/m); return m ? Number(m[1]) : null; };
let oemCache;
/** The OEM code page of this Windows machine (chcp), or null elsewhere and when it cannot be read. */
export function oemCodepage() {
  if (oemCache !== undefined) return oemCache;
  oemCache = null;
  if (process.platform === 'win32') {
    const r = spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'latin1', timeout: 5000, windowsHide: true });
    if (!r.error && r.status === 0) oemCache = parseChcp(r.stdout);
  }
  return oemCache;
}
function decodeName(raw, utf8Flag, extra, codepage) {
  if (utf8Flag) return raw.toString('utf8');
  const up = extraField(extra, 0x7075);            // Info-ZIP Unicode Path: version (1), CRC of the raw name (4), UTF-8 name
  if (up && up.length > 5 && up[0] === 1 && up.readUInt32LE(1) === crc32(raw)) return up.subarray(5).toString('utf8');
  try { return utf8Strict.decode(raw); } catch { /* not UTF-8: a legacy code page */ }
  const oem = codepageDecoder(codepage ?? oemCodepage());
  if (oem) { try { return oem.decode(raw); } catch { /* not that page either */ } }
  return [...raw].map(b => (b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80])).join('');
}
function extraField(extra, id) {
  for (let i = 0; i + 4 <= extra.length;) {
    const h = extra.readUInt16LE(i), len = extra.readUInt16LE(i + 2);
    if (h === id) return extra.subarray(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return null;
}

// ---------- writer ----------
const SIG = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50, end64: 0x06064b50, locator64: 0x07064b50 };
const FLAG_UTF8 = 0x0800;
const MADE_BY = (3 << 8) | 45;                     // Unix, spec 4.5
function dosDateTime(d) {
  const y = d.getFullYear();
  if (y < 1980) return { time: 0, date: (1 << 5) | 1 };
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

export class ZipWriter {
  /**
   * Open `file` for writing. Options: streamOver (bytes; larger files are streamed, default 8 MiB), level (zlib level),
   * limit32 / limit16 (where ZIP64 starts: 0xFFFFFFFF and 0xFFFF; tests lower them to exercise ZIP64 on small files).
   */
  static async open(file, { streamOver = 8 * 1024 * 1024, level = 6, limit32 = 0xFFFFFFFF, limit16 = 0xFFFF } = {}) {
    const z = new ZipWriter();
    Object.assign(z, { file, fd: fs.openSync(file, 'w'), pos: 0, entries: [], names: new Set(), streamOver, level, limit32, limit16 });
    return z;
  }
  #write(buf, at = this.pos) { fs.writeSync(this.fd, buf, 0, buf.length, at); if (at === this.pos) this.pos += buf.length; }
  #name(name) {
    const why = unsafeName(name); if (why) throw new Error(`zip: refusing to write "${name}": ${why}`);
    if (this.names.has(name)) throw new Error(`zip: "${name}" is already in the archive`);
    this.names.add(name);
    return Buffer.from(name, 'utf8');
  }
  #localHeader(raw, e, zip64) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(SIG.local, 0); h.writeUInt16LE(zip64 ? 45 : 20, 4); h.writeUInt16LE(FLAG_UTF8, 6); h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(e.time, 10); h.writeUInt16LE(e.date, 12); h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(zip64 ? 0xFFFFFFFF : e.csize, 18); h.writeUInt32LE(zip64 ? 0xFFFFFFFF : e.size, 22);
    const extra = zip64 ? Buffer.concat([Buffer.from([1, 0, 16, 0]), u64(e.size), u64(e.csize)]) : Buffer.alloc(0);
    h.writeUInt16LE(raw.length, 26); h.writeUInt16LE(extra.length, 28);
    return Buffer.concat([h, raw, extra]);
  }
  #entry(name, raw, mtime, mode) {
    const { time, date } = dosDateTime(mtime || new Date());
    return { name, raw, time, date, mode: mode || 0o100644, offset: this.pos, method: 8, crc: 0, size: 0, csize: 0 };
  }
  /** Add an in-memory entry. Returns { name, size, sha256 }. */
  addBuffer(name, data, { mtime, mode } = {}) {
    const raw = this.#name(name); const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const e = this.#entry(name, raw, mtime, mode);
    const deflated = zlib.deflateRawSync(buf, { level: this.level });
    const body = deflated.length < buf.length ? deflated : buf;
    Object.assign(e, { method: body === buf ? 0 : 8, crc: crc32(buf), size: buf.length, csize: body.length });
    const zip64 = e.size >= this.limit32 || e.csize >= this.limit32;
    this.#write(this.#localHeader(raw, e, zip64)); this.#write(body);
    this.entries.push(e);
    return { name, size: e.size, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }
  /** Add a file from disk; large files are streamed. Returns { name, size, sha256 } of what was read. */
  async addFile(name, file, opts = {}) {
    const st = fs.statSync(file);
    if (st.size <= this.streamOver) return this.addBuffer(name, fs.readFileSync(file), { mtime: st.mtime, ...opts });
    const raw = this.#name(name); const e = this.#entry(name, raw, opts.mtime || st.mtime, opts.mode);
    const zip64 = st.size >= this.limit32;          // decided before reading: the local header's size fields are patched later
    const header = this.#localHeader(raw, e, zip64); const at = this.pos; this.#write(header);
    const dataAt = this.pos;
    const pass = async method => {
      this.pos = dataAt; let crc = 0, size = 0, csize = 0; const hash = crypto.createHash('sha256');
      const count = async function* (src) { for await (const c of src) { crc = crc32(c, crc); size += c.length; hash.update(c); yield c; } };
      const sink = async src => { for await (const c of src) { this.#write(c); csize += c.length; } };
      await (method === 8 ? pipeline(fs.createReadStream(file), count, zlib.createDeflateRaw({ level: this.level }), sink) : pipeline(fs.createReadStream(file), count, sink));
      return { crc, size, csize, sha256: hash.digest('hex') };
    };
    let r = await pass(8), method = 8;
    if (r.csize >= r.size) { r = await pass(0); method = 0; }   // did not shrink: store it
    if (!zip64 && (r.size >= this.limit32 || r.csize >= this.limit32)) throw new Error(`zip: ${file} grew past 4 GiB while it was being read`);
    Object.assign(e, { method, crc: r.crc, size: r.size, csize: r.csize });
    this.#write(this.#localHeader(raw, e, zip64), at);
    this.entries.push(e);
    return { name, size: r.size, sha256: r.sha256 };
  }
  /** Write the central directory and the end records, then close the file. */
  async close() {
    const cdStart = this.pos;
    for (const e of this.entries) {
      const zip64 = e.size >= this.limit32 || e.csize >= this.limit32 || e.offset >= this.limit32;
      const extra = zip64 ? Buffer.concat([Buffer.from([1, 0, 24, 0]), u64(e.size), u64(e.csize), u64(e.offset)]) : Buffer.alloc(0);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG.central, 0); h.writeUInt16LE(MADE_BY, 4); h.writeUInt16LE(zip64 ? 45 : 20, 6); h.writeUInt16LE(FLAG_UTF8, 8);
      h.writeUInt16LE(e.method, 10); h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14); h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(zip64 ? 0xFFFFFFFF : e.csize, 20); h.writeUInt32LE(zip64 ? 0xFFFFFFFF : e.size, 24);
      h.writeUInt16LE(e.raw.length, 28); h.writeUInt16LE(extra.length, 30); h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36);
      h.writeUInt32LE(((e.mode & 0xFFFF) << 16) >>> 0, 38); h.writeUInt32LE(zip64 ? 0xFFFFFFFF : e.offset, 42);
      this.#write(Buffer.concat([h, e.raw, extra]));
    }
    const cdSize = this.pos - cdStart, count = this.entries.length;
    if (count >= this.limit16 || cdSize >= this.limit32 || cdStart >= this.limit32) {
      const end64At = this.pos, r = Buffer.alloc(56);
      r.writeUInt32LE(SIG.end64, 0); r.writeBigUInt64LE(44n, 4); r.writeUInt16LE(MADE_BY, 12); r.writeUInt16LE(45, 14);
      r.writeUInt32LE(0, 16); r.writeUInt32LE(0, 20); r.writeBigUInt64LE(BigInt(count), 24); r.writeBigUInt64LE(BigInt(count), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40); r.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20); loc.writeUInt32LE(SIG.locator64, 0); loc.writeUInt32LE(0, 4); loc.writeBigUInt64LE(BigInt(end64At), 8); loc.writeUInt32LE(1, 16);
      this.#write(Buffer.concat([r, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG.end, 0);
    end.writeUInt16LE(Math.min(count, 0xFFFF), 8); end.writeUInt16LE(Math.min(count, 0xFFFF), 10);
    if (count >= this.limit16) { end.writeUInt16LE(0xFFFF, 8); end.writeUInt16LE(0xFFFF, 10); }
    end.writeUInt32LE(cdSize >= this.limit32 ? 0xFFFFFFFF : cdSize, 12); end.writeUInt32LE(cdStart >= this.limit32 ? 0xFFFFFFFF : cdStart, 16);
    this.#write(end);
    fs.ftruncateSync(this.fd, this.pos);            // a STORE rewrite can leave old bytes past the end
    fs.closeSync(this.fd);
    return { file: this.file, entries: count, bytes: this.pos };
  }
  /** Close and delete a half-written archive. */
  abort() { try { fs.closeSync(this.fd); } catch { /* closed */ } fs.rmSync(this.file, { force: true }); }
}

// ---------- reader ----------
function readAt(fd, at, len) {
  const b = Buffer.alloc(len); let got = 0;
  while (got < len) { const n = fs.readSync(fd, b, got, len - got, at + got); if (!n) break; got += n; }
  return b.subarray(0, got);
}
const bad = msg => new Error(`not a readable zip: ${msg}`);

/**
 * Read the central directory of `file`. Returns { file, entries: [{ name, method, crc, size, csize, offset, dir, mode }] }.
 * Throws on anything this reader will not extract: unsafe names, symlinks, encryption, methods other than STORE and DEFLATE.
 * codepage: the code page of names without the UTF-8 flag (default: this Windows machine's OEM code page, then CP437).
 */
export function readZip(file, { codepage = null } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const tailLen = Math.min(total, 22 + 0xFFFF); const tail = readAt(fd, total - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG.end && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) { e = i; break; }
    if (e < 0) throw bad('no end of central directory record');
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdStart = tail.readUInt32LE(e + 16);
    const endAt = total - tailLen + e;
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdStart === 0xFFFFFFFF) {
      const loc = endAt >= 20 ? readAt(fd, endAt - 20, 20) : null;
      if (loc && loc.readUInt32LE(0) === SIG.locator64) {
        const r = readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
        if (r.length < 56 || r.readUInt32LE(0) !== SIG.end64) throw bad('broken ZIP64 end record');
        count = Number(r.readBigUInt64LE(32)); cdSize = Number(r.readBigUInt64LE(40)); cdStart = Number(r.readBigUInt64LE(48));
      }
    }
    if (cdStart + cdSize > total) throw bad('central directory is past the end of the file');
    const cd = readAt(fd, cdStart, cdSize);
    const entries = []; const seen = new Set();
    for (let i = 0, n = 0; n < count; n++) {
      if (i + 46 > cd.length || cd.readUInt32LE(i) !== SIG.central) throw bad(`central directory entry ${n + 1} is damaged`);
      const madeBy = cd.readUInt16LE(i + 4) >> 8, flags = cd.readUInt16LE(i + 8), method = cd.readUInt16LE(i + 10);
      let csize = cd.readUInt32LE(i + 20), size = cd.readUInt32LE(i + 24), offset = cd.readUInt32LE(i + 42);
      const nameLen = cd.readUInt16LE(i + 28), extraLen = cd.readUInt16LE(i + 30), commentLen = cd.readUInt16LE(i + 32);
      const attr = cd.readUInt32LE(i + 38);
      const raw = cd.subarray(i + 46, i + 46 + nameLen), extra = cd.subarray(i + 46 + nameLen, i + 46 + nameLen + extraLen);
      const z64 = extraField(extra, 0x0001);
      if (z64) {
        let k = 0; const next = () => { const v = Number(z64.readBigUInt64LE(k)); k += 8; return v; };
        if (size === 0xFFFFFFFF) size = next();
        if (csize === 0xFFFFFFFF) csize = next();
        if (offset === 0xFFFFFFFF) offset = next();
      }
      const name = normalizeSeparators(decodeName(raw, flags & FLAG_UTF8, extra, codepage), madeBy);
      const mode = madeBy === 3 ? attr >>> 16 : 0;
      const dir = name.endsWith('/');
      const why = unsafeName(dir ? name.slice(0, -1) : name);
      if (why) throw new Error(`zip: refusing "${name}": ${why}`);
      if ((mode & TYPE_MASK) === SYMLINK) throw new Error(`zip: refusing "${name}": symlink entries are not extracted`);
      if (flags & 1) throw new Error(`zip: "${name}" is encrypted; encrypted archives are not supported`);
      if (!dir && method !== 0 && method !== 8) throw new Error(`zip: "${name}" uses compression method ${method}; only STORE (0) and DEFLATE (8) are supported`);
      if (seen.has(name)) throw new Error(`zip: "${name}" appears twice`);
      seen.add(name);
      entries.push({ name, method, crc: cd.readUInt32LE(i + 16), size, csize, offset, dir, mode });
      i += 46 + nameLen + extraLen + commentLen;
    }
    return { file, entries };
  } finally { fs.closeSync(fd); }
}

function dataStart(file, e) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = readAt(fd, e.offset, 30);
    if (h.length < 30 || h.readUInt32LE(0) !== SIG.local) throw bad(`local header of "${e.name}" is damaged`);
    return e.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally { fs.closeSync(fd); }
}
/** Stream one entry's contents through `sink` (an async function taking an async iterable of Buffers); CRC and size are checked. */
async function streamEntry(zip, e, sink) {
  const start = dataStart(zip.file, e);
  let crc = 0, size = 0;
  const check = async function* (src) {
    for await (const c of src) {
      crc = crc32(c, crc); size += c.length;
      if (size > e.size) throw new Error(`zip: "${e.name}" is larger than the directory says (${e.size} bytes)`);
      yield c;
    }
    if (size !== e.size) throw new Error(`zip: "${e.name}" has ${size} bytes, the directory says ${e.size}`);
    if (crc !== e.crc) throw new Error(`zip: "${e.name}" is damaged (CRC mismatch)`);
  };
  const src = e.csize ? fs.createReadStream(zip.file, { start, end: start + e.csize - 1 }) : (async function* () {})();
  try {
    if (e.method === 8 && e.csize) await pipeline(src, zlib.createInflateRaw(), check, sink);
    else await pipeline(src, check, sink);
  } catch (err) {
    if (/^zip: /.test(err.message)) throw err;
    throw new Error(`zip: "${e.name}" is damaged (${err.message})`);
  }
}
/** The entry's contents as a Buffer (CRC checked). For small entries such as manifest.json. */
export async function readEntry(zip, e) {
  const parts = []; await streamEntry(zip, e, async src => { for await (const c of src) parts.push(c); });
  return Buffer.concat(parts);
}
/** Write the entry to `to` (its folder is created). Written to a temporary name first, so a damaged entry leaves nothing. */
export async function extractEntry(zip, e, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.${process.pid}.part`;
  try { await streamEntry(zip, e, async src => { await pipeline(src, fs.createWriteStream(tmp)); }); fs.renameSync(tmp, to); }
  catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}
/** Where an entry lands under `dir`: joined segment by segment, and checked to stay inside `dir`. */
export function entryPath(dir, name) {
  const why = unsafeName(name); if (why) throw new Error(`zip: refusing "${name}": ${why}`);
  const win = process.platform === 'win32' && windowsNameProblem(name);
  if (win) throw new Error(`zip: refusing "${name}": ${win}`);
  const base = path.resolve(dir), to = path.resolve(base, ...name.split('/'));
  if (to !== base && !to.startsWith(base + path.sep)) throw new Error(`zip: refusing "${name}": it points outside the target folder`);
  return to;
}
/** Extract every file entry into `dir`. Returns the names extracted. */
export async function extractZip(file, dir) {
  const zip = readZip(file); const names = [];
  for (const e of zip.entries) { if (e.dir) continue; await extractEntry(zip, e, entryPath(dir, e.name)); names.push(e.name); }
  return names;
}

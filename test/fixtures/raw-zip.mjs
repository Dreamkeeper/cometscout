// Test helper (no tests here): a STORE-only zip with raw name bytes and a chosen "made by" host, like the zips other
// tools write (PowerShell 5.1 Compress-Archive: host 0 and "\" separators; Explorer and tar.exe: OEM code page names).
import fs from 'node:fs';
import { crc32 } from '../../lib/zip.mjs';

// CP866 for the Russian letters, enough to write the names a Russian Windows machine would
const CP866 = { 'Ё': 0xF0, 'ё': 0xF1 };
for (let i = 0; i < 32; i++) CP866[String.fromCharCode(0x410 + i)] = i < 16 ? 0x80 + i : 0x90 + i - 16;   // А-Я
for (let i = 0; i < 32; i++) CP866[String.fromCharCode(0x430 + i)] = i < 16 ? 0xA0 + i : 0xE0 + i - 16;   // а-я
export const cp866 = s => Buffer.from([...s].map(ch => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : CP866[ch])));

/** entries: [{ name: Buffer|string, data: Buffer|string }]; host: the "version made by" host byte; utf8: set flag bit 11. */
export function rawZip(file, entries, { host = 0, utf8 = false } = {}) {
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8'), data = Buffer.from(e.data);
    const crc = crc32(data), flags = utf8 ? 0x0800 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((host << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
  return file;
}

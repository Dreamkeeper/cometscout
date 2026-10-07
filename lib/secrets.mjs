// Secrets export: .env and the data/state files that hold a login session (archive.mjs SECRET_STATE), encrypted with
// a passphrase (scrypt + AES-256-GCM). Never part of a normal export or backup.
//   node cli.mjs export-secrets --out <file>          node cli.mjs import-secrets --from <file> [--dry-run] [--force]
// The passphrase is read from the terminal (asked twice on export) or from COMETSCOUT_SECRETS_PASSPHRASE, never from an
// argument (arguments show up in the process list and the shell history).
// Files made before the rename have the format id from lib/legacy-names.mjs and are still read.
// File: JSON { format: "cometscout-secrets", version: 1, kdf: { name: "scrypt", N, r, p, salt }, iv, tag, data } (base64);
// data decrypts to JSON { exported_at, source_host, files: { ".env": base64, "data/state/<file>": base64 } }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, STATE, today } from './config.mjs';
import { SECRET_STATE } from './archive.mjs';
import { envVar, OLD_SECRETS_FORMAT } from './legacy-names.mjs';
import { refusedEnvName } from './env-names.mjs';

export const SECRETS_FORMAT = 'cometscout-secrets';
export const PASSPHRASE_ENV = 'COMETSCOUT_SECRETS_PASSPHRASE';
const aad = format => Buffer.from(`${format}/1`);   // the format id is authenticated: an old file uses its old id
const KDF = { N: 2 ** 15, r: 8, p: 1 };
// scrypt needs about 128 * N * r bytes; a file asking for more than this is refused before any key is derived, so a
// crafted file cannot make import-secrets allocate gigabytes before the tag check fails
export const MAX_SCRYPT_MEM = 256 * 1024 * 1024;

/** The secret files of this install that exist: { rel: absolute path }. */
export function secretFiles() {
  const all = { '.env': path.join(ROOT, '.env'), ...Object.fromEntries(SECRET_STATE.map(f => [`data/state/${f}`, STATE(f)])) };
  return Object.fromEntries(Object.entries(all).filter(([, p]) => fs.existsSync(p)));
}
const known = () => ({ '.env': path.join(ROOT, '.env'), ...Object.fromEntries(SECRET_STATE.map(f => [`data/state/${f}`, STATE(f)])) });

const key = (pass, salt, { N, r, p }) => crypto.scryptSync(String(pass).normalize('NFC'), salt, 32, { N, r, p, maxmem: MAX_SCRYPT_MEM + 1024 * 1024 });
/** Encrypt { rel: Buffer } with a passphrase; returns the file's JSON object. */
export function encrypt(files, passphrase, kdf = KDF) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(passphrase, salt, kdf), iv); c.setAAD(aad(SECRETS_FORMAT));
  const plain = Buffer.from(JSON.stringify({ exported_at: new Date().toISOString(), source_host: os.hostname(), files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) }));
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { format: SECRETS_FORMAT, version: 1, kdf: { name: 'scrypt', ...kdf, salt: salt.toString('base64') }, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
/** Decrypt a file's JSON object; returns { exported_at, source_host, files: { rel: Buffer } }. */
export function decrypt(doc, passphrase) {
  if (doc?.format !== SECRETS_FORMAT && doc?.format !== OLD_SECRETS_FORMAT) throw new Error('not a CometScout secrets file');
  if (doc.version !== 1) throw new Error(`secrets file version ${doc.version} is not supported; update CometScout`);
  const { N, r, p, salt } = doc.kdf || {};
  const pow2 = Number.isInteger(N) && N >= 2 && (N & (N - 1)) === 0;
  if (doc.kdf?.name !== 'scrypt' || !pow2 || !(Number.isInteger(r) && r >= 1 && Number.isInteger(p) && p >= 1 && p <= 16) || 128 * N * r > MAX_SCRYPT_MEM) throw new Error('secrets file has unsupported key settings');
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(passphrase, Buffer.from(salt, 'base64'), { N, r, p }), Buffer.from(doc.iv, 'base64'));
    d.setAAD(aad(doc.format)); d.setAuthTag(Buffer.from(doc.tag, 'base64'));
    plain = Buffer.concat([d.update(Buffer.from(doc.data, 'base64')), d.final()]);
  } catch { throw new Error('wrong passphrase, or the secrets file is damaged'); }
  const j = JSON.parse(plain.toString('utf8'));
  return { ...j, files: Object.fromEntries(Object.entries(j.files || {}).map(([k, v]) => [k, Buffer.from(v, 'base64')])) };
}

const writePrivate = (file, buf) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file); };

/**
 * Set KEY=value lines in .env (the workspace's one-time secrets page): an existing line for the key is replaced in
 * place, a new one is added at the end, every other line stays, and the file keeps its line endings and mode 600.
 * A value with spaces at either end or a leading quote is written in single quotes, which the .env reader strips.
 * A value is one line of text. A name that changes how programs start or where traffic goes (NODE_OPTIONS, PATH, a
 * proxy, COMETSCOUT_*: lib/env-names.mjs) is refused whoever calls, and nothing is written. Returns the keys written;
 * never logs a value.
 */
export function setEnvValues(values, file = path.join(ROOT, '.env')) {
  const entries = Object.entries(values || {});
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`${k} is not a variable name`);
    const why = refusedEnvName(k); if (why) throw new Error(`${k} cannot be written to .env: ${why}`);
    if (typeof v !== 'string' || !v || /[\r\n\0]/.test(v)) throw new Error(`the value for ${k} must be one line of text`);
  }
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
  for (const [k, v] of entries) {
    const line = `${k}=${/^\s|\s$|^["']/.test(v) ? `'${v}'` : v}`;
    const re = new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`);
    const i = lines.findIndex(l => re.test(l));
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  writePrivate(file, lines.join(eol) + eol);
  return entries.map(([k]) => k);
}

/** Write the encrypted secrets file. Returns { out, files: [rel] }. */
export function exportSecrets({ out, passphrase, kdf }) {
  if (!passphrase || String(passphrase).length < 8) throw new Error('the passphrase needs at least 8 characters');
  const found = secretFiles();
  if (!Object.keys(found).length) throw new Error('no secrets to export: there is no .env and no saved login session');
  const files = Object.fromEntries(Object.entries(found).map(([rel, p]) => [rel, fs.readFileSync(p)]));
  const abs = path.resolve(out); fs.mkdirSync(path.dirname(abs), { recursive: true });
  writePrivate(abs, JSON.stringify(encrypt(files, passphrase, kdf), null, 1) + '\n');
  return { out: abs, files: Object.keys(files) };
}

/**
 * Decrypt and write the secrets. A file that exists with other content stops the import unless force is set; with
 * force the old file is kept next to it as <name>.replaced-<date>. Returns { add, same, conflict, skipped, replaced, dryRun }.
 */
export function importSecrets({ from, passphrase, force = false, dryRun = false, date = today() }) {
  let doc; try { doc = JSON.parse(fs.readFileSync(path.resolve(from), 'utf8')); } catch (e) { throw new Error(`cannot read ${from}: ${e.code === 'ENOENT' ? 'no such file' : 'not a CometScout secrets file'}`); }
  const { files } = decrypt(doc, passphrase);
  const targets = known(); const r = { add: [], same: [], conflict: [], skipped: [], replaced: [], dryRun };
  for (const [rel, buf] of Object.entries(files)) {
    const to = targets[rel]; if (!to) { r.skipped.push(rel); continue; }
    if (!fs.existsSync(to)) r.add.push(rel); else if (fs.readFileSync(to).equals(buf)) r.same.push(rel); else r.conflict.push(rel);
  }
  if (dryRun) return r;
  if (r.conflict.length && !force) throw Object.assign(new Error(`${r.conflict.join(', ')} already exist with other content; rerun with --force to replace them (the old ones are kept as <name>.replaced-${date})`), { result: r });
  for (const rel of r.conflict) { const to = targets[rel], old = `${to}.replaced-${date}`; writePrivate(old, fs.readFileSync(to)); r.replaced.push(path.basename(old)); }
  for (const rel of [...r.add, ...r.conflict]) { fs.mkdirSync(path.dirname(targets[rel]), { recursive: true }); writePrivate(targets[rel], files[rel]); }
  return r;
}

/** Read a line from the terminal without echoing it. */
export function askHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') { reject(new Error(`no terminal to ask for the passphrase; set ${PASSPHRASE_ENV} instead`)); return; }
    output.write(question); input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    let s = '';
    const done = (err) => { input.setRawMode(false); input.pause(); input.off('data', onData); output.write('\n'); if (err) reject(err); else resolve(s); };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { done(); return; }
        if (ch === '\u0003') { done(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch;
      }
    };
    input.on('data', onData);
  });
}
/** The passphrase from COMETSCOUT_SECRETS_PASSPHRASE (or its old name), else the terminal (twice when confirm is set). */
export async function readPassphrase({ confirm = false, env = process.env, ask = askHidden } = {}) {
  const fromEnv = envVar('SECRETS_PASSPHRASE', env); if (fromEnv) return fromEnv;
  const p = await ask('Passphrase: ');
  if (confirm && (await ask('Passphrase again: ')) !== p) throw new Error('the two passphrases differ');
  return p;
}

#!/usr/bin/env node
// Dependency licence check: every package CometScout installs must carry a licence from the allowlist below.
//   node tools/licenses.mjs                                   # npm: package-lock.json (no network)
//   node tools/licenses.mjs --python                          # also the Python packages pinned for the transcription module
//   node tools/licenses.mjs --lock <file> --constraints <file> # other files (the CI self-test uses a temporary lockfile)
// npm: the "license" field the lockfile records for each package. Python: the packages pinned in
// deploy/modules/transcribe/constraints.txt plus faster-whisper (FASTER_WHISPER_VERSION in lib/transcribe.mjs), each at its
// pinned version, read from PyPI's JSON API (metadata only, nothing is installed). Packages pip resolves without a pin
// are not covered: they have no fixed version to check. GigaAM comes from a GitHub commit archive, not PyPI; its licence
// (MIT) was checked by hand and is listed in OVERRIDES' comment. Exit 1 when any package is not allowed or unknown.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Permissive licences (SPDX ids). "BSD" alone is the PyPI classifier "BSD License", which does not say which variant;
// every BSD variant is permissive.
export const ALLOWED = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD', 'ISC', '0BSD', 'Zlib',
  'CC0-1.0', 'PSF-2.0', 'Python-2.0', 'Unlicense',
  // MPL-2.0 is weak copyleft, per file: it only binds changes to the MPL files themselves. CometScout installs these
  // packages unmodified (certifi, tqdm), so it is allowed. A changed copy of an MPL file would have to stay MPL.
  'MPL-2.0']);

// Packages whose PyPI metadata names no usable licence: the licence read by hand from the project's own repository,
// with the reason. (GigaAM, installed from github.com/salute-developers/GigaAM at a pinned commit: MIT, from
// gh api repos/salute-developers/GigaAM/license, checked 2026-10-13.)
export const OVERRIDES = {
  fsspec: { license: 'BSD-3-Clause', why: 'PyPI metadata is empty; github.com/fsspec/filesystem_spec LICENSE is BSD-3-Clause (checked 2026-10-13)' },
  'sherpa-onnx': { license: 'Apache-2.0', why: 'PyPI says "Apache licensed, as found in the LICENSE file"; github.com/k2-fsa/sherpa-onnx LICENSE is Apache-2.0 (checked 2026-10-13)' },
};

// PyPI trove classifiers and free-text licence fields to SPDX ids.
const CLASSIFIERS = {
  'MIT License': 'MIT', 'MIT No Attribution License (MIT-0)': 'MIT-0', 'Apache Software License': 'Apache-2.0',
  'BSD License': 'BSD', 'ISC License (ISCL)': 'ISC', 'Mozilla Public License 2.0 (MPL 2.0)': 'MPL-2.0',
  'Python Software Foundation License': 'PSF-2.0', 'zlib/libpng License': 'Zlib', 'The Unlicense (Unlicense)': 'Unlicense',
};
const TEXT = { mit: 'MIT', 'mit license': 'MIT', bsd: 'BSD', 'bsd license': 'BSD', 'bsd 3-clause license': 'BSD-3-Clause',
  'bsd-3-clause': 'BSD-3-Clause', 'bsd-2-clause': 'BSD-2-Clause', 'apache-2.0': 'Apache-2.0', 'apache 2.0': 'Apache-2.0',
  'apache software license': 'Apache-2.0', isc: 'ISC' };

/** True when an SPDX expression is satisfied by ALLOWED: AND needs every part, OR any part; parentheses group. */
export function allowedExpression(expr) {
  const tokens = String(expr || '').replace(/[()]/g, m => ` ${m} `).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let i = 0;
  const atom = () => {
    const t = tokens[i++];
    if (t === '(') { const v = or(); if (tokens[i++] !== ')') throw new Error('unbalanced parentheses'); return v; }
    if (!t || t === ')' || /^(AND|OR|WITH)$/i.test(t)) throw new Error(`unexpected "${t ?? 'end'}"`);
    if (/^WITH$/i.test(tokens[i] || '')) { i += 2; return false; }   // licence exceptions are reviewed by hand
    return ALLOWED.has(t.replace(/\+$/, ''));
  };
  const and = () => { let v = atom(); while (/^AND$/i.test(tokens[i] || '')) { i++; v = atom() && v; } return v; };
  const or = () => { let v = and(); while (/^OR$/i.test(tokens[i] || '')) { i++; v = and() || v; } return v; };
  try { const v = or(); return i === tokens.length && v; } catch { return false; }
}

/** The npm packages of a package-lock.json (v2/v3) as { name, version, license }. */
export function npmPackages(lock) {
  return Object.entries(lock.packages || {}).filter(([k]) => k.startsWith('node_modules/') || k.includes('/node_modules/'))
    .map(([k, p]) => ({ name: p.name || k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length), version: p.version, license: typeof p.license === 'string' ? p.license : '' }));
}

/** name==version pins of a pip constraints file (local version labels such as +cpu dropped; PyPI has the same release). */
export function constraintPins(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^;\s#]+)/);
    if (m) { const version = m[2].replace(/\+.*$/, ''); out.set(`${m[1].toLowerCase()}==${version}`, { name: m[1], version }); }
  }
  return [...out.values()];
}

/** The SPDX licence of a PyPI release's info object: license_expression, else classifiers, else a known short text. */
export function pypiLicense(info) {
  if (info.license_expression) return info.license_expression;
  const fromClassifiers = (info.classifiers || []).filter(c => c.startsWith('License :: ')).map(c => CLASSIFIERS[c.split(' :: ').pop()] || `unknown classifier "${c}"`);
  if (fromClassifiers.length) return fromClassifiers.length === 1 ? fromClassifiers[0] : fromClassifiers.map(x => `(${x})`).join(' OR ');
  const t = String(info.license || '').trim();
  return TEXT[t.toLowerCase()] || (/^[A-Za-z0-9.+-]+( (AND|OR) [A-Za-z0-9.+-]+)*$/.test(t) ? t : '');
}

/** One row per package: { kind, name, version, license, ok, note }. fetchJson(url) is injected in tests. */
export async function pythonRows(pins, { fetchJson }) {
  const rows = [];
  for (const { name, version } of pins) {
    let license = '', note = '';
    const o = OVERRIDES[name.toLowerCase()];
    if (o) { license = o.license; note = o.why; }
    else {
      try { license = pypiLicense((await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`)).info || {}); }
      catch (e) { note = `PyPI: ${e.message}`; }
    }
    rows.push({ kind: 'pypi', name, version, license, ok: allowedExpression(license), note: note || (license ? '' : 'no licence in the metadata') });
  }
  return rows;
}

export function npmRows(lock) {
  return npmPackages(lock).map(p => ({ kind: 'npm', ...p, ok: allowedExpression(p.license), note: p.license ? '' : 'no licence in package-lock.json' }));
}

export function report(rows) {
  const lines = rows.map(r => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.kind} ${r.name} ${r.version}: ${r.license || '(none)'}${r.note ? ` (${r.note})` : ''}`);
  const bad = rows.filter(r => !r.ok);
  lines.push(bad.length ? `${bad.length} of ${rows.length} packages have a licence outside the allowlist (tools/licenses.mjs ALLOWED), or none.` : `All ${rows.length} packages have an allowed licence.`);
  return { text: lines.join('\n'), ok: bad.length === 0 };
}

async function main(args) {
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const lock = JSON.parse(fs.readFileSync(opt('--lock') || path.join(ROOT, 'package-lock.json'), 'utf8'));
  const rows = npmRows(lock);
  if (args.includes('--python') || opt('--constraints')) {
    const pins = constraintPins(fs.readFileSync(opt('--constraints') || path.join(ROOT, 'deploy/modules/transcribe/constraints.txt'), 'utf8'));
    if (!opt('--constraints')) {
      const fw = fs.readFileSync(path.join(ROOT, 'lib/transcribe.mjs'), 'utf8').match(/FASTER_WHISPER_VERSION = '([^']+)'/);
      if (!fw) throw new Error('FASTER_WHISPER_VERSION not found in lib/transcribe.mjs');
      pins.push({ name: 'faster-whisper', version: fw[1] });
    }
    const fetchJson = async url => { const r = await fetch(url, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
    rows.push(...await pythonRows(pins, { fetchJson }));
  }
  const { text, ok } = report(rows);
  console.log(text);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(`licenses: ${e.message}`); process.exitCode = 1; });
}

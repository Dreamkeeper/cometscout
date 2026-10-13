// tools/licenses.mjs: the dependency licence check CI runs (.github/workflows/deps.yml). Synthetic lockfiles and a fake
// PyPI; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedExpression, npmRows, constraintPins, pypiLicense, pythonRows, report } from '../tools/licenses.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('SPDX expressions: permissive ids pass, copyleft fails, AND needs every part, OR any part', () => {
  for (const ok of ['MIT', 'Apache-2.0', 'BSD-3-Clause AND 0BSD AND MIT', 'MPL-2.0 AND MIT', 'GPL-3.0-only OR MIT', '(MIT OR GPL-2.0) AND ISC']) assert.equal(allowedExpression(ok), true, ok);
  for (const bad of ['GPL-3.0-only', 'AGPL-3.0', 'MIT AND GPL-2.0-only', 'BUSL-1.1', 'SSPL-1.0', '', 'UNLICENSED', 'SEE LICENSE IN LICENSE', 'GPL-2.0 WITH Classpath-exception-2.0', '(MIT', 'MIT AND']) assert.equal(allowedExpression(bad), false, bad);
});

test('npm: every package in the lockfile is checked, the root project is not', () => {
  const lock = { packages: { '': { name: 'x', license: 'GPL-3.0' }, 'node_modules/a': { version: '1.0.0', license: 'MIT' }, 'node_modules/b': { version: '2.0.0', license: 'GPL-3.0-only' }, 'node_modules/a/node_modules/c': { version: '3.0.0' } } };
  const rows = npmRows(lock);
  assert.deepEqual(rows.map(r => [r.name, r.ok]), [['a', true], ['b', false], ['c', false]]);
  const r = report(rows);
  assert.equal(r.ok, false);
  assert.match(r.text, /FAIL  npm b 2\.0\.0: GPL-3\.0-only/);
  assert.match(r.text, /FAIL  npm c 3\.0\.0: \(none\) \(no licence in package-lock\.json\)/);
  assert.match(r.text, /2 of 3 packages/);
});

test('the real package-lock.json passes', () => {
  const r = report(npmRows(JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))));
  assert.equal(r.ok, true, r.text);
});

test('constraints: name==version pins, markers and +cpu labels dropped, one row per version', () => {
  const pins = constraintPins('# comment\nfoo==1.0\nbar==2.0+cpu\nbaz==3.0; python_version >= "3.11"\nbaz==2.9; python_version < "3.11"\nfoo==1.0\nqux>=1\n');
  assert.deepEqual(pins, [{ name: 'foo', version: '1.0' }, { name: 'bar', version: '2.0' }, { name: 'baz', version: '3.0' }, { name: 'baz', version: '2.9' }]);
});

test('PyPI metadata: license_expression first, then classifiers, then a short licence text', () => {
  assert.equal(pypiLicense({ license_expression: 'MIT AND Zlib', license: 'whatever' }), 'MIT AND Zlib');
  assert.equal(pypiLicense({ classifiers: ['License :: OSI Approved :: BSD License'], license: 'Copyright (c) someone, long text' }), 'BSD');
  assert.equal(pypiLicense({ classifiers: ['License :: OSI Approved :: GNU General Public License v3 (GPLv3)'] }), 'unknown classifier "License :: OSI Approved :: GNU General Public License v3 (GPLv3)"');
  assert.equal(pypiLicense({ license: 'MIT' }), 'MIT');
  assert.equal(pypiLicense({ license: 'BSD 3-Clause License' }), 'BSD-3-Clause');
  assert.equal(pypiLicense({ license: 'Copyright (c) someone. All rights reserved.' }), '');
  assert.equal(pypiLicense({}), '');
});

test('Python rows: a fake PyPI; copyleft, unknown and unreachable fail, overrides carry their reason', async () => {
  const meta = { good: { license_expression: 'Apache-2.0' }, gpl: { license: 'GPL-3.0-only' }, empty: {} };
  const fetchJson = async url => { const name = url.split('/')[4]; if (!meta[name]) throw new Error('HTTP 404'); return { info: meta[name] }; };
  const rows = await pythonRows([{ name: 'good', version: '1' }, { name: 'gpl', version: '1' }, { name: 'empty', version: '1' }, { name: 'gone', version: '1' }, { name: 'fsspec', version: '2026.7.0' }], { fetchJson });
  assert.deepEqual(rows.map(r => [r.name, r.ok]), [['good', true], ['gpl', false], ['empty', false], ['gone', false], ['fsspec', true]]);
  assert.match(rows[2].note, /no licence/);
  assert.match(rows[3].note, /HTTP 404/);
  assert.match(rows[4].note, /BSD-3-Clause/);
});

test('the command exits 1 on a lockfile with a copyleft package and 0 on the real one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-licenses-'));
  try {
    const lock = path.join(tmp, 'package-lock.json');
    fs.writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/copyleft': { version: '1.0.0', license: 'GPL-3.0-only' } } }));
    const bad = spawnSync(process.execPath, [path.join(ROOT, 'tools/licenses.mjs'), '--lock', lock], { encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /FAIL  npm copyleft 1\.0\.0: GPL-3\.0-only/);
    const good = spawnSync(process.execPath, [path.join(ROOT, 'tools/licenses.mjs')], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stdout + good.stderr);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the command fails when it reads no packages: an old lockfile format or an empty constraints file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lic-'));
  try {
    const v1 = path.join(dir, 'v1.json'); fs.writeFileSync(v1, JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0' } } }));
    let r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'licenses.mjs'), '--lock', v1], { encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /no packages read/);
    const ok = path.join(dir, 'ok.json'); fs.writeFileSync(ok, JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0', license: 'MIT' } } }));
    const empty = path.join(dir, 'c.txt'); fs.writeFileSync(empty, '# no pins here\n');
    r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'licenses.mjs'), '--lock', ok, '--constraints', empty], { encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /no name==version pins/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

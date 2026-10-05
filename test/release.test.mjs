// release.json: package.json's version has a valid entry, CHANGELOG.md is generated from it, malformed entries are
// caught, versions sort as semver, and the GitHub release text round-trips through the parser the update check uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as R from '../lib/release.mjs';
import { SCHEMA_VERSION } from '../lib/archive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tool = args => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'changelog.mjs'), ...args], { encoding: 'utf8' });
const entry = (extra = {}) => ({ version: '0.2.0', date: '2026-11-01', min_node: 20, schema_version: 1, migrations: ['002-add-field'], behaviour_changes: false,
  notes: { highlights: ['One line.'], new: ['A thing.'], changed: [], action_needed: [{ text: 'Check it.', setting: 'schedule.time' }] }, ...extra });

test('release.json has a valid entry for package.json\'s version, with this code\'s data schema', () => {
  const list = R.readReleases();
  assert.deepEqual(R.releaseProblems(list, { version: pkg.version, schema: SCHEMA_VERSION }), []);
  assert.equal(list[0].version, pkg.version, 'the newest entry is the current version');
});

test('CHANGELOG.md is what tools/changelog.mjs generates from release.json', () => {
  const r = tool(['--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n'), R.changelogText(R.readReleases()));
});

test('malformed entries are named', () => {
  assert.deepEqual(R.entryProblems(entry(), { root: null }), []);
  const p = e => R.entryProblems(e, { root: null }).join('\n');
  assert.match(p(entry({ version: 'v0.2.0' })), /no "v"/);
  assert.match(p(entry({ date: '2026-02-30' })), /YYYY-MM-DD/);
  assert.match(p(entry({ min_node: 18 })), /min_node/);
  assert.match(p(entry({ migrations: ['add-field'] })), /migrations/);
  assert.match(p(entry({ behaviour_changes: 'no' })), /behaviour_changes/);
  assert.match(p(entry({ notes: { highlights: [] } })), /highlights/);
  assert.match(p(entry({ notes: { highlights: ['x'], action_needed: [{ setting: 'a' }] } })), /action_needed/);
  assert.match(p(entry({ notes: { highlights: ['x'], extra: [] } })), /not a notes key/);
  assert.match(p(entry({ notes: { highlights: ['Fast \u2014 and loud'] } })), /em dashes/);
  assert.match(p(entry({ media: [{ path: '../secret.png', alt: 'x' }] })), /relative path/);
  assert.match(p(entry({ media: [{ path: 'docs/a.exe', alt: 'x' }] })), /image/);
  assert.match(p(entry({ surprise: 1 })), /unknown key "surprise"/);
  assert.match(R.entryProblems(entry({ media: [{ path: 'docs/screenshots/none.png', alt: 'x' }] })).join('\n'), /not found/);
  assert.deepEqual(R.entryProblems(entry({ notes_ru: { new: ['Новое.'] } }), { root: null }), [], 'notes_ru may leave out highlights (English is used)');
});

test('the list: newest first, no duplicates, an entry for the version', () => {
  const a = entry(), b = entry({ version: '0.1.0', date: '2026-10-01', migrations: [] });
  assert.deepEqual(R.releaseProblems([a, b], { version: '0.2.0', root: null }), []);
  assert.match(R.releaseProblems([b, a], { root: null }).join('\n'), /newest first/);
  assert.match(R.releaseProblems([a, a], { root: null }).join('\n'), /listed twice/);
  assert.match(R.releaseProblems([a, b], { version: '0.3.0', root: null }).join('\n'), /no entry for it/);
  assert.match(R.releaseProblems([a], { version: '0.2.0', schema: 2, root: null }).join('\n'), /schema_version is 1, the code's data schema is 2/);
  assert.deepEqual(R.releaseProblems([]), ['release.json must be a list with at least one entry']);
});

test('versions sort as semver: a pre-release before its release, numbers as numbers', () => {
  const sorted = ['0.10.0', '0.2.0', 'v0.2.0-beta.2', '0.2.0-beta.10', '0.2.0-alpha', '1.0.0', '0.2.1'].sort(R.compareVersions);
  assert.deepEqual(sorted, ['0.2.0-alpha', 'v0.2.0-beta.2', '0.2.0-beta.10', '0.2.0', '0.2.1', '0.10.0', '1.0.0']);
  assert.equal(R.bare('v1.2.3'), '1.2.3'); assert.equal(R.bare('main'), null);
  assert.equal(R.isPrerelease('v1.0.0-rc.1'), true); assert.equal(R.isPrerelease('1.0.0'), false);
  assert.throws(() => R.compareVersions('1.0', '1.0.0'), /not a version/);
});

test('the GitHub release text carries what the update check reads', () => {
  const sha = 'ab'.repeat(32);
  const body = R.releaseBody(entry({ behaviour_changes: true }), sha);
  assert.deepEqual(R.parseReleaseBody(body), { highlights: ['One line.'], behaviour_changes: true, min_node: 20, sha256: sha });
  assert.deepEqual(R.parseReleaseBody('Some text\r\nwith nothing'), { highlights: [], behaviour_changes: false, min_node: null, sha256: null });
  const r = tool(['--release', pkg.version, '--sha256', sha]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Source zip sha256: ${sha}`));
  assert.equal(tool(['--release', pkg.version, '--sha256', 'xyz']).status, 1);
  assert.equal(tool(['--release', '9.9.9']).status, 1);
});

test('notes in a locale fall back to English per key; releasesBetween is (from, to]', () => {
  const e = entry({ notes_ru: { highlights: ['Одна строка.'] } });
  assert.deepEqual(R.notesFor(e, 'ru').highlights, ['Одна строка.']);
  assert.deepEqual(R.notesFor(e, 'ru').new, ['A thing.']);
  assert.deepEqual(R.notesFor(e, 'de').highlights, ['One line.']);
  const list = [entry({ version: '0.3.0' }), entry(), entry({ version: '0.1.0' })];
  assert.deepEqual(R.releasesBetween('0.1.0', '0.2.0', list).map(x => x.version), ['0.2.0']);
  assert.deepEqual(R.releasesBetween(null, '0.2.0', list).map(x => x.version), ['0.2.0', '0.1.0']);
});

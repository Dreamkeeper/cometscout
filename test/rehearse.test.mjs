// tools/rehearse/lib.mjs, the helpers of the install rehearsal: the fake next version, the source zip builder (its
// files, version, release.json entry and sha256, and that an update unpacks it), the settings, the canned model
// answer, the synthetic jobs, the expected doctor TODOs, the export check and the PASS/FAIL report. The script itself
// runs in .github/workflows/rehearse.yml. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextVersion, buildSourceZip, releaseFiles, rehearsalSettings, fakeModelAnswer, syntheticJobs, unexpectedTodos, exportMismatches, oldUnits, parseResults, report } from '../tools/rehearse/lib.mjs';
import { readZip, readEntry, ZipWriter } from '../lib/zip.mjs';
import { OLD_UNITS } from '../lib/legacy-names.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(REPO, 'tools', 'rehearse', 'lib.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-rehearse-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment longer */ } });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

test('nextVersion: the patch number plus one, without a pre-release suffix; not a version throws', () => {
  assert.equal(nextVersion('0.1.0'), '0.1.1');
  assert.equal(nextVersion('v1.9.9'), '1.9.10');
  assert.equal(nextVersion('0.3.0-beta.2'), '0.3.1');
  assert.throws(() => nextVersion('latest'), /not a version/);
});

/** A small release folder: the files a release has, with .release-files.json listing the code. */
function fakeRelease(dir, version = '0.4.0') {
  const files = { 'cli.mjs': "console.log('cli');\n", 'lib/a.mjs': 'export const a = 1;\n', 'package.json': JSON.stringify({ name: 'cometscout', version }, null, 2) + '\n',
    'release.json': JSON.stringify([{ version, date: '2026-10-01', min_node: 20, schema_version: 3, migrations: [], behaviour_changes: false, notes: { highlights: ['x'] } }], null, 2) + '\n' };
  for (const [rel, text] of Object.entries(files)) { const p = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  fs.mkdirSync(path.join(dir, 'node_modules', 'preact'), { recursive: true }); fs.writeFileSync(path.join(dir, 'node_modules', 'preact', 'index.js'), '');
  fs.writeFileSync(path.join(dir, '.release-files.json'), JSON.stringify({ version, files: Object.fromEntries(Object.keys(files).map(f => [f, 'x'])) }));
  return Object.keys(files).sort();
}

test('buildSourceZip: GitHub layout, the new version in package.json, a release.json entry on top, the sha256 of the file; the update unpacks it', async () => {
  const code = path.join(tmp, 'release'), files = fakeRelease(code);
  assert.deepEqual(releaseFiles(code), files, 'the list from .release-files.json: no node_modules');
  const r = await buildSourceZip({ codeDir: code, version: 'v0.4.1', out: path.join(tmp, 'zips', 'next.zip'), date: '2026-10-07' });
  assert.equal(r.sha256, sha(fs.readFileSync(r.file)));
  const zip = readZip(r.file);
  assert.deepEqual(zip.entries.map(e => e.name).sort(), files.map(f => `cometscout-0.4.1/${f}`));
  const read = async name => (await readEntry(zip, zip.entries.find(e => e.name === `cometscout-0.4.1/${name}`))).toString('utf8');
  assert.equal(JSON.parse(await read('package.json')).version, '0.4.1');
  const rel = JSON.parse(await read('release.json'));
  assert.deepEqual(rel.map(e => e.version), ['0.4.1', '0.4.0']);
  assert.equal(rel[0].schema_version, 3, 'the data schema stays');
  assert.deepEqual(rel[0].migrations, []);
  assert.ok(!JSON.stringify(rel[0]).includes(String.fromCharCode(0x2014)), 'no em dash');
  assert.equal(await read('lib/a.mjs'), 'export const a = 1;\n');
  // the update's own unpacking drops the top folder
  process.env.COMETSCOUT_HOME = path.join(tmp, 'unpack-home');
  const { unpackRelease } = await import('../lib/update.mjs');
  const dir = path.join(tmp, 'unpacked');
  assert.deepEqual(await unpackRelease(r.file, dir), files);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.4.1');
  await assert.rejects(buildSourceZip({ codeDir: path.join(tmp, 'zips'), version: '1.0.0', out: path.join(tmp, 'x.zip') }), /does not look like CometScout code/);
});

test('rehearsalSettings: only drop-dir, Telegram and the update check off, a fixed schedule in UTC, packs on; the input is not changed', () => {
  const base = JSON.parse(fs.readFileSync(path.join(REPO, 'settings.example.json'), 'utf8')), copy = structuredClone(base);
  const s = rehearsalSettings(base, { dropDir: '/home/sam/cometscout-rehearsal/drop', time: '03:17' });
  assert.deepEqual(base, copy);
  assert.deepEqual(Object.entries(s.sources).filter(([, v]) => v.enabled).map(([k]) => k), ['drop_dir']);
  assert.equal(s.sources.drop_dir.dir, '/home/sam/cometscout-rehearsal/drop');
  assert.equal(s.sources.drop_dir.settle_sec, 0);
  assert.equal(s.sources.drop_dir.move_processed_to, '/home/sam/cometscout-rehearsal/drop/processed');
  assert.equal(s.delivery.telegram.enabled, false);
  assert.equal(s.update.check, false);
  assert.equal(s.health.ping_url, '');
  assert.deepEqual(s.schedule, { days: [1, 2, 3, 4, 5, 6, 7], time: '03:17' });
  assert.equal(s.timezone, 'UTC');
  assert.equal(s.pack.enabled, true);
  assert.ok(!('LLM_FAKE' in s) && !JSON.stringify(s).includes('LLM_FAKE'), 'the canned model is never in settings');
});

test('fakeModelAnswer: a strong-fit verdict and a pack that uses only ids from the library', () => {
  const lib = JSON.parse(fs.readFileSync(path.join(REPO, 'profile.example', 'cv-library.json'), 'utf8'));
  const a = fakeModelAnswer(lib);
  assert.equal(a.verdict, 'strong-fit'); assert.equal(a.apply_priority, 1);
  for (const k of ['confidence', 'rationale', 'fit_signals', 'gaps', 'action', 'positioning', 'answers', 'flags']) assert.ok(k in a, k);
  const bullets = new Set(lib.experience.flatMap(e => e.roles.flatMap(r => r.bullets.map(b => b.id))));
  assert.ok(a.cv.experience.length > 0);
  for (const e of a.cv.experience) { assert.ok(lib.experience.some(x => x.key === e.key)); for (const id of e.bullet_ids) assert.ok(bullets.has(id), id); }
  assert.deepEqual(a.cv.skill_ids, lib.skills.map(x => x.id));
  assert.equal(a.cv.tagline, lib.taglines[0].text);
  assert.equal(fakeModelAnswer({}).cv.experience.length, 0, 'an empty library still gives an answer');
});

test('syntheticJobs: three job files with company, role, an unroutable link and enough text to decode', () => {
  const jobs = syntheticJobs();
  assert.equal(jobs.length, 3); assert.equal(new Set(jobs.map(j => j.name)).size, 3);
  for (const j of jobs) {
    assert.match(j.name, /^rehearsal-\d-[a-z0-9-]+\.md$/);
    assert.match(j.text, /^---\ncompany: "[^"]+"\nrole: "[^"]+"\nurl: "https:\/\/jobs\.example\.invalid\//);
    assert.ok(j.text.split('---').pop().length > 400, 'longer than the decoder minimum');
  }
});

test('unexpectedTodos: the model CLI and the example profile are expected right after install; only the CLI after the profile', () => {
  const out = ['ok   Node 20.1.0', 'TODO claude CLI not found  ->  install Claude Code', 'TODO profile: profile.example  ->  create profile/', 'warn something', 'TODO Python 3 (packs the DOCX files)  ->  install python3'].join('\n');
  assert.deepEqual(unexpectedTodos(out, 'install'), ['TODO Python 3 (packs the DOCX files)  ->  install python3']);
  assert.deepEqual(unexpectedTodos(out, 'profile'), ['TODO profile: profile.example  ->  create profile/', 'TODO Python 3 (packs the DOCX files)  ->  install python3']);
  assert.deepEqual(unexpectedTodos('ok   all\r\nTODO codex CLI not found', 'profile'), []);
  assert.throws(() => unexpectedTodos('', 'later'), /unknown stage/);
});

test('exportMismatches: missing and different files per home; an export with no files is a mismatch', async () => {
  const a = path.join(tmp, 'home-a'), b = path.join(tmp, 'home-b');
  for (const h of [a, b]) { fs.mkdirSync(path.join(h, 'data', 'state'), { recursive: true }); fs.writeFileSync(path.join(h, 'settings.json'), '{}\n'); }
  fs.writeFileSync(path.join(a, 'data', 'state', 'x.json'), '{"x":1}\n');
  const zipFile = path.join(tmp, 'export.zip'), z = await ZipWriter.open(zipFile);
  const files = { 'settings.json': sha('{}\n'), 'data/state/x.json': sha('{"x":1}\n') };
  z.addBuffer('settings.json', '{}\n'); z.addBuffer('data/state/x.json', '{"x":1}\n'); z.addBuffer('manifest.json', JSON.stringify({ files }));
  await z.close();
  assert.deepEqual(await exportMismatches(zipFile, [a]), []);
  assert.deepEqual(await exportMismatches(zipFile, [a, b]), [{ home: b, rel: 'data/state/x.json', why: 'missing' }]);
  fs.writeFileSync(path.join(b, 'data', 'state', 'x.json'), '{"x":2}\n');
  assert.deepEqual(await exportMismatches(zipFile, [b]), [{ home: b, rel: 'data/state/x.json', why: 'different' }]);
  const empty = path.join(tmp, 'empty.zip'), e = await ZipWriter.open(empty); e.addBuffer('manifest.json', JSON.stringify({ files: {} })); await e.close();
  assert.equal((await exportMismatches(empty, [a]))[0].why, 'the export holds no files');
});

test('oldUnits: the timer and the run unit from before the rename, from lib/legacy-names.mjs', () => {
  const o = oldUnits();
  assert.ok(OLD_UNITS.includes(o.timer) && o.timer.endsWith('.timer'));
  assert.ok(OLD_UNITS.includes(o.service) && o.service === o.timer.replace(/\.timer$/, '.service'));
});

test('report: one line per step with its time, PASS only when nothing failed', () => {
  const rows = parseResults('1 install\tPASS\t61.24\t\n2 layout\tFAIL\t1.5\tno app/current\n3 profile\tSKIP\t0\tthe install failed\n');
  assert.deepEqual(rows[1], { step: '2 layout', status: 'FAIL', seconds: 1.5, detail: 'no app/current' });
  const r = report(rows);
  assert.equal(r.code, 1);
  assert.deepEqual(r.text.split('\n'), ['PASS  1 install    61.2s', 'FAIL  2 layout      1.5s  no app/current', 'SKIP  3 profile     0.0s  the install failed', '', 'FAIL: 1 passed, 1 failed, 1 skipped, 62.7s in all']);
  const ok = report(parseResults('1 install\tPASS\t2\t\n11 cleanup\tSKIP\t0\t--keep\n'));
  assert.equal(ok.code, 0); assert.match(ok.text, /^PASS: 1 passed, 0 failed, 1 skipped, 2\.0s in all$/m);
  assert.equal(report([]).code, 1, 'no steps at all is not a pass');
});

test('the command line: next-version, jobs, settings, report exit codes, usage', () => {
  const run = (...a) => spawnSync(process.execPath, [HELPER, ...a], { encoding: 'utf8' });
  assert.equal(run('next-version', '0.2.9').stdout.trim(), '0.2.10');
  const drop = path.join(tmp, 'drop');
  assert.equal(run('jobs', drop).status, 0);
  assert.equal(fs.readdirSync(drop).filter(f => f.endsWith('.md')).length, 3);
  const s = path.join(tmp, 'settings.json'); fs.copyFileSync(path.join(REPO, 'settings.example.json'), s);
  assert.equal(run('settings', s, drop, '04:17').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(s, 'utf8')).schedule.time, '04:17');
  const res = path.join(tmp, 'results.tsv');
  fs.writeFileSync(res, '1 install\tPASS\t1\t\n'); assert.equal(run('report', res).status, 0);
  fs.appendFileSync(res, '2 layout\tFAIL\t1\tbroken\n'); assert.equal(run('report', res).status, 1);
  assert.equal(run('next-version').status, 2);
  assert.equal(run('nothing').status, 1);
});

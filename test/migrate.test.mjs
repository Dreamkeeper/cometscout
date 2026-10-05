// Data migrations (lib/migrate.mjs): in order, each once, recorded in data/state/schema.json after each one; a
// migration that throws stops the run and the ones before it stay recorded; ids must match the file names.
// The install layout (lib/layout.mjs): the home of a release folder, the app/current switch, local edits, pruning,
// adopt of a git-clone layout. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-migrate-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));
const M = await import('../lib/migrate.mjs');
const L = await import('../lib/layout.mjs');

const dir = path.join(tmp, 'migrations'); fs.mkdirSync(dir);
const counter = path.join(tmp, 'data', 'state', 'counter.json');
const mig = (name, body) => fs.writeFileSync(path.join(dir, `${name}.mjs`), `export const id = '${name}';\nexport async function up(ctx) {\n${body}\n}\n`);
const bump = `const c = ctx.readJson(ctx.state('counter.json'), {}); c[id] = (c[id] || 0) + 1; ctx.writeJson(ctx.state('counter.json'), c);`;

test('migrations run in order, once each; schema.json records them; a dry run lists what is pending', async () => {
  mig('002-second', bump); mig('001-first', bump); fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a migration');
  assert.deepEqual(M.listMigrations(dir).map(m => m.id), ['001-first', '002-second']);
  assert.deepEqual((await M.runMigrations({ dir, dryRun: true })).pending, ['001-first', '002-second']);
  assert.equal(fs.existsSync(counter), false, 'a dry run writes nothing');
  const r = await M.runMigrations({ dir });
  assert.deepEqual(r.applied, ['001-first', '002-second']);
  assert.deepEqual(JSON.parse(fs.readFileSync(M.SCHEMA_FILE(), 'utf8')), { version: 1, applied: ['001-first', '002-second'] });
  assert.deepEqual((await M.runMigrations({ dir })).applied, [], 'nothing runs twice');
  assert.deepEqual(JSON.parse(fs.readFileSync(counter, 'utf8')), { '001-first': 1, '002-second': 1 });
});

test('a migration that throws stops the run; the ones before it stay recorded; a wrong id is refused', async () => {
  mig('003-ok', bump); mig('004-boom', "throw new Error('synthetic failure');"); mig('005-later', bump);
  await assert.rejects(M.runMigrations({ dir }), /synthetic failure/);
  assert.deepEqual(M.readSchema().applied, ['001-first', '002-second', '003-ok']);
  assert.equal(JSON.parse(fs.readFileSync(counter, 'utf8'))['005-later'], undefined);
  fs.rmSync(path.join(dir, '004-boom.mjs'));
  fs.writeFileSync(path.join(dir, '004-renamed.mjs'), "export const id = '004-other';\nexport function up() {}\n");
  await assert.rejects(M.runMigrations({ dir }), /must export id "004-renamed"/);
});

test('no migrations folder: nothing to do, schema.json is written once', async () => {
  const f = path.join(tmp, 'other-schema.json');
  assert.deepEqual(await M.runMigrations({ dir: path.join(tmp, 'none'), schemaFile: f }), { applied: [], pending: [], version: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { version: 1, applied: [] });
  assert.deepEqual(M.readSchema(path.join(tmp, 'missing.json')), { version: 1, applied: [] });
});

// ---------- layout ----------
const home = path.join(tmp, 'home');
/** A tiny code folder: just enough files to be adopted. */
function fakeCode(version, dirName = `code-${version}`) {
  const d = path.join(tmp, dirName);
  for (const [rel, text] of Object.entries({ 'cli.mjs': '// cli\n', 'package.json': JSON.stringify({ name: 'cometscout', version }), 'lib/a.mjs': 'export const a = 1;\n',
    'settings.json': '{"private":true}', '.env': 'SECRET=x', 'data/state/x.json': '{}', 'node_modules/p/index.js': '' })) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text);
  }
  return d;
}

test('the home of a release folder is the folder above app/; any other code folder is its own home', () => {
  const h = path.join(tmp, 'h');
  assert.equal(L.homeFromCode(path.join(h, 'app', 'releases', 'v0.2.0')), h);
  assert.equal(L.homeFromCode(path.join(h, 'app', 'releases', 'v0.2.0-beta.1')), h);
  assert.equal(L.homeFromCode(path.join(h, 'app', 'current')), h);
  assert.equal(L.homeFromCode(path.join(h, 'app', 'releases', 'notes')), path.join(h, 'app', 'releases', 'notes'));
  assert.equal(L.homeFromCode(h), h);
});

test('codeFiles without git leaves out the home\'s own files; adopt copies the code, points app/current at it, and is idempotent', () => {
  const code = fakeCode('0.1.0');
  assert.deepEqual(L.codeFiles(code), ['cli.mjs', 'lib/a.mjs', 'package.json']);
  const installs = [], units = [];
  const r = L.adopt({ root: home, code, install: d => { installs.push(d); fs.mkdirSync(path.join(d, 'node_modules')); return true; }, units: () => { units.push(1); return { code: 0, lines: ['units done'] }; } });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(L.currentVersion(home), '0.1.0');
  assert.equal(fs.readFileSync(path.join(L.currentLink(home), 'lib', 'a.mjs'), 'utf8'), 'export const a = 1;\n');
  assert.equal(fs.existsSync(path.join(L.releaseDir(home, '0.1.0'), 'settings.json')), false, 'no personal file is copied');
  assert.deepEqual(L.localEdits(L.releaseDir(home, '0.1.0')), []);
  assert.equal(installs.length, 1); assert.equal(units.length, 1);
  assert.ok(r.lines.includes('units done'));
  const again = L.adopt({ root: home, code, install: () => assert.fail('no second install'), units: () => assert.fail('no second unit run') });
  assert.equal(again.code, 0); assert.match(again.lines[0], /already runs from app\/current \(v0\.1\.0\)/);
});

test('pointCurrent swaps the link; unitCode is app/current for a release; local edits are found; pruning keeps what rollback needs', () => {
  for (const v of ['0.2.0', '0.3.0', '0.4.0', '0.5.0']) { const d = L.releaseDir(home, v); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'cli.mjs'), `// ${v}\n`); }
  assert.equal(L.pointCurrent(home, '0.4.0'), '0.1.0');
  assert.equal(L.currentVersion(home), '0.4.0');
  assert.equal(fs.readFileSync(path.join(L.currentLink(home), 'cli.mjs'), 'utf8'), '// 0.4.0\n');
  assert.throws(() => L.pointCurrent(home, '9.9.9'), /no release folder/);
  assert.equal(L.unitCode(L.releaseDir(home, '0.4.0'), home), L.currentLink(home));
  assert.equal(L.unitCode(REPO, home), REPO);
  assert.deepEqual(L.installedReleases(home), ['0.5.0', '0.4.0', '0.3.0', '0.2.0', '0.1.0']);
  fs.appendFileSync(path.join(L.releaseDir(home, '0.1.0'), 'cli.mjs'), '// edited\n');
  fs.rmSync(path.join(L.releaseDir(home, '0.1.0'), 'lib', 'a.mjs'));
  assert.deepEqual(L.localEdits(L.releaseDir(home, '0.1.0')), [{ rel: 'cli.mjs', why: 'changed' }, { rel: 'lib/a.mjs', why: 'missing' }]);
  assert.equal(L.localEdits(L.releaseDir(home, '0.2.0')), null, 'no list: installed by hand');
  // keep 0.4.0 (current), 0.1.0 (the version the update came from) and 0.3.0; 0.5.0 is newer (a failed attempt) and stays
  assert.deepEqual(L.pruneReleases(home, { also: ['0.1.0'] }), ['0.2.0']);
  assert.deepEqual(L.installedReleases(home), ['0.5.0', '0.4.0', '0.3.0', '0.1.0']);
});

test('install.sh puts the code in app/releases with --adopt and runs the timer and doctor from app/current', () => {
  const sh = fs.readFileSync(path.join(REPO, 'deploy', 'install.sh'), 'utf8');
  assert.match(sh, /^node cli\.mjs update --adopt --no-units$/m);
  assert.match(sh, /^node app\/current\/cli\.mjs timer /m);
  assert.match(sh, /^node app\/current\/cli\.mjs doctor$/m);
  assert.ok(sh.indexOf('update --adopt') < sh.indexOf('app/current/cli.mjs timer'));
});

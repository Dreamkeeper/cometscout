// cli.mjs update and rollback end to end, in a temp home with local fake releases: source zips built from this code
// with another version number and a migration, a canned GitHub API and a fake download (no network, no systemd).
// adopt of a git-clone layout; lock refusals; a migration that throws and a failed check both roll back to the exact
// previous state (the home hashed before and after); a good update backs up, migrates once, switches and passes the
// real checks of the new code (doctor, serve --check, a dry-run decode with the canned model answer, picks);
// rollback by default and with --restore-data (the lost-items list); Tonight after a run. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-update-'));
const H = path.join(tmp, 'home');
process.env.COMETSCOUT_HOME = H;
delete process.env.COMETSCOUT_DATA; delete process.env.COMETSCOUT_SETTINGS; delete process.env.COMETSCOUT_LLM_FAKE;

// ---------- the home: settings, profile, one decoded job, one application ----------
const FAKE_MODEL = path.join(tmp, 'fake-model-cli.mjs');
fs.writeFileSync(FAKE_MODEL, "console.log('9.9.9 (synthetic model cli)');\n");
const write = (rel, text) => { const p = path.join(H, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
write('settings.json', JSON.stringify({ candidate_name: 'Sam Example', timezone: 'UTC', locale: 'en', llm: { provider: 'claude', model: 'sonnet', pack_model: 'opus', bin: FAKE_MODEL },
  sources: {}, pack: { enabled: false }, backup: { nightly: false }, update: { channel: 'stable' } }, null, 2) + '\n');
write('profile/profile.md', `# Sam Example (synthetic)\n\n${'Product manager for logistics software, remote, English. '.repeat(6)}\n`);
const JOB = '2026-10-01--acme--product-manager.md';
write(`data/decoded/${JOB}`, ['---', 'company: "Acme"', 'role: "Product Manager"', 'url: "https://jobs.example/acme-pm"', 'source: "ats_boards"', 'location: "Remote"', 'found: 2026-10-01', '---', '',
  '# Acme - Product Manager', '', 'Synthetic job text. '.repeat(30), '', '## Decode Result', 'Decoded 2026-10-01 by CometScout (claude/sonnet).', 'verdict: strong-fit', 'confidence: high', 'apply_priority: 1',
  'rationale: Fits.', 'fit_signals: logistics', 'gaps: none', 'action: Apply.', ''].join('\n'));
write('data/state/applications.json', JSON.stringify({ 'acme--product-manager': { company: 'Acme', role: 'Product Manager', status: 'applied', updated: '2026-10-02', events: [{ type: 'applied', date: '2026-10-02' }] } }, null, 1));

const L = await import('../lib/layout.mjs');
const U = await import('../lib/update.mjs');
const { releaseBody } = await import('../lib/release.mjs');
const { ZipWriter, readZip } = await import('../lib/zip.mjs');
const { listBackups } = await import('../lib/backup.mjs');
const { takeLock } = await import('../lib/lock.mjs');

// ---------- fake releases ----------
const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: REPO, encoding: 'utf8' });
const CODE_FILES = (git.status === 0 && git.stdout ? git.stdout.split('\0').filter(Boolean) : L.codeFiles(REPO)).filter(f => fs.existsSync(path.join(REPO, f)) && fs.statSync(path.join(REPO, f)).isFile());
const BASE = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const RELEASES = {};
/** A source zip like GitHub's: this code under "cometscout-<version>/", with the version, a release.json entry and migrations added. */
async function makeRelease(version, migrations = {}) {
  const src = path.join(tmp, 'src', version);
  for (const rel of CODE_FILES) { const to = path.join(src, ...rel.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(REPO, ...rel.split('/')), to); }
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')); pkg.version = version; fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const entry = { version, date: '2026-11-01', min_node: 20, schema_version: 1, migrations: Object.keys(migrations), behaviour_changes: false, notes: { highlights: [`Synthetic release ${version}.`], new: ['A synthetic change.'] } };
  fs.writeFileSync(path.join(src, 'release.json'), JSON.stringify([entry, ...JSON.parse(fs.readFileSync(path.join(src, 'release.json'), 'utf8'))], null, 2) + '\n');
  const files = [...CODE_FILES];
  for (const [id, body] of Object.entries(migrations)) { fs.mkdirSync(path.join(src, 'migrations'), { recursive: true }); fs.writeFileSync(path.join(src, 'migrations', `${id}.mjs`), `export const id = '${id}';\nexport async function up(ctx) {\n${body}\n}\n`); files.push(`migrations/${id}.mjs`); }
  const zipFile = path.join(tmp, `cometscout-${version}.zip`), z = await ZipWriter.open(zipFile);
  for (const rel of files) await z.addFile(`cometscout-${version}/${rel}`, path.join(src, ...rel.split('/')));
  await z.close();
  const buf = fs.readFileSync(zipFile), sha = crypto.createHash('sha256').update(buf).digest('hex');
  RELEASES[version] = { buf, sha, gh: { tag_name: `v${version}`, draft: false, prerelease: false, html_url: `https://github.example/v${version}`, body: releaseBody(entry, sha) } };
}
const fetchCalls = [];
const fakeFetch = async url => {
  fetchCalls.push(url);
  const tag = url.match(/\/releases\/tags\/v(.+)$/);
  if (tag) return RELEASES[tag[1]] ? { ok: true, status: 200, json: async () => RELEASES[tag[1]].gh } : { ok: false, status: 404, json: async () => ({}) };
  if (/\/releases\?per_page=/.test(url)) return { ok: true, status: 200, json: async () => Object.values(RELEASES).map(r => r.gh) };
  throw new Error(`unexpected request ${url}`);
};
const downloads = [];
const download = async url => { downloads.push(url); const v = url.match(/refs\/tags\/v(.+)\.zip$/)?.[1]; if (!RELEASES[v]) throw new Error('404'); return RELEASES[v].buf; };
const install = dir => { fs.cpSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), { recursive: true }); return true; };
const unitRuns = [], sent = [];
const units = () => { unitRuns.push(L.currentVersion(H)); return { code: 0, lines: [] }; };
const deps = (extra = {}) => ({ fetch: fakeFetch, download, install, units, send: async t => sent.push(t), say: () => {}, ...extra });

/** Every file an update may touch (data, profile, settings; not backups/ or app/), hashed, plus where app/current points. */
function hashHome() {
  const out = { current: L.currentVersion(H) };
  const skip = new Set(['data/state/update.json', 'data/state/bot.json', 'data/state/run.lock']);
  const walk = rel => { const p = path.join(H, ...rel.split('/')); if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walk(r); else if (!skip.has(r)) out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(H, ...r.split('/')))).digest('hex'); } };
  for (const d of ['inbox', 'decoded', 'rejected', 'digests', 'packs', 'state']) walk(`data/${d}`);
  walk('profile'); out['settings.json'] = crypto.createHash('sha256').update(fs.readFileSync(path.join(H, 'settings.json'))).digest('hex');
  return out;
}
// the commands run as this process's children under its lock (it took the lock as cli.mjs update does), unless parent is false
const cli = (args, env = {}, { parent = true } = {}) => spawnSync(process.execPath, [path.join(L.currentLink(H), 'cli.mjs'), ...args], { encoding: 'utf8', cwd: H, env: { ...process.env, ...(parent ? { COMETSCOUT_LOCK_PARENT: String(process.pid) } : {}), ...env } });
/** A live process that is not this one, to hold the run lock. */
function holder() { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' }); const gone = new Promise(r => c.once('exit', r)); return { pid: c.pid, stop: () => { c.kill(); return gone; } }; }
const LOCK = path.join(H, 'data', 'state', 'run.lock');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment longer */ } });

await makeRelease('0.1.1', { '002-boom': "ctx.writeJson(ctx.state('boom.json'), { half: 'done' });\nthrow new Error('synthetic migration failure');" });
await makeRelease('0.1.2', { '002-add-flag': "ctx.writeJson(ctx.state('flag.json'), { flag: true });" });
await makeRelease('0.2.0', { '002-add-flag': "const fs = await import('node:fs'); fs.appendFileSync(ctx.state('flag-log.txt'), 'ran\\n');\nctx.writeJson(ctx.state('flag.json'), { flag: true });" });

test('updates refuse a git-clone layout; adopt moves the code into app/releases and the release finds its home by itself', () => {
  assert.equal(BASE, '0.1.0');
  return (async () => {
    const r0 = await U.runUpdate(deps({ to: '0.2.0' }));
    assert.equal(r0.code, 1); assert.match(r0.lines[0], /update --adopt once/);
    const a = L.adopt({ root: H, code: REPO, files: CODE_FILES, install, units });
    assert.equal(a.code, 0, a.lines.join('\n'));
    assert.equal(L.currentVersion(H), '0.1.0');
    assert.deepEqual(L.localEdits(L.releaseDir(H, '0.1.0')), []);
    assert.equal(L.adopt({ root: H, code: REPO, files: CODE_FILES, install, units }).code, 0, 'again: nothing to do');
    assert.equal(unitRuns.length, 1);
    // no COMETSCOUT_HOME: app/releases/v0.1.0 knows the home is two folders above app/
    const env = { ...process.env }; delete env.COMETSCOUT_HOME;
    const r = spawnSync(process.execPath, [path.join(L.currentLink(H), 'cli.mjs'), 'list'], { encoding: 'utf8', cwd: tmp, env });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /applied\s+Acme: Product Manager/);
  })();
});

test('lock refusals: update, rollback and migrate wait for a run; a step under the update\'s lock runs', async () => {
  const h = holder(); fs.writeFileSync(LOCK, String(h.pid));
  try {
    const u = await U.runUpdate(deps({ to: '0.2.0' }));
    assert.equal(u.code, 1); assert.match(u.lines.join('\n'), /Not updating: another CometScout run is in progress/);
    const r = await U.runRollback({ say: () => {}, units });
    assert.equal(r.code, 1); assert.match(r.lines.join('\n'), /Not rolling back: another CometScout run/);
    const m = cli(['migrate']); assert.equal(m.status, 1); assert.match(m.stdout, /another CometScout run is in progress/);
    assert.deepEqual(downloads, [], 'nothing was downloaded');
  } finally { await h.stop(); fs.rmSync(LOCK, { force: true }); }
  assert.equal(takeLock(), null, 'this process takes the lock, as cli.mjs update does');
  assert.equal(cli(['migrate'], {}, { parent: false }).status, 1, 'another process is refused');
  const m = cli(['migrate'], { COMETSCOUT_LOCK_PARENT: String(process.pid) });
  assert.equal(m.status, 0, m.stdout); assert.equal(fs.readFileSync(LOCK, 'utf8'), String(process.pid), 'the parent keeps its lock');
  fs.rmSync(path.join(H, 'data', 'state', 'schema.json'), { force: true });
});

test('preflight: a missing tag, a download that does not match, and code edited in place stop the update before anything is written', async () => {
  const before = hashHome(), backups = listBackups().length;
  assert.match((await U.runUpdate(deps({ to: '0.3.0' }))).lines.join('\n'), /no release v0\.3\.0 on GitHub/);
  assert.match((await U.runUpdate(deps({ to: '0.2.0', download: async () => Buffer.from('not the zip') }))).lines.join('\n'), /does not match the sha256/);
  const f = path.join(L.releaseDir(H, '0.1.0'), 'lib', 'text.mjs'); const orig = fs.readFileSync(f);
  fs.appendFileSync(f, '// a local edit\n');
  try { assert.match((await U.runUpdate(deps({ to: '0.2.0' }))).lines.join('\n'), /edited in place \(lib\/text\.mjs changed\)/); } finally { fs.writeFileSync(f, orig); }
  assert.match((await U.runUpdate(deps({ to: '0.1.0' }))).lines.join('\n'), /not newer than v0\.1\.0/);
  assert.deepEqual(hashHome(), before); assert.equal(listBackups().length, backups);
});

test('a migration that throws rolls back to the exact previous state; the failed release stays for a look', async () => {
  const before = hashHome();
  const r = await U.runUpdate(deps({ to: '0.1.1' }));
  assert.equal(r.code, 1); assert.equal(r.step, 'migrate');
  assert.deepEqual(hashHome(), before);
  assert.equal(fs.existsSync(path.join(H, 'data', 'state', 'boom.json')), false);
  assert.equal(L.currentVersion(H), '0.1.0');
  assert.ok(fs.existsSync(path.join(L.releaseDir(H, '0.1.1'), 'cli.mjs')));
  assert.ok(listBackups().some(b => b.label === 'pre-update-v0.1.0-to-v0.1.1'));
  assert.match(sent.at(-1), /^The update to v0\.1\.1 failed at migrate and was rolled back to v0\.1\.0\./);
  assert.deepEqual(U.readState().history.at(-1).result, 'rolled back');
});

test('a failed check after the switch switches back, restores the data exactly and regenerates the units again', async () => {
  const before = hashHome(), runs = unitRuns.length;
  const r = await U.runUpdate(deps({ to: '0.1.2', verify: () => ({ ok: false, step: 'serve --check', detail: 'synthetic: the workspace did not answer' }) }));
  assert.equal(r.code, 1); assert.equal(r.step, 'verify (serve --check)');
  assert.deepEqual(hashHome(), before);
  assert.equal(fs.existsSync(path.join(H, 'data', 'state', 'flag.json')), false, 'what the migration wrote is gone');
  assert.deepEqual(unitRuns.slice(runs), ['0.1.2', '0.1.0'], 'units for the new code, then for the old again');
  assert.match(r.lines.join('\n'), /synthetic: the workspace did not answer/);
});

let preUpdate;
test('an update: backup, side-by-side install, migration once, switch, the new code\'s own checks, What is new', async () => {
  preUpdate = hashHome();
  const r = await U.runUpdate(deps({ to: '0.2.0' }));
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(L.currentVersion(H), '0.2.0');
  assert.ok(listBackups().some(b => b.label === 'pre-update-v0.1.0-to-v0.2.0'));
  assert.equal(fs.readFileSync(path.join(H, 'data', 'state', 'flag-log.txt'), 'utf8'), 'ran\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(H, 'data', 'state', 'schema.json'), 'utf8')).applied, ['002-add-flag']);
  const again = cli(['migrate']);
  assert.equal(again.status, 0); assert.match(again.stdout, /No pending migrations/);
  assert.equal(fs.readFileSync(path.join(H, 'data', 'state', 'flag-log.txt'), 'utf8'), 'ran\n', 'applied once');
  assert.deepEqual(L.localEdits(L.releaseDir(H, '0.2.0')), []);
  assert.deepEqual(L.installedReleases(H), ['0.2.0', '0.1.2', '0.1.0'], '0.1.0 (where it came from) is kept, 0.1.1 is pruned');
  const st = U.readState();
  assert.equal(st.whats_new_pending, '0.2.0'); assert.equal(st.whats_new_from, '0.1.0');
  const w = U.whatsNew({ current: '0.2.0', list: JSON.parse(fs.readFileSync(path.join(L.releaseDir(H, '0.2.0'), 'release.json'), 'utf8')) });
  assert.equal(w.show, true); assert.deepEqual(w.releases.map(x => x.version), ['0.2.0']);
  assert.match(sent.at(-1), /^CometScout is updated to v0\.2\.0 \(from v0\.1\.0\)\.\nSynthetic release 0\.2\.0\.\nWhat is new: /);
  assert.equal(cli(['serve', '--check']).status, 0, 'the new release serves the workspace');
});

test('rollback: by default the code goes back to where the update came from, not to a failed attempt', async () => {
  const r = await U.runRollback({ units, say: () => {} });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(L.currentVersion(H), '0.1.0');
  assert.equal(fs.readFileSync(path.join(H, 'data', 'state', 'flag-log.txt'), 'utf8'), 'ran\n', 'data stays: expand, then contract');
  assert.equal((await U.runRollback({ to: 'v9.9.9', units, say: () => {} })).code, 1);
  L.pointCurrent(H, '0.2.0');
});

test('rollback --restore-data lists what would be lost, asks for --yes, backs up, restores the pre-update state and offers the re-import', async () => {
  write('data/decoded/2026-11-02--beta--analyst.md', '---\ncompany: "Beta"\nrole: "Analyst"\n---\n\nSynthetic.\n');
  const apps = JSON.parse(fs.readFileSync(path.join(H, 'data', 'state', 'applications.json'), 'utf8'));
  apps['acme--product-manager'].events.push({ type: 'interview', date: '2026-11-03', event_date: '2026-11-10' });
  write('data/state/applications.json', JSON.stringify(apps, null, 1));
  const ask = await U.runRollback({ restoreData: true, units, say: () => {} });
  assert.equal(ask.code, 1);
  const text = ask.lines.join('\n');
  assert.match(text, /data\/decoded: 1 new/);
  assert.match(text, /data\/state: 3 new, 1 changed/);
  assert.match(text, /application events:\n {4}Acme: 1/);
  assert.match(text, /Run again with --yes/);
  assert.equal(L.currentVersion(H), '0.2.0', 'nothing changed without --yes');
  const r = await U.runRollback({ restoreData: true, yes: true, units, say: () => {} });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual(hashHome(), preUpdate, 'the state from before the update, and the code it ran');
  const fresh = listBackups().find(b => b.label === 'pre-rollback-v0.2.0');
  assert.ok(fresh);
  assert.ok(readZip(fresh.file).entries.some(e => e.name === 'data/decoded/2026-11-02--beta--analyst.md'), 'the newer items are in the fresh backup');
  assert.match(r.lines.at(-1), /^To bring back the newer items listed above: node cli\.mjs import --from .*pre-rollback-v0\.2\.0\.zip --on-conflict keep --data-only$/);
});

test('Tonight: the choice is kept, the next run starts the update, which waits for the run to let go of the lock', async () => {
  assert.equal(U.updateAction('tonight', '0.2.0', { current: '0.1.0' }).changed, true);
  const launched = [];
  await U.afterRun({ fetch: fakeFetch, current: '0.1.0', send: async () => {}, launch: a => { launched.push(a); return { ok: true, how: 'test' }; } });
  assert.deepEqual(launched, [['update', '--to', 'v0.2.0', '--wait-lock']]);
  const h = holder(); fs.writeFileSync(LOCK, String(h.pid));
  let waited = 0;
  const r = await U.runUpdate(deps({ to: '0.2.0', waitLock: true, verify: () => ({ ok: true }), wait: async () => { waited++; await h.stop(); } }));
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(waited, 1);
  assert.equal(L.currentVersion(H), '0.2.0');
  assert.equal(U.readState().pending, null, 'Tonight is done');
});

test('in a git-clone home with app/current, the clone\'s cli.mjs hands every command to the active release, except --adopt', () => {
  const clone = path.join(tmp, 'clone');
  for (const rel of CODE_FILES) { const to = path.join(clone, ...rel.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(REPO, ...rel.split('/')), to); }
  const rel = path.join(clone, 'app', 'releases', 'v9.9.9'); fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, 'cli.mjs'), "console.log('active release:', process.argv.slice(2).join(' '));\n");
  L.pointCurrent(clone, '9.9.9');
  const env = { ...process.env }; delete env.COMETSCOUT_HOME;
  const run = args => spawnSync(process.execPath, [path.join(clone, 'cli.mjs'), ...args], { encoding: 'utf8', cwd: clone, env });
  assert.equal(run(['list', '--x']).stdout.trim(), 'active release: list --x');
  assert.match(run(['update', '--adopt']).stdout, /already runs from app\/current \(v9\.9\.9\)/);
});

test('decode --file decodes one job again only as a dry run, and writes nothing', () => {
  const before = hashHome();
  const refused = cli(['decode', '--file', JOB]);
  assert.equal(refused.status, 1); assert.match(refused.stdout, /--file needs --dry-run/);
  const r = cli(['decode', '--dry-run', '--file', JOB], { COMETSCOUT_LLM_FAKE: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(r.stdout.includes(`${JOB}: long-shot (dry run, nothing written)`), r.stdout);
  assert.equal(cli(['decode', '--dry-run', '--file', '../settings.json']).status, 1);
  assert.deepEqual(hashHome(), before);
});

// Encrypted secrets export: round trip, wrong passphrase, conflicts, no plaintext in the file, passphrase sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-secrets-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home);
const ENV = 'RTJ_API_TOKEN=planted-token-0a1b2c3d\nHIRIFY_COOKIE="session=planted-cookie-9z8y"\n';
const JAR = JSON.stringify({ env: 'abc', cookies: { refresh: 'planted-jar-value-5e6f' } });
fs.writeFileSync(path.join(home, '.env'), ENV);
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ timezone: 'UTC' }));
process.env.JOBPILOT_HOME = home;
process.env.JOBPILOT_DATA = path.join(home, 'data');
delete process.env.JOBPILOT_SETTINGS;
delete process.env.JOBPILOT_SECRETS_PASSPHRASE;
const { STATE } = await import('../lib/config.mjs');
const S = await import('../lib/secrets.mjs');
fs.writeFileSync(STATE('hirify-cookies.json'), JAR);
const PASS = 'correct horse battery';
const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, input: '', env: { ...process.env, ...env } });

test('export, delete, import: the same bytes come back, with private file modes', () => {
  const out = path.join(tmp, 'secrets.enc');
  const r = S.exportSecrets({ out, passphrase: PASS });
  assert.deepEqual(r.files, ['.env', 'data/state/hirify-cookies.json']);
  const raw = fs.readFileSync(out, 'utf8');
  for (const s of ['planted-token-0a1b2c3d', 'planted-cookie-9z8y', 'planted-jar-value-5e6f', 'RTJ_API_TOKEN']) assert.ok(!raw.includes(s), s);
  assert.equal(JSON.parse(raw).format, 'jobpilot-secrets');
  fs.rmSync(path.join(home, '.env')); fs.rmSync(STATE('hirify-cookies.json'));
  const imp = S.importSecrets({ from: out, passphrase: PASS });
  assert.deepEqual(imp.add, ['.env', 'data/state/hirify-cookies.json']);
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), ENV);
  assert.equal(fs.readFileSync(STATE('hirify-cookies.json'), 'utf8'), JAR);
  if (process.platform !== 'win32') for (const f of [out, path.join(home, '.env')]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
  assert.deepEqual(S.importSecrets({ from: out, passphrase: PASS }).same, ['.env', 'data/state/hirify-cookies.json']);
});

test('a wrong passphrase fails cleanly and writes nothing', () => {
  const out = path.join(tmp, 'wrong.enc'); S.exportSecrets({ out, passphrase: PASS });
  fs.rmSync(path.join(home, '.env'));
  assert.throws(() => S.importSecrets({ from: out, passphrase: 'not the passphrase' }), /^Error: wrong passphrase, or the secrets file is damaged$/);
  assert.ok(!fs.existsSync(path.join(home, '.env')));
  const doc = JSON.parse(fs.readFileSync(out, 'utf8')); doc.data = Buffer.from('x'.repeat(40)).toString('base64');
  assert.throws(() => S.decrypt(doc, PASS), /wrong passphrase, or the secrets file is damaged/);
  doc.kdf.N = 2 ** 30; assert.throws(() => S.decrypt(doc, PASS), /unsupported key settings/);
  fs.writeFileSync(path.join(home, '.env'), ENV);
});

test('a different local file stops the import unless --force, which keeps the old one aside', () => {
  const out = path.join(tmp, 'conflict.enc'); S.exportSecrets({ out, passphrase: PASS });
  fs.writeFileSync(path.join(home, '.env'), 'RTJ_API_TOKEN=a-newer-local-token\n');
  assert.throws(() => S.importSecrets({ from: out, passphrase: PASS, date: '2026-10-02' }), /\.env already exist.*--force/);
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), 'RTJ_API_TOKEN=a-newer-local-token\n');
  const r = S.importSecrets({ from: out, passphrase: PASS, force: true, date: '2026-10-02' });
  assert.deepEqual(r.replaced, ['.env.replaced-2026-10-02']);
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), ENV);
  assert.equal(fs.readFileSync(path.join(home, '.env.replaced-2026-10-02'), 'utf8'), 'RTJ_API_TOKEN=a-newer-local-token\n');
});

test('passphrase: from the environment, else asked twice; a short one is refused', async () => {
  assert.equal(await S.readPassphrase({ env: { JOBPILOT_SECRETS_PASSPHRASE: 'from-env-123' }, ask: () => { throw new Error('asked'); } }), 'from-env-123');
  const answers = ['one-passphrase', 'another-one'];
  await assert.rejects(S.readPassphrase({ env: {}, confirm: true, ask: async () => answers.shift() }), /differ/);
  assert.equal(await S.readPassphrase({ env: {}, confirm: true, ask: async () => 'same-passphrase' }), 'same-passphrase');
  assert.throws(() => S.exportSecrets({ out: path.join(tmp, 'short.enc'), passphrase: 'short' }), /at least 8/);
});

test('the CLI takes the passphrase from JOBPILOT_SECRETS_PASSPHRASE, never from an argument, and needs a terminal otherwise', () => {
  const out = path.join(tmp, 'cli.enc');
  let r = cli(['export-secrets', '--out', out]);
  assert.equal(r.status, 1); assert.match(r.stdout, /no terminal to ask for the passphrase; set JOBPILOT_SECRETS_PASSPHRASE/);
  r = cli(['export-secrets', '--out', out], { JOBPILOT_SECRETS_PASSPHRASE: PASS });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Encrypted \.env, data\/state\/hirify-cookies\.json/);
  r = cli(['import-secrets', '--from', out, '--dry-run'], { JOBPILOT_SECRETS_PASSPHRASE: PASS });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Dry run, nothing written\. identical: \.env, data\/state\/hirify-cookies\.json/);
  r = cli(['import-secrets', '--from', out], { JOBPILOT_SECRETS_PASSPHRASE: 'wrong passphrase' });
  assert.equal(r.status, 1); assert.match(r.stdout, /Secrets import stopped: wrong passphrase/);
});

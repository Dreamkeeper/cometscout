// Environment variable names (lib/env-names.mjs) and the places that write or load .env: names that change how a
// program starts, where traffic goes or which certificates are trusted, and CometScout's own control variables, are
// never written by lib/secrets.mjs, never offered or used by a secrets link, and never loaded from .env by
// lib/config.mjs (doctor lists them). *_env settings resolve to a checked name: never another feature's secret.
// Synthetic data only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OLD_ENV, NEW_ENV } from '../lib/legacy-names.mjs';
import { refusedEnvName, secretEnvName, secretEnvOf, secretEnvProblems, KNOWN_SECRETS, FORM_SECRETS } from '../lib/env-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-env-names-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
const { setEnvValues } = await import('../lib/secrets.mjs');
const form = await import('../lib/secrets-form.mjs');
const schema = await import('../lib/settings-schema.mjs');

const DANGEROUS = ['NODE_OPTIONS', 'node_options', 'NODE_PATH', 'PATH', 'Path', 'HOME', 'SHELL', 'ENV', 'BASH_ENV', 'IFS', 'COMSPEC',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT',
  'HTTP_PROXY', 'https_proxy', 'ALL_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'GIT_SSH_COMMAND', 'GIT_DIR', 'GIT', 'SOFFICE', 'npm_config_registry', 'NPM_CONFIG_SCRIPT_SHELL',
  `${NEW_ENV}SETTINGS`, `${NEW_ENV}TRANSCRIBE_CMD`, `${OLD_ENV}HOME`, `${OLD_ENV.toLowerCase()}data`];

test('refusedEnvName: start-up, proxy, certificate and control names are refused in any case; the secrets are not', () => {
  for (const k of DANGEROUS) assert.ok(refusedEnvName(k), `${k} should be refused`);
  for (const k of [...KNOWN_SECRETS, 'RTJ_API_TOKEN_2', 'MY_COOKIE', 'PATHFINDER_TOKEN', 'HOMEPAGE_TOKEN']) assert.equal(refusedEnvName(k), null, k);
  assert.match(refusedEnvName(`${NEW_ENV}DATA`), /control variable/);
});

test('secretEnvName: the default when unset; never a refused name, the model CLI\'s login, or another feature\'s secret', () => {
  assert.deepEqual(secretEnvName(undefined, 'RTJ_API_TOKEN'), { name: 'RTJ_API_TOKEN', problem: null });
  assert.deepEqual(secretEnvName('RTJ_TOKEN_SECOND', 'RTJ_API_TOKEN'), { name: 'RTJ_TOKEN_SECOND', problem: null }, 'a name of your own is fine');
  assert.match(secretEnvName('GMAIL_CLIENT_SECRET', 'RTJ_API_TOKEN').problem, /secret of another feature/);
  assert.match(secretEnvName('telegram_bot_token', 'TELEGRAM_CHAT_ID').problem, /secret of another feature/);
  assert.match(secretEnvName('NODE_OPTIONS', 'TELEGRAM_CHAT_ID').problem, /cannot hold a secret/);
  assert.match(secretEnvName('ANTHROPIC_API_KEY', 'RTJ_API_TOKEN').problem, /model CLI/);
  assert.match(secretEnvName('a b', 'RTJ_API_TOKEN').problem, /not a variable name/);
  assert.equal(secretEnvName('NODE_OPTIONS', 'TELEGRAM_CHAT_ID').name, '');
  const s = { sources: { rtj: { token_env: 'HIRIFY_COOKIE' } }, delivery: { telegram: { chat_id_env: 'PATH' } } };
  assert.equal(secretEnvOf(s, 'sources.rtj.token_env'), '');
  assert.equal(secretEnvOf(s, 'delivery.telegram.token_env'), 'TELEGRAM_BOT_TOKEN');
  assert.deepEqual(secretEnvProblems(s).map(p => p.split(':')[0]), ['sources.rtj.token_env', 'delivery.telegram.chat_id_env']);
  assert.deepEqual(FORM_SECRETS, ['RTJ_API_TOKEN', 'HIRIFY_COOKIE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET']);
});

test('setEnvValues refuses every dangerous name, whoever calls it, and writes nothing', () => {
  const f = path.join(tmp, 'set.env');
  fs.writeFileSync(f, 'RTJ_API_TOKEN=synthetic-keep-0001\n');
  for (const k of DANGEROUS) {
    assert.throws(() => setEnvValues({ TELEGRAM_CHAT_ID: '123', [k]: '--require ./x.js' }, f), new RegExp(`${k} cannot be written to \\.env`));
    assert.equal(fs.readFileSync(f, 'utf8'), 'RTJ_API_TOKEN=synthetic-keep-0001\n', `${k}: nothing written`);
  }
  assert.deepEqual(setEnvValues({ TELEGRAM_CHAT_ID: '123' }, f), ['TELEGRAM_CHAT_ID']);
});

test('a secrets link offers only the fixed names, and a stored link naming anything else writes nothing', () => {
  const file = path.join(tmp, 'links.json'), envFile = path.join(tmp, 'links.env');
  for (const k of ['NODE_OPTIONS', 'GMAIL_REFRESH_TOKEN', `${NEW_ENV}HOME`]) {
    assert.throws(() => form.issueLink([k], { file }), /cannot be set here/);
    assert.throws(() => form.issueLink([k], { file, allowed: [k] }), /cannot be set here/, `${k}: the caller cannot widen the list`);
  }
  // a link written before this check (or by hand) that names NODE_OPTIONS
  const t0 = Date.parse('2026-10-07T10:00:00Z');
  const a = form.issueLink(['TELEGRAM_CHAT_ID'], { file, now: t0 });
  const j = JSON.parse(fs.readFileSync(file, 'utf8')); j.links[0].keys.push('NODE_OPTIONS'); fs.writeFileSync(file, JSON.stringify(j));
  const r = form.useLink(a.token, { NODE_OPTIONS: '--require ./evil.js' }, { file, envFile, now: t0 + 1000 });
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.match(r.error, /cannot set NODE_OPTIONS/);
  assert.ok(!fs.existsSync(envFile), '.env was not written');
});

test('the settings table: every *_env key and workspace.url are locked; reserved names are never a known path', () => {
  const envKeys = schema.SCHEMA.filter(x => /_env$/.test(x.key));
  assert.deepEqual(envKeys.map(x => x.key).sort(), ['delivery.telegram.chat_id_env', 'delivery.telegram.token_env', 'sources.hirify.cookie_env', 'sources.rtj.token_env']);
  for (const x of envKeys) assert.match(x.locked, /environment variable/, x.key);
  assert.match(schema.entryFor('workspace.url').locked, /secrets link/);
  for (const p of ['sources_report.prices.__proto__', 'sources_report.prices.constructor.price_month', 'modules.transcribe.engines.prototype', 'picks.__proto__']) {
    assert.equal(schema.knownPath(p.split('.')), false, p); assert.equal(schema.entryFor(p), null, p);
  }
  assert.deepEqual(schema.forbiddenKeys(['sources_report', 'prices'], JSON.parse('{"a": {"__proto__": 1}, "b": [{"constructor": 2}]}')), ['sources_report.prices.a.__proto__', 'sources_report.prices.b.0.constructor']);
  assert.deepEqual(schema.forbiddenKeys(['picks', 'per_day'], 2), []);
});

test('.env loading: dangerous and control names are not exported, doctor lists them, the secrets still load', () => {
  const h = path.join(tmp, 'loader-home'); fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, '.env'), ['NODE_OPTIONS=--max-old-space-size=99', 'https_proxy=http://127.0.0.1:9', 'LD_PRELOAD=/tmp/x.so', `${NEW_ENV}SETTINGS=/tmp/evil.json`,
    `${OLD_ENV}DATA=/tmp/evil-data`, 'GIT_SSH_COMMAND=touch /tmp/pwned', 'RTJ_API_TOKEN=synthetic-loader-0001', ''].join('\n'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_OPTIONS|https?_proxy|LD_PRELOAD|GIT_SSH_COMMAND|RTJ_API_TOKEN)$/i.test(k) && ![NEW_ENV, OLD_ENV].some(p => k.toUpperCase().startsWith(p))));
  Object.assign(env, { COMETSCOUT_HOME: h, COMETSCOUT_DATA: path.join(h, 'data') });
  const probe = `const c = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'config.mjs')).href)});
const pick = k => Object.keys(process.env).find(x => x.toUpperCase() === k.toUpperCase());
console.log(JSON.stringify({ seen: ['NODE_OPTIONS', 'HTTPS_PROXY', 'LD_PRELOAD', '${NEW_ENV}SETTINGS', '${OLD_ENV}DATA', 'GIT_SSH_COMMAND'].filter(k => pick(k) && process.env[pick(k)]), token: process.env.RTJ_API_TOKEN, data: c.DATA, settings: c.SETTINGS_FILE, refused: c.ENV_REFUSED.map(x => x.key) }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.seen, [], 'nothing dangerous reached process.env');
  assert.equal(out.token, 'synthetic-loader-0001', 'the secret still loads');
  assert.equal(out.data, path.join(h, 'data')); assert.ok(!out.settings.includes('evil'));
  assert.deepEqual(out.refused, ['NODE_OPTIONS', 'https_proxy', 'LD_PRELOAD', `${NEW_ENV}SETTINGS`, `${OLD_ENV}DATA`, 'GIT_SSH_COMMAND']);
  const doc = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'doctor'], { encoding: 'utf8', env });
  assert.match(doc.stdout, /^warn \.env lines not loaded: NODE_OPTIONS \(it changes how Node\.js starts\); https_proxy \(.*\); .*GIT_SSH_COMMAND/m);
  assert.ok(!doc.stdout.includes('synthetic-loader-0001'));
});

// Settings override, number guard, .env parsing, model environment without secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-config-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'custom-settings.json');
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ candidate_name: 'Test Person', picks: { per_day: 4 } }));
fs.writeFileSync(path.join(tmp, '.env'), 'export TEST_RTJ_API_TOKEN="abcdefghijkl" \nPLAIN_VALUE=hello\nnot a line\n');

const c = await import('../lib/config.mjs');

test('COMETSCOUT_SETTINGS replaces settings.json and merges with defaults', () => {
  assert.equal(c.SETTINGS.candidate_name, 'Test Person');
  assert.equal(c.SETTINGS.picks.per_day, 4);
  assert.equal(c.SETTINGS.picks.window_days, 14, 'default kept');
});

test('a missing COMETSCOUT_SETTINGS file stops with a clear error', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify('file://' + path.join(ROOT, 'lib', 'config.mjs').replace(/\\/g, '/'))})`],
    { env: { ...process.env, COMETSCOUT_SETTINGS: path.join(tmp, 'missing.json') }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist/);
});

test('num falls back on typos and out-of-range values', () => {
  assert.equal(c.num('two', 2), 2);
  assert.equal(c.num('', 5), 5);
  assert.equal(c.num(50, 10, 0, 20), 10);
  assert.equal(c.num('7', 1), 7);
});

test('.env: export prefix, quotes and trailing spaces; bad lines reported', () => {
  assert.equal(process.env.TEST_RTJ_API_TOKEN, 'abcdefghijkl');
  assert.equal(process.env.PLAIN_VALUE, 'hello');
  assert.deepEqual(c.ENV_PROBLEMS, ['not a line']);
});

test('the model environment carries no secrets, and secret values are known for the output check', () => {
  const env = c.modelEnv();
  assert.equal(env.TEST_RTJ_API_TOKEN, undefined);
  assert.equal(env.PLAIN_VALUE, undefined, 'everything from .env is removed');
  assert.ok(env.PATH || env.Path, 'ordinary variables stay');
  assert.ok(c.SECRET_VALUES().includes('abcdefghijkl'));
});

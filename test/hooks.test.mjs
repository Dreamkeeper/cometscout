// Hooks: payload on stdin, failures and timeouts never throw, unknown events are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-hooks-'));
const out = path.join(tmp, 'event.json');
const writer = path.join(tmp, 'write-stdin.mjs');
fs.writeFileSync(writer, `import fs from 'node:fs'; let s=''; process.stdin.on('data', d => s += d).on('end', () => fs.writeFileSync(process.argv[2], s));`);
const sleeper = path.join(tmp, 'sleep.mjs');
fs.writeFileSync(sleeper, 'setTimeout(() => {}, 5000);');
const q = p => `"${p}"`;
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({
  hooks: {
    timeout_sec: 1,
    job_written: `node ${q(writer)} ${q(out)}`,
    decoded: ['node -e "process.exit(3)"', `node ${q(sleeper)}`],
  },
}));

const { runHook, hooksFor, HOOK_EVENTS } = await import('../lib/hooks.mjs');

test('the payload arrives on stdin as JSON with the event name', () => {
  const r = runHook('job_written', { file: 'a.md', company: 'Acme' });
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, true);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(got.event, 'job_written');
  assert.equal(got.file, 'a.md');
  assert.ok(got.at);
});

test('a failing or slow hook is reported, never thrown', () => {
  const r = runHook('decoded', { file: 'b.md' });
  assert.equal(r.length, 2);
  assert.equal(r[0].ok, false);
  assert.equal(r[0].status, 3);
  assert.equal(r[1].ok, false, 'timed out after timeout_sec');
});

test('events with no hooks do nothing; unknown events are refused', () => {
  assert.deepEqual(runHook('picks', {}), []);
  assert.deepEqual(hooksFor('run_done'), []);
  assert.ok(HOOK_EVENTS.includes('before_run'));
  assert.throws(() => runHook('nope', {}), /unknown hook event/);
});

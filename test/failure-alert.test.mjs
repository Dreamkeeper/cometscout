// Failure alert: the run unit names jobpilot-failure@.service in OnFailure=, the template runs cli.mjs notify, and
// notify sends one Telegram message (exit 0 with a log line when delivery is off). Telegram is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-alert-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));
const { unitFiles, notify } = await import('../lib/ops.mjs');

test('the run unit has OnFailure= and the failure template runs notify', () => {
  const u = unitFiles({ root: '/srv/jobpilot', node: '/usr/bin/node', time: '18:30', tz: 'Europe/Madrid', envPath: '/usr/bin:/bin' });
  assert.deepEqual(Object.keys(u), ['jobpilot.service', 'jobpilot.timer', 'jobpilot-failure@.service']);
  const unitSection = u['jobpilot.service'].split('[Service]')[0];
  assert.match(unitSection, /^OnFailure=jobpilot-failure@%n\.service$/m);
  assert.match(u['jobpilot.service'], /^ExecStart=\/usr\/bin\/node \/srv\/jobpilot\/cli\.mjs run$/m);
  assert.match(u['jobpilot.timer'], /^OnCalendar=\*-\*-\* 18:30:00 Europe\/Madrid$/m);
  const f = u['jobpilot-failure@.service'];
  assert.match(f, /^ExecStart=\/usr\/bin\/node \/srv\/jobpilot\/cli\.mjs notify "jobpilot: %i failed, see journalctl --user -u %i"$/m);
  assert.match(f, /^WorkingDirectory=\/srv\/jobpilot$/m);
  assert.match(f, /^Type=oneshot$/m);
  assert.ok(!f.includes('@ROOT@') && !f.includes('@NODE@'));
});

test('the template ships in deploy/, and install.sh installs the units through cli.mjs timer', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'deploy', 'jobpilot-failure@.service'), 'utf8');
  assert.match(tpl, /cli\.mjs notify "jobpilot: %i failed/);
  const sh = fs.readFileSync(path.join(ROOT, 'deploy', 'install.sh'), 'utf8');
  assert.match(sh, /node cli\.mjs timer/);
  assert.match(sh, /jobpilot-failure@/);
});

test('notify sends one message; delivery off is exit 0 with a log line; a failed send is exit 1', async () => {
  const sent = [];
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    assert.equal(await notify('jobpilot: jobpilot.service failed', { on: () => true, send: async t => { sent.push(t); return true; } }), 0);
    assert.deepEqual(sent, ['jobpilot: jobpilot.service failed']);
    assert.equal(await notify('jobpilot: x failed', { on: () => false, send: async () => { throw new Error('must not be called'); } }), 0);
    assert.ok(lines.some(l => /Telegram delivery is off, not sent: jobpilot: x failed/.test(l)));
    assert.equal(await notify('x', { on: () => true, send: async () => { throw new Error('Telegram sendMessage 401'); } }), 1);
    assert.ok(lines.some(l => /notify: Telegram failed: Telegram sendMessage 401/.test(l)));
    assert.equal(await notify('  ', { on: () => true, send: async () => true }), 1, 'no text');
  } finally { console.log = orig; }
});

test('cli.mjs notify exits 0 when Telegram is off', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'notify', 'jobpilot: jobpilot.service failed, see journalctl --user -u jobpilot.service'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Telegram delivery is off, not sent: jobpilot: jobpilot\.service failed/);
});

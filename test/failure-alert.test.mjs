// Failure alert: the run unit names cometscout-failure@.service in OnFailure=, the template runs cli.mjs notify, and
// notify sends one Telegram message (exit 0 with a log line when delivery is off). Telegram is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-alert-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));
const { unitFiles, notify } = await import('../lib/ops.mjs');

test('units run cli.mjs from the code folder and set COMETSCOUT_HOME when it differs', () => {
  const u = unitFiles({ root: '/home/me/jp-data', code: '/opt/cometscout', node: '/usr/bin/node', time: '18:30', envPath: '/usr/bin' });
  assert.match(u['cometscout.service'], /^ExecStart=\/usr\/bin\/node \/opt\/cometscout\/cli\.mjs run$/m);
  assert.match(u['cometscout.service'], /^Environment="COMETSCOUT_HOME=\/home\/me\/jp-data"$/m);
  assert.match(u['cometscout.service'], /^WorkingDirectory=\/home\/me\/jp-data$/m);
  assert.match(u['cometscout-failure@.service'], /^ExecStart=\/usr\/bin\/node \/opt\/cometscout\/cli\.mjs notify /m);
  assert.match(u['cometscout-failure@.service'], /^Environment="COMETSCOUT_HOME=\/home\/me\/jp-data"$/m);
  const same = unitFiles({ root: '/srv/cometscout', node: '/usr/bin/node', time: '18:30', envPath: '/usr/bin' });
  assert.ok(!same['cometscout.service'].includes('COMETSCOUT_HOME') && !same['cometscout-failure@.service'].includes('COMETSCOUT_HOME'));
});

test('the run unit has OnFailure= and the failure template runs notify', () => {
  const u = unitFiles({ root: '/srv/cometscout', node: '/usr/bin/node', time: '18:30', tz: 'Europe/Madrid', envPath: '/usr/bin:/bin' });
  assert.deepEqual(Object.keys(u), ['cometscout.service', 'cometscout.timer', 'cometscout-failure@.service']);
  const unitSection = u['cometscout.service'].split('[Service]')[0];
  assert.match(unitSection, /^OnFailure=cometscout-failure@%n\.service$/m);
  assert.match(u['cometscout.service'], /^ExecStart=\/usr\/bin\/node \/srv\/cometscout\/cli\.mjs run$/m);
  assert.match(u['cometscout.timer'], /^OnCalendar=\*-\*-\* 18:30:00 Europe\/Madrid$/m);
  const f = u['cometscout-failure@.service'];
  assert.match(f, /^ExecStart=\/usr\/bin\/node \/srv\/cometscout\/cli\.mjs notify "cometscout: %i failed, see journalctl --user -u %i"$/m);
  assert.match(f, /^WorkingDirectory=\/srv\/cometscout$/m);
  assert.match(f, /^Type=oneshot$/m);
  assert.ok(!f.includes('@ROOT@') && !f.includes('@NODE@'));
});

test('the unit paths use "/" even where path.join uses "\\" (Windows)', () => {
  // A child process where path.join behaves as on Windows; the units must still say /srv/cometscout/cli.mjs.
  const script = `import path from 'node:path'; path.join = path.win32.join;
    const { unitFiles } = await import(${JSON.stringify(new URL('../lib/ops.mjs', import.meta.url).href)});
    const u = unitFiles({ root: '/srv/cometscout', node: '/usr/bin/node', time: '18:30', envPath: '/usr/bin' });
    console.log(JSON.stringify(Object.values(u).join('\\n').split('\\n').filter(l => l.startsWith('ExecStart='))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, COMETSCOUT_DATA: path.join(tmp, 'winsim') } });
  assert.equal(r.status, 0, r.stderr);
  const exec = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(exec.length, 2);
  for (const l of exec) { assert.ok(!l.includes('\\'), l); assert.match(l, /\/srv\/cometscout\/cli\.mjs /); }
});

test('the template ships in deploy/, and install.sh installs the units through cli.mjs timer', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'deploy', 'cometscout-failure@.service'), 'utf8');
  assert.match(tpl, /cli\.mjs notify "cometscout: %i failed/);
  const sh = fs.readFileSync(path.join(ROOT, 'deploy', 'install.sh'), 'utf8');
  assert.match(sh, /node cli\.mjs timer/);
  assert.match(sh, /cometscout-failure@/);
});

test('notify sends one message; delivery off is exit 0 with a log line; a failed send is exit 1', async () => {
  const sent = [];
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    assert.equal(await notify('cometscout: cometscout.service failed', { on: () => true, send: async t => { sent.push(t); return true; } }), 0);
    assert.deepEqual(sent, ['cometscout: cometscout.service failed']);
    assert.equal(await notify('cometscout: x failed', { on: () => false, send: async () => { throw new Error('must not be called'); } }), 0);
    assert.ok(lines.some(l => /Telegram delivery is off, not sent: cometscout: x failed/.test(l)));
    assert.equal(await notify('x', { on: () => true, send: async () => { throw new Error('Telegram sendMessage 401'); } }), 1);
    assert.ok(lines.some(l => /notify: Telegram failed: Telegram sendMessage 401/.test(l)));
    assert.equal(await notify('  ', { on: () => true, send: async () => true }), 1, 'no text');
  } finally { console.log = orig; }
});

test('cli.mjs notify exits 0 when Telegram is off', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'notify', 'cometscout: cometscout.service failed, see journalctl --user -u cometscout.service'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Telegram delivery is off, not sent: cometscout: cometscout\.service failed/);
});

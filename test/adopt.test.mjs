// update --adopt on an installed layout (what deploy/install.sh runs every time): nothing changes, except that
// workspace modules missing from the current release are installed. The rehearsal path: a first install without npm,
// then "install npm and run install.sh again". Synthetic code folder, no npm, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adopt, currentVersion, releaseDir, localEdits } from '../lib/layout.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-adopt-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment longer */ } });
const home = path.join(tmp, 'home');
for (const [rel, text] of Object.entries({ 'cli.mjs': "console.log('cli');\n", 'package.json': '{ "name": "cometscout", "version": "0.5.0" }\n', 'lib/a.mjs': 'export const a = 1;\n' })) {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text);
}
const files = ['cli.mjs', 'lib/a.mjs', 'package.json'];
const units = () => ({ code: 0, lines: [] });
const npm = ok => { const calls = []; return { calls, install: dir => { calls.push(dir); if (ok) { fs.mkdirSync(path.join(dir, 'node_modules', 'preact'), { recursive: true }); } return ok; } }; };

test('a first adopt without npm says how to finish; adopt again with npm installs the modules and changes nothing else', () => {
  const none = npm(false);
  const a = adopt({ root: home, code: home, files, install: none.install, units });
  assert.equal(a.code, 0, a.lines.join('\n'));
  assert.equal(currentVersion(home), '0.5.0');
  assert.match(a.lines.join('\n'), /npm ci failed and the clone has no node_modules: .*install npm and run bash deploy\/install\.sh again/);
  const dest = releaseDir(home, '0.5.0');
  assert.equal(fs.existsSync(path.join(dest, 'node_modules')), false);

  const withNpm = npm(true);
  const b = adopt({ root: home, code: home, files, install: withNpm.install, units });
  assert.equal(b.code, 0);
  assert.deepEqual(b.lines, ['This install already runs from app/current (v0.5.0); nothing to adopt.', 'Installed the workspace modules (npm ci --omit=dev).']);
  assert.deepEqual(withNpm.calls, [dest]);
  assert.ok(fs.existsSync(path.join(dest, 'node_modules', 'preact')));
  assert.deepEqual(localEdits(dest), [], 'the release still matches its file list');

  const again = npm(true);
  const c = adopt({ root: home, code: home, files, install: again.install, units });
  assert.deepEqual(c.lines, ['This install already runs from app/current (v0.5.0); nothing to adopt.']);
  assert.deepEqual(again.calls, [], 'npm is not run when the modules are there');
});

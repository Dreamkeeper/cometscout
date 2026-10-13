// The supported runtimes are named the same everywhere: Node MIN_NODE or newer (package.json, package-lock.json,
// deploy/install.sh, the rehearsal, the CI matrix, doctor) and Python 3.11 or newer for the transcription module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_NODE } from '../lib/release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('Node: one minimum, and it is a supported LTS line (22 or newer)', () => {
  assert.ok(MIN_NODE >= 22, 'Node 20 is end of life since 2026-04-30');
  assert.equal(JSON.parse(read('package.json')).engines.node, `>=${MIN_NODE}`);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages[''].engines.node, `>=${MIN_NODE}`);
  assert.match(read('deploy/install.sh'), new RegExp(`\\)" -lt ${MIN_NODE} \\]; then`));
  assert.match(read('deploy/install.sh'), new RegExp(`Node ${MIN_NODE} or newer is needed`));
  assert.match(read('tools/rehearse/rehearse.sh'), new RegExp(`\\)" -ge ${MIN_NODE} \\] \\|\\| fail "Node ${MIN_NODE} or newer`));
  assert.match(read('lib/doctor.mjs'), />= MIN_NODE, `Node \$\{process\.versions\.node\}`/);
  // the CI matrix starts at the minimum and has no end-of-life line
  const matrix = read('.github/workflows/test.yml').match(/^\s*node: \[([^\]]+)\]/m);
  assert.ok(matrix, 'test.yml has a node matrix');
  const majors = matrix[1].split(',').map(x => Number(x.trim()));
  assert.equal(Math.min(...majors), MIN_NODE);
  assert.ok(majors.every(n => Number.isInteger(n) && n >= MIN_NODE), matrix[1]);
});

test('Python for the transcription module: 3.11 or newer everywhere it is named', async () => {
  const T = await import('../lib/transcribe-speakers.mjs');
  assert.deepEqual(T.SPEAKERS_PYTHON[0], [3, 11]);
  const text = read('lib/transcribe.mjs');
  assert.match(text, /export const MIN_PYTHON = \[3, 11\];/);
  assert.match(text, /export const GIGAAM_PYTHON = \[\[3, 11\], \[3, 14\]\];/);
  for (const f of ['README.md', 'INSTALL.md', 'README-rus.md', 'deploy/modules/transcribe.sh', 'deploy/modules/transcribe.ps1']) {
    assert.doesNotMatch(read(f), /Python 3\.10 to 3\.14|Python 3\.10-3\.14/, `${f} still names Python 3.10`);
  }
});

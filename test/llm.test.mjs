// lib/llm.mjs: a settings.llm.bin that is a Node script (.mjs/.js) runs through this Node, so it works on Windows,
// where a script file cannot be spawned directly (EFTYPE). The stand-in has no shebang and is not executable,
// so spawning it directly fails on Linux too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-llm-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
const fake = path.join(tmp, 'fake-claude.mjs');
fs.writeFileSync(fake, `let s = ''; process.stdin.on('data', d => s += d).on('end', () => process.stdout.write(JSON.stringify({ structured_output: { echo: s.trim(), args: process.argv.slice(2).length }, total_cost_usd: 0.01 })));\n`, { mode: 0o644 });
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ llm: { provider: 'claude', bin: fake } }));

const { callJson, binCommand } = await import('../lib/llm.mjs');

test('a .mjs model bin is run with this Node', async () => {
  const r = await callJson({ prompt: 'synthetic prompt', schema: { type: 'object' }, model: 'sonnet', timeoutSec: 30 });
  assert.equal(r.value.echo, 'synthetic prompt');
  assert.ok(r.value.args > 0, 'the CLI arguments reach the script');
  assert.equal(r.cost, 0.01);
});

test('binCommand: scripts go through process.execPath, anything else is spawned as is', () => {
  assert.deepEqual(binCommand('/x/fake.mjs', ['-p']), [process.execPath, ['/x/fake.mjs', '-p']]);
  assert.deepEqual(binCommand('C:\\tools\\fake.JS', []), [process.execPath, ['C:\\tools\\fake.JS']]);
  assert.deepEqual(binCommand('claude', ['--version']), ['claude', ['--version']]);
  assert.deepEqual(binCommand('codex.cmd', []), ['codex.cmd', []]);
});

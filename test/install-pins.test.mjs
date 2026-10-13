// The install instructions name exact versions: CometScout is cloned at a release tag (the version in package.json),
// the model CLIs at the versions below, and nothing is piped from curl into a shell without a version. The same
// versions everywhere: README.md, README-rus.md, INSTALL.md, deploy/install.sh and lib/coach.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_CODE_VERSION } from '../lib/coach.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const VERSION = JSON.parse(read('package.json')).version;
const FILES = ['README.md', 'README-rus.md', 'INSTALL.md', 'deploy/install.sh', 'lib/coach.mjs'];
const SEMVER = /^\d+\.\d+\.\d+$/;
// The one piped installer without an exact version: NodeSource's setup script, which names a Node major line and adds
// NodeSource's signed apt repository (apt then installs nodejs from it, like the distribution's own packages).
const NODESOURCE = /^curl -fsSL https:\/\/deb\.nodesource\.com\/setup_\d+\.x \| sudo -E bash -$/;

test('CometScout is cloned at the release tag of package.json, never at the branch head', () => {
  let clones = 0;
  for (const f of FILES) {
    for (const line of read(f).split('\n')) {
      if (!/git clone\s+.*github\.com\/Dreamkeeper\/cometscout/.test(line)) continue;
      clones++;
      assert.match(line, new RegExp(`git clone --branch v${VERSION.replace(/\./g, '\\.')} --depth 1 https://github\\.com/Dreamkeeper/cometscout\\.git`), `${f}: ${line.trim()}`);
    }
  }
  assert.ok(clones >= 3, 'README.md, README-rus.md and INSTALL.md each show the clone');
});

test('no curl | shell without an exact version; Claude Code at CLAUDE_CODE_VERSION', () => {
  let claude = 0;
  for (const f of FILES) {
    for (const raw of read(f).split('\n')) {
      const line = raw.trim().replace(/^echo "\s*(Claude Code:\s*)?/, '').replace(/"$/, '');
      if (!/curl\b.*\|\s*(sudo\s+(-E\s+)?)?(ba)?sh\b/.test(line)) continue;
      if (NODESOURCE.test(line)) continue;
      const m = line.match(/\|\s*bash -s ([^\s`]+)/);
      if (m && m[1] === '${CLAUDE_CODE_VERSION}') m[1] = CLAUDE_CODE_VERSION;   // lib/coach.mjs builds the line from the constant
      assert.ok(m && SEMVER.test(m[1]), `${f}: a piped installer needs an exact version: ${raw.trim()}`);
      if (line.includes('claude.ai/install.sh')) { claude++; assert.equal(m[1], CLAUDE_CODE_VERSION, `${f}: ${raw.trim()}`); }
    }
  }
  assert.ok(claude >= 3, 'INSTALL.md, README-rus.md and deploy/install.sh show the Claude Code installer');
  assert.match(CLAUDE_CODE_VERSION, SEMVER);
});

test('npm install -g always names an exact version, the same one in every file', () => {
  const seen = {};
  for (const f of FILES) {
    for (const m of read(f).matchAll(/npm (?:i|install) -g (\S+)/g)) {
      const at = m[1].lastIndexOf('@');
      const name = at > 0 ? m[1].slice(0, at) : m[1], version = at > 0 ? m[1].slice(at + 1) : '';
      assert.match(version, SEMVER, `${f}: npm install -g ${m[1]} needs an exact version`);
      (seen[name] ||= new Set()).add(version);
    }
  }
  for (const [name, versions] of Object.entries(seen)) assert.equal(versions.size, 1, `${name}: one version everywhere, found ${[...versions].join(', ')}`);
  assert.ok(seen['@openai/codex'], 'the Codex install is shown');
});

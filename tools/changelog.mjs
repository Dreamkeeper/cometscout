#!/usr/bin/env node
// CHANGELOG.md and GitHub release texts from release.json (lib/release.mjs), so the notes have one source.
//   node tools/changelog.mjs                          # check release.json, then write CHANGELOG.md
//   node tools/changelog.mjs --check                  # exit 1 when CHANGELOG.md is not what release.json gives
//   node tools/changelog.mjs --release 0.2.0 [--sha256 <hex>]   # the GitHub release text for one version, on stdout
import fs from 'node:fs';
import path from 'node:path';
import { CODE, readReleases, releaseProblems, changelogText, releaseBody, releaseFor, bare } from '../lib/release.mjs';

const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? '' : undefined; };
const OUT = path.join(CODE, 'CHANGELOG.md');
const list = readReleases(), version = JSON.parse(fs.readFileSync(path.join(CODE, 'package.json'), 'utf8')).version;
const problems = releaseProblems(list, { version });
if (problems.length) { console.error(`release.json:\n${problems.map(p => `  ${p}`).join('\n')}`); process.exit(1); }

if (opt('--release') !== undefined) {
  const e = releaseFor(opt('--release'), list);
  if (!e) { console.error(`release.json has no entry for "${opt('--release')}"`); process.exit(1); }
  const sha = opt('--sha256') ?? '';
  if (sha && !/^[0-9a-f]{64}$/i.test(sha)) { console.error('--sha256 needs the 64 hex characters of sha256sum'); process.exit(1); }
  process.stdout.write(releaseBody(e, sha.toLowerCase()));
  process.exit(0);
}
const text = changelogText(list);
if (args.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (cur !== text) { console.error('CHANGELOG.md is out of date: run node tools/changelog.mjs'); process.exit(1); }
  console.log(`CHANGELOG.md matches release.json (${list.length} version(s), newest ${bare(list[0].version)})`);
  process.exit(0);
}
fs.writeFileSync(OUT, text);
console.log(`Wrote CHANGELOG.md (${list.length} version(s), newest ${list[0].version})`);

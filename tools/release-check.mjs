#!/usr/bin/env node
// The check a release tag must pass (.github/workflows/release-check.yml, on every pushed v* tag):
//   node tools/release-check.mjs <tag, e.g. v0.2.2>
// package.json's version is the tag's, release.json's newest entry is the tag's version, and that entry's date is not
// in the future (no later than today anywhere on earth, UTC+14, so a tag made just after local midnight passes).
// Exit 0 when all hold, 1 with one line per problem otherwise. It reads the checkout it runs in and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The latest calendar date anywhere on earth at `now` (UTC+14), YYYY-MM-DD. */
export const latestDate = (now = new Date()) => new Date(now.getTime() + 14 * 3600000).toISOString().slice(0, 10);

/** What is wrong for `tag` ([] when nothing): pkg is package.json, releases is release.json, both parsed. */
export function releaseCheck(tag, { pkg, releases, now = new Date() }) {
  const out = [], t = String(tag || '');
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t)) return [`"${t}" is not a release tag like v1.2.3`];
  const v = t.slice(1), top = Array.isArray(releases) ? releases[0] : null;
  if (pkg?.version !== v) out.push(`package.json says ${pkg?.version ?? '(no version)'}, the tag is ${t}`);
  if (!top) out.push('release.json has no entry');
  else {
    if (top.version !== v) out.push(`release.json's newest entry is ${top.version ?? '(no version)'}, the tag is ${t}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(top.date || ''))) out.push(`release.json's newest entry has no date (YYYY-MM-DD): ${JSON.stringify(top.date)}`);
    else if (top.date > latestDate(now)) out.push(`release.json's newest entry is dated ${top.date}, in the future: set the day you tag`);
  }
  return out;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(self)) {
  const read = f => JSON.parse(fs.readFileSync(path.join(CODE, f), 'utf8'));
  const problems = releaseCheck(process.argv[2], { pkg: read('package.json'), releases: read('release.json') });
  for (const p of problems) console.log(`release-check: ${p}`);
  if (!problems.length) console.log(`release-check: ${process.argv[2]} matches package.json and release.json`);
  process.exitCode = problems.length ? 1 : 0;
}

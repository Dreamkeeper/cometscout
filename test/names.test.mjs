// The old product name (jobpilot) may appear only where a fallback needs it: lib/legacy-names.mjs, the few places
// that cannot import it (listed in ALLOWED), the tests, the task briefs written before the rename, and one history
// line per doc. Any other "jobpilot" in a tracked or new file fails this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = /jobpilot/i;
const WHOLE = [/^lib\/legacy-names\.mjs$/, /^test\//, /^docs\/tasks\/(0[1-9]|1[0-6])-[^/]+\.md$/, /\.(png|jpe?g|gif|pdf|docx|zip|gz|ico|woff2?)$/i];
// lines that may name the old name, per file: what cannot import lib/legacy-names.mjs
const ALLOWED = {
  'package.json': [/^\s*"jobpilot": "cli\.mjs",?$/],
  'package-lock.json': [/^\s*"jobpilot": "cli\.mjs",?$/],
  'deploy/install.sh': [/CometScout was called jobpilot/, /^OLD_HOME="\$HOME\/jobpilot"$/, /^node cli\.mjs timer "\$\{COMETSCOUT_TIME:-\$\{JOBPILOT_TIME:-\}\}" \|\| true$/],
  'web/lib/logic.js': [/^const OLD_FILTERS_KEY = 'jobpilot\.workspace\.filters';$/],
};
// one line per doc may say what the product was called
const HISTORY = /was called jobpilot|назывался jobpilot|still say jobpilot/;

/** [{ file, line, text }] for every line naming the old name where it is not allowed. files: { rel: text }. */
export function violations(files) {
  const out = [];
  for (const [rel, text] of Object.entries(files)) {
    if (WHOLE.some(re => re.test(rel))) continue;
    let history = 0;
    text.split(/\r?\n/).forEach((l, i) => {
      if (!OLD.test(l)) return;
      if ((ALLOWED[rel] || []).some(re => re.test(l))) return;
      if (rel.endsWith('.md') && HISTORY.test(l) && ++history === 1) return;
      out.push({ file: rel, line: i + 1, text: l.trim().slice(0, 120) });
    });
  }
  return out;
}

function repoFiles() {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.split('\n').filter(Boolean).filter(f => fs.existsSync(path.join(ROOT, f)));
  // no git (a downloaded copy): walk the folder, leaving out what is never part of the code
  const skip = new Set(['node_modules', '.git', 'data', 'backups', 'profile']);
  const walk = (d, out = []) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const rel = d ? `${d}/${e.name}` : e.name; if (e.isDirectory()) { if (!skip.has(e.name)) walk(rel, out); } else if (!/^(\.env|settings\.json)/.test(e.name)) out.push(rel); } return out; };
  return walk('');
}

test('no "jobpilot" outside lib/legacy-names.mjs, the allowed lines, tests, old briefs and one history line per doc', () => {
  const files = {};
  for (const f of repoFiles()) if (!WHOLE.some(re => re.test(f))) files[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const v = violations(files);
  assert.deepEqual(v, [], `the old name is back:\n${v.map(x => `  ${x.file}:${x.line}: ${x.text}`).join('\n')}\nUse the new name, or put the fallback in lib/legacy-names.mjs.`);
});

test('the check itself: code, a header, an env var and a second history line are caught; allowed lines are not', () => {
  const v = violations({
    'lib/x.mjs': "const a = process.env.JOBPILOT_HOME;\nconst ok = 1;\nheaders['X-Jobpilot']",
    'lib/legacy-names.mjs': "export const OLD = 'jobpilot';",
    'test/a.test.mjs': 'jobpilot',
    'docs/tasks/03-hirify-source.md': 'jobpilot',
    'docs/tasks/17-later.md': 'jobpilot reads',
    'README.md': '> CometScout was called jobpilot until October 2026.\nCometScout was called jobpilot, again.',
    'package.json': '    "jobpilot": "cli.mjs"\n  "name": "jobpilot",',
  });
  assert.deepEqual(v.map(x => `${x.file}:${x.line}`), ['lib/x.mjs:1', 'lib/x.mjs:3', 'docs/tasks/17-later.md:1', 'README.md:2', 'package.json:2']);
});

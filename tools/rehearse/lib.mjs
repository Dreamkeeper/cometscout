#!/usr/bin/env node
// Helpers for tools/rehearse/rehearse.sh, the install rehearsal on a fresh Debian or Ubuntu machine. Pure functions
// (tested by test/rehearse.test.mjs on every platform) plus a small command line the script calls:
//   node tools/rehearse/lib.mjs next-version <version>                        # 0.1.0 -> 0.1.1 (the fake next release)
//   node tools/rehearse/lib.mjs build-zip <code dir> <version> <out.zip>      # a GitHub-style source zip; prints its sha256
//   node tools/rehearse/lib.mjs settings <settings.json> <drop dir> <HH:MM>   # the rehearsal's settings, written in place
//   node tools/rehearse/lib.mjs fake-model <cv-library.json> <out.json>       # the canned model answer (decode and pack)
//   node tools/rehearse/lib.mjs jobs <drop dir>                               # synthetic job files for the drop-dir source
//   node tools/rehearse/lib.mjs doctor-check <doctor output file> <stage>     # TODO lines that are not expected at this stage
//   node tools/rehearse/lib.mjs export-check <export.zip> <home> [<home>...]   # every exported file has the same hash in each home
//   node tools/rehearse/lib.mjs old-units                                     # the unit names from before the rename (timer, service)
//   node tools/rehearse/lib.mjs old-env-prefix                                # the variable prefix from before the rename
//   node tools/rehearse/lib.mjs report <results.tsv>                          # the PASS/FAIL table; exit 1 on any FAIL
// It never imports lib/config.mjs (which would create data folders next to this checkout).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ZipWriter, readZip, readEntry } from '../../lib/zip.mjs';
import { parseVersion, bare } from '../../lib/release.mjs';
import { codeFiles, FILE_LIST } from '../../lib/layout.mjs';
import { OLD_UNITS, OLD } from '../../lib/legacy-names.mjs';

/** The fake next release: the patch number plus one, without a pre-release suffix ("v0.1.0" -> "0.1.1"). */
export function nextVersion(v) {
  const p = parseVersion(v); if (!p) throw new Error(`not a version: ${v}`);
  return `${p.major}.${p.minor}.${p.patch + 1}`;
}

/** The code files of a release folder: its .release-files.json list when it has one, else the folder walked. */
export function releaseFiles(codeDir) {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(codeDir, FILE_LIST), 'utf8')).files).sort(); } catch { return codeFiles(codeDir); }
}

/**
 * A source zip as GitHub builds it (everything under "cometscout-<version>/") from the code in `codeDir`, with
 * package.json at `version` and a release.json entry for it on top. Returns { file, sha256, files }.
 */
export async function buildSourceZip({ codeDir, version, out, files = releaseFiles(codeDir), date = new Date().toISOString().slice(0, 10) }) {
  const v = bare(version); if (!v) throw new Error(`not a version: ${version}`);
  if (!files.includes('cli.mjs') || !files.includes('package.json')) throw new Error(`${codeDir} does not look like CometScout code`);
  const pkg = JSON.parse(fs.readFileSync(path.join(codeDir, 'package.json'), 'utf8'));
  const releases = files.includes('release.json') ? JSON.parse(fs.readFileSync(path.join(codeDir, 'release.json'), 'utf8')) : [];
  const entry = { version: v, date, min_node: 20, schema_version: releases[0]?.schema_version ?? 1, migrations: [], behaviour_changes: false,
    notes: { highlights: [`Rehearsal build ${v}, made from v${pkg.version} by tools/rehearse.`], new: ['Nothing: the code of the previous version with a new number.'] } };
  const changed = { 'package.json': JSON.stringify({ ...pkg, version: v }, null, 2) + '\n', 'release.json': JSON.stringify([entry, ...releases.filter(r => r?.version !== v)], null, 2) + '\n' };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const top = `cometscout-${v}`, z = await ZipWriter.open(out), all = [...new Set([...files, 'release.json'])].sort();
  try {
    for (const rel of all) {
      if (rel in changed) z.addBuffer(`${top}/${rel}`, changed[rel]);
      else await z.addFile(`${top}/${rel}`, path.join(codeDir, ...rel.split('/')));
    }
    await z.close();
  } catch (e) { z.abort(); throw e; }
  return { file: path.resolve(out), sha256: crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'), files: all };
}

/**
 * The rehearsal's settings, from the installed settings.json: every source off except drop-dir (the folder `dropDir`,
 * no settle time), Telegram off, no update check (no network), the digest every day at `time` UTC, packs on.
 */
export function rehearsalSettings(base, { dropDir, time }) {
  const s = structuredClone(base || {});
  delete s._comment;
  s.timezone = 'UTC';
  s.schedule = { days: [1, 2, 3, 4, 5, 6, 7], time };
  s.sources = Object.fromEntries(Object.entries(s.sources || {}).map(([k, v]) => [k, { ...(v && typeof v === 'object' ? v : {}), enabled: false }]));
  s.sources.drop_dir = { ...(s.sources.drop_dir || {}), enabled: true, dir: dropDir, settle_sec: 0, move_processed_to: path.posix.join(dropDir, 'processed'), max_fetches_per_run: 5 };
  s.delivery = { ...(s.delivery || {}), telegram: { ...(s.delivery?.telegram || {}), enabled: false } };
  s.update = { ...(s.update || {}), check: false };
  s.health = { ping_url: '' };
  s.pack = { ...(s.pack || {}), enabled: true };
  s.backup = { ...(s.backup || {}), nightly: true, copy_to: '' };
  s.picks = { ...(s.picks || {}), per_day: 2, exclude_location_regex: '', exclude_onsite_location_regex: '' };
  return s;
}

/**
 * The canned model answer for the whole run (COMETSCOUT_LLM_FAKE=<this file>): one object that is both a decode verdict
 * (a strong fit, priority 1, so the jobs become picks) and a pack (CV items picked from the library by id).
 */
export function fakeModelAnswer(lib) {
  const ids = list => (Array.isArray(list) ? list : []).map(x => x?.id).filter(Boolean);
  return {
    verdict: 'strong-fit', confidence: 'high', apply_priority: 1,
    rationale: 'Rehearsal: canned answer, no model was called.', fit_signals: ['rehearsal'], gaps: [], action: 'Rehearsal: nothing to do.',
    positioning: 'Rehearsal: canned pack, no model was called.',
    cv: {
      tagline: lib?.taglines?.[0]?.text || 'Product Manager', summary: lib?.summaries?.[0]?.text || 'Product manager.',
      order: ['experience', 'skills', 'awards', 'education'], ai_work_ids: [],
      experience: (lib?.experience || []).map(e => ({ key: e.key, bullet_ids: (e.roles || []).flatMap(r => ids(r.bullets)).slice(0, 3) })),
      skill_ids: ids(lib?.skills), award_ids: ids(lib?.awards),
    },
    answers: [], flags: [],
  };
}

const JOB_TEXT = 'This is a synthetic job posting written for the CometScout install rehearsal. The team builds software for small logistics companies and works remotely across Europe. You will own the roadmap of one product area, talk to customers every week, write clear specifications with engineers and measure adoption after each release. We look for several years of product management in B2B software and plain written English.';
/** Three synthetic job files in CometScout's own format (front matter + text), for the drop-dir source. [{ name, text }] */
export function syntheticJobs() {
  return [['Northwind Rehearsal', 'Senior Product Manager'], ['Contoso Rehearsal', 'Product Manager, Integrations'], ['Fabrikam Rehearsal', 'Product Owner']].map(([company, role], i) => {
    const s = `${company} ${role}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return { name: `rehearsal-${i + 1}-${s}.md`, text: ['---', `company: "${company}"`, `role: "${role}"`, `url: "https://jobs.example.invalid/${s}"`, 'source: "rehearsal"', 'location: "Remote (worldwide)"', '---', '',
      `# ${company} - ${role}`, '', JOB_TEXT, '', JOB_TEXT, ''].join('\n') };
  });
}

// doctor TODO lines an install without a real model CLI may print: at "install" also the example profile (no
// profile/ yet). The rehearsal never installs Claude Code or Codex, so their line is expected at every stage.
export const EXPECTED_TODOS = {
  install: [/^TODO (claude|codex) CLI not found/, /^TODO profile: profile\.example/],
  profile: [/^TODO (claude|codex) CLI not found/],
};
/** The TODO lines in doctor's output that are not expected at `stage`. */
export function unexpectedTodos(output, stage) {
  const ok = EXPECTED_TODOS[stage]; if (!ok) throw new Error(`unknown stage ${stage}`);
  return String(output || '').split(/\r?\n/).filter(l => /^TODO /.test(l)).filter(l => !ok.some(re => re.test(l)));
}

/** Compare an export with homes: [{ home, rel, why }] for every exported file that is missing or different in a home. */
export async function exportMismatches(zipFile, homes) {
  const zip = readZip(zipFile), m = zip.entries.find(e => e.name === 'manifest.json');
  if (!m) return [{ home: zipFile, rel: 'manifest.json', why: 'missing' }];
  const files = JSON.parse((await readEntry(zip, m)).toString('utf8')).files || {};
  if (!Object.keys(files).length) return [{ home: zipFile, rel: '(all)', why: 'the export holds no files' }];
  const out = [];
  for (const home of homes) for (const [rel, h] of Object.entries(files)) {
    const p = path.join(home, ...rel.split('/'));
    if (!fs.existsSync(p)) out.push({ home, rel, why: 'missing' });
    else if (crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') !== h) out.push({ home, rel, why: 'different' });
  }
  return out;
}

/** The old timer and run unit, from lib/legacy-names.mjs. */
export const oldUnits = () => ({ timer: OLD_UNITS.find(u => u.endsWith('.timer')), service: OLD_UNITS.find(u => /^[^-@]+\.service$/.test(u)) });

/** Parse results.tsv lines: "<step>\t<PASS|FAIL|SKIP>\t<seconds>\t<detail>". */
export const parseResults = text => String(text || '').split(/\r?\n/).filter(Boolean).map(l => { const [step, status, seconds, ...d] = l.split('\t'); return { step, status, seconds: Number(seconds) || 0, detail: d.join(' ') }; });
/** The report: a table, then the summary line. Returns { text, code } (code 1 on any FAIL, or on no steps at all). */
export function report(results) {
  const w = Math.max(4, ...results.map(r => r.step.length));
  const lines = results.map(r => `${r.status.padEnd(4)}  ${r.step.padEnd(w)}  ${`${r.seconds.toFixed(1)}s`.padStart(7)}${r.detail ? `  ${r.detail}` : ''}`);
  const n = s => results.filter(r => r.status === s).length, total = results.reduce((t, r) => t + r.seconds, 0);
  const failed = n('FAIL') > 0 || !results.length;
  lines.push('', `${failed ? 'FAIL' : 'PASS'}: ${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped, ${total.toFixed(1)}s in all`);
  return { text: lines.join('\n'), code: failed ? 1 : 0 };
}

// ---------- command line ----------
async function main([cmd, ...a]) {
  const need = n => { if (a.length < n) throw new Error(`usage: see the head of ${path.basename(fileURLToPath(import.meta.url))}`); };
  switch (cmd) {
    case 'next-version': need(1); console.log(nextVersion(a[0])); return 0;
    case 'build-zip': { need(3); const r = await buildSourceZip({ codeDir: a[0], version: a[1], out: a[2] }); console.log(r.sha256); return 0; }
    case 'settings': { need(3); const s = rehearsalSettings(JSON.parse(fs.readFileSync(a[0], 'utf8')), { dropDir: a[1], time: a[2] }); fs.writeFileSync(a[0], JSON.stringify(s, null, 2) + '\n'); return 0; }
    case 'fake-model': need(2); fs.writeFileSync(a[1], JSON.stringify(fakeModelAnswer(JSON.parse(fs.readFileSync(a[0], 'utf8'))), null, 1) + '\n'); return 0;
    case 'jobs': { need(1); fs.mkdirSync(a[0], { recursive: true }); for (const j of syntheticJobs()) fs.writeFileSync(path.join(a[0], j.name), j.text); console.log(syntheticJobs().length); return 0; }
    case 'doctor-check': { need(2); const u = unexpectedTodos(fs.readFileSync(a[0], 'utf8'), a[1]); for (const l of u) console.log(l); return u.length ? 1 : 0; }
    case 'export-check': { need(2); const m = await exportMismatches(a[0], a.slice(1)); for (const x of m) console.log(`${x.home}: ${x.rel} ${x.why}`); return m.length ? 1 : 0; }
    case 'old-env-prefix': console.log(`${OLD.toUpperCase()}_`); return 0;
    case 'old-units': { const o = oldUnits(); console.log(`${o.timer} ${o.service}`); return 0; }
    case 'report': { need(1); const r = report(parseResults(fs.existsSync(a[0]) ? fs.readFileSync(a[0], 'utf8') : '')); console.log(r.text); return r.code; }
    default: console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n')); return 1;
  }
}
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(self)) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (e) { console.error(`rehearse: ${e.message}`); process.exitCode = 2; }
}

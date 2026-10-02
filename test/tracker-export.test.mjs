// Tracker export: which entries are applications, stage and furthest stage, dates, notes, source and link from the
// queue file, overrides, validation, and the file is rewritten only when its content changes. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-tracker-'));
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));
const DATA = process.env.JOBPILOT_DATA;
const APPS = path.join(DATA, 'state', 'applications.json');
const OVERRIDES = path.join(DATA, 'state', 'tracker-overrides.json');
const OUT = path.join(tmp, 'out', 'pipeline.json');

const tr = await import('../lib/tracker.mjs');

fs.mkdirSync(path.join(DATA, 'decoded'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'decoded', '2026-09-18--lumenfield--product-owner.md'),
  '---\ncompany: "Lumenfield"\nrole: "Product Owner"\nurl: "https://jobs.example/lumenfield/1"\nsource: "linkedin"\nfound: 2026-09-18\n---\n\n# Lumenfield - Product Owner\n\ntext\n');
fs.writeFileSync(path.join(DATA, 'decoded', '2026-09-19--quarry-systems--product-manager.md'),
  '---\ncompany: "Quarry Systems"\nrole: "Product Manager"\nurl: "https://jobs.example/quarry/7"\nsource: "rtj"\nfound: 2026-09-19\n---\n\n# Quarry Systems - Product Manager\n\ntext\n');

const ev = (date, type, source = 'cli') => ({ date, type, source });
const APPS_DATA = {
  '2026-09-18--lumenfield--product-owner.md': { company: 'Lumenfield', role: 'Product Owner', status: 'applied', updated: '2026-09-20',
    events: [ev('2026-09-20', 'applied'), ev('2026-09-24', 'application_received', 'gmail')] },
  '2026-09-19--quarry-systems--product-manager.md': { company: 'Quarry Systems', role: 'Product Manager', status: 'rejected', updated: '2026-10-01',
    events: [ev('2026-09-21', 'applied'), ev('2026-09-25', 'interview', 'gmail'), ev('2026-10-01', 'rejection', 'gmail'), ev('2026-10-01', 'rejected')] },
  'manual:ridgeway labs|platform pm': { company: 'Ridgeway Labs', role: 'Platform PM', status: 'interview', updated: '2026-09-28',
    events: [ev('2026-09-15', 'applied'), ev('2026-09-27', 'test_task', 'gmail'), ev('2026-09-28', 'interview')] },
  'manual:northwind devices|growth pm': { company: 'Northwind Devices', role: 'Growth PM', status: 'skipped', updated: '2026-09-10', events: [ev('2026-09-10', 'skipped')] },
  'manual:harbor apps|product lead': { company: 'Harbor Apps', role: 'Product Lead', status: 'skipped', updated: '2026-09-12',
    events: [ev('2026-09-05', 'applied'), ev('2026-09-12', 'skipped')] },
  'manual:copperline|product owner': { company: 'Copperline', role: 'Product Owner', status: 'closed', applied: '2026-09-01', updated: '2026-09-22' },
  'manual:bluefjord|data pm': { company: 'Bluefjord', role: 'Data PM', status: 'offer', updated: '2026-09-30', events: [ev('2026-09-30', 'offer', 'gmail')] },
  'manual:tidewell|product manager': { company: 'Tidewell', role: 'Product Manager', status: 'screen', updated: '2026-09-29' },
};
const seed = (apps = APPS_DATA, overrides = null) => {
  fs.writeFileSync(APPS, JSON.stringify(apps, null, 1));
  fs.rmSync(OVERRIDES, { force: true });
  if (overrides) fs.writeFileSync(OVERRIDES, JSON.stringify({ overrides }));
  fs.rmSync(path.join(tmp, 'out'), { recursive: true, force: true });
};
const byCompany = rows => Object.fromEntries(rows.map(r => [r.company, r]));

test('only applications are exported, with stage, furthest stage, dates, notes, source and link', () => {
  seed();
  const r = tr.trackerExport({ out: OUT, now: new Date('2026-10-02T09:00:00Z') });
  const rows = byCompany(r.applications);
  assert.deepEqual(Object.keys(rows).sort(), ['Bluefjord', 'Copperline', 'Harbor Apps', 'Lumenfield', 'Quarry Systems', 'Ridgeway Labs', 'Tidewell']);
  assert.ok(!rows['Northwind Devices'], 'a skipped role never applied to is left out');
  assert.deepEqual(rows.Lumenfield, { company: 'Lumenfield', role: 'Product Owner', stage: 'Applied', furthestStage: 'Applied', dateApplied: '2026-09-20',
    lastActivity: '2026-09-24', notes: 'Last update 2026-09-24', source: 'linkedin', link: 'https://jobs.example/lumenfield/1' });
  assert.equal(rows['Quarry Systems'].stage, 'Rejected');
  assert.equal(rows['Quarry Systems'].furthestStage, 'Interview', 'a rejection after an interview keeps Interview');
  assert.equal(rows['Quarry Systems'].notes, 'Rejected 2026-10-01');
  assert.equal(rows['Quarry Systems'].source, 'rtj');
  assert.equal(rows['Ridgeway Labs'].furthestStage, 'Interview');
  assert.equal(rows['Ridgeway Labs'].dateApplied, '2026-09-15');
  assert.equal(rows['Ridgeway Labs'].source, '', 'a manual record has no queue file');
  assert.equal(rows['Ridgeway Labs'].link, '');
  assert.equal(rows['Harbor Apps'].stage, 'Withdrawn', 'skipped after an applied event is still an application');
  assert.equal(rows.Copperline.stage, 'Withdrawn');
  assert.equal(rows.Copperline.notes, 'Closed 2026-09-22');
  assert.equal(rows.Copperline.dateApplied, '2026-09-01', 'the applied field when there is no applied event');
  assert.equal(rows.Bluefjord.stage, 'Offer');
  assert.equal(rows.Bluefjord.furthestStage, 'Offer');
  assert.equal(rows.Bluefjord.dateApplied, '2026-09-30', 'updated when nothing else says when');
  assert.equal(rows.Tidewell.stage, 'Screen');
  assert.equal(rows.Tidewell.furthestStage, 'Screen');

  const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  assert.equal(doc.app, 'job-pipeline-tracker');
  assert.equal(doc.version, 1);
  assert.equal(doc.exportedAt, '2026-10-02T09:00:00.000Z');
  assert.match(doc.contentHash, /^[0-9a-f]{16}$/);
  assert.equal(doc.contentHash, tr.contentHash(doc.applications));
  assert.deepEqual(doc.applications.map(a => a.dateApplied), [...doc.applications.map(a => a.dateApplied)].sort(), 'sorted by date applied');
  assert.match(r.message, /^wrote .*pipeline\.json \(7 applications: Applied 1, Screen 1, Interview 1, Offer 1, Rejected 1, Withdrawn 2\)$/);
});

test('the file is rewritten only when the content changes', () => {
  seed();
  tr.trackerExport({ out: OUT, now: new Date('2026-10-02T09:00:00Z') });
  const again = tr.trackerExport({ out: OUT, now: new Date('2026-10-03T09:00:00Z') });
  assert.equal(again.written, false);
  assert.match(again.message, /^unchanged \(7 applications: Applied 1, /);
  assert.equal(JSON.parse(fs.readFileSync(OUT, 'utf8')).exportedAt, '2026-10-02T09:00:00.000Z', 'exportedAt stays, so the app does not re-import');
  const apps = structuredClone(APPS_DATA);
  apps['2026-09-18--lumenfield--product-owner.md'].status = 'interview';
  fs.writeFileSync(APPS, JSON.stringify(apps));
  const changed = tr.trackerExport({ out: OUT, now: new Date('2026-10-04T09:00:00Z') });
  assert.equal(changed.written, true);
  assert.equal(JSON.parse(fs.readFileSync(OUT, 'utf8')).exportedAt, '2026-10-04T09:00:00.000Z');
  assert.deepEqual(fs.readdirSync(path.dirname(OUT)), ['pipeline.json'], 'no temp file is left behind');
});

test('a dry run writes nothing', () => {
  seed();
  const r = tr.trackerExport({ out: OUT, dryRun: true });
  assert.equal(r.written, false);
  assert.match(r.message, /^would write .* dry run, nothing written\)$/);
  assert.ok(!fs.existsSync(OUT));
});

test('overrides drop or change rows; one that matches nothing is reported', () => {
  seed(APPS_DATA, [
    { company: 'lumenfield', role: 'owner', drop: true },
    { company: 'Ridgeway Labs', stage: 'Offer', notes: 'Verbal offer' },
    { company: 'Copperline', role: 'designer', drop: true },
    { company: 'Nobody Inc', stage: 'Interview' },
  ]);
  const r = tr.trackerExport({ out: OUT });
  const rows = byCompany(r.applications);
  assert.ok(!rows.Lumenfield, 'dropped (company in any case, role as a substring)');
  assert.equal(rows['Ridgeway Labs'].stage, 'Offer');
  assert.equal(rows['Ridgeway Labs'].furthestStage, 'Offer', 'a further stage set by hand moves furthestStage');
  assert.equal(rows['Ridgeway Labs'].notes, 'Verbal offer');
  assert.ok(rows.Copperline, 'the role substring did not match, so the row stays');
  assert.deepEqual(r.unused.map(o => o.company), ['Copperline', 'Nobody Inc']);
});

test('an invalid row stops the export and shows the row', () => {
  seed({ ...APPS_DATA, 'manual:oddco|pm': { company: 'OddCo', role: 'PM', status: 'ghosted', updated: '2026-09-30' } });
  assert.throws(() => tr.trackerExport({ out: OUT }), e => /invalid row \(stage "\(unknown status "ghosted"\)" is not one of Applied/.test(e.message) && e.message.includes('"company":"OddCo"'));
  assert.ok(!fs.existsSync(OUT));
  seed(APPS_DATA, [{ company: 'Tidewell', dateApplied: 'last week' }]);
  assert.throws(() => tr.trackerExport({ out: OUT }), /dateApplied "last week" is not YYYY-MM-DD/);
  seed(APPS_DATA, [{ company: 'Tidewell', furthestStage: 'Rejected' }]);
  assert.throws(() => tr.trackerExport({ out: OUT }), /furthestStage "Rejected" is not one of/);
});

test('a broken overrides file is named', () => {
  seed();
  fs.writeFileSync(OVERRIDES, '{ "overrides": [ { "company": "x", } ] }');
  assert.throws(() => tr.readOverrides(OVERRIDES), /tracker-overrides\.json is not valid JSON/);
  fs.writeFileSync(OVERRIDES, '{ "overrides": [ { "stage": "Offer" } ] }');
  assert.throws(() => tr.readOverrides(OVERRIDES), /every override needs "company"/);
});

test('cli.mjs tracker-export writes, then says unchanged; a bad row exits 1', () => {
  seed(APPS_DATA, [{ company: 'Nobody Inc', drop: true }]);
  const env = { ...process.env, JOBPILOT_HOME: ROOT };
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'tracker-export', '--out', OUT, ...a], { encoding: 'utf8', env });
  const first = cli();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /override matched nothing: \{"company":"Nobody Inc","drop":true\}/);
  assert.match(first.stdout, /wrote .*pipeline\.json/);
  const second = cli();
  assert.match(second.stdout, /unchanged \(7 applications: Applied 1, Screen 1, Interview 1, Offer 1, Rejected 1, Withdrawn 2\)/);
  seed({ 'manual:oddco|pm': { company: 'OddCo', role: 'PM', status: 'ghosted', updated: '2026-09-30' } });
  const bad = cli();
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /tracker-export stopped: invalid row/);
});

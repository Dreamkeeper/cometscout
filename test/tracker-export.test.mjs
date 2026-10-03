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
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_RUN_DATE = '2026-10-02';
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));
const DATA = process.env.JOBPILOT_DATA;
const APPS = path.join(DATA, 'state', 'applications.json');
const OVERRIDES = path.join(DATA, 'state', 'tracker-overrides.json');
const OUT = path.join(tmp, 'out', 'pipeline.json');

const tr = await import('../lib/tracker.mjs');
const { SETTINGS } = await import('../lib/config.mjs');

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

test('accepted (a job the user holds) is Offer / Offer with an "Accepted" note: the tracker has no hired stage', () => {
  const a = { company: 'Saltmarsh', role: 'Senior PM', status: 'accepted', updated: '2026-09-28',
    events: [ev('2026-09-02', 'applied'), ev('2026-09-20', 'offer', 'gmail'), ev('2026-09-28', 'accepted'), ev('2026-10-01', 'offer', 'gmail')] };
  const r = tr.toRow('manual:saltmarsh|senior pm', a, {}, '2026-10-02');
  assert.equal(r.stage, 'Offer');
  assert.equal(r.furthestStage, 'Offer');
  assert.equal(r.notes, 'Accepted 2026-09-28');
  assert.deepEqual(tr.rowProblems(r), []);
  // recorded by hand with no offer event: still reached Offer
  const b = tr.toRow('k', { company: 'Orchard', role: 'PM', status: 'accepted', updated: '2026-09-15', events: [ev('2026-09-01', 'applied'), ev('2026-09-15', 'accepted')] }, {}, '2026-10-02');
  assert.deepEqual([b.stage, b.furthestStage, b.notes], ['Offer', 'Offer', 'Accepted 2026-09-15']);
});

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
  const env = process.env;
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

test('a role closed or withdrawn before applying is not exported; an entry with no date is skipped and reported, not fatal', () => {
  seed({
    ...APPS_DATA,
    'manual:closedco one|pm': { company: 'Closedco One', role: 'PM', status: 'closed' },
    'manual:closedco two|pm': { company: 'Closedco Two', role: 'PM', status: 'closed' },
    'manual:closedco three|pm': { company: 'Closedco Three', role: 'PM', status: 'closed', events: [{ type: 'closed' }] },
    'manual:pulledback|pm': { company: 'Pulledback', role: 'PM', status: 'withdrawn', updated: '2026-09-25', events: [ev('2026-09-25', 'withdrawn')] },
    'manual:nodate|pm': { company: 'Nodate', role: 'Product Manager', status: 'applied' },
  });
  const r = tr.trackerExport({ out: OUT });
  const names = r.applications.map(a => a.company);
  for (const c of ['Closedco One', 'Closedco Two', 'Closedco Three', 'Pulledback', 'Nodate']) assert.ok(!names.includes(c), c);
  assert.equal(r.applications.length, 7, 'the rest of the file is still written');
  assert.ok(fs.existsSync(OUT));
  assert.deepEqual(r.undated.map(x => x.company), ['Nodate']);
  assert.deepEqual(tr.exportNotes(r), ['skipped, no date up to today: Nodate: Product Manager']);
  assert.equal(tr.isApplication({ status: 'closed', applied: '2026-09-01' }), true, 'an applied date is proof enough');
  assert.equal(tr.isApplication({ status: 'withdrawn', events: [ev('2026-09-01', 'applied')] }), true);
});

test('dateApplied falls back to the earliest dated event before updated; lastActivity never runs past today', () => {
  seed({
    'manual:earlyco|pm': { company: 'Earlyco', role: 'PM', status: 'interview', updated: '2026-09-20', events: [ev('2026-09-10', 'interview', 'gmail'), ev('2026-09-05', 'application_received', 'gmail')] },
    'manual:bookedco|pm': { company: 'Bookedco', role: 'PM', status: 'interview', updated: '2026-09-28', events: [ev('2026-09-20', 'applied'), ev('2026-10-10', 'interview', 'gmail')] },
  });
  const rows = byCompany(tr.trackerExport({ out: OUT }).applications);
  assert.equal(rows.Earlyco.dateApplied, '2026-09-05');
  assert.equal(rows.Bookedco.lastActivity, '2026-09-28', 'the interview on 2026-10-10 is booked, not done (today is 2026-10-02)');
  assert.equal(rows.Bookedco.notes, 'Last update 2026-09-28');
  const future = tr.toRow('manual:soonco|pm', { company: 'Soonco', role: 'PM', status: 'rejected', updated: '2026-09-30', events: [ev('2026-09-20', 'applied'), ev('2026-10-09', 'rejected')] }, {}, '2026-10-02');
  assert.equal(future.notes, 'Rejected 2026-09-30', 'notes never name an event after today');
  const later = byCompany(tr.trackerExport({ out: OUT, date: '2026-10-10' }).applications);
  assert.equal(later.Bookedco.lastActivity, '2026-10-10', 'it counts from its day on');
});

test('an override "note" is a comment and is not copied; an override applies to every row it matches', () => {
  seed({
    'manual:tidewell|product manager': { company: 'Tidewell', role: 'Product Manager', status: 'applied', updated: '2026-09-29' },
    'manual:tidewell|data pm': { company: 'Tidewell', role: 'Data PM', status: 'applied', updated: '2026-09-29' },
  }, [{ company: 'Tidewell', stage: 'Screen', note: 'the recruiter called about both' }]);
  const r = tr.trackerExport({ out: OUT });
  assert.equal(r.applications.length, 2);
  for (const row of r.applications) {
    assert.equal(row.stage, 'Screen');
    assert.ok(!('note' in row), JSON.stringify(row));
  }
});

test('a row without a role breaks the format and stops the export', () => {
  seed({ ...APPS_DATA, 'manual:roleless|': { company: 'Roleless', role: '', status: 'applied', updated: '2026-09-30' } });
  assert.throws(() => tr.trackerExport({ out: OUT }), /invalid row \(role is empty\)/);
  assert.ok(!fs.existsSync(OUT));
});

test('a relative tracker_export.out is under the data folder; doctor shows it with "/"', () => {
  seed();
  const keep = SETTINGS.tracker_export;
  try {
    SETTINGS.tracker_export = { enabled: true, out: 'exports/pipeline.json' };
    assert.equal(tr.trackerOutFile(), path.join(DATA, 'exports', 'pipeline.json'));
    assert.equal(tr.trackerExport().file, path.join(DATA, 'exports', 'pipeline.json'));
    SETTINGS.tracker_export = { enabled: true, out: OUT };
    assert.equal(tr.trackerOutFile(), OUT, 'an absolute path is used as it is');
    SETTINGS.tracker_export = { enabled: true };
    assert.equal(tr.trackerOutFile(), path.join(DATA, 'tracker', 'pipeline.json'));
  } finally { SETTINGS.tracker_export = keep; }
  const settings = path.join(tmp, 'doctor-settings.json');
  fs.writeFileSync(settings, JSON.stringify({ timezone: 'UTC', tracker_export: { enabled: true, out: 'exports/pipeline.json' } }));
  const doc = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'doctor'], { encoding: 'utf8', env: { ...process.env, JOBPILOT_SETTINGS: settings } });
  assert.match(doc.stdout, /^ok {3}tracker export: data\/exports\/pipeline\.json$/m, doc.stdout);
});

test('cli.mjs tracker-export --dry-run prints the rows as JSON on stdout, the summary on stderr, and writes nothing', () => {
  seed();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'tracker-export', '--out', OUT, '--dry-run'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr.trimEnd().split('\n').at(-1), /^would write .*pipeline\.json \(7 applications: .*dry run, nothing written\)$/);
  const rows = JSON.parse(r.stdout);   // stdout is the JSON alone, so it can be piped
  assert.equal(rows.length, 7);
  assert.deepEqual(Object.keys(rows[0]), ['company', 'role', 'stage', 'furthestStage', 'dateApplied', 'lastActivity', 'notes', 'source', 'link']);
  assert.ok(!fs.existsSync(OUT));
});

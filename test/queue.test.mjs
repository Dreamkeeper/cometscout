// Queue rules: filters, normalising, front matter, duplicates, file names, decode results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-test-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
process.env.JOBPILOT_RUN_DATE = '2026-10-01';
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC', queue: { dedupe_days: 60, aliases: [['Acme Robotics', 'Acme']] } }));
// An old decode of the same title, written before the dedupe index is first built (the index is built once per process).
fs.mkdirSync(path.join(tmp, 'data', 'decoded'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'data', 'decoded', '2026-07-01--oldco--product-manager.md'),
  '---\ncompany: "OldCo"\nrole: "Product Manager"\nurl: "https://old.example/1"\nfound: 2026-07-01\n---\n\n# OldCo - Product Manager\n\ntext\n');

const q = await import('../lib/queue.mjs');

test('matchesAny matches whole words and prefixes, in any script', () => {
  const cases = [
    ['Kitchen Associate', ['soc'], false], ['SOC Analyst', ['soc'], true], ['Senior Product Manager', ['product manager'], true],
    ['Product  Manager II', ['product manager'], true], ['Engineering Lead', ['engineer*'], true], ['Engineer', ['engineering'], false],
    ['Менеджер продукта', ['продукта'], true], ['Менеджер продуктов', ['продукта'], false], ['C++ Developer', ['c++'], true],
    ['Internal Tools PM', ['intern'], false], ['', ['x'], false], ['Anything', [], false],
  ];
  for (const [hay, list, want] of cases) assert.equal(q.matchesAny(hay, list), want, `${hay} vs ${list}`);
});

test('norm keeps every script and drops Latin accents only', () => {
  assert.equal(q.norm('José Co'), 'jose co');
  assert.equal(q.norm('Йошкар'), 'йошкар');
  assert.equal(q.norm('株式会社サンプル'), '株式会社サンプル');
  assert.ok(Buffer.byteLength(q.slug('Очень длинное название компании на кириллице которое не влезает'), 'utf8') <= 60);
  assert.equal(q.slug('***'), 'unknown');
});

test('frontMatter reads quoted and escaped values', () => {
  const fm = q.frontMatter('---\ncompany: "A \\"B\\" C"\nfound: 2026-10-01\n---\nbody');
  assert.equal(fm.company, 'A "B" C');
  assert.equal(fm.found, '2026-10-01');
});

test('writeJob writes extra keys but never overrides standard ones', () => {
  const r = q.writeJob({ company: 'Acme', role: 'PM (EU)', url: 'https://a.example/1', source: 'test', text: 'x'.repeat(400),
    extra: { band: 2, remote_scope: 'europe', industries: ['iot', 'energy'], company: 'Evil', 'Bad-Key': 1, empty: '' } });
  assert.equal(r.written, true);
  const job = q.loadJob(r.file);
  assert.equal(job.fm.company, 'Acme');
  assert.equal(job.fm.band, '2');
  assert.equal(job.fm.remote_scope, 'europe');
  assert.equal(job.fm.industries, 'iot, energy');
  assert.equal(job.fm['Bad-Key'], undefined);
  assert.equal(job.fm.empty, undefined);
});

test('duplicates: URL first, then the same title at the same company', () => {
  const w = (company, role, url, location) => q.writeJob({ company, role, url, location, source: 'test', text: 'x' });
  assert.equal(w('Beta', 'Product Manager', 'https://b.example/1', 'Berlin, Germany').written, true);
  assert.equal(w('Other', 'Whatever', 'https://b.example/1?utm=x').written, false, 'same URL with a query string');
  assert.equal(w('Beta', 'Product Manager', 'https://linkedin.example/9', 'Berlin').written, false, 'same title, overlapping location');
  assert.equal(w('Beta', 'Product Manager', 'https://b.example/3', 'Madrid, Spain').written, true, 'same title, another city');
  assert.equal(w('Beta', 'Senior Product Manager', 'https://b.example/4', 'Berlin').written, true, 'different title');
  assert.equal(w('OldCo', 'Product Manager', 'https://old.example/2').written, true, 'repost after dedupe_days');
});

test('an unknown company never dedupes on the title alone; the URL still does', () => {
  const w = (company, role, url) => q.writeJob({ company, role, url, source: 'test', text: 'x' });
  assert.equal(w('Unknown', 'Product Manager Platform', 'https://u.example/1').written, true);
  assert.equal(w('Unknown', 'Product Manager Platform', 'https://u.example/2').written, true, 'two unknown companies are not one job');
  assert.equal(w('', 'Product Manager Platform', 'https://u.example/3').written, true, 'an empty company neither');
  assert.equal(w('unknown', 'Something Else', 'https://u.example/1/').written, false, 'the same URL is still a duplicate');
});

test('URL dedupe keeps job-id query parameters (gh_jid, jobId, id) and drops the rest', () => {
  const w = (company, url) => q.writeJob({ company, role: `Role at ${url}`, url, source: 'test', text: 'x' });
  assert.equal(w('Embedco', 'https://careers.embedco.example/jobs?gh_jid=111&utm_source=x').written, true);
  assert.equal(w('Embedco', 'https://careers.embedco.example/jobs?gh_jid=222').written, true, 'another Greenhouse-embed job');
  assert.equal(w('Embedco', 'https://careers.embedco.example/jobs?utm_source=y&gh_jid=111').written, false, 'same job id, other tracking');
  assert.equal(w('Idco', 'https://idco.example/job?jobId=7').written, true);
  assert.equal(w('Idco', 'https://idco.example/job?jobId=8').written, true);
  assert.equal(w('Idco', 'https://idco.example/view?id=1').written, true);
  assert.equal(w('Idco', 'https://idco.example/view?id=2').written, true);
  assert.equal(w('Idco', 'https://idco.example/view?id=2#apply').written, false);
});

test('a name collision on the same day gets a numeric suffix', () => {
  const a = q.writeJob({ company: 'Gamma', role: 'Engineer 2', url: 'https://g.example/1', location: 'Paris', source: 'test', text: 'x' });
  const b = q.writeJob({ company: 'Gamma', role: 'Engineer 2', url: 'https://g.example/2', location: 'Lyon', source: 'test', text: 'x' });
  assert.equal(a.file, '2026-10-01--gamma--engineer-2.md');
  assert.equal(b.file, '2026-10-01--gamma--engineer-2--2.md');
});

test('parseResult reads the last Decode Result block', () => {
  const v = q.parseResult('x\n\n## Decode Result\nDecoded 2026-09-30 by jobpilot (claude/sonnet).\nverdict: gate-reject (work authorization)\nconfidence: high\napply_priority: 5\nrationale: no route\naction: skip\n');
  assert.equal(v.verdict, 'gate-reject');
  assert.equal(v.gate, 'work authorization');
  assert.equal(v.apply_priority, 5);
  assert.equal(v.decoded_on, '2026-09-30');
});

test('htmlText decodes numeric and common named entities, once', () => {
  assert.equal(q.htmlText('<p>Caf&eacute; &#233;t&#xE9; &rsquo;quoted&lsquo; a&ndash;b c&mdash;d wait&hellip; x&nbsp;y &#39;s&#39;</p>'),
    "Caf\u00e9 \u00e9t\u00e9 \u2019quoted\u2018 a\u2013b c\u2014d wait\u2026 x y 's'");
  assert.equal(q.htmlText('5 &amp;lt; 6 &amp; R&amp;D'), '5 &lt; 6 & R&D', 'one pass: an escaped entity stays escaped');
  assert.equal(q.htmlText('&bogus; &#0; &#xD800; &Eacute;'), '&bogus; &#0; &#xD800; &Eacute;', 'unknown or invalid entities are kept as written');
});

// ---------- dedupe against the user's applications (data/state/applications.json) ----------
const APPS = path.join(tmp, 'data', 'state', 'applications.json');
const writeApps = (apps, mtime) => { fs.writeFileSync(APPS, JSON.stringify(apps, null, 1)); if (mtime) fs.utimesSync(APPS, mtime, mtime); };
const job = (company, role, url, opts) => q.writeJob({ company, role, url, source: 'test', text: 'x' }, opts);

test('a role close to one in applications is a duplicate: alias family and half the role words', () => {
  writeApps({
    '2026-09-01--acme--senior-pm-robotics.md': { company: 'Acme', role: 'Senior PM, Robotics', status: 'applied', updated: '2026-09-02' },
    'manual:quarry systems|data analyst': { company: 'Quarry Systems', role: 'Data Analyst', status: 'rejected', updated: '2026-09-05' },
    'manual:lumenfield|platform product owner': { company: 'Lumenfield', role: 'Platform Product Owner', status: 'withdrawn', updated: '2026-09-06' },
  });
  const r = job('Acme Robotics', 'Product Manager, Robotics', 'https://acme.example/jobs/1');
  assert.equal(r.written, false);
  assert.equal(r.reason, 'already in applications: Acme: Senior PM, Robotics (applied)');
  assert.equal(job('Quarry Systems', 'Hardware Product Manager', 'https://quarry.example/1').written, true, 'same company, another role');
  assert.equal(job('Lumenfield', 'Product Owner, Platform', 'https://lumen.example/1').reason, 'already in applications: Lumenfield: Platform Product Owner (withdrawn)', 'any status counts');
  assert.equal(job('Acme Robotics', 'Robotics Product Lead', 'https://acme.example/jobs/2', { titleDedupe: false }).written, true, 'a placeholder company is matched by URL only');
  assert.equal(job('Unknown', 'Senior PM, Robotics', 'https://u.example/robotics').written, true, 'an unknown company never matches an application');
});

test('a plain decode at the company still uses the exact-title rule only', () => {
  fs.writeFileSync(path.join(tmp, 'data', 'decoded', '2026-09-28--driftwood--product-manager-payments.md'),
    '---\ncompany: "Driftwood"\nrole: "Product Manager, Payments"\nurl: "https://drift.example/1"\nfound: 2026-09-28\n---\n\n# Driftwood\n');
  assert.equal(job('Driftwood', 'Senior Product Manager, Payments', 'https://drift.example/2').written, true);
});

test('applications.json is read again when it changes in the same process', () => {
  assert.equal(job('Harborline', 'Growth Product Manager', 'https://harbor.example/1').written, true);
  writeApps({ 'manual:harborline|growth pm': { company: 'Harborline', role: 'Growth Analytics', status: 'screen', updated: '2026-09-30' } }, new Date('2026-09-30T10:00:00Z'));
  assert.equal(job('Harborline', 'Growth Analytics Lead', 'https://harbor.example/2').reason, 'already in applications: Harborline: Growth Analytics (screen)');
  writeApps({}, new Date('2026-09-30T11:00:00Z'));
  assert.equal(job('Harborline', 'Growth Analytics Lead', 'https://harbor.example/3').written, true, 'the record was removed');
});

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
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC', queue: { dedupe_days: 60 } }));
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

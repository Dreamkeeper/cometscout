// Company alias families, the employer match and role overlap (lib/companies.mjs). Synthetic companies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-companies-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({
  timezone: 'UTC',
  queue: { aliases: [['Acme Robotics', 'Acme'], ['Northwind Labs', 'Northwind', 'NWL Group'], ['Ola', 'Ola Cabs'], ['Zeta Holdings', 'ZH']], role_stopwords: ['Banking'] },
}));
const c = await import('../lib/companies.mjs');

test('aliasFamilies reads queue.aliases as a list of lists or an object', () => {
  assert.equal(c.aliasFamilies().length, 4);
  const obj = c.aliasFamilies({ 'Acme Robotics': ['Acme'], Solo: 'Solo Labs' });
  assert.deepEqual(obj.map(f => [...f]), [['acme robotics', 'acme'], ['solo', 'solo labs']]);
  assert.deepEqual(c.aliasFamilies(null), []);
});

test('familyOf: a family whose alias occurs as whole words, else the name itself', () => {
  assert.deepEqual(c.familyOf('Acme').sort(), ['acme', 'acme robotics']);
  assert.deepEqual(c.familyOf('ACME Robotics, Inc.').sort(), ['acme', 'acme robotics']);
  assert.deepEqual(c.familyOf('NWL Group GmbH').sort(), ['northwind', 'northwind labs', 'nwl group']);
  assert.deepEqual(c.familyOf('Motorola'), ['motorola'], 'alias "ola" is not a substring match');
  assert.deepEqual(c.familyOf('Ola').sort(), ['ola', 'ola cabs']);
  assert.deepEqual(c.familyOf('ZH').sort(), ['zeta holdings', 'zh'], 'a short alias matches the whole name');
  assert.deepEqual(c.familyOf('ZH Partners'), ['zh partners'], 'a short alias never matches inside a longer name');
  assert.deepEqual(c.familyOf('Quarry Systems'), ['quarry systems']);
  assert.deepEqual(c.familyOf(''), []);
});

test('companyMatch: family members, whole-word containment of 4+ characters, never empty or unknown', () => {
  assert.equal(c.companyMatch('Acme', 'Acme Robotics'), true);
  assert.equal(c.companyMatch('Northwind', 'NWL Group'), true);
  assert.equal(c.companyMatch('Ridgeway', 'Ridgeway Labs'), true, 'contained as whole words');
  assert.equal(c.companyMatch('Ridgeway Labs', 'Ridgeway'), true, 'either way round');
  assert.equal(c.companyMatch('Ridge', 'Ridgeway Labs'), false, 'not a word of it');
  assert.equal(c.companyMatch('Abc', 'Abc Corp'), false, 'names shorter than 4 characters only match exactly');
  assert.equal(c.companyMatch('Abc', 'abc'), true);
  assert.equal(c.companyMatch('Motorola', 'Ola Cabs'), false);
  assert.equal(c.companyMatch('Quarry Systems', 'Lumenfield'), false);
  for (const x of ['', 'Unknown', null]) {
    assert.equal(c.companyMatch(x, 'Acme'), false);
    assert.equal(c.companyMatch('Acme', x), false);
  }
  assert.equal(c.companyMatch('Unknown', 'Unknown'), false);
});

test('companyMatch: a contained name that is one generic word never matches', () => {
  for (const [a, b] of [['Labs', 'Ridgeway Labs'], ['Quarry Systems', 'Systems'], ['Holdings', 'Driftwood Holdings'], ['GmbH', 'Kestrel GmbH'],
    ['Technologies', 'Harborline Technologies'], ['Group', 'Juniper Group'], ['ООО', 'ООО Квадрат']]) assert.equal(c.companyMatch(a, b), false, `${a} / ${b}`);
  assert.equal(c.companyMatch('Kestrel', 'Kestrel GmbH'), true, 'the distinctive name still matches');
  assert.equal(c.companyMatch('Квадрат', 'ООО Квадрат'), true);
  assert.equal(c.companyMatch('Labs', 'labs'), true, 'equal names always match');
});

test('companyKind keeps the stricter exact / prefix match the outcomes source uses', () => {
  assert.equal(c.companyKind('Acme', 'Acme Robotics'), 'exact');
  assert.equal(c.companyKind('Ridgeway', 'Ridgeway Labs'), 'prefix');
  assert.equal(c.companyKind('Labs', 'Ridgeway Labs'), null);
});

test('roleWords and roleOverlap: stopwords and words of 2 characters or less do not count', () => {
  assert.deepEqual([...c.roleWords('Senior PM, Robotics')], ['robotics']);
  assert.deepEqual([...c.roleWords('Product Manager, Robotics')], ['product', 'robotics']);
  assert.equal(c.roleOverlap('Senior PM, Robotics', 'Product Manager, Robotics'), 1);
  assert.equal(c.roleOverlap('Hardware Product Manager', 'Data Analyst'), 0);
  assert.equal(c.roleOverlap('Product Manager Payments', 'Product Owner Logistics', c.dedupeStopwords()), 0, 'with the dedupe stoplist "product" is no shared word');
  assert.equal(c.roleOverlap('Senior Manager', 'Product Manager'), 0, 'one side has no words left');
  assert.equal(c.roleOverlap('', 'Product Manager'), 0);
  assert.equal(c.roleOverlap('Ведущий менеджер продукта', 'Менеджер продукта'), 1);
});

test('dedupe role match: the dedupe stoplist and more than half the words shared', () => {
  const dup = (a, b) => c.sameRoleForDedupe(a, b);
  for (const [a, b] of [['Senior Product Manager', 'Product Manager, Payments'], ['Product Manager', 'Product Marketing Manager'],
    ['Senior Product Manager, Growth', 'Product Manager, Hardware'], ['Software Engineer, Backend', 'Software Engineer, Mobile'],
    ['Product Owner', 'Product Manager'], ['Менеджер продукта', 'Менеджер по продукту']]) assert.equal(dup(a, b), false, `${a} / ${b}`);
  for (const [a, b] of [['Senior PM, Robotics', 'Product Manager, Robotics'], ['Platform Product Owner', 'Product Owner, Platform'],
    ['Growth Analytics', 'Growth Analytics Lead'], ['Senior Software Engineer, Backend Payments', 'Software Engineer, Backend Payments']]) assert.equal(dup(a, b), true, `${a} / ${b}`);
  for (const w of ['product', 'owner', 'продукта', 'продукту', 'mfd', 'senior', 'banking']) assert.ok(c.dedupeStopwords().has(w), w);
  assert.equal(dup('Mobile Payments Platform', 'Web Payments Platform'), true, 'two of three words shared');
  assert.equal(c.sameRoleForDedupe('Mobile Payments Platform', 'Web Payments Platform', c.dedupeStopwords(['Payments', 'platform'])), false, 'queue.role_stopwords adds words');
  assert.equal(dup('Mobile Banking Analytics', 'Web Banking Analytics'), false, '"banking" from queue.role_stopwords in settings');
  assert.equal(c.ROLE_STOPWORDS.has('product'), false, 'the shared ROLE_STOPWORDS (outcomes) is unchanged');
});

test('picks role match: no stoplist, half the words shared, an empty side is the same process', () => {
  assert.equal(c.sameRole('Senior Product Manager', 'Product Manager, Payments'), true);
  assert.equal(c.sameRole('Lead Engineer', 'Data Scientist'), false, 'stopwords alone never empty a title here');
  assert.equal(c.sameRole('PM', 'Data Scientist'), true, 'no word longer than 2 characters on one side');
  assert.equal(c.sameRole('', 'Anything'), true);
  assert.equal(c.sameRole('Software Engineer, Backend', 'Software Engineer, Mobile'), true, 'two of three words shared');
  assert.equal(c.sameRole('Data Analyst', 'Product Manager'), false);
});

test('companies.mjs and queue.mjs do not import each other', () => {
  const src = f => fs.readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8');
  assert.doesNotMatch(src('companies.mjs'), /from '\.\/queue\.mjs'/);
  assert.match(src('companies.mjs'), /from '\.\/text\.mjs'/);
});

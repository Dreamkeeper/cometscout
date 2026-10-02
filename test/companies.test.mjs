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
  queue: { aliases: [['Acme Robotics', 'Acme'], ['Northwind Labs', 'Northwind', 'NWL Group'], ['Ola', 'Ola Cabs'], ['Zeta Holdings', 'ZH']] },
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
  assert.equal(c.roleOverlap('Product Manager Payments', 'Product Owner Logistics'), 0.5);
  assert.equal(c.roleOverlap('Senior Manager', 'Product Manager'), 0, 'one side has no words left');
  assert.equal(c.roleOverlap('', 'Product Manager'), 0);
  assert.equal(c.roleOverlap('Ведущий менеджер продукта', 'Менеджер продукта'), 1);
});

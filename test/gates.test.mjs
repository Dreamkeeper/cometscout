// Shared gates: the RTJ fixture expectations, one case per gate, missing fields, Cyrillic text, text-only sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-gates-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));

const { checkGates, fromRtj, fromText, countriesIn, attendanceIn, describeGates, gateTally } = await import('../lib/gates.mjs');

// The sample user from the brief: citizenship RU, may work in ES, on-site in ES/DE/NL/FR, English and Russian.
const GATES = {
  user: { citizenships: ['RU'], work_authorization: ['ES'] },
  languages: ['en', 'ru'],
  onsite_countries: ['ES', 'DE', 'NL', 'FR'],
  remote: { accept_worldwide: true, accept_regions: ['Europe', 'EU', 'EMEA'] },
  sponsorship_refusal_phrases: ['without sponsorship', 'no visa sponsorship', 'must be authorized to work in'],
  must_reside_phrases: [],
  headcount: { demote_over: 500, reject_over: null, reject_keywords_over: { min: 500, keywords: ['smart home'] }, demote_unless: ['remote_worldwide', 'remote_region', 'sponsorship'] },
  companies: { exclude: [], agencies: [] },
  industries: { exclude: [] },
};
const base = { company: 'Example Co', title: 'Product Manager', text: '', languages: [], required_languages: [], attendance: [], countries: [],
  remote_scope: null, allowed_regions: [], excluded_countries: [], required_citizenships: [], forbidden_citizenships: [], sponsorship: null,
  mandatory: [], headcount: null, industries: [] };
const job = over => ({ ...base, ...over });

test('every _expect in the RTJ fixture holds with the sample gates', () => {
  const items = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'rtj', 'positions.json'), 'utf8'));
  assert.equal(items.length, 7);
  for (const it of items) {
    const r = checkGates(fromRtj(it), GATES), e = it._expect;
    if (/^pass with flag/.test(e)) { assert.equal(r.decision, 'pass', e); assert.ok(r.flags.length > 0, `${e}: flag expected`); }
    else if (/^pass/.test(e)) assert.equal(r.decision, 'pass', `${e}: ${r.gate} ${r.reason}`);
    else if (/^reject (\w+)/.test(e)) { assert.equal(r.decision, 'reject', e); assert.equal(r.gate, e.match(/^reject (\w+)/)[1], `${e}: ${r.reason}`); }
    else if (/^band 4/.test(e)) { assert.ok(['reject', 'demote'].includes(r.decision), e); assert.equal(r.gate, 'headcount', e); }
    else assert.fail(`unhandled _expect: ${e}`);
  }
});

test('no gates settings: everything passes, nothing flagged', () => {
  const items = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'rtj', 'positions.json'), 'utf8'));
  for (const it of items) assert.deepEqual(checkGates(fromRtj(it), undefined), { decision: 'pass', gate: null, reason: '', flags: [] });
  assert.equal(checkGates(job({ forbidden_citizenships: ['RU'] }), null).decision, 'pass');
  assert.equal(checkGates(job({}), {}).decision, 'pass');
  assert.equal(checkGates(job({ forbidden_citizenships: ['RU'] })).decision, 'pass', 'default comes from settings, which has no gates here');
});

test('missing fields never reject', () => {
  assert.equal(checkGates({}, GATES).decision, 'pass');
  assert.equal(checkGates(null, GATES).decision, 'pass');
  assert.equal(checkGates(base, GATES).decision, 'pass');
  assert.equal(checkGates(job({ attendance: ['office'] }), GATES).decision, 'pass', 'on-site with unknown country');
  assert.equal(checkGates(job({ countries: ['US'] }), GATES).decision, 'pass', 'country without attendance');
  assert.equal(checkGates(job({ headcount: { min: null, max: null } }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ remote_scope: 'geo_restricted', attendance: ['remote'], allowed_regions: [] }), { user: {} }).decision, 'pass', 'no remote settings, no remote check');
});

test('company gate: excluded and agency, whole words', () => {
  const g = { companies: { exclude: ['Acme'], agencies: ['Talent Bridge'] } };
  assert.deepEqual([checkGates(job({ company: 'ACME Inc' }), g).gate, checkGates(job({ company: 'Talent Bridge Recruiting' }), g).gate], ['company', 'company']);
  assert.equal(checkGates(job({ company: 'Acmeworks' }), g).decision, 'pass');
  assert.equal(checkGates(job({ company: 'Рога и Копыта' }), { companies: { exclude: ['рога'] } }).gate, 'company', 'Cyrillic');
});

test('industry gate: industries, company or title', () => {
  const g = { industries: { exclude: ['gambling', 'crypto*'] } };
  assert.equal(checkGates(job({ industries: ['Online Gambling'] }), g).gate, 'industry');
  assert.equal(checkGates(job({ title: 'PM, Cryptocurrency Wallet' }), g).gate, 'industry');
  assert.equal(checkGates(job({ industries: ['IoT'] }), g).decision, 'pass');
  assert.equal(checkGates(job({ title: 'Менеджер продукта, азартные игры' }), { industries: { exclude: ['азартные игры'] } }).gate, 'industry');
});

test('language gate: posting language and required levels', () => {
  assert.equal(checkGates(job({ languages: ['de'] }), GATES).gate, 'language');
  assert.equal(checkGates(job({ languages: ['de', 'en'] }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ languages: ['RU'] }), GATES).decision, 'pass', 'case-insensitive');
  assert.equal(checkGates(job({ required_languages: [{ lang: 'de', level: 'c1' }] }), GATES).gate, 'language');
  assert.equal(checkGates(job({ required_languages: [{ lang: 'de', level: 'Fluent' }] }), GATES).gate, 'language');
  const low = checkGates(job({ required_languages: [{ lang: 'es', level: 'b1' }] }), GATES);
  assert.equal(low.decision, 'pass'); assert.match(low.flags[0], /es b1/);
  assert.equal(checkGates(job({ required_languages: [{ lang: 'ru', level: 'native' }] }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ languages: ['de'] }), { user: GATES.user }).decision, 'pass', 'no languages set, no check');
});

test('legal gate: citizenship, work authorization, sponsorship', () => {
  assert.equal(checkGates(job({ forbidden_citizenships: ['by', 'ru'] }), GATES).gate, 'legal');
  assert.equal(checkGates(job({ required_citizenships: ['US'] }), GATES).gate, 'legal');
  assert.equal(checkGates(job({ required_citizenships: ['RU', 'KZ'] }), GATES).decision, 'pass');
  const onsiteUS = { attendance: ['office'], countries: ['US'] };
  assert.equal(checkGates(job({ ...onsiteUS, mandatory: [{ class: 'LEGAL_AUTHORIZATION', text: 'Authorized to work in the US' }] }), GATES).gate, 'legal');
  assert.equal(checkGates(job({ ...onsiteUS, sponsorship: 'NOT_AVAILABLE' }), GATES).gate, 'legal');
  assert.equal(checkGates(job({ ...onsiteUS, text: 'We hire Without Sponsorship only.' }), GATES).gate, 'legal');
  // on-site in a country you may work in: no reject
  assert.equal(checkGates(job({ attendance: ['office'], countries: ['ES'], sponsorship: 'NOT_AVAILABLE' }), GATES).decision, 'pass');
  // remote: only a flag
  const remote = checkGates(job({ attendance: ['remote'], remote_scope: 'worldwide', countries: ['US'], sponsorship: 'NOT_AVAILABLE', text: 'no visa sponsorship' }), GATES);
  assert.equal(remote.decision, 'pass'); assert.ok(remote.flags.some(f => f.startsWith('legal')));
  // Cyrillic refusal phrase
  const g = { ...GATES, sponsorship_refusal_phrases: ['без визовой поддержки'] };
  assert.equal(checkGates(job({ ...onsiteUS, text: 'Работа в офисе, без визовой поддержки.' }), g).gate, 'legal');
});

test('geo gate: on-site countries and excluded countries', () => {
  assert.equal(checkGates(job({ attendance: ['hybrid'], countries: ['PL'] }), GATES).gate, 'geo');
  assert.equal(checkGates(job({ attendance: ['office'], countries: ['PL', 'DE'] }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ attendance: ['office', 'remote'], remote_scope: 'worldwide', countries: ['PL'] }), GATES).decision, 'pass', 'remote option');
  assert.equal(checkGates(job({ attendance: ['remote'], remote_scope: 'worldwide', excluded_countries: ['ES'] }), GATES).gate, 'geo-remote');
});

test('remote gate: regions, worldwide, must-reside phrases', () => {
  const r = (scope, regions, extra = {}) => job({ attendance: ['remote'], remote_scope: scope, allowed_regions: regions, ...extra });
  assert.equal(checkGates(r('geo_restricted', ['Western Europe']), GATES).decision, 'pass');
  assert.equal(checkGates(r('geo_restricted', ['es']), GATES).decision, 'pass', 'ISO code of a work authorization country');
  assert.equal(checkGates(r('geo_restricted', ['FR']), GATES).decision, 'pass', 'ISO code of an on-site country');
  assert.equal(checkGates(r('geo_restricted', ['US', 'Canada']), GATES).gate, 'geo-remote');
  assert.equal(checkGates(r('geo_restricted', ['US'], { attendance: ['remote', 'office'], countries: ['DE'] }), GATES).decision, 'pass', 'office in an accepted country');
  assert.equal(checkGates(r('worldwide', []), GATES).decision, 'pass');
  assert.equal(checkGates(r('worldwide', []), { ...GATES, remote: { accept_worldwide: false } }).gate, 'geo-remote');
  const g = { ...GATES, must_reside_phrases: ['must reside in the US', 'только резиденты РФ'] };
  assert.equal(checkGates(r('worldwide', [], { text: 'Candidates must reside in the US.' }), g).gate, 'geo-remote');
  assert.equal(checkGates(r('worldwide', [], { text: 'Вакансия только резиденты РФ.' }), g).gate, 'geo-remote');
  assert.equal(checkGates(job({ attendance: ['office'], countries: ['ES'], text: 'must reside in the US' }), g).decision, 'pass', 'phrase only applies to remote jobs');
});

test('headcount gate: reject_over, keywords, demote and its exceptions', () => {
  const big = { headcount: { min: 1001, max: 5000 } };
  assert.equal(checkGates(job({ ...big }), { headcount: { reject_over: 1000 } }).gate, 'headcount');
  assert.equal(checkGates(job({ ...big, industries: ['Smart Home'] }), GATES).decision, 'reject');
  assert.equal(checkGates(job({ ...big, title: 'PM, умный дом' }), { headcount: { reject_keywords_over: { min: 500, keywords: ['умный дом'] } } }).decision, 'reject');
  assert.equal(checkGates(job({ ...big }), GATES).decision, 'demote');
  assert.equal(checkGates(job({ ...big, attendance: ['remote'], remote_scope: 'worldwide' }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ ...big, attendance: ['remote'], remote_scope: 'geo_restricted', allowed_regions: ['EMEA'] }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ ...big, sponsorship: 'AVAILABLE' }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ ...big, attendance: ['remote'], remote_scope: 'worldwide' }), { headcount: { demote_over: 500 } }).decision, 'demote', 'no demote_unless');
  assert.equal(checkGates(job({ headcount: { min: 500 } }), GATES).decision, 'pass', 'over means more than');
  assert.equal(checkGates(job({ headcount: { min: '2000' } }), { headcount: { demote_over: 'abc' } }).decision, 'pass', 'a broken number is no limit');
});

test('first reject wins and flags accumulate', () => {
  const r = checkGates(job({ company: 'Acme', forbidden_citizenships: ['RU'] }), { ...GATES, companies: { exclude: ['acme'] } });
  assert.equal(r.gate, 'company');
  const p = checkGates(job({ attendance: ['remote'], remote_scope: 'geo_restricted', allowed_regions: ['Europe'], required_languages: [{ lang: 'es', level: 'a2' }], sponsorship: 'NOT_AVAILABLE' }), GATES);
  assert.equal(p.decision, 'pass'); assert.equal(p.flags.length, 3);
});

test('text-only sources: countries and attendance read plainly, nothing guessed', () => {
  assert.deepEqual(countriesIn('Berlin, Germany'), ['DE']);
  assert.deepEqual(countriesIn('Remote - Spain'), ['ES']);
  assert.deepEqual(countriesIn('Austin, TX, United States'), ['US']);
  assert.deepEqual(countriesIn('London, UK; Amsterdam, Netherlands'), ['GB', 'NL']);
  assert.deepEqual(countriesIn('Santa Fe, New Mexico'), []);
  assert.deepEqual(countriesIn('Atlanta, Georgia'), []);
  assert.deepEqual(countriesIn(''), []);
  assert.deepEqual(attendanceIn('Berlin; OnSite'), ['office']);
  assert.deepEqual(attendanceIn('Remote (Europe); Hybrid'), ['remote', 'hybrid']);
  assert.deepEqual(attendanceIn('Madrid'), []);
  const j = fromText({ company: 'Acme', title: 'PM', text: 'x', location: 'Warsaw, Poland; On-site' });
  assert.equal(checkGates(j, GATES).gate, 'geo');
  assert.equal(checkGates(fromText({ company: 'Acme', title: 'PM', location: 'Warsaw, Poland' }), GATES).decision, 'pass', 'attendance unknown');
});

test('describeGates and the tally', () => {
  const d = describeGates({ ...GATES, langs: ['en'], _comment: 'x' });
  assert.deepEqual(d.unknown, ['langs']);
  assert.deepEqual(d.active, ['language', 'legal', 'geo', 'remote', 'headcount']);
  assert.deepEqual(describeGates(undefined), { active: [], unknown: [] });
  const t = gateTally();
  t.add({ decision: 'reject', gate: 'legal' }); t.add({ decision: 'reject', gate: 'legal' }); t.add({ decision: 'demote', gate: 'headcount' }); t.add({ decision: 'pass' });
  assert.equal(String(t), 'gated 2 (legal 2), demoted 1'); assert.equal(t.total, 3);
});

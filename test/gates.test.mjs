// Shared gates: the RTJ fixture expectations, one case per gate, missing fields, Cyrillic text, text-only sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-gates-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));

const { checkGates, fromRtj, fromText, countriesIn, attendanceIn, describeGates, gateTally, settle, recordDemote } = await import('../lib/gates.mjs');
const ROOT = path.join(HERE, '..');

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

// Review fixes. Every case starts from the brief's full sample GATES (remote block included) and changes only the job,
// or the one settings key under test. The governing rule: a missing or oddly written field never rejects.
const remoteJob = (regions, extra = {}) => job({ attendance: ['remote'], remote_scope: 'geo_restricted', allowed_regions: regions, ...extra });

test('geo_restricted with no regions listed: flag, not reject', () => {
  for (const regions of [[], null, undefined, ['', '  ']]) {
    const r = checkGates(remoteJob(regions), GATES);
    assert.equal(r.decision, 'pass', JSON.stringify(regions));
    assert.ok(r.flags.includes('remote: region-restricted, regions not listed'), JSON.stringify(r.flags));
  }
  const item = { position: { title: 'PM', remote_scope: 'geo_restricted', allowed_regions: [], locations: [{ country: 'US', attendance: ['remote'] }], languages: ['en'] }, employer: { name: 'Example Co' } };
  assert.equal(checkGates(fromRtj(item), GATES).decision, 'pass', 'from an RTJ item too');
});

test('allowed_regions written as country names or code lists are read', () => {
  for (const regions of [['Spain'], ['Germany, Spain'], ['Spain, Portugal, Italy'], ['ES, PT'], ['Remote - Spain']]) {
    const r = checkGates(remoteJob(regions), GATES);
    assert.equal(r.decision, 'pass', `${regions}: ${r.reason}`); assert.match(r.flags.join(), /remote: limited to/);
  }
  assert.equal(checkGates(remoteJob(['Spain']), { ...GATES, onsite_countries: [] }).decision, 'pass', 'work authorization alone is enough');
  const us = checkGates(remoteJob(['United States']), GATES);
  assert.equal(us.decision, 'reject'); assert.equal(us.gate, 'geo-remote');
  assert.equal(checkGates(remoteJob(['Austin, United States']), GATES).gate, 'geo-remote');
});

test('remote block without accept_regions: geo_restricted is flag-only', () => {
  for (const remote of [{ accept_worldwide: true }, {}, { accept_worldwide: true, accept_regions: [] }, { accept_regions: null }]) {
    const g = { ...GATES, remote };
    const r = checkGates(remoteJob(['United States']), g);
    assert.equal(r.decision, 'pass', JSON.stringify(remote)); assert.match(r.flags.join(), /United States.*no remote\.accept_regions/);
    assert.equal(checkGates(remoteJob(['Spain']), g).decision, 'pass');
  }
  assert.equal(checkGates(remoteJob(['United States']), GATES).decision, 'reject', 'with accept_regions set it still rejects');
});

test('the shipped accept_regions match European Union, EEA and other Europe spellings', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8')).gates;
  assert.deepEqual(example.remote.accept_regions, ['Europe*', 'EU', 'EEA', 'EMEA']);
  const g = { ...GATES, remote: { ...GATES.remote, accept_regions: example.remote.accept_regions } };
  for (const region of ['European Union', 'EEA', 'Europe', 'Western Europe', 'EMEA', 'EU', 'European Economic Area'])
    assert.equal(checkGates(remoteJob([region]), g).decision, 'pass', region);
  assert.equal(checkGates(remoteJob(['United States', 'Canada']), g).gate, 'geo-remote');
  assert.equal(checkGates(remoteJob(['Eurasia']), g).gate, 'geo-remote', 'the prefix is a word prefix, not a substring');
});

test('demoted jobs are recorded once in data/state/demoted.jsonl and not marked seen', () => {
  const file = path.join(process.env.JOBPILOT_DATA, 'state', 'demoted.jsonl');
  fs.rmSync(file, { force: true });
  const big = job({ attendance: ['office'], countries: ['ES'], headcount: { min: 2000, max: 5000 } });
  const g = checkGates(big, GATES); assert.equal(g.decision, 'demote');
  const meta = { source: 'linkedin', company: 'Example Co', role: 'Product Manager', url: 'https://jobs.example/1' };
  assert.deepEqual(settle(g, meta, { dry: true }), { queue: false, markSeen: false });
  assert.equal(fs.existsSync(file), false, 'a dry run writes nothing');
  assert.deepEqual(settle(g, meta), { queue: false, markSeen: false });
  settle(g, meta);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 1, 'the same job is recorded once');
  assert.deepEqual(Object.keys(lines[0]), ['date', 'source', 'company', 'role', 'url', 'gate', 'reason']);
  assert.match(lines[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual({ ...lines[0], date: 'x' }, { date: 'x', ...meta, gate: 'headcount', reason: g.reason });
  assert.deepEqual(settle(checkGates(job({ forbidden_citizenships: ['RU'] }), GATES), meta), { queue: false, markSeen: true }, 'a reject is final');
  assert.deepEqual(settle(checkGates(base, GATES), meta), { queue: true, markSeen: true });
  assert.equal(recordDemote({ source: 'rtj', company: 'Other Co', role: 'PM' }, g), true, 'no url: keyed by company and role');
  assert.equal(recordDemote({ source: 'rtj', company: 'Other Co', role: 'PM' }, g), false);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('language codes with region tags compare by primary subtag', () => {
  assert.equal(checkGates(job({ languages: ['en-US'] }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ languages: ['EN_gb', 'de-DE'] }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ languages: ['de-AT'] }), GATES).gate, 'language');
  assert.equal(checkGates(job({ required_languages: [{ lang: 'en-GB', level: 'c2' }] }), GATES).decision, 'pass');
  assert.equal(checkGates(job({ required_languages: [{ lang: 'de-CH', level: 'c1' }] }), GATES).gate, 'language');
  assert.equal(checkGates(job({ languages: ['en'] }), { ...GATES, languages: ['en-GB', 'ru-RU'] }).decision, 'pass', 'user codes with tags');
});

test('legal flag whenever the job is not on-site only in a country the user may work in', () => {
  const legal = { mandatory: [{ class: 'LEGAL_AUTHORIZATION', text: 'Authorized to work in the US' }] };
  for (const over of [{ countries: ['US'] }, { attendance: [], countries: [] }, { attendance: ['hybrid', 'remote'], countries: ['US'] }, { attendance: ['office'] }]) {
    const r = checkGates(job({ ...legal, ...over }), GATES);
    assert.equal(r.decision, 'pass', JSON.stringify(over)); assert.ok(r.flags.some(f => f.startsWith('legal:')), JSON.stringify(over));
  }
  const inside = checkGates(job({ ...legal, attendance: ['office'], countries: ['ES'] }), GATES);
  assert.equal(inside.decision, 'pass'); assert.deepEqual(inside.flags, []);
});

test('legal: sponsorship available turns an on-site authorization reject into a flag', () => {
  const de = { attendance: ['office'], countries: ['DE'], text: 'You must be authorized to work in Germany.', mandatory: [{ class: 'LEGAL_AUTHORIZATION', text: 'Authorized to work in Germany' }] };
  const ok = checkGates(job({ ...de, sponsorship: 'AVAILABLE' }), GATES);
  assert.equal(ok.decision, 'pass', ok.reason); assert.ok(ok.flags.some(f => /^legal: .*sponsorship available/.test(f)), ok.flags.join());
  for (const sponsorship of ['NOT_AVAILABLE', 'AMBIGUOUS', 'NOT_MENTIONED', null]) assert.equal(checkGates(job({ ...de, sponsorship }), GATES).gate, 'legal', String(sponsorship));
  const item = { position: { title: 'PM', languages: ['en'], locations: [{ country: 'DE', city: 'Berlin', attendance: ['office'] }], remote_scope: 'none', visa_sponsorship_availability: 'AVAILABLE',
    raw_job_description: 'Applicants must be authorized to work in Germany.', objective_criteria: [{ class: 'LEGAL_AUTHORIZATION', criteria: 'Authorized to work in Germany', is_mandatory: true }] }, employer: { name: 'Example Co' } };
  assert.equal(checkGates(fromRtj(item), GATES).decision, 'pass', 'from an RTJ item');
});

test('on-site fallback for a region-restricted remote job counts only office or hybrid locations', () => {
  const rtj = locations => ({ position: { title: 'PM', languages: ['en'], remote_scope: 'geo_restricted', allowed_regions: ['United States'], locations }, employer: { name: 'Example Co' } });
  const remoteES = checkGates(fromRtj(rtj([{ country: 'ES', attendance: ['remote'] }, { country: 'US', attendance: ['office'] }])), GATES);
  assert.equal(remoteES.decision, 'reject', 'a remote-only ES location is not an on-site option'); assert.equal(remoteES.gate, 'geo-remote');
  const officeNL = checkGates(fromRtj(rtj([{ country: 'NL', attendance: ['office'] }, { country: 'US', attendance: ['remote'] }])), GATES);
  assert.equal(officeNL.decision, 'pass'); assert.ok(officeNL.flags.some(f => /on-site option in NL$/.test(f)), officeNL.flags.join());
  const hybridES = checkGates(fromRtj(rtj([{ country: 'ES', attendance: ['hybrid', 'remote'] }])), GATES);
  assert.equal(hybridES.decision, 'pass');
  // the same pairing for accept_worldwide: false
  const ww = { ...GATES, remote: { ...GATES.remote, accept_worldwide: false } };
  const pair = (a, b) => checkGates(job({ attendance: ['remote', 'office'], remote_scope: 'worldwide', countries: ['ES', 'US'], locations: [{ country: 'ES', attendance: a }, { country: 'US', attendance: b }] }), ww);
  assert.equal(pair(['remote'], ['office']).gate, 'geo-remote');
  assert.equal(pair(['office'], ['remote']).decision, 'pass');
  // text sources keep one attendance per location string
  const t = fromText({ location: ['Madrid, Spain; Remote', 'Austin, United States; On-site'] });
  assert.deepEqual(t.locations, [{ country: 'ES', attendance: ['remote'] }, { country: 'US', attendance: ['office'] }]);
  assert.deepEqual(t.countries, ['ES', 'US']); assert.deepEqual(t.attendance, ['remote', 'office']);
});

test('headcount gating is opt-in: no headcount block never demotes or rejects', () => {
  const { headcount, ...noHc } = GATES;
  const huge = { headcount: { min: 100000, max: 500000 }, industries: ['Smart Home'], title: 'PM, smart home', attendance: ['office'], countries: ['ES'] };
  for (const g of [noHc, { ...noHc, headcount: null }, { ...noHc, headcount: {} }, { ...noHc, headcount: { demote_over: null, reject_over: null, demote_unless: ['sponsorship'] } }]) {
    const r = checkGates(job(huge), g);
    assert.equal(r.decision, 'pass', JSON.stringify(g.headcount)); assert.ok(!r.flags.some(f => f.startsWith('headcount')));
  }
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8')).gates;
  assert.equal(checkGates(job(huge), { ...GATES, headcount: example.headcount }).decision, 'pass', 'the example file ships it off');
});

test('settings.example.json matches the example profile and the README Gates block', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8')).gates;
  assert.deepEqual(example.languages, ['en', 'es'], 'the example person: English C1, Spanish native');
  assert.equal(example.headcount.demote_over, null);
  assert.equal(example.headcount.reject_over, null);
  assert.equal(example.headcount.reject_keywords_over, undefined);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const block = readme.slice(readme.indexOf('### Gates')).match(/```json\n"gates": ([\s\S]*?)\n```/);
  assert.ok(block, 'README has a Gates json block');
  const { _comment, ...rest } = example;
  assert.deepEqual(JSON.parse(block[1]), rest);
  assert.match(readme, /demoted\.jsonl/);
});

test('tally keeps jobs gated on an earlier run apart', () => {
  const t = gateTally();
  t.add({ decision: 'reject', gate: 'geo' }); t.add({ decision: 'reject', gate: 'geo' }, true); t.add({ decision: 'demote', gate: 'headcount' }, true);
  assert.equal(String(t), 'gated 1 (geo 1), 2 still gated from earlier runs'); assert.equal(t.total, 3);
  const only = gateTally(); only.add({ decision: 'reject', gate: 'legal' }, true);
  assert.equal(String(only), '1 still gated from earlier runs');
});

// Sources end to end, with fetch mocked (no network) and their own data folder.
function sourceRun(script, settings, routes, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-src-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ timezone: 'UTC', ...settings }));
  fs.writeFileSync(path.join(home, 'routes.json'), JSON.stringify(routes));
  fs.writeFileSync(path.join(home, 'mock-fetch.mjs'), `import fs from 'node:fs';
const routes = JSON.parse(fs.readFileSync(process.env.MOCK_ROUTES, 'utf8'));
globalThis.fetch = async url => { const k = Object.keys(routes).find(p => String(url).startsWith(p));
  return k ? new Response(JSON.stringify(routes[k]), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('not found', { status: 404 }); };`);
  const run = (args = []) => {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(home, 'mock-fetch.mjs')).href, path.join(ROOT, 'sources', script), ...args], {
      encoding: 'utf8', env: { ...process.env, JOBPILOT_HOME: home, JOBPILOT_DATA: path.join(home, 'data'), JOBPILOT_SETTINGS: path.join(home, 'settings.json'), MOCK_ROUTES: path.join(home, 'routes.json'), ...extraEnv } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r.stdout;
  };
  const demoted = () => { const f = path.join(home, 'data', 'state', 'demoted.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []; };
  const inbox = () => fs.readdirSync(path.join(home, 'data', 'inbox'));
  const file = name => fs.readFileSync(path.join(home, 'data', 'inbox', name), 'utf8');
  return { run, demoted, inbox, file };
}

test('rtj: a demoted job is appended to demoted.jsonl once; a dry run writes nothing', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'rtj', 'positions.json'), 'utf8'));
  const big = { position: { title: 'Senior Product Manager', apply_url: 'https://jobs.example/big-1', languages: ['en'], remote_scope: 'none',
    locations: [{ city: 'Madrid', country: 'ES', attendance: ['office'] }], raw_job_description: 'Synthetic posting.' }, employer: { name: 'Bigco Example', headcount: { min: 2001, max: 5000 }, industries: ['Logistics'] } };
  const settings = { sources: { rtj: { enabled: true, token_env: 'RTJ_TEST_TOKEN' } }, gates: GATES };
  const routes = { 'https://rtj.app/api/jobs/search': { positions: [...fixture, big] } };
  const dry = sourceRun('rtj.mjs', settings, routes, { RTJ_TEST_TOKEN: 'synthetic' });
  dry.run(['--dry-run']);
  assert.deepEqual(dry.demoted(), []);
  const s = sourceRun('rtj.mjs', settings, routes, { RTJ_TEST_TOKEN: 'synthetic' });
  const out = s.run();
  assert.match(out, /demoted 1/);
  const d = s.demoted();
  assert.equal(d.length, 1);
  assert.deepEqual({ ...d[0], date: 'x', reason: 'x' }, { date: 'x', source: 'rtj', company: 'Bigco Example', role: 'Senior Product Manager', url: 'https://jobs.example/big-1', gate: 'headcount', reason: 'x' });
  s.run();
  assert.equal(s.demoted().length, 1, 'the next run does not repeat it');
});

test('ats-boards: Ashby secondary locations reach the gates; a job gated before is counted apart', () => {
  const board = { jobs: [
    { title: 'Product Manager', jobUrl: 'https://jobs.example/ashby/1', location: 'Warsaw', address: { postalAddress: { addressCountry: 'Poland' } }, workplaceType: 'OnSite',
      secondaryLocations: [{ location: 'Madrid', address: { postalAddress: { addressLocality: 'Madrid', addressCountry: 'Spain' } } }], descriptionPlain: 'Synthetic posting.' },
    { title: 'Product Manager, Payments', jobUrl: 'https://jobs.example/ashby/2', location: 'Warsaw, Poland', workplaceType: 'OnSite', descriptionPlain: 'Synthetic posting.' },
  ] };
  const settings = { sources: { ats_boards: { enabled: true, companies: [{ name: 'Example Co', ats: 'ashby', board: 'exampleco' }], title_include: ['product manager'] } }, gates: GATES };
  const s = sourceRun('ats-boards.mjs', settings, { 'https://api.ashbyhq.com/posting-api/job-board/exampleco': board });
  const first = s.run();
  assert.match(first, /1 new job\(s\), gated 1 \(geo 1\)/);
  assert.equal(s.inbox().length, 1);
  assert.match(s.file(s.inbox()[0]), /location: "Warsaw, Poland \| Madrid, Spain; OnSite"/);
  const second = s.run();
  assert.match(second, /0 new job\(s\), 1 still gated from earlier runs/);
  assert.doesNotMatch(second, /gated 1 \(/);
});

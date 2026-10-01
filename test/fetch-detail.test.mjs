// fetch-detail: full job text from known ATS APIs or the page itself, page-title parsing, listing-page detection.
// No network: every test injects its own fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'fetch-detail');
const read = name => fs.readFileSync(path.join(FIX, name), 'utf8');

const { fetchDetail, parseSearchTitle, companyFromUrl, isListingPage } = await import('../lib/fetch-detail.mjs');

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body });
const htmlRes = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
/** A fake fetch keyed by exact URL (query string included); unlisted URLs fail the test loudly. */
function stub(map) {
  return async url => { if (!(url in map)) throw new Error(`unexpected fetch: ${url}`); return map[url]; };
}

test('fetchDetail: Greenhouse job, HTML content unescaped and stripped', async () => {
  const url = 'https://job-boards.greenhouse.io/northwind/jobs/7000001';
  const fetch = stub({ 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/7000001?content=true': jsonRes(200, read('greenhouse-job.json')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'greenhouse');
  assert.equal(d.title, 'Product Manager');
  assert.equal(d.location, 'Remote - Europe');
  assert.match(d.text, /Product Manager/);
  assert.ok(!d.text.includes('&lt;'), 'entities decoded');
  assert.ok(!d.text.includes('<b>'), 'tags stripped');
});

test('fetchDetail: Greenhouse 404 is unavailable, never an error', async () => {
  const url = 'https://job-boards.greenhouse.io/northwind/jobs/9999999';
  const fetch = stub({ 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/9999999?content=true': jsonRes(404, '{}') });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'greenhouse');
  assert.equal(d.unavailable, 'posting gone');
});

test('fetchDetail: a network error is reported, not thrown', async () => {
  const url = 'https://job-boards.greenhouse.io/northwind/jobs/7000001';
  const fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'error');
  assert.match(d.error, /ENOTFOUND/);
});

test('fetchDetail: Ashby job found in the board listing, with a company hint', async () => {
  const url = 'https://jobs.ashbyhq.com/acme-robotics/11111111-1111-1111-1111-111111111111';
  const fetch = stub({ 'https://api.ashbyhq.com/posting-api/job-board/acme-robotics?includeCompensation=true': jsonRes(200, read('ashby-board.json')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'ashby');
  assert.equal(d.title, 'Staff Firmware Engineer');
  assert.equal(d.companyHint, 'Acme Robotics');
  assert.match(d.location, /Berlin/);
  assert.match(d.text, /firmware engineer/);
});

test('fetchDetail: Ashby job missing from the board listing is unavailable', async () => {
  const url = 'https://jobs.ashbyhq.com/acme-robotics/22222222-2222-2222-2222-222222222222';
  const fetch = stub({ 'https://api.ashbyhq.com/posting-api/job-board/acme-robotics?includeCompensation=true': jsonRes(200, read('ashby-board.json')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'ashby');
  assert.equal(d.unavailable, 'posting gone');
});

test('fetchDetail: Lever posting', async () => {
  const url = 'https://jobs.lever.co/lumenfield/00000000-0000-0000-0000-000000000001';
  const fetch = stub({ 'https://api.lever.co/v0/postings/lumenfield/00000000-0000-0000-0000-000000000001?mode=json': jsonRes(200, read('lever-posting.json')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'lever');
  assert.equal(d.title, 'Sr. AI Product Manager');
  assert.match(d.location, /Remote - EU/);
  assert.match(d.text, /ML-driven/);
  assert.match(d.text, /5\+ years/);
});

test('fetchDetail: Lever EU subdomain hits the EU API', async () => {
  const url = 'https://jobs.eu.lever.co/lumenfield/00000000-0000-0000-0000-000000000001';
  const fetch = stub({ 'https://api.eu.lever.co/v0/postings/lumenfield/00000000-0000-0000-0000-000000000001?mode=json': jsonRes(200, read('lever-posting.json')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'lever');
});

test('fetchDetail: Workable job', async () => {
  const url = 'https://apply.workable.com/northwind/j/ABCDEF1234';
  const fetch = stub({ 'https://apply.workable.com/api/v2/accounts/northwind/jobs/ABCDEF1234': jsonRes(200, read('workable-job.json')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'workable');
  assert.equal(d.title, 'Product Manager - AI');
  assert.match(d.location, /Madrid/);
  assert.match(d.location, /remote/i);
  assert.match(d.text, /AI roadmap/);
});

test('fetchDetail: Recruitee offer', async () => {
  const url = 'https://acme.recruitee.com/o/backend-engineer';
  const fetch = stub({ 'https://acme.recruitee.com/api/offers/backend-engineer': jsonRes(200, read('recruitee-offer.json')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'recruitee');
  assert.equal(d.title, 'Backend Engineer');
  assert.match(d.location, /Lisbon/);
  assert.match(d.text, /backend team/);
});

test('fetchDetail: generic page with JSON-LD JobPosting', async () => {
  const url = 'https://www.jobfluent.com/jobs/product-manager-barcelona-aaaaaa';
  const fetch = stub({ [url]: htmlRes(200, read('page-jsonld.html')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'page');
  assert.equal(d.title, 'Product Manager');
  assert.equal(d.companyHint, 'Lumenfield');
  assert.match(d.location, /Barcelona/);
  assert.match(d.text, /growth roadmap/);
});

test('fetchDetail: generic page, no JSON-LD, falls back to visible text', async () => {
  const url = 'https://himalayas.app/companies/ridgeway/jobs/pm-cloud';
  const fetch = stub({ [url]: htmlRes(200, read('page-plain.html')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'page');
  assert.equal(d.companyHint, undefined);
  assert.ok(d.text.length > 600);
  assert.ok(!d.text.includes('<p>'), 'tags stripped');
});

test('fetchDetail: a page with too little text is unavailable', async () => {
  const url = 'https://example.com/careers/stub';
  const fetch = stub({ [url]: htmlRes(200, read('page-too-short.html')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'page');
  assert.equal(d.unavailable, 'too little text to read');
});

test('fetchDetail: a page that is gone (410) is unavailable', async () => {
  const url = 'https://example.com/careers/gone';
  const fetch = stub({ [url]: htmlRes(410, '') });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.unavailable, 'posting gone');
});

test('fetchDetail: not a URL at all', async () => {
  const d = await fetchDetail('not a url', { fetch: async () => { throw new Error('should not be called'); } });
  assert.equal(d.via, 'error');
});

test('companyFromUrl: the board/account slug of each known ATS, title-cased', () => {
  assert.equal(companyFromUrl('https://job-boards.greenhouse.io/northwind/jobs/7000001'), 'Northwind');
  assert.equal(companyFromUrl('https://jobs.ashbyhq.com/acme-robotics/11111111-1111-1111-1111-111111111111'), 'Acme Robotics');
  assert.equal(companyFromUrl('https://jobs.lever.co/lumenfield/00000000-0000-0000-0000-000000000001'), 'Lumenfield');
  assert.equal(companyFromUrl('https://apply.workable.com/northwind/j/ABCDEF1234'), 'Northwind');
  assert.equal(companyFromUrl('https://acme.recruitee.com/o/backend-engineer'), 'Acme');
  assert.equal(companyFromUrl('https://himalayas.app/companies/ridgeway/jobs/pm-cloud'), null);
});

test('parseSearchTitle: every format in the brief', () => {
  assert.deepEqual(parseSearchTitle('Job Application for Product Manager at Northwind Devices'),
    { title: 'Product Manager', company: 'Northwind Devices', location: '' });
  assert.deepEqual(parseSearchTitle('Product Manager at Lumenfield in Barcelona or Remote | JobFluent'),
    { title: 'Product Manager', company: 'Lumenfield', location: 'Barcelona or Remote' });
  assert.deepEqual(parseSearchTitle("Staff Product Manager at Brightline | Y Combinator's Work at a Startup"),
    { title: 'Staff Product Manager', company: 'Brightline', location: '' });
  assert.deepEqual(parseSearchTitle('Ridgeway Labs hiring Product Manager - Cloud • Remote (Work from Home) | Himalayas'),
    { title: 'Product Manager - Cloud', company: 'Ridgeway Labs', location: 'Remote (Work from Home)' });
  assert.deepEqual(parseSearchTitle('[Hiring] Lead Product Manager, AI @Quarry Systems'),
    { title: 'Lead Product Manager, AI', company: 'Quarry Systems', location: '' });
  assert.deepEqual(parseSearchTitle('Kvadrat Soft: Product Owner'),
    { title: 'Product Owner', company: 'Kvadrat Soft', location: '' });
  assert.deepEqual(parseSearchTitle('Product Manager - AI - Northwind'),
    { title: 'Product Manager - AI', company: 'Northwind', location: '' });
});

test('parseSearchTitle: "Co - X" vs "X - Co" is resolved by isTitle when given', () => {
  const isRealTitle = real => s => s.trim().toLowerCase() === real.toLowerCase();
  assert.deepEqual(parseSearchTitle('Lumenfield - Sr. AI Product Manager', isRealTitle('Sr. AI Product Manager')),
    { title: 'Sr. AI Product Manager', company: 'Lumenfield', location: '' });
  assert.deepEqual(parseSearchTitle('Sr. AI Product Manager - Lumenfield', isRealTitle('Sr. AI Product Manager')),
    { title: 'Sr. AI Product Manager', company: 'Lumenfield', location: '' });
});

test('parseSearchTitle: with no isTitle signal, "Co - X" is the default reading', () => {
  assert.deepEqual(parseSearchTitle('Lumenfield - Sr. AI Product Manager'),
    { title: 'Sr. AI Product Manager', company: 'Lumenfield', location: '' });
});

test('isListingPage: search/listing pages are rejected, job pages are not', () => {
  assert.equal(isListingPage('https://www.jobfluent.com/jobs-barcelona/product-manager', 'Product Manager jobs for startups in Barcelona - JobFluent'), true);
  assert.equal(isListingPage('https://www.recruitco.example/jobs/product-manager', 'Product Manager ofertas de empleo en España | Recruitco'), true);
  assert.equal(isListingPage('https://www.linkedin.com/jobs/search?keywords=pm', 'Product Manager jobs | LinkedIn'), true);
  assert.equal(isListingPage('https://www.indeed.com/jobs?q=product+manager', 'product manager jobs'), true);
  assert.equal(isListingPage('https://www.jobfluent.com/jobs/product-manager-barcelona-aaaaaa', 'Product Manager at Lumenfield in Barcelona or Remote | JobFluent'), false);
  assert.equal(isListingPage('https://himalayas.app/companies/ridgeway/jobs/pm-cloud', 'Ridgeway Labs hiring Product Manager - Cloud • Remote (Work from Home) | Himalayas'), false);
  assert.equal(isListingPage('https://job-boards.greenhouse.io/northwind/jobs/7000001', 'Job Application for Product Manager at Northwind Devices'), false);
});

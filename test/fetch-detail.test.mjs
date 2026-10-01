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

const { fetchDetail, parseSearchTitle, parseSearchTitleRule, companyFromUrl, isListingPage } = await import('../lib/fetch-detail.mjs');

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
  assert.doesNotMatch(d.text, /<[a-z\/]/i, 'raw HTML in lists[].content is stripped');
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
  assert.doesNotMatch(d.text, /<[a-z\/]/i, 'raw HTML is stripped');
});

test('fetchDetail: Recruitee offer', async () => {
  const url = 'https://acme.recruitee.com/o/backend-engineer';
  const fetch = stub({ 'https://acme.recruitee.com/api/offers/backend-engineer': jsonRes(200, read('recruitee-offer.json')) });
  const d = await fetchDetail(url, { fetch });
  assert.equal(d.via, 'recruitee');
  assert.equal(d.title, 'Backend Engineer');
  assert.match(d.location, /Lisbon/);
  assert.match(d.text, /backend team/);
  assert.match(d.text, /We\u2019re hiring/, 'entities inside raw HTML are decoded');
  assert.match(d.text, /platform & APIs/);
  assert.doesNotMatch(d.text, /<[a-z\/]|&[a-z]+;/i, 'no tags or entities left');
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

// --- review fixes ---------------------------------------------------------------------------------------------

test('fetchDetail: 401/403/451 are terminal errors, 429/5xx are worth a retry', async () => {
  const url = 'https://job-boards.greenhouse.io/northwind/jobs/7000001';
  for (const status of [401, 403, 451]) {
    const d = await fetchDetail(url, { fetch: async () => jsonRes(status, '{}') });
    assert.equal(d.via, 'error'); assert.equal(d.status, status); assert.equal(d.terminal, true, `HTTP ${status}`);
  }
  for (const status of [429, 500, 503]) {
    const d = await fetchDetail(url, { fetch: async () => jsonRes(status, '{}') });
    assert.equal(d.via, 'error'); assert.equal(d.terminal, false, `HTTP ${status}`);
  }
  const net = await fetchDetail(url, { fetch: async () => { throw new Error('The operation was aborted due to timeout'); } });
  assert.equal(net.terminal, false);
});

test('fetchDetail: pages get a browser User-Agent, ATS APIs keep jobpilot\'s', async () => {
  const seen = {};
  const fetch = async (url, opts) => { seen[url] = opts.headers['User-Agent']; return url.includes('greenhouse') ? jsonRes(200, read('greenhouse-job.json')) : htmlRes(200, read('page-plain.html')); };
  await fetchDetail('https://example.com/careers/pm', { fetch });
  await fetchDetail('https://job-boards.greenhouse.io/northwind/jobs/7000001', { fetch });
  assert.match(seen['https://example.com/careers/pm'], /^Mozilla\/5\.0/);
  assert.doesNotMatch(seen['https://example.com/careers/pm'], /jobpilot/);
  assert.match(seen['https://boards-api.greenhouse.io/v1/boards/northwind/jobs/7000001?content=true'], /^jobpilot\//);
});

test('fetchDetail: Ashby .../application and Lever .../apply links still go to the API', async () => {
  const a = await fetchDetail('https://jobs.ashbyhq.com/acme-robotics/11111111-1111-1111-1111-111111111111/application',
    { fetch: stub({ 'https://api.ashbyhq.com/posting-api/job-board/acme-robotics?includeCompensation=true': jsonRes(200, read('ashby-board.json')) }) });
  assert.equal(a.via, 'ashby'); assert.equal(a.title, 'Staff Firmware Engineer');
  const l = await fetchDetail('https://jobs.lever.co/lumenfield/00000000-0000-0000-0000-000000000001/apply',
    { fetch: stub({ 'https://api.lever.co/v0/postings/lumenfield/00000000-0000-0000-0000-000000000001?mode=json': jsonRes(200, read('lever-posting.json')) }) });
  assert.equal(l.via, 'lever');
  assert.equal(companyFromUrl('https://jobs.ashbyhq.com/acme-robotics/11111111-1111-1111-1111-111111111111/application'), 'Acme Robotics');
  assert.equal(companyFromUrl('https://jobs.lever.co/lumenfield/00000000-0000-0000-0000-000000000001/apply'), 'Lumenfield');
});

test('fetchDetail: Workable remote from j.remote or workplace "remote", not only telecommuting', async () => {
  const base = JSON.parse(read('workable-job.json'));
  for (const extra of [{ remote: true }, { workplace: 'remote' }]) {
    const body = JSON.stringify({ ...base, ...extra, location: { ...base.location, telecommuting: false } });
    const d = await fetchDetail('https://apply.workable.com/northwind/j/ABCDEF1234', { fetch: async () => jsonRes(200, body) });
    assert.match(d.location, /\(remote\)/, JSON.stringify(extra));
  }
  const onsite = JSON.stringify({ ...base, location: { ...base.location, telecommuting: false } });
  const d = await fetchDetail('https://apply.workable.com/northwind/j/ABCDEF1234', { fetch: async () => jsonRes(200, onsite) });
  assert.doesNotMatch(d.location, /remote/);
});

const ldPage = (ld, body = '') => `<!doctype html><title>t</title>${[].concat(ld).map(x => `<script type="application/ld+json">${x}</script>`).join('')}<body>${body}</body>`;

test('fetchDetail: JSON-LD addressCountry as an object uses its name; TELECOMMUTE adds remote', async () => {
  const jp = { '@type': 'JobPosting', title: 'Product Manager', description: '<p>Own the roadmap.</p>', hiringOrganization: { name: 'Lumenfield' },
    jobLocation: { '@type': 'Place', address: { addressLocality: 'Madrid', addressCountry: { '@type': 'Country', name: 'Spain' } } }, jobLocationType: 'TELECOMMUTE' };
  const d = await fetchDetail('https://example.com/jobs/1', { fetch: async () => htmlRes(200, ldPage(JSON.stringify(jp))) });
  assert.equal(d.location, 'Madrid, Spain (remote)');
  assert.doesNotMatch(d.location, /object/);
  const only = await fetchDetail('https://example.com/jobs/2', { fetch: async () => htmlRes(200, ldPage(JSON.stringify({ ...jp, jobLocation: undefined }))) });
  assert.equal(only.location, 'Remote');
});

test('fetchDetail: JSON-LD that is null, a number or an array of nulls is skipped, not an error', async () => {
  const jp = JSON.stringify({ '@type': 'JobPosting', title: 'Product Manager', description: 'Own the roadmap.', hiringOrganization: 'Lumenfield' });
  const d = await fetchDetail('https://example.com/jobs/3', { fetch: async () => htmlRes(200, ldPage(['null', '[null, null]', '42', '"x"', '[null, ' + jp + ']'])) });
  assert.equal(d.via, 'page'); assert.equal(d.title, 'Product Manager'); assert.equal(d.companyHint, 'Lumenfield');
  const none = await fetchDetail('https://example.com/jobs/4', { fetch: async () => htmlRes(200, ldPage(['null', '[null]'], read('page-plain.html'))) });
  assert.equal(none.via, 'page'); assert.ok(!none.error && !none.unavailable, 'falls back to the visible text');
});

test('fetchDetail: menus, headers and footers do not count as job text', async () => {
  const chrome = `<nav>${'Home Jobs Companies Salaries Blog About Contact '.repeat(20)}</nav><header>${'Sign in Register '.repeat(20)}</header>`;
  const foot = `<footer>${'Privacy Terms Cookies Imprint '.repeat(20)}</footer><aside>${'Similar jobs '.repeat(30)}</aside>`;
  const d = await fetchDetail('https://example.com/careers/stub2', { fetch: async () => htmlRes(200, `<html><body>${chrome}<main><p>Apply now.</p></main>${foot}</body></html>`) });
  assert.equal(d.unavailable, 'too little text to read');
});

test('fetchDetail: closed postings are unavailable (English and Russian markers)', async () => {
  for (const marker of ['This job is no longer accepting applications.', 'Sorry, this position has been filled.', 'This job has expired.', 'Эта вакансия в архиве.']) {
    const d = await fetchDetail('https://example.com/careers/closed', { fetch: async () => htmlRes(200, read('page-plain.html').replace('<h1>About the role</h1>', `<h1>About the role</h1><p>${marker}</p>`)) });
    assert.equal(d.unavailable, 'posting closed', marker);
  }
});

test('fetchDetail: a redirect to a listing page or the home page is unavailable', async () => {
  const toListing = await fetchDetail('https://www.jobfluent.com/jobs/old-posting-1', { fetch: async () => ({ ...htmlRes(200, read('page-plain.html')), url: 'https://www.jobfluent.com/jobs-barcelona/product-manager' }) });
  assert.equal(toListing.unavailable, 'redirected to a listing page');
  const hops = { 'https://example.com/careers/old': { status: 301, ok: false, headers: new Headers({ location: '/' }), text: async () => '' }, 'https://example.com/': htmlRes(200, read('page-plain.html')) };
  const toHome = await fetchDetail('https://example.com/careers/old', { fetch: stub(hops) });
  assert.equal(toHome.unavailable, 'redirected to the home page');
});

test('fetchDetail: job text is capped at 20,000 characters', async () => {
  const long = `<html><body><p>${'Build things that matter. '.repeat(2000)}</p></body></html>`;
  const d = await fetchDetail('https://example.com/careers/long', { fetch: async () => htmlRes(200, long) });
  assert.ok(d.text.length <= 20000 + 60, `got ${d.text.length}`);
  assert.match(d.text, /text cut at 20000 characters/);
});

test('fetchDetail: only http(s), never loopback, link-local or private hosts (also after a redirect)', async () => {
  const never = async url => { throw new Error(`must not fetch ${url}`); };
  for (const url of ['ftp://example.com/job', 'file:///etc/passwd', 'http://localhost:8080/job', 'http://127.0.0.1/job', 'http://10.1.2.3/job',
    'http://172.20.0.1/job', 'http://192.168.1.10/job', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/job', 'http://[fe80::1]/job',
    'http://[fd00::1]/job', 'http://[::ffff:127.0.0.1]/job', 'http://printer.local/job']) {
    const d = await fetchDetail(url, { fetch: never });
    assert.equal(d.via, 'error', url); assert.equal(d.terminal, true, url); assert.match(d.error, /^refused/, url);
  }
  const redirect = await fetchDetail('https://example.com/careers/r', { fetch: stub({ 'https://example.com/careers/r': { status: 302, ok: false, headers: new Headers({ location: 'http://127.0.0.1/admin' }), text: async () => '' } }) });
  assert.equal(redirect.terminal, true); assert.match(redirect.error, /refused/);
  const dnsPrivate = await fetchDetail('https://intranet.example.com/job', { fetch: never, lookup: async () => [{ address: '10.0.0.7', family: 4 }] });
  assert.match(dnsPrivate.error, /resolves to a private address/);
  const ok = await fetchDetail('https://example.com/careers/pm', { fetch: async () => htmlRes(200, read('page-plain.html')) });
  assert.equal(ok.via, 'page'); assert.ok(ok.text);
});

test('fetchDetail: a trailing dot, IPv6 site-local, NAT64 and the 192.0.0.0/24 and 198.18.0.0/15 ranges are refused', async () => {
  const never = async url => { throw new Error(`must not fetch ${url}`); };
  for (const url of ['http://localhost./job', 'http://printer.local./job', 'http://[fec0::1]/job', 'http://[feff::1]/job',
    'http://[64:ff9b::127.0.0.1]/job', 'http://[64:ff9b::a9fe:a9fe]/job', 'http://192.0.0.8/job', 'http://198.18.0.1/job', 'http://198.19.255.254/job']) {
    const d = await fetchDetail(url, { fetch: never });
    assert.equal(d.via, 'error', url); assert.equal(d.terminal, true, url); assert.match(d.error, /^refused/, url);
  }
  const nat64 = await fetchDetail('https://nat64.example.com/job', { fetch: never, lookup: async () => [{ address: '64:ff9b::a00:7', family: 6 }] });
  assert.match(nat64.error, /resolves to a private address/, 'NAT64 of 10.0.0.7');
  const siteLocal = await fetchDetail('https://sitelocal.example.com/job', { fetch: never, lookup: async () => [{ address: 'fec0::5', family: 6 }] });
  assert.match(siteLocal.error, /resolves to a private address/);
  // public addresses next to those ranges are still fetched
  for (const url of ['http://[64:ff9b::808:808]/careers/pm', 'http://198.20.0.1/careers/pm', 'http://192.0.1.1/careers/pm']) {
    const d = await fetchDetail(url, { fetch: async () => htmlRes(200, read('page-plain.html')) });
    assert.equal(d.via, 'page', url);
  }
});

test('fetchDetail: response bodies over about 2 MB are refused (streamed and declared)', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 10);
  const streamed = await fetchDetail('https://example.com/careers/big', { fetch: async () => new Response(`<p>${big}</p>`, { status: 200 }) });
  assert.equal(streamed.via, 'error'); assert.match(streamed.error, /larger than 2 MB/); assert.equal(streamed.terminal, true);
  const declared = await fetchDetail('https://example.com/careers/big2', { fetch: async () => ({ ...htmlRes(200, ''), headers: new Headers({ 'content-length': String(5e6) }) }) });
  assert.match(declared.error, /larger than 2 MB/);
  const fine = await fetchDetail('https://example.com/careers/real', { fetch: async () => new Response(read('page-plain.html'), { status: 200 }) });
  assert.equal(fine.via, 'page'); assert.ok(fine.text.length > 600);
});

test('fetchDetail: Greenhouse content decodes &#39; and numeric entities', async () => {
  const body = JSON.stringify({ title: 'PM', location: { name: 'Remote' }, content: '&lt;p&gt;We&#39;re building caf&amp;eacute; software &amp;amp; more&lt;/p&gt;' });
  const d = await fetchDetail('https://job-boards.greenhouse.io/northwind/jobs/7000002', { fetch: async () => jsonRes(200, body) });
  assert.equal(d.text, "We're building café software & more");
});

test('parseSearchTitle: three-part dash titles use isTitle before the default', () => {
  const isReal = real => s => s.trim().toLowerCase() === real.toLowerCase();
  assert.deepEqual(parseSearchTitle('Lumenfield - Product Manager - AI', isReal('Product Manager - AI')),
    { title: 'Product Manager - AI', company: 'Lumenfield', location: '' });
  assert.deepEqual(parseSearchTitle('Product Manager - AI - Northwind', isReal('Product Manager - AI')),
    { title: 'Product Manager - AI', company: 'Northwind', location: '' });
});

test('parseSearchTitle: the colon rule needs evidence', () => {
  assert.deepEqual(parseSearchTitle('Acme - Product Manager: Platform'), { title: 'Product Manager: Platform', company: 'Acme', location: '' });
  assert.deepEqual(parseSearchTitle('Product Manager: Payments at Acme'), { title: 'Product Manager: Payments', company: 'Acme', location: '' });
  assert.deepEqual(parseSearchTitle('Kvadrat Soft: Product Owner'), { title: 'Product Owner', company: 'Kvadrat Soft', location: '' });
  assert.deepEqual(parseSearchTitle('A Very Long Company Name Group: Product Owner', s => s === 'Product Owner'),
    { title: 'Product Owner', company: 'A Very Long Company Name Group', location: '' });
  assert.equal(parseSearchTitle('A Very Long Company Name Group: Product Owner').company, '', 'five words and no signal: not trusted');
});

test('parseSearchTitle: Wellfound, Himalayas without a location, and newlines in <title>', () => {
  assert.deepEqual(parseSearchTitle('Senior Product Manager at Brightline • Remote | Wellfound'),
    { title: 'Senior Product Manager', company: 'Brightline', location: 'Remote' });
  assert.deepEqual(parseSearchTitle('Senior Product Manager at Brightline | Wellfound'),
    { title: 'Senior Product Manager', company: 'Brightline', location: '' });
  assert.deepEqual(parseSearchTitle('Senior Product Manager at Brightline'), { title: 'Senior Product Manager', company: 'Brightline', location: '' });
  assert.deepEqual(parseSearchTitle('Ridgeway Labs hiring Product Manager | Himalayas'), { title: 'Product Manager', company: 'Ridgeway Labs', location: '' });
  assert.deepEqual(parseSearchTitle('\n  Job Application for Product Manager\n    at Northwind Devices\n'),
    { title: 'Product Manager', company: 'Northwind Devices', location: '' });
  assert.equal(parseSearchTitleRule('Lumenfield - Sr. AI Product Manager').rule, 'dash');
  assert.equal(parseSearchTitleRule('Job Application for PM at Northwind').rule, 'greenhouse');
});

test('isListingPage: recruiter sites (Michael Page, Page Personnel) and "empleo(s)" titles', () => {
  assert.equal(isListingPage('https://www.michaelpage.es/jobs/product-manager', 'Product Manager | Michael Page'), true);
  assert.equal(isListingPage('https://www.pagepersonnel.fr/jobs/chef-de-projet', 'Chef de projet | Page Personnel'), true);
  assert.equal(isListingPage('https://www.example.es/ofertas/pm', '35 empleos de Product Manager en Madrid'), true);
  assert.equal(isListingPage('https://www.example.es/ofertas/pm', 'Empleo: Product Manager en Madrid'), true);
  assert.equal(isListingPage('https://www.jobfluent.com/jobs/product-manager-barcelona-aaaaaa', 'Product Manager at Lumenfield'), false, 'no generic /jobs/ rule');
});

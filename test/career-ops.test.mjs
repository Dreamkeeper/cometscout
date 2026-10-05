// career-ops source: reads a career-ops checkout (data/pipeline.md, data/scan-history.tsv) and queues its finds.
// No network: fetch is injected throughout (canned Ashby and Lever answers from test/fixtures/career-ops/).
// Every expectation in test/fixtures/career-ops/expected.json is checked below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'career-ops');
const fixture = name => fs.readFileSync(path.join(FIX, name), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-career-ops-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
process.env.COMETSCOUT_RUN_DATE = '2026-10-01';

/** A career-ops checkout in the temp folder. pipeline/tsv null = file left out. */
function careerOps(name, pipeline, tsv) {
  const dir = path.join(tmp, name), data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  if (pipeline != null) fs.writeFileSync(path.join(data, 'pipeline.md'), pipeline);
  if (tsv != null) fs.writeFileSync(path.join(data, 'scan-history.tsv'), tsv);
  return dir;
}
const fixtureDir = careerOps('career-ops', fixture('pipeline.md'), fixture('scan-history.tsv'));
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({
  timezone: 'UTC',
  sources: { career_ops: { enabled: true, path: fixtureDir, include_evaluated: false, max_per_run: 30 } },
}));

const co = await import('../sources/career-ops.mjs');
const { run, parsePipeline, parseScanHistory, collectCandidates, fairShare, urlKey, checkSetup, careerOpsDir, MAX_ATTEMPTS } = co;
const { DIRS, SETTINGS, STATE } = await import('../lib/config.mjs');
const { frontMatter, writeJob } = await import('../lib/queue.mjs');
const cfg = SETTINGS.sources.career_ops;

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body });
const htmlRes = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const NORTHWIND = 'https://jobs.ashbyhq.com/northwind/11111111-1111-1111-1111-111111111111';
const LUMENFIELD = 'https://jobs.lever.co/lumenfield/22222222-2222-2222-2222-222222222222';
const PLATFORM_PM = 'https://careers.example.net/jobs/platform-pm';
// API and page URLs fetchDetail calls for the fixture's links
const FIXTURE_FETCHES = {
  'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true': 'ashby-northwind.json',
  'https://boards-api.greenhouse.io/v1/boards/harborline/jobs/4000001?content=true': 'greenhouse-harborline.json',
  'https://api.lever.co/v0/postings/brightline/44444444-4444-4444-4444-444444444444?mode=json': 'lever-brightline.json',
  'https://api.ashbyhq.com/posting-api/job-board/cobaltworks?includeCompensation=true': 'ashby-cobaltworks.json',
  'https://api.lever.co/v0/postings/lumenfield/22222222-2222-2222-2222-222222222222?mode=json': 'lever-lumenfield.json',
  'https://careers.example.com/jobs/bare-link': 'page-plain.html',
  'https://careers.example.org/jobs/note-only': 'page-plain.html',
  'https://careers.example.net/jobs/posted-only': 'page-plain.html',
  [PLATFORM_PM]: 'page-plain.html',
};

/** fetch from a map of API/page URL -> response; anything else fails the test. Records every call. */
function fakeFetch(map) {
  const calls = [];
  const fn = async url => { calls.push(url); if (!(url in map)) throw new Error(`unexpected fetch: ${url}`); const r = map[url]; return typeof r === 'function' ? r() : r; };
  fn.calls = calls;
  return fn;
}
const fixtureFetch = () => fakeFetch(Object.fromEntries(Object.entries(FIXTURE_FETCHES).map(([u, f]) => [u, () => f.endsWith('.json') ? jsonRes(200, fixture(f)) : htmlRes(200, fixture(f))])));
const go = (extra = {}) => run({ pageDelayMs: 0, ...extra });
const inbox = () => fs.readdirSync(DIRS.inbox).filter(f => f.endsWith('.md')).map(f => ({ f, fm: frontMatter(fs.readFileSync(path.join(DIRS.inbox, f), 'utf8')), txt: fs.readFileSync(path.join(DIRS.inbox, f), 'utf8') }));
const byUrl = url => inbox().find(j => j.fm.url === url);
const state = () => JSON.parse(fs.readFileSync(STATE('career-ops.json'), 'utf8'));
const seenOf = url => state().seen[urlKey(url)];
/** Every file under dir with its size, mtime and content hash: equal snapshots mean nothing was written there. */
function snapshot(dir) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { out[p] = 'dir'; walk(p); } else { const s = fs.statSync(p); out[p] = `${s.size}:${s.mtimeMs}:${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}`; }
  } };
  walk(dir);
  return out;
}
/** Point the source at another checkout (and settings) for one test. */
function use(dir, extra = {}) { Object.assign(cfg, { path: dir, include_evaluated: false, max_per_run: 30 }, extra); }
const PAGE_TEXT = 'This is a full job description for a product role. '.repeat(20);
const page = (title, jsonLd) => `<!doctype html><html><head><title>${title}</title>${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}</head><body><main><h1>${title}</h1><p>${PAGE_TEXT}</p></main></body></html>`;
const ashbyBoard = (org, id, title, extra = {}) => jsonRes(200, JSON.stringify({ organizationName: extra.org, jobs: [{ id, title, jobUrl: `https://jobs.ashbyhq.com/${org}/${id}`, location: extra.location || 'Madrid, Spain', workplaceType: extra.workplace || 'Hybrid', isRemote: false, descriptionPlain: extra.text || PAGE_TEXT }] }));
const uuid = n => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

// --- parsers ----------------------------------------------------------------------------------------------------
test('parsePipeline reads every row shape of the real format (fixture)', () => {
  const { items, odd } = parsePipeline(fixture('pipeline.md'));
  assert.deepEqual(odd, []);
  const by = Object.fromEntries(items.map(i => [i.url, i]));
  const nw = by[NORTHWIND];
  assert.deepEqual([nw.mark, nw.company, nw.role, nw.location, nw.compensation], ['open', 'Northwind Devices', 'Senior Product Manager', 'Madrid, Spain', '70000-90000 EUR']);
  assert.deepEqual(nw.labels, { posted: '2026-09-27' });
  const hb = by['https://boards.greenhouse.io/harborline/jobs/4000001'];
  assert.deepEqual([hb.location, hb.compensation, hb.labels.trust], ['Remote (EU)', '', '60 missing_apply_url,suspicious_domain']);
  const bl = by['https://jobs.lever.co/brightline/44444444-4444-4444-4444-444444444444'];
  assert.deepEqual([bl.company, bl.role, bl.location], ['Brightline', 'Product Owner', ''], 'a labeled segment is never read as the location');
  assert.equal(bl.labels.note, 'curated shortlist');
  assert.match(bl.labels.rank, /^4\.1\/5/);
  assert.equal(by['https://careers.example.com/jobs/bare-link'].company, '');
  assert.deepEqual([by['https://careers.example.org/jobs/note-only'].company, by['https://careers.example.org/jobs/note-only'].labels.note], ['', 'forwarded by a friend']);
  assert.deepEqual([by['https://careers.example.net/jobs/posted-only'].company, by['https://careers.example.net/jobs/posted-only'].labels.posted], ['', '2026-06-18']);
  assert.equal(by['https://boards.example-ats.com/quarry/jobs/2'].mark, 'skip');
  const lf = by[LUMENFIELD];
  assert.deepEqual([lf.mark, lf.company, lf.role, lf.number, lf.score, lf.location], ['evaluated', 'Lumenfield', 'PM Connected Home', '013', '3.8/5', ''], 'a report-led row has no location cell');
  assert.equal(by[PLATFORM_PM].score, '8.5/10', 'a score in **bold**');
  assert.equal(by['https://jobs.lever.co/kestrel/66666666-6666-6666-6666-666666666666'].mark, 'discarded');
  assert.equal(by['https://boards.greenhouse.io/oldmill/jobs/4000002'].mark, 'expired');
});

test('parsePipeline: a labeled segment right after the link is never the company', () => {
  const { items } = parsePipeline('- [ ] https://a.example/1 | note: x\n- [ ] https://a.example/2 | posted: 2026-06-18\n- [ ] https://a.example/3 | trust: 80\n- [ ] https://a.example/4 | rank: 3.0/5 - meh\n');
  assert.deepEqual(items.map(i => i.company), ['', '', '', '']);
  assert.deepEqual(items.map(i => i.role), ['', '', '', '']);
  assert.deepEqual(items.map(i => Object.keys(i.labels)[0]), ['note', 'posted', 'trust', 'rank']);
});

test('parsePipeline: a "Remote: EMEA" location is not a label; an empty location cell keeps compensation in place', () => {
  const { items } = parsePipeline('- [ ] https://a.example/1 | Co | PM | Remote: EMEA\n- [ ] https://a.example/2 | Co | PM |  | 100000-120000 USD | note: x\n');
  assert.deepEqual([items[0].location, items[0].labels], ['Remote: EMEA', {}]);
  assert.deepEqual([items[1].location, items[1].compensation], ['', '100000-120000 USD']);
});

test('parsePipeline: skipped and expired [x] rows, any "skipped" first cell, and markdown escapes', () => {
  const { items } = parsePipeline([
    '- [x] #-- | https://a.example/1 | skipped (pre-screen mismatch: wrong field)',
    '- [x] #021 | https://a.example/2 | Skipped (duplicate of #020)',
    '- [x] ~~https://a.example/3 | Co | PM~~ — posting expired (liveness sweep)',
    '- [x] ~~https://a.example/4 | Co | PM',
    '- [x] #022 | https://a.example/5 | Co \\[EU\\] | PM | 4/5 | PDF ✅',
    '- [ ] https://a.example/6 | Co | PM | note: see ~~old~~ note',
  ].join('\n'));
  assert.deepEqual(items.map(i => i.mark), ['discarded', 'discarded', 'expired', 'expired', 'evaluated', 'open']);
  assert.equal(items[4].company, 'Co [EU]');
  assert.equal(items[5].company, 'Co', 'a strikethrough inside a note does not expire the row');
});

test('parsePipeline: other marks, placeholders, a BOM, CRLF and checkbox lines without a link', () => {
  const md = '﻿# Pipeline\r\n- [ ] https://a.example/1 | - | Role A\r\n* [X] https://b.example/2 | Bee | Role B\r\n- [~] https://c.example/3 | Cee | Role C\r\n- [ ] no link here | Dee | Role D\r\nprose https://e.example/5\r\n';
  const { items, odd } = parsePipeline(md);
  assert.deepEqual(items.map(i => [i.mark, i.url, i.company]), [['open', 'https://a.example/1', ''], ['evaluated', 'https://b.example/2', 'Bee'], ['other', 'https://c.example/3', 'Cee']]);
  assert.equal(items[1].score, undefined, 'no score is not an error');
  assert.equal(odd.length, 1);
});

test('parseScanHistory reads the real 12-column file; the last row per link wins', () => {
  const { rows } = parseScanHistory(fixture('scan-history.tsv'));
  const by = Object.fromEntries(rows.map(r => [r.url, r]));
  assert.equal(rows.length, 6, 'one row per link');
  assert.equal(by['https://boards.greenhouse.io/tidewater/jobs/4000003'].status, 'skipped_expired');
  const cw = by['https://jobs.ashbyhq.com/cobaltworks/77777777-7777-7777-7777-777777777777'];
  assert.deepEqual([cw.company, cw.title, cw.status, cw.location, cw.posted_at, cw.trust_score, cw.trust_flags, cw.portal, cw.first_seen],
    ['Cobalt Works', 'Product Manager, Payments', 'added', 'Barcelona, Spain', '2026-09-28', '70', 'suspicious_domain', 'ashby-api', '2026-09-29']);
  const back = parseScanHistory('url\tstatus\nhttps://x.example/1\tskipped_age\nhttps://x.example/1\tadded\n');
  assert.deepEqual(back.rows.map(r => r.status), ['added'], 'a later "added" wins too');
});

test('parseScanHistory: legacy files without a header, with 7 columns, or with the status column missing', () => {
  const seven = parseScanHistory('https://y.example/1\t2026-09-01\tlever-api\tPM\tYco\tadded\tMadrid, Spain\n');
  assert.deepEqual([seven.rows[0].company, seven.rows[0].status, seven.rows[0].location], ['Yco', 'added', 'Madrid, Spain']);
  const old = parseScanHistory('https://y.example/2\t2026-09-01\tlever-api\tPM\tZco\n');
  assert.equal(old.rows[0].status, 'added', 'no status column at all reads as added, as career-ops itself does');
  const swapped = parseScanHistory('Status\tCompany\tURL\tTitle\nADDED \tAcme\thttps://x.example/1\tPM\n\tNoStatus\thttps://x.example/2\tPM\nadded\tNo link\t\tPM\n');
  assert.deepEqual(swapped.rows.map(r => [r.url, r.company, r.title, r.status]), [['https://x.example/1', 'Acme', 'PM', 'added'], ['https://x.example/2', 'NoStatus', 'PM', '']]);
  assert.equal(swapped.odd, 1);
});

test('collectCandidates: [!], [x], skipped and expired win over [ ] for the same link; scan rows already in the pipeline are left out', () => {
  const p = parsePipeline(`- [ ] https://a.example/1 | A | R\n- [x] #2 | https://a.example/1/ | A | R | 4/5\n- [!] https://b.example/2 | B | R — SKIP: x\n- [ ] https://b.example/2#top | B | R\n- [x] ~~https://e.example/5 | E | R~~\n- [ ] https://e.example/5 | E | R\n`);
  const h = parseScanHistory('url\tstatus\nhttps://a.example/1\tadded\nhttps://c.example/3\tadded\nhttps://c.example/3\tadded\nhttps://d.example/4\tskipped_location\nhttps://e.example/5\tadded\n');
  const off = collectCandidates(p, h);
  assert.deepEqual(off.candidates.map(c => c.url), ['https://c.example/3'], 'evaluated off: only the new scan row, once');
  const on = collectCandidates(p, h, { includeEvaluated: true });
  assert.deepEqual(on.candidates.map(c => c.url), ['https://a.example/1/', 'https://c.example/3']);
  assert.match(on.candidates[0].notes, /#2, score 4\/5/);
});

test('urlKey drops the fragment and trailing slash but keeps the query', () => {
  assert.equal(urlKey('https://Boards.Example.com/x/'), 'https://boards.example.com/x');
  assert.equal(urlKey('https://a.example/j#apply'), 'https://a.example/j');
  assert.notEqual(urlKey('https://a.example/j?gh_jid=1'), urlKey('https://a.example/j?gh_jid=2'));
});

test('fairShare takes one per company in turn, up to max', () => {
  const c = (company, n) => ({ company, url: `https://x.example/${company}/${n}` });
  const list = [c('A', 1), c('A', 2), c('A', 3), c('A', 4), c('B', 1), c('C', 1), c('C', 2), { company: '', url: 'https://nocompany.example/1' }];
  assert.deepEqual(fairShare(list, 4).map(x => x.url), ['https://x.example/A/1', 'https://x.example/B/1', 'https://x.example/C/1', 'https://nocompany.example/1']);
  assert.equal(fairShare(list, 100).length, list.length);
});

test('fairShare tells companies on one ATS host apart by the board in the link', () => {
  const a1 = { company: '', url: `https://jobs.ashbyhq.com/aco/${uuid(301)}` }, a2 = { company: '', url: `https://jobs.ashbyhq.com/aco/${uuid(302)}` };
  const b1 = { company: '', url: `https://jobs.ashbyhq.com/bco/${uuid(303)}` }, named = { company: 'Aco', url: `https://jobs.ashbyhq.com/aco/${uuid(304)}` };
  assert.deepEqual(fairShare([a1, a2, b1], 2), [a1, b1], 'aco and bco are two companies, not one host');
  assert.deepEqual(fairShare([a1, named, b1], 2), [a1, b1], 'a written company and the same board slug are one company');
});

// --- the fixture --------------------------------------------------------------------------------------------------
const expected = JSON.parse(fixture('expected.json'));
/** Every expectation of one block of expected.json. */
function checkExpected(block) {
  for (const [url, want] of Object.entries(block.queued)) {
    const j = byUrl(url);
    assert.ok(j, `queued: ${url}`);
    assert.equal(j.fm.source, 'career-ops', url);
    for (const k of ['company', 'role', 'location', 'salary', 'posted']) if (k in want) assert.equal(j.fm[k], want[k], `${k} of ${url}`);
    for (const s of want.notes_include || []) assert.ok(String(j.fm.notes).includes(s), `notes of ${url} include "${s}": ${j.fm.notes}`);
    for (const s of want.source_flags_include || []) assert.ok(String(j.fm.source_flags).includes(s), `source_flags of ${url} include "${s}": ${j.fm.source_flags}`);
  }
  for (const url of Object.keys(block.not_queued)) assert.equal(byUrl(url), undefined, `not queued: ${url} (${block.not_queued[url]})`);
}

test('every expectation in expected.json holds (include_evaluated off), and nothing is written into the career-ops folder', async () => {
  use(fixtureDir);
  const before = snapshot(fixtureDir);
  const fetch = fixtureFetch();
  const r = await go({ fetch });
  assert.equal(r.ran, true);
  checkExpected(expected.include_evaluated_off);
  assert.equal(r.written, Object.keys(expected.include_evaluated_off.queued).length);
  const fetchedFor = new Set(fetch.calls);
  for (const url of [LUMENFIELD, PLATFORM_PM]) assert.ok(![...fetchedFor].some(u => u.includes(url.split('/').pop())), `${url} is not even fetched`);
  assert.match(byUrl(NORTHWIND).txt, /companion app/, 'full text from the Ashby API');
  assert.equal(seenOf(NORTHWIND).outcome, 'written');
  assert.deepEqual(snapshot(fixtureDir), before, 'the career-ops folder is untouched');

  // a second run fetches nothing: every link is remembered
  const again = fakeFetch({});
  const r2 = await go({ fetch: again });
  assert.equal(r2.written, 0);
  assert.deepEqual(again.calls, []);
  assert.deepEqual(snapshot(fixtureDir), before);
});

test('every expectation in expected.json holds with include_evaluated on, still without touching the folder', async () => {
  use(fixtureDir, { include_evaluated: true });
  const before = snapshot(fixtureDir);
  const fetch = fixtureFetch();
  const r = await go({ fetch });
  assert.equal(r.written, Object.keys(expected.include_evaluated_on.queued).length);
  assert.equal(fetch.calls.length, 2, 'only the two evaluated rows are fetched; the rest are remembered');
  checkExpected(expected.include_evaluated_on);
  checkExpected({ queued: expected.include_evaluated_off.queued, not_queued: {} });
  assert.deepEqual(snapshot(fixtureDir), before);
});

test('an evaluated item already in cometscout history is not queued twice', async () => {
  const url = 'https://jobs.lever.co/saltmarsh/33333333-3333-3333-3333-333333333333';
  writeJob({ company: 'Saltmarsh', role: 'Product Lead', url: 'https://other-board.example/saltmarsh/1', source: 'linkedin', text: 'From another source.' });
  use(careerOps('co-history', `- [x] #020 | ${url} | Saltmarsh | Product Lead | 4.1/5\n`, null), { include_evaluated: true });
  const fetch = fakeFetch({ 'https://api.lever.co/v0/postings/saltmarsh/33333333-3333-3333-3333-333333333333?mode=json': jsonRes(200, JSON.stringify({ text: 'Product Lead', descriptionPlain: PAGE_TEXT })) });
  const r = await go({ fetch });
  assert.equal(r.written, 0);
  assert.equal(byUrl(url), undefined);
  assert.equal(seenOf(url).outcome, 'duplicate');
});

// --- gates --------------------------------------------------------------------------------------------------------
test('gates run before any fetch: an excluded company is never fetched', async () => {
  const url = `https://jobs.ashbyhq.com/gatedco/${uuid(1)}`;
  use(careerOps('co-gate-before', `- [ ] ${url} | Gatedco | Product Manager\n`, null));
  SETTINGS.gates = { companies: { exclude: ['Gatedco'] } };
  try {
    const fetch = fakeFetch({});
    const r = await go({ fetch });
    assert.deepEqual(fetch.calls, []);
    assert.equal(r.written, 0);
    assert.deepEqual([seenOf(url).outcome, seenOf(url).gate], ['gated', 'company']);
  } finally { delete SETTINGS.gates; }
});

test('gates run again on the fetched text and location; their flags reach the job', async () => {
  const berlin = `https://jobs.ashbyhq.com/eastco/${uuid(2)}`, madrid = `https://jobs.ashbyhq.com/westco/${uuid(3)}`;
  use(careerOps('co-gate-after', `- [ ] ${berlin} | Eastco | Product Manager Berlin\n- [ ] ${madrid} | Westco | Product Manager Madrid\n`, null));
  SETTINGS.gates = { onsite_countries: ['ES'], user: { work_authorization: ['ES'] }, sponsorship_refusal_phrases: ['no visa sponsorship'] };
  try {
    const fetch = fakeFetch({
      'https://api.ashbyhq.com/posting-api/job-board/eastco?includeCompensation=true': ashbyBoard('eastco', uuid(2), 'Product Manager Berlin', { location: 'Berlin, Germany', workplace: 'OnSite' }),
      'https://api.ashbyhq.com/posting-api/job-board/westco?includeCompensation=true': ashbyBoard('westco', uuid(3), 'Product Manager Madrid', { location: 'Remote, Spain', workplace: 'Remote', text: `${PAGE_TEXT} There is no visa sponsorship for this role.` }),
    });
    const r = await go({ fetch });
    assert.equal(fetch.calls.length, 2);
    assert.equal(byUrl(berlin), undefined, 'on-site in Germany only: geo gate');
    assert.deepEqual([seenOf(berlin).outcome, seenOf(berlin).gate], ['gated', 'geo']);
    const m = byUrl(madrid);
    assert.ok(m, 'remote in Spain passes');
    assert.match(m.fm.gate_flags, /sponsorship|authoriz/i);
    assert.equal(r.written, 1);
  } finally { delete SETTINGS.gates; }
});

// --- missing or odd fields: flag, never reject ----------------------------------------------------------------------
test('a line with only a link is still queued: company from the posting, role from the posting, both flagged', async () => {
  const hinted = 'https://careers.example.com/jobs/hinted-role', bare = 'https://careers.example.net/jobs/opaque-role';
  use(careerOps('co-missing', `- [ ] ${hinted}\n- [ ] ${bare} | | \n`, null));
  const fetch = fakeFetch({
    [hinted]: htmlRes(200, page('Careers', { '@type': 'JobPosting', title: 'Platform Product Manager', description: PAGE_TEXT, hiringOrganization: { name: 'Hintco' } })),
    [bare]: htmlRes(200, page('Data Product Owner - apply now')),
  });
  const r = await go({ fetch });
  assert.equal(r.written, 2);
  const h = byUrl(hinted);
  assert.equal(h.fm.company, 'Hintco');
  assert.equal(h.fm.role, 'Platform Product Manager');
  assert.match(h.fm.source_flags, /company not in career-ops data/);
  assert.match(h.fm.source_flags, /role not in career-ops data/);
  const b = byUrl(bare);
  assert.equal(b.fm.company, 'Unknown', 'never guessed from the title punctuation');
  assert.equal(b.fm.role, 'Data Product Owner - apply now');
  assert.match(b.fm.source_flags, /company unknown/);
});

test('a scan row with no company uses the ATS board slug, flagged; a row with no status is not taken', async () => {
  const url = `https://jobs.ashbyhq.com/slugco/${uuid(5)}`, noStatus = `https://jobs.ashbyhq.com/slugco/${uuid(6)}`;
  use(careerOps('co-slug', '# Pipeline\n', `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n${url}\t2026-09-30\tashby-api\tGrowth PM\t\tadded\n${noStatus}\t\t\tGrowth PM 2\tSlugco\t\n`));
  const fetch = fakeFetch({ 'https://api.ashbyhq.com/posting-api/job-board/slugco?includeCompensation=true': ashbyBoard('slugco', uuid(5), 'Growth PM') });
  const r = await go({ fetch });
  assert.equal(r.written, 1);
  const j = byUrl(url);
  assert.equal(j.fm.company, 'Slugco');
  assert.match(j.fm.source_flags, /company not in career-ops data/);
  assert.match(j.fm.notes, /scan history \(ashby-api, first seen 2026-09-30\)/);
  assert.equal(byUrl(noStatus), undefined);
});

test('a line with an unknown mark is reported, not queued, and keeps its scan row out', async () => {
  const url = 'https://careers.example.org/jobs/unknown-mark';
  use(careerOps('co-mark', `- [~] ${url} | Markco | PM\n`, `url\tstatus\n${url}\tadded\n`));
  const fetch = fakeFetch({});
  const r = await go({ fetch });
  assert.equal(r.written, 0);
  assert.equal(r.counts.other, 1);
  assert.deepEqual(fetch.calls, []);
});

// --- fetch outcomes ---------------------------------------------------------------------------------------------------
test('a closed posting is skipped and remembered', async () => {
  const url = `https://jobs.lever.co/goneco/${uuid(7)}`;
  use(careerOps('co-gone', `- [ ] ${url} | Goneco | PM\n`, null));
  await go({ fetch: fakeFetch({ [`https://api.lever.co/v0/postings/goneco/${uuid(7)}?mode=json`]: htmlRes(404, '') }) });
  assert.equal(byUrl(url), undefined);
  assert.equal(seenOf(url).outcome, 'unavailable');
});

test('a listing-page link is skipped without a fetch; a role named "Jobs in ..." is not', async () => {
  const listing = 'https://www.linkedin.com/jobs/search/?keywords=pm', role = `https://jobs.ashbyhq.com/listco/${uuid(8)}`;
  use(careerOps('co-listing', `- [ ] ${listing} | Listco | PM\n- [ ] ${role} | Listco | Head of Jobs in Marketplaces\n`, null));
  const fetch = fakeFetch({ 'https://api.ashbyhq.com/posting-api/job-board/listco?includeCompensation=true': ashbyBoard('listco', uuid(8), 'Head of Jobs in Marketplaces') });
  await go({ fetch });
  assert.equal(seenOf(listing).outcome, 'listing-page');
  assert.ok(byUrl(role));
});

test(`a link that keeps failing is tried ${MAX_ATTEMPTS} runs, then queued without text when company and role are known`, async () => {
  const url = 'https://careers.example.com/jobs/flaky';
  use(careerOps('co-retry', `- [ ] ${url} | Flakyco | Product Manager Flaky\n`, null));
  const down = fakeFetch({ [url]: () => { throw new Error('network down'); } });
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    await go({ fetch: down });
    assert.deepEqual([seenOf(url).outcome, seenOf(url).attempts], ['retry', i]);
    assert.match(seenOf(url).last_error, /network down/);
    assert.equal(byUrl(url), undefined);
  }
  await go({ fetch: down });
  assert.equal(down.calls.length, MAX_ATTEMPTS);
  assert.deepEqual([seenOf(url).outcome, seenOf(url).attempts], ['written-no-text', MAX_ATTEMPTS]);
  const j = byUrl(url);
  assert.equal(j.fm.full_text, 'missing');
  assert.equal(j.fm.company, 'Flakyco');
  await go({ fetch: down });
  assert.equal(down.calls.length, MAX_ATTEMPTS, 'never tried again');
});

test('403 is final at once; with no company anywhere the link is reported as unreadable, not queued', async () => {
  const url = 'https://careers.example.com/jobs/forbidden';
  use(careerOps('co-403', `- [ ] ${url} | | Product Manager Forbidden\n`, null));
  const fetch = fakeFetch({ [url]: htmlRes(403, '') });
  await go({ fetch });
  assert.deepEqual([seenOf(url).outcome, seenOf(url).attempts], ['unreadable', 1]);
  assert.equal(byUrl(url), undefined);
});

test('one failing candidate never stops the run; state is saved and it is given up after the attempt limit', async () => {
  const bad = `https://jobs.ashbyhq.com/crashco/${uuid(9)}`, good = `https://jobs.ashbyhq.com/fineco/${uuid(10)}`;
  use(careerOps('co-crash', `- [ ] ${bad} | Crashco | PM Crash\n- [ ] ${good} | Fineco | PM Fine\n`, null));
  let goodCalls = 0;
  const fetchDetail = async url => {
    if (url === bad) throw new Error('parser blew up');
    goodCalls++;
    return { via: 'ashby', title: 'PM Fine', location: 'Madrid, Spain', text: PAGE_TEXT };
  };
  await go({ fetchDetail });
  assert.ok(byUrl(good), 'the next candidate is still queued');
  assert.deepEqual([seenOf(bad).outcome, seenOf(bad).attempts], ['retry', 1]);
  for (let i = 2; i <= MAX_ATTEMPTS; i++) await go({ fetchDetail });
  assert.deepEqual([seenOf(bad).outcome, seenOf(bad).attempts], ['failed', MAX_ATTEMPTS]);
  assert.equal(goodCalls, 1);
});

test('page fetches are spaced out; ATS API calls are not', async () => {
  const p1 = 'https://careers.example.com/jobs/space-1', p2 = 'https://careers.example.com/jobs/space-2', ats = `https://jobs.ashbyhq.com/spaceco/${uuid(13)}`;
  use(careerOps('co-space', `- [ ] ${p1} | Spaceco | PM One\n- [ ] ${ats} | Spaceco | PM Two\n- [ ] ${p2} | Spaceco | PM Three\n`, null));
  const waits = [];
  const fetch = fakeFetch({ [p1]: htmlRes(200, page('PM One')), [p2]: htmlRes(200, page('PM Three')),
    'https://api.ashbyhq.com/posting-api/job-board/spaceco?includeCompensation=true': ashbyBoard('spaceco', uuid(13), 'PM Two') });
  const r = await run({ fetch, pageDelayMs: 60000, sleep: async ms => { waits.push(ms); } });
  assert.equal(r.written, 3);
  assert.equal(waits.length, 1, 'one wait: before the second page, none for the first page or the API call');
  assert.ok(waits[0] > 50000 && waits[0] <= 60000);
});

// --- max_per_run ------------------------------------------------------------------------------------------------------
test('max_per_run is shared out one per company in turn; the rest wait for the next run', async () => {
  const link = (org, n) => `https://jobs.ashbyhq.com/${org}/${uuid(100 + n)}`;
  const lines = [1, 2, 3, 4, 5].map(n => `- [ ] ${link('bigco', n)} | Bigco | Role ${n}`)
    .concat([`- [ ] ${link('smallco', 6)} | Smallco | Role 6`, `- [ ] ${link('tinyco', 7)} | Tinyco | Role 7`]);
  use(careerOps('co-fair', `${lines.join('\n')}\n`, null), { max_per_run: 3 });
  const fetchDetail = async url => ({ via: 'ashby', title: '', location: '', text: `${PAGE_TEXT} ${url}` });
  const r1 = await go({ fetchDetail });
  assert.equal(r1.written, 3);
  assert.equal(r1.held, 4);
  assert.ok(byUrl(link('bigco', 1)) && byUrl(link('smallco', 6)) && byUrl(link('tinyco', 7)), 'one of each company first');
  assert.equal(byUrl(link('bigco', 2)), undefined);
  const r2 = await go({ fetchDetail });
  assert.equal(r2.written, 3);
  const r3 = await go({ fetchDetail });
  assert.equal(r3.written, 1);
  assert.equal(r3.held, 0);
});

test('a broken max_per_run falls back to 30 instead of turning the limit off', async () => {
  const lines = Array.from({ length: 32 }, (_, n) => `- [ ] https://jobs.ashbyhq.com/manyco${n}/${uuid(200 + n)} | Manyco${n} | Role`);
  use(careerOps('co-many', `${lines.join('\n')}\n`, null), { max_per_run: 'lots' });
  const r = await go({ fetchDetail: async url => ({ via: 'ashby', title: 'Role', location: '', text: `${PAGE_TEXT} ${url}` }) });
  assert.equal(r.written, 30);
  assert.equal(r.held, 2);
});

// --- location, compensation, labels ------------------------------------------------------------------------------
test('the location from the pipeline and from scan history reaches the gates before any fetch', async () => {
  const pipe = `https://jobs.ashbyhq.com/onsiteco/${uuid(400)}`, scan = `https://jobs.ashbyhq.com/scanonsite/${uuid(401)}`;
  use(careerOps('co-loc-gate', `- [ ] ${pipe} | Onsiteco | Product Manager Onsite | On-site, Berlin, Germany\n`,
    `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n${scan}\t2026-09-30\tashby-api\tProduct Manager Scan\tScanonsite\tadded\tOn-site, Munich, Germany\n`));
  SETTINGS.gates = { onsite_countries: ['ES'] };
  try {
    const fetch = fakeFetch({});
    await go({ fetch });
    assert.deepEqual(fetch.calls, [], 'rejected on the location alone, no fetch');
    assert.deepEqual([seenOf(pipe).outcome, seenOf(pipe).gate], ['gated', 'geo']);
    assert.deepEqual([seenOf(scan).outcome, seenOf(scan).gate], ['gated', 'geo']);
  } finally { delete SETTINGS.gates; }
});

test('location and compensation reach the job on both paths: fetched (page without a location) and given up', async () => {
  const fetched = 'https://careers.example.com/jobs/loc-fetched', flaky = 'https://careers.example.com/jobs/loc-flaky';
  use(careerOps('co-loc-write', `- [ ] ${fetched} | Locco | PM Fetched | Valencia, Spain | 60000-70000 EUR\n- [ ] ${flaky} | Locco | PM Flaky | Remote (EU) |  | posted: 2026-09-01\n`, null));
  const fetch = fakeFetch({ [fetched]: htmlRes(200, page('PM Fetched')), [flaky]: htmlRes(403, '') });
  await go({ fetch });
  const f = byUrl(fetched);
  assert.deepEqual([f.fm.location, f.fm.salary], ['Valencia, Spain', '60000-70000 EUR']);
  const g = byUrl(flaky);
  assert.equal(g.fm.full_text, 'missing');
  assert.deepEqual([g.fm.location, g.fm.salary, g.fm.posted], ['Remote (EU)', undefined, '2026-09-01']);
});

// --- applications.json ----------------------------------------------------------------------------------------------
test('a candidate already in applications.json (same link, or same company and role) is skipped as applied-elsewhere', async () => {
  const byFile = `https://jobs.ashbyhq.com/appco/${uuid(500)}`, byField = `https://jobs.ashbyhq.com/appco/${uuid(501)}?utm_source=x`, byRole = `https://jobs.ashbyhq.com/appco/${uuid(502)}`;
  const afterFetch = 'https://careers.example.com/jobs/app-after-fetch', fresh = `https://jobs.ashbyhq.com/appco/${uuid(503)}`;
  fs.writeFileSync(path.join(DIRS.decoded, '2026-09-01--appco--pm-file.md'), `---\ncompany: "Appco"\nrole: "PM File"\nurl: "${byFile}"\nfound: 2026-09-01\n---\n\n# Appco - PM File\n\ntext\n`);
  fs.writeFileSync(STATE('applications.json'), JSON.stringify({
    '2026-09-01--appco--pm-file.md': { company: 'Appco', role: 'PM File', status: 'applied', events: [] },
    'manual:appco|pm field': { company: 'Appco', role: 'PM Field', url: `https://jobs.ashbyhq.com/appco/${uuid(501)}`, status: 'interview', events: [] },
    'manual:appco|senior pm': { company: 'APPCO', role: 'Senior PM!', status: 'applied', events: [] },
    'manual:hintco|platform pm': { company: 'Hintapp', role: 'Platform PM App', status: 'applied', events: [] },
  }));
  try {
    use(careerOps('co-applied', [`- [ ] ${byFile} | Appco | PM File Renamed`, `- [ ] ${byField} | Appco | PM Field`, `- [ ] ${byRole} | Appco | Senior PM`,
      `- [ ] ${afterFetch}`, `- [ ] ${fresh} | Appco | PM Fresh`].join('\n') + '\n', null));
    const fetch = fakeFetch({
      'https://api.ashbyhq.com/posting-api/job-board/appco?includeCompensation=true': ashbyBoard('appco', uuid(503), 'PM Fresh'),
      [afterFetch]: htmlRes(200, page('Careers', { '@type': 'JobPosting', title: 'Platform PM App', description: PAGE_TEXT, hiringOrganization: { name: 'Hintapp' } })),
    });
    const r = await go({ fetch });
    for (const url of [byFile, byField, byRole, afterFetch]) assert.equal(seenOf(url).outcome, 'applied-elsewhere', url);
    assert.equal(fetch.calls.filter(u => u.includes('appco')).length, 1, 'only the fresh one is fetched; the first three are known before any fetch');
    assert.equal(r.written, 1);
    assert.ok(byUrl(fresh));
  } finally { fs.rmSync(STATE('applications.json'), { force: true }); }
});

test('a broken applications.json stops the run before anything is marked', async () => {
  const url = `https://jobs.ashbyhq.com/brokenapps/${uuid(504)}`;
  use(careerOps('co-broken-apps', `- [ ] ${url} | Brokenapps | PM\n`, null));
  fs.writeFileSync(STATE('applications.json'), '{ not json');
  try {
    const r = await go({ fetchDetail: async () => { throw new Error('must not fetch'); } });
    assert.equal(r.ran, false);
    assert.equal(seenOf(url), undefined);
  } finally { fs.rmSync(STATE('applications.json'), { force: true }); }
});

// --- gate rejects are re-checked without a fetch ------------------------------------------------------------------
test('a link gated before the fetch is freed by a settings change on the next run; one gated after the fetch is not refetched', async () => {
  const before = `https://jobs.ashbyhq.com/regateco/${uuid(600)}`, after = `https://jobs.ashbyhq.com/regatelate/${uuid(601)}`;
  use(careerOps('co-regate', `- [ ] ${before} | Regateco | Product Manager Regate\n- [ ] ${after} | Regatelate | Product Manager Late\n`, null));
  const fetch = fakeFetch({
    'https://api.ashbyhq.com/posting-api/job-board/regateco?includeCompensation=true': ashbyBoard('regateco', uuid(600), 'Product Manager Regate'),
    'https://api.ashbyhq.com/posting-api/job-board/regatelate?includeCompensation=true': ashbyBoard('regatelate', uuid(601), 'Product Manager Late', { location: 'Berlin, Germany', workplace: 'OnSite' }),
  });
  SETTINGS.gates = { companies: { exclude: ['Regateco'] }, onsite_countries: ['ES'] };
  try {
    await go({ fetch });
    assert.deepEqual([seenOf(before).outcome, seenOf(before).gate], ['gated', 'company']);
    assert.deepEqual([seenOf(after).outcome, seenOf(after).gate], ['gated', 'geo']);
    assert.equal(fetch.calls.length, 1);
    await go({ fetch });
    assert.equal(fetch.calls.length, 1, 'still gated: no fetch for either');
    SETTINGS.gates = { onsite_countries: ['ES'] };   // the company is no longer excluded
    const r = await go({ fetch });
    assert.equal(r.written, 1);
    assert.ok(byUrl(before), 'freed without anyone touching the state file');
    assert.equal(fetch.calls.length, 2, 'the link gated after its fetch is not fetched again');
    assert.equal(seenOf(after).outcome, 'gated');
  } finally { delete SETTINGS.gates; }
});

test('"queued as Unknown" counts only jobs actually written', async () => {
  const url = 'https://careers.example.com/jobs/unknown-dup';
  writeJob({ company: 'Someone', role: 'Something', url, source: 'linkedin', text: 'From another source.' });
  use(careerOps('co-unknown-dup', `- [ ] ${url}\n`, null));
  const r = await go({ fetch: fakeFetch({ [url]: htmlRes(200, page('Plain Page Role')) }) });
  assert.equal(r.written, 0);
  assert.equal(r.unknown, 0);
  assert.equal(seenOf(url).outcome, 'duplicate');
});

// --- file names -------------------------------------------------------------------------------------------------------
test('pipeline_file and scan_history_file point at other files, relative to path or absolute', async () => {
  const dir = careerOps('co-files', null, null);
  fs.mkdirSync(path.join(dir, 'inbox'));
  const pipeUrl = `https://jobs.ashbyhq.com/fileco/${uuid(700)}`, scanUrl = `https://jobs.ashbyhq.com/filescan/${uuid(701)}`;
  fs.writeFileSync(path.join(dir, 'inbox', 'pipe.md'), `- [ ] ${pipeUrl} | Fileco | PM Files\n`);
  const absHistory = path.join(tmp, 'elsewhere-history.tsv');
  fs.writeFileSync(absHistory, `url\tstatus\ttitle\tcompany\n${scanUrl}\tadded\tPM Scan Files\tFilescan\n`);
  use(dir, { pipeline_file: 'inbox/pipe.md', scan_history_file: absHistory });
  try {
    assert.equal(checkSetup(cfg).good, true, 'doctor reads the same file');
    const r = await go({ fetchDetail: async url => ({ via: 'ashby', title: '', location: '', text: `${PAGE_TEXT} ${url}` }) });
    assert.equal(r.written, 2);
    assert.ok(byUrl(pipeUrl) && byUrl(scanUrl));
    assert.match(checkSetup({ path: dir }).fix, /no data\/pipeline\.md/, 'the default name is still data/pipeline.md');
  } finally { delete cfg.pipeline_file; delete cfg.scan_history_file; }
});

// --- runs that do nothing -----------------------------------------------------------------------------------------------
test('--dry-run fetches but writes nothing: no job, no state', async () => {
  const url = `https://jobs.ashbyhq.com/dryco/${uuid(11)}`;
  use(careerOps('co-dry', `- [ ] ${url} | Dryco | PM Dry\n`, null));
  const stateBefore = fs.readFileSync(STATE('career-ops.json'), 'utf8'), inboxBefore = inbox().length;
  const r = await go({ dryRun: true, fetchDetail: async () => ({ via: 'ashby', title: 'PM Dry', location: '', text: PAGE_TEXT }) });
  assert.equal(r.written, 1, 'reports what it would write');
  assert.equal(inbox().length, inboxBefore);
  assert.equal(fs.readFileSync(STATE('career-ops.json'), 'utf8'), stateBefore);
});

test('disabled, no path, or no pipeline.md: nothing is read, fetched or marked', async () => {
  const fetchDetail = async () => { throw new Error('must not fetch'); };
  const stateBefore = fs.readFileSync(STATE('career-ops.json'), 'utf8');
  use(fixtureDir, { enabled: false });
  assert.equal((await go({ fetchDetail })).ran, false);
  use('', { enabled: true });
  assert.equal((await go({ fetchDetail })).ran, false);
  use(careerOps('co-nopipe', null, `url\tstatus\nhttps://x.example/nopipe\tadded\n`));
  assert.equal((await go({ fetchDetail })).ran, false, 'scan rows cannot be checked against a missing pipeline');
  assert.equal(fs.readFileSync(STATE('career-ops.json'), 'utf8'), stateBefore);
  cfg.enabled = true;
});

test('a pipeline.md that exists but cannot be read stops the run before anything is marked', async () => {
  const dir = careerOps('co-unreadable', null, `url\tstatus\nhttps://x.example/unreadable\tadded\n`);
  fs.mkdirSync(path.join(dir, 'data', 'pipeline.md'));   // a folder in its place: reading it fails with EISDIR
  use(dir);
  const stateBefore = fs.readFileSync(STATE('career-ops.json'), 'utf8');
  const r = await go({ fetchDetail: async () => { throw new Error('must not fetch'); } });
  assert.equal(r.ran, false);
  assert.equal(fs.readFileSync(STATE('career-ops.json'), 'utf8'), stateBefore);
  assert.match(checkSetup({ path: dir }).fix, /cannot read/);
});

test('a link that left career-ops is forgotten after 120 days; one still listed is kept', async () => {
  const listed = `https://jobs.ashbyhq.com/keepco/${uuid(12)}`;
  use(careerOps('co-prune', `- [!] ${listed} | Keepco | PM — SKIP: no\n`, null));
  const s = state();
  const old = new Date(Date.now() - 200 * 864e5).toISOString();
  s.seen[urlKey(listed)] = { at: old, outcome: 'written' };
  s.seen['https://gone.example/job'] = { at: old, outcome: 'written' };
  s.seen['https://recent.example/job'] = { at: new Date().toISOString(), outcome: 'written' };
  fs.writeFileSync(STATE('career-ops.json'), JSON.stringify(s));
  await go({ fetchDetail: async () => { throw new Error('must not fetch'); } });
  const after = state().seen;
  assert.ok(after[urlKey(listed)]);
  assert.equal(after['https://gone.example/job'], undefined);
  assert.ok(after['https://recent.example/job']);
});

test('--dry-run leaves a broken state file as it is and starts from an empty state in memory', async () => {
  fs.writeFileSync(STATE('career-ops.json'), '{ broken for dry run');
  const asideBefore = fs.readdirSync(DIRS.state).filter(f => f.startsWith('career-ops.json.broken-')).length;
  const url = `https://jobs.ashbyhq.com/drybroken/${uuid(800)}`;
  use(careerOps('co-dry-broken', `- [ ] ${url} | Drybroken | PM\n`, null));
  const r = await go({ dryRun: true, fetchDetail: async () => ({ via: 'ashby', title: 'PM', location: '', text: PAGE_TEXT }) });
  assert.equal(r.written, 1);
  assert.equal(fs.readFileSync(STATE('career-ops.json'), 'utf8'), '{ broken for dry run', 'not renamed, not rewritten');
  assert.equal(fs.readdirSync(DIRS.state).filter(f => f.startsWith('career-ops.json.broken-')).length, asideBefore);
  assert.ok(r.report.some(l => /dry run.*empty state/i.test(l)), r.report.join('\n'));
});

test('a broken state file is kept aside, not silently replaced', async () => {
  fs.writeFileSync(STATE('career-ops.json'), '{ not json');
  use(careerOps('co-broken-state', '# Pipeline\n', null));
  await go({ fetchDetail: async () => { throw new Error('must not fetch'); } });
  assert.ok(fs.readdirSync(DIRS.state).some(f => f.startsWith('career-ops.json.broken-')));
  assert.deepEqual(state().seen, {});
});

// --- doctor -------------------------------------------------------------------------------------------------------------
test('doctor check: path set, folder exists, data/pipeline.md readable', () => {
  assert.equal(checkSetup({ enabled: true, path: fixtureDir }).good, true);
  assert.match(checkSetup({ enabled: true }).fix, /set sources\.career_ops\.path/);
  assert.match(checkSetup({ enabled: true, path: path.join(tmp, 'nowhere') }).fix, /does not exist/);
  assert.match(checkSetup({ enabled: true, path: careerOps('co-empty', null, null) }).fix, /no data\/pipeline\.md/);
  assert.equal(careerOpsDir({ path: '~/career-ops' }), path.join(os.homedir(), 'career-ops'));
});

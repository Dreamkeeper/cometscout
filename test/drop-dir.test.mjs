// drop-dir: external tools hand jobs to jobpilot by dropping files into a folder.
// No network: fetchDetail's fetch is injected throughout. Every _expect in test/fixtures/openclaw/synthesis-queue.json
// is checked below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const read = (...rel) => fs.readFileSync(path.join(FIX, ...rel), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-dropdir-'));
const dropDir = path.join(tmp, 'drop');
fs.mkdirSync(dropDir, { recursive: true });
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
process.env.JOBPILOT_RUN_DATE = '2026-10-01';
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({
  timezone: 'UTC',
  sources: { drop_dir: { enabled: true, dir: dropDir, settle_sec: 2 } },
}));

const { run, handleJobFile, handleQueueFile } = await import('../sources/drop-dir.mjs');
const { DIRS } = await import('../lib/config.mjs');
const { frontMatter } = await import('../lib/queue.mjs');

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body });
const htmlRes = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const old = () => { const t = Date.now() / 1000 - 3600; return [t, t]; };   // well past settle_sec

function inboxJobs() {
  return fs.readdirSync(DIRS.inbox).filter(f => f.endsWith('.md')).map(f => frontMatter(fs.readFileSync(path.join(DIRS.inbox, f), 'utf8')));
}
function byUrl(url) { return inboxJobs().find(fm => fm.url === url); }

test('a file younger than settle_sec is left alone', async () => {
  const file = path.join(dropDir, 'fresh.queue.json');
  fs.writeFileSync(file, JSON.stringify({ candidates: [] }));
  const r = await run({ fetch: async () => { throw new Error('must not fetch'); } });
  assert.ok(r.report.some(l => l.startsWith('fresh.queue.json: too new')));
  assert.ok(fs.existsSync(file), 'left in the drop dir');
  fs.rmSync(file);
});

test('a job file in jobpilot\'s own format is validated, queued and moved to processed/', async () => {
  const file = path.join(dropDir, 'good-job.md');
  fs.writeFileSync(file, '---\ncompany: "Acme Robotics"\nrole: "Firmware Engineer"\nurl: "https://acme.example/jobs/1"\nsource: "openclaw"\nlocation: "Berlin"\n---\n\n# Acme Robotics - Firmware Engineer\n\nBuild embedded firmware for our robots.\n');
  fs.utimesSync(file, ...old());
  const r = handleJobFile(file, { processedDir: path.join(dropDir, 'processed') });
  assert.equal(r.written, true);
  assert.ok(!fs.existsSync(file), 'moved out of the drop dir');
  assert.ok(fs.existsSync(path.join(dropDir, 'processed', 'good-job.md')));
  const job = byUrl('https://acme.example/jobs/1');
  assert.equal(job.company, 'Acme Robotics');
  assert.equal(job.role, 'Firmware Engineer');
  assert.equal(job.source, 'openclaw');
});

test('a job file missing company/role is left in place, not queued', async () => {
  const file = path.join(dropDir, 'bad-job.md');
  fs.writeFileSync(file, '---\nrole: "Mystery Role"\nurl: "https://acme.example/jobs/2"\n---\n\nsome text\n');
  fs.utimesSync(file, ...old());
  const r = handleJobFile(file, { processedDir: path.join(dropDir, 'processed') });
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(file), 'left in place');
  assert.equal(byUrl('https://acme.example/jobs/2'), undefined);
  fs.rmSync(file);
});

test('every _expect in the openclaw synthesis-queue fixture holds', async () => {
  const file = path.join(dropDir, 'openclaw.queue.json');
  fs.writeFileSync(file, read('openclaw', 'synthesis-queue.json'));
  fs.utimesSync(file, ...old());

  const fetchMap = {
    'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/7000001?content=true': jsonRes(200, read('fetch-detail', 'greenhouse-job.json')),
    'https://www.jobfluent.com/jobs/product-manager-barcelona-aaaaaa': htmlRes(200, read('fetch-detail', 'page-jsonld.html')),
    'https://himalayas.app/companies/ridgeway/jobs/pm-cloud': htmlRes(200, read('fetch-detail', 'page-plain.html')),
    'https://remotive.com/remote-jobs/product/lead-pm-ai-1': htmlRes(200, read('fetch-detail', 'page-plain.html')),
    'https://www.workatastartup.com/jobs/1': htmlRes(200, read('fetch-detail', 'page-plain.html')),
    'https://weworkremotely.com/remote-jobs/kvadrat-product-owner': htmlRes(200, read('fetch-detail', 'page-plain.html')),
    'https://api.lever.co/v0/postings/lumenfield/00000000-0000-0000-0000-000000000001?mode=json': jsonRes(200, read('fetch-detail', 'lever-posting.json')),
    'https://apply.workable.com/api/v2/accounts/northwind/jobs/ABCDEF1234': jsonRes(200, read('fetch-detail', 'workable-job.json')),
  };
  const fetch = async url => { if (!(url in fetchMap)) throw new Error(`unexpected fetch (listing pages must not be fetched): ${url}`); return fetchMap[url]; };

  const r = await handleQueueFile(file, { processedDir: path.join(dropDir, 'processed'), fetch, seen: {} });
  assert.equal(r.allDone, true);
  assert.ok(!fs.existsSync(file), 'moved to processed once every candidate has an answer');
  assert.equal(r.written, 8, 'the 2 listing pages are skipped, the other 8 are written');

  // 1: Job Application for Product Manager at Northwind Devices (Greenhouse)
  let j = byUrl('https://job-boards.greenhouse.io/northwind/jobs/7000001');
  assert.equal(j.company, 'Northwind Devices');

  // 2: Product Manager at Lumenfield in Barcelona or Remote | JobFluent
  j = byUrl('https://www.jobfluent.com/jobs/product-manager-barcelona-aaaaaa');
  assert.equal(j.company, 'Lumenfield');
  assert.equal(j.location, 'Barcelona or Remote');

  // 3 and 4: listing pages, never queued
  assert.equal(byUrl('https://www.jobfluent.com/jobs-barcelona/product-manager'), undefined);
  assert.equal(byUrl('https://www.recruitco.example/jobs/product-manager'), undefined);

  // 5: Ridgeway Labs hiring Product Manager - Cloud (Himalayas)
  j = byUrl('https://himalayas.app/companies/ridgeway/jobs/pm-cloud');
  assert.equal(j.company, 'Ridgeway Labs');
  assert.equal(j.role, 'Product Manager - Cloud');

  // 6: [Hiring] Lead Product Manager, AI @Quarry Systems (Remotive)
  j = byUrl('https://remotive.com/remote-jobs/product/lead-pm-ai-1');
  assert.equal(j.company, 'Quarry Systems');

  // 7: Staff Product Manager at Brightline | Y Combinator's Work at a Startup
  j = byUrl('https://www.workatastartup.com/jobs/1');
  assert.equal(j.company, 'Brightline');

  // 8: Kvadrat Soft: Product Owner (We Work Remotely)
  j = byUrl('https://weworkremotely.com/remote-jobs/kvadrat-product-owner');
  assert.equal(j.company, 'Kvadrat Soft');

  // 9: Lumenfield - Sr. AI Product Manager (Lever; company resolved via the fetched real title or the Lever slug)
  j = byUrl('https://jobs.lever.co/lumenfield/00000000-0000-0000-0000-000000000001');
  assert.equal(j.company, 'Lumenfield');

  // 10: Product Manager - AI - Northwind (Workable)
  j = byUrl('https://apply.workable.com/northwind/j/ABCDEF1234');
  assert.equal(j.company, 'Northwind');
  assert.equal(j.role, 'Product Manager - AI');
});

test('a candidate with neither a company nor any text is skipped as unidentifiable', async () => {
  const file = path.join(dropDir, 'unidentifiable.queue.json');
  const url = 'https://example.com/careers/opaque-listing';
  fs.writeFileSync(file, JSON.stringify({ candidates: [{ title: 'qwerty opaque listing', url }] }));
  fs.utimesSync(file, ...old());
  const html = '<!doctype html><title>qwerty opaque listing</title><script type="application/ld+json">{"@type":"JobPosting","title":"","description":""}</script>';
  const fetch = async () => htmlRes(200, html);
  const r = await handleQueueFile(file, { processedDir: path.join(dropDir, 'processed'), fetch, seen: {} });
  assert.equal(r.written, 0);
  assert.equal(byUrl(url), undefined);
  assert.equal(r.allDone, true);
});

test('a page that cannot be fetched is never marked seen, and its file is kept for the next run', async () => {
  const file = path.join(dropDir, 'retry.queue.json');
  const okUrl = 'https://job-boards.greenhouse.io/northwind/jobs/7000001';
  const flakyUrl = 'https://example.com/careers/flaky';
  fs.writeFileSync(file, JSON.stringify({ candidates: [{ title: 'Job Application for Product Manager at Northwind Devices', url: okUrl }, { title: 'Some Role at Flaky Co', url: flakyUrl }] }));
  fs.utimesSync(file, ...old());
  const seen = {};
  const fetch1 = async url => {
    if (url === 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/7000001?content=true') return jsonRes(200, read('fetch-detail', 'greenhouse-job.json'));
    throw new Error('network down');
  };
  const r1 = await handleQueueFile(file, { processedDir: path.join(dropDir, 'processed'), fetch: fetch1, seen });
  assert.equal(r1.allDone, false);
  assert.ok(fs.existsSync(file), 'kept for the next run');
  assert.ok(seen[okUrl], 'the successful candidate is remembered so it is not rewritten');
  assert.ok(!seen[flakyUrl], 'the failed fetch is never marked seen');
  const writtenOnce = inboxJobs().filter(fm => fm.url === okUrl).length;
  assert.equal(writtenOnce, 1);

  const fetch2 = async url => {
    if (url === flakyUrl) return htmlRes(200, read('fetch-detail', 'page-plain.html'));
    throw new Error('must not refetch an already-seen URL');
  };
  const r2 = await handleQueueFile(file, { processedDir: path.join(dropDir, 'processed'), fetch: fetch2, seen });
  assert.equal(r2.allDone, true);
  assert.ok(!fs.existsSync(file), 'now moved to processed');
  assert.equal(inboxJobs().filter(fm => fm.url === okUrl).length, 1, 'not written twice');
  assert.ok(byUrl(flakyUrl), 'the retried candidate is now queued');
});

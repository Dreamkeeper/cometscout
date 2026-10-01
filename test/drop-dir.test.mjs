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

const { run, handleJobFile, handleQueueFile, moveInto, MAX_ATTEMPTS } = await import('../sources/drop-dir.mjs');
const { DIRS, SETTINGS, STATE } = await import('../lib/config.mjs');
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

test('a job file missing company/role is moved to failed/ with the reason, not queued', async () => {
  const file = path.join(dropDir, 'bad-job.md');
  const original = '---\nrole: "Mystery Role"\nurl: "https://acme.example/jobs/2"\n---\n\nsome text\n';
  fs.writeFileSync(file, original);
  fs.utimesSync(file, ...old());
  const r = handleJobFile(file, { processedDir: path.join(dropDir, 'processed') });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(file), 'no longer in the drop dir');
  assert.equal(fs.readFileSync(path.join(dropDir, 'failed', 'bad-job.md'), 'utf8'), original, 'kept byte for byte');
  assert.match(fs.readFileSync(path.join(dropDir, 'failed', 'bad-job.md.reason.txt'), 'utf8'), /missing company\/role/);
  assert.equal(byUrl('https://acme.example/jobs/2'), undefined);
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

  const r = await handleQueueFile(file, { processedDir: path.join(dropDir, 'processed'), fetch, seen: {}, pageDelayMs: 0 });
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
  assert.equal(seen[flakyUrl].outcome, 'retry', 'the failed fetch is only marked for another try');
  assert.equal(seen[flakyUrl].attempts, 1);
  assert.match(seen[flakyUrl].last_error, /network down/);
  const writtenOnce = inboxJobs().filter(fm => fm.url === okUrl).length;
  assert.equal(writtenOnce, 1);

  const fetch2 = async url => {
    if (url === flakyUrl) return htmlRes(200, read('fetch-detail', 'page-plain.html'));
    throw new Error('must not refetch an already-seen URL');
  };
  const r2 = await handleQueueFile(file, { processedDir: path.join(dropDir, 'processed'), fetch: fetch2, seen });
  assert.equal(seen[flakyUrl].outcome, 'written');
  assert.equal(r2.allDone, true);
  assert.ok(!fs.existsSync(file), 'now moved to processed');
  assert.equal(inboxJobs().filter(fm => fm.url === okUrl).length, 1, 'not written twice');
  assert.ok(byUrl(flakyUrl), 'the retried candidate is now queued');
});

// --- review fixes ---------------------------------------------------------------------------------------------
const q = (name, candidates, dir = dropDir) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify({ candidates })); fs.utimesSync(f, ...old()); return f; };
const opts = (extra = {}) => ({ processedDir: path.join(dropDir, 'processed'), pageDelayMs: 0, ...extra });
const status = code => async () => htmlRes(code, '');
/** A fresh drop folder for run(), so earlier tests' files are not picked up. */
function freshDir(name) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
  SETTINGS.sources.drop_dir.dir = dir; delete SETTINGS.sources.drop_dir.move_processed_to;
  return dir;
}
const stateNow = () => JSON.parse(fs.readFileSync(STATE('drop-dir.json'), 'utf8'));

test('403 is final on the first hit: a known company is queued without text and the file moves on', async () => {
  const url = 'https://job-boards.greenhouse.io/northwind/jobs/7100001';
  const file = q('forbidden.queue.json', [{ title: 'Job Application for Growth PM at Northwind Devices', url }]);
  const seen = {};
  const r = await handleQueueFile(file, opts({ fetch: status(403), seen }));
  assert.equal(r.allDone, true);
  assert.ok(!fs.existsSync(file), 'not pinned in the drop dir');
  assert.equal(seen[url].outcome, 'written-no-text');
  assert.equal(seen[url].attempts, 1);
  assert.match(seen[url].last_error, /403/);
  const j = byUrl(url);
  assert.equal(j.company, 'Northwind Devices');
  assert.equal(j.role, 'Growth PM');
  assert.equal(j.full_text, 'missing');
});

test('a final failure with no known company is reported as unreadable, never queued', async () => {
  const url = 'https://example.com/careers/opaque-403';
  const file = q('unreadable.queue.json', [{ title: 'qwerty', url }]);
  const seen = {};
  const r = await handleQueueFile(file, opts({ fetch: status(451), seen }));
  assert.equal(r.allDone, true);
  assert.equal(seen[url].outcome, 'unreadable');
  assert.match(r.message, /unreadable: https:\/\/example\.com\/careers\/opaque-403 \(HTTP 451\)/);
  assert.equal(byUrl(url), undefined);
});

test('429/5xx/DNS errors are retried for 3 runs, then resolved; the file is never pinned', async () => {
  const url = 'https://apply.workable.com/northwind/j/RETRY00001';
  const file = q('flaky.queue.json', [{ title: 'Data Product Manager - AI - Northwind', url }]);
  const seen = {};
  const errors = [status(503), status(429), async () => { throw new Error('getaddrinfo ENOTFOUND'); }];
  for (let run = 1; run <= MAX_ATTEMPTS; run++) {
    const r = await handleQueueFile(file, opts({ fetch: errors[run - 1], seen }));
    if (run < MAX_ATTEMPTS) {
      assert.equal(r.allDone, false, `run ${run}: kept`); assert.ok(fs.existsSync(file));
      assert.equal(seen[url].outcome, 'retry'); assert.equal(seen[url].attempts, run);
    } else {
      assert.equal(r.allDone, true, 'given up after 3 runs'); assert.ok(!fs.existsSync(file));
      assert.equal(seen[url].outcome, 'written-no-text'); assert.equal(seen[url].attempts, 3);
      assert.match(seen[url].last_error, /ENOTFOUND/);
    }
  }
  const j = byUrl(url);
  assert.equal(j.company, 'Northwind', 'the Workable slug');
  assert.equal(j.role, 'Data Product Manager - AI');
  assert.equal(j.full_text, 'missing');
});

test('a URL listed twice in one run is fetched once', async () => {
  const url = 'https://example.com/careers/twice';
  const f1 = q('twice-a.queue.json', [{ title: 'Acme: Product Owner', url }]);
  const f2 = q('twice-b.queue.json', [{ title: 'Acme: Product Owner', url }]);
  const seen = {}, tried = new Set(); let calls = 0;
  const fetch = async () => { calls++; return htmlRes(503, ''); };
  await handleQueueFile(f1, opts({ fetch, seen, tried }));
  const r2 = await handleQueueFile(f2, opts({ fetch, seen, tried }));
  assert.equal(calls, 1);
  assert.equal(seen[url].attempts, 1, 'one attempt counted for the run');
  assert.equal(r2.allDone, false);
  fs.rmSync(f1); fs.rmSync(f2);
});

test('run(): one bad file does not stop the others, and the state is saved', async () => {
  const dir = freshDir('drop-perfile');
  const okUrl = 'https://example.com/careers/perfile-ok';
  q('a-busy.queue.json', [{ title: 'Busy Co: Product Owner', url: 'https://example.com/careers/perfile-busy' }], dir);
  q('b-ok.queue.json', [{ title: 'Fine Co: Product Owner', url: okUrl }], dir);
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { if (path.basename(String(from)) === 'a-busy.queue.json') { const e = new Error('resource busy or locked'); e.code = 'EBUSY'; throw e; } return realRename(from, to); };
  try {
    const fetch = async () => htmlRes(200, read('fetch-detail', 'page-plain.html'));
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const r = await run({ fetch, pageDelayMs: 0 });
      const busy = r.report.find(l => l.startsWith('a-busy.queue.json'));
      if (i < MAX_ATTEMPTS) assert.match(busy, /^a-busy\.queue\.json: failed \(EBUSY: .*\), will retry next run$/, `run ${i}`);
      else assert.match(busy, /could not move it to failed\/ either/, 'still busy: reported, kept, not lost');
      if (i === 1) assert.ok(r.report.some(l => /^b-ok\.queue\.json: 1 new/.test(l)), 'the other file is still processed');
    }
  } finally { fs.renameSync = realRename; }
  const st = stateNow();
  assert.equal(st.seen[okUrl].outcome, 'written');
  assert.equal(st.seen['https://example.com/careers/perfile-busy'].outcome, 'written', 'queued once, remembered');
  assert.equal(inboxJobs().filter(fm => fm.url === 'https://example.com/careers/perfile-busy').length, 1, 'never queued twice');
  assert.ok(fs.existsSync(path.join(dir, 'processed', 'b-ok.queue.json')));
  // the lock goes away: the next run moves it on without refetching or requeueing anything
  const r = await run({ fetch: async url => { throw new Error(`must not refetch ${url}`); }, pageDelayMs: 0 });
  assert.ok(r.report.some(l => /^a-busy\.queue\.json: 0 new, 1 skipped$/.test(l)), r.report.join('\n'));
  assert.ok(!fs.existsSync(path.join(dir, 'a-busy.queue.json')));
});

test('run(): a file that keeps failing is moved to failed/ after 3 runs', async () => {
  const dir = freshDir('drop-stuck');
  const file = path.join(dir, 'stuck.md');
  fs.writeFileSync(file, '---\ncompany: "Stuck Co"\nrole: "PM"\n---\nbody\n'); fs.utimesSync(file, ...old());
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...a) => { if (String(p) === file) { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; } return realRead(p, ...a); };
  try {
    for (let i = 1; i <= MAX_ATTEMPTS; i++) await run({ pageDelayMs: 0 });
  } finally { fs.readFileSync = realRead; }
  assert.ok(!fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(dir, 'failed', 'stuck.md')));
  assert.match(fs.readFileSync(path.join(dir, 'failed', 'stuck.md.reason.txt'), 'utf8'), /failed 3 runs in a row; last error: EACCES/);
  assert.equal(stateNow().files['stuck.md'], undefined, 'no stale failure count left behind');
});

test('moveInto: falls back to copy + delete when the target is on another volume (EXDEV)', () => {
  const dir = freshDir('drop-exdev');
  const file = path.join(dir, 'x.queue.json'); fs.writeFileSync(file, '{"candidates":[]}');
  fs.mkdirSync(path.join(dir, 'other'), { recursive: true }); fs.writeFileSync(path.join(dir, 'other', 'x.queue.json'), 'older');
  const dest = moveInto(file, path.join(dir, 'other'), { rename: () => { const e = new Error('cross-device link not permitted'); e.code = 'EXDEV'; throw e; } });
  assert.equal(path.basename(dest), 'x--2.queue.json', 'never overwrites');
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"candidates":[]}');
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(path.join(dir, 'other', 'x.queue.json'), 'utf8'), 'older');
});

test('run(): bad JSON and a queue file without candidates go to failed/; dotfiles and other files are ignored', async () => {
  const dir = freshDir('drop-malformed');
  const put = (n, body) => { fs.writeFileSync(path.join(dir, n), body); fs.utimesSync(path.join(dir, n), ...old()); };
  put('broken.queue.json', '{"candidates": [');
  put('shape.queue.json', '{"jobs": []}');
  for (const n of ['desktop.ini', '.job.md.swp', '.~lock.job.md#', 'notes.txt', '.hidden.md', 'job.md.tmp', '.syncthing.a.queue.json.tmp']) put(n, 'x');
  const r = await run({ fetch: async () => { throw new Error('must not fetch'); }, pageDelayMs: 0 });
  assert.match(r.report.find(l => l.startsWith('broken.queue.json')), /not valid JSON .*moved to failed\//);
  assert.match(r.report.find(l => l.startsWith('shape.queue.json')), /no "candidates" list, moved to failed\//);
  assert.equal(r.report.length, 2, `only the two queue files are looked at:\n${r.report.join('\n')}`);
  assert.equal(fs.readFileSync(path.join(dir, 'failed', 'broken.queue.json'), 'utf8'), '{"candidates": [');
  assert.match(fs.readFileSync(path.join(dir, 'failed', 'broken.queue.json.reason.txt'), 'utf8'), /not valid JSON/);
  for (const n of ['desktop.ini', '.job.md.swp', 'notes.txt', '.hidden.md', 'job.md.tmp']) assert.ok(fs.existsSync(path.join(dir, n)), `${n} untouched`);
});

test('a candidate with text but no company is queued as "Unknown"; one with no role is skipped', async () => {
  const unknownUrl = 'https://example.com/careers/no-company', noRoleUrl = 'https://example.com/careers/no-role';
  const noRole = `<html><title></title><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: '', description: 'x'.repeat(50), hiringOrganization: { name: 'Acme' } })}</script></html>`;
  const file = q('blanks.queue.json', [{ title: 'Senior Product Manager', url: unknownUrl }, { title: '', url: noRoleUrl }]);
  const seen = {};
  const fetch = async url => url === unknownUrl ? htmlRes(200, read('fetch-detail', 'page-plain.html')) : htmlRes(200, noRole);
  const r = await handleQueueFile(file, opts({ fetch, seen }));
  assert.equal(r.written, 1);
  const j = byUrl(unknownUrl);
  assert.equal(j.company, 'Unknown'); assert.equal(j.role, 'Senior Product Manager');
  assert.equal(seen[noRoleUrl].outcome, 'no-role');
  assert.equal(byUrl(noRoleUrl), undefined);
});

test('a known ATS link prefers the board slug over a punctuation guess from the title', async () => {
  const url = 'https://jobs.lever.co/lumenfield/00000000-0000-0000-0000-000000000099';
  const file = q('ats-pref.queue.json', [{ title: 'Lumenfield Careers - Product Lead', url }]);
  const posting = { ...JSON.parse(read('fetch-detail', 'lever-posting.json')), text: 'Principal Product Manager' };
  const fetch = async () => jsonRes(200, JSON.stringify(posting));
  await handleQueueFile(file, opts({ fetch, seen: {} }));
  const j = byUrl(url);
  assert.equal(j.company, 'Lumenfield', 'not "Lumenfield Careers" from the "Co - Title" default');
  assert.equal(j.role, 'Principal Product Manager', 'the title from the API');
});

test('a closed posting or a redirect to a listing page is never queued', async () => {
  const closedUrl = 'https://example.com/careers/closed-1', movedUrl = 'https://www.jobfluent.com/jobs/moved-1';
  const file = q('closed.queue.json', [{ title: 'Acme: Product Owner', url: closedUrl }, { title: 'Beta: Product Owner', url: movedUrl }]);
  const seen = {};
  const fetch = async url => url === closedUrl
    ? htmlRes(200, read('fetch-detail', 'page-plain.html').replace('</h1>', '</h1><p>This position has been filled.</p>'))
    : { ...htmlRes(200, read('fetch-detail', 'page-plain.html')), url: 'https://www.jobfluent.com/jobs-madrid/product-owner' };
  const r = await handleQueueFile(file, opts({ fetch, seen }));
  assert.equal(r.written, 0);
  assert.equal(seen[closedUrl].outcome, 'unavailable'); assert.equal(seen[closedUrl].reason, 'posting closed');
  assert.equal(seen[movedUrl].reason, 'redirected to a listing page');
});

test('run(): a missing folder is reported clearly, and doctor flags it', async () => {
  SETTINGS.sources.drop_dir.dir = path.join(tmp, 'does-not-exist');
  const lines = []; const realLog = console.log; console.log = (...a) => lines.push(a.join(' '));
  try { const r = await run({}); assert.equal(r.ran, false); } finally { console.log = realLog; }
  assert.ok(lines.some(l => /drop-dir: the folder .*does-not-exist does not exist/.test(l)), lines.join('\n'));

  const settings = path.join(tmp, 'settings-doctor.json');
  fs.writeFileSync(settings, JSON.stringify({ sources: { drop_dir: { enabled: true, dir: path.join(tmp, 'does-not-exist') } } }));
  const { spawnSync } = await import('node:child_process');
  const d = spawnSync(process.execPath, [path.join(HERE, '..', 'cli.mjs'), 'doctor'], { encoding: 'utf8', env: { ...process.env, JOBPILOT_SETTINGS: settings }, timeout: 60000 });
  assert.match(d.stdout, /TODO drop-dir folder: .*does-not-exist/);
});

test('page fetches are spaced 1.5 s apart; ATS API calls are not', async () => {
  const file = q('polite.queue.json', [
    { title: 'A Co: Product Owner', url: 'https://example.com/careers/polite-1' },
    { title: 'Job Application for PM at Northwind Devices', url: 'https://job-boards.greenhouse.io/northwind/jobs/7200001' },
    { title: 'B Co: Product Owner', url: 'https://example.com/careers/polite-2' },
    { title: 'Job Application for PM 2 at Northwind Devices', url: 'https://job-boards.greenhouse.io/northwind/jobs/7200002' },
    { title: 'C Co: Product Owner', url: 'https://example.com/careers/polite-3' },
  ]);
  const order = [], waits = [];
  const fetch = async url => { order.push(url); return url.includes('greenhouse') ? jsonRes(200, read('fetch-detail', 'greenhouse-job.json')) : htmlRes(200, read('fetch-detail', 'page-plain.html')); };
  const sleep = async ms => { waits.push({ ms, before: order.length }); };
  await handleQueueFile(file, opts({ fetch, seen: {}, pageDelayMs: 1500, sleep }));
  assert.equal(waits.length, 2, 'a wait before the 2nd and 3rd page, none before API calls');
  for (const w of waits) assert.ok(w.ms > 1000 && w.ms <= 1500, `waited ${w.ms} ms`);
  assert.deepEqual(waits.map(w => w.before), [2, 4], 'the waits come right before a page fetch');
});

test('run(): seen entries older than 120 days are pruned; a modification time in the future counts as settled', async () => {
  const dir = freshDir('drop-housekeeping');
  const st = stateNow();
  st.seen['https://example.com/ancient'] = { at: new Date(Date.now() - 121 * 864e5).toISOString(), outcome: 'written' };
  st.seen['https://example.com/recent'] = { at: new Date(Date.now() - 119 * 864e5).toISOString(), outcome: 'written' };
  fs.writeFileSync(STATE('drop-dir.json'), JSON.stringify(st));
  const future = path.join(dir, 'future.queue.json');
  fs.writeFileSync(future, JSON.stringify({ candidates: [] }));
  const t = Date.now() / 1000 + 86400 * 365; fs.utimesSync(future, t, t);
  const r = await run({ pageDelayMs: 0 });
  assert.ok(r.report.some(l => /^future\.queue\.json: 0 new/.test(l)), r.report.join('\n'));
  assert.ok(!fs.existsSync(future), 'processed, not pinned by a skewed clock');
  const after = stateNow();
  assert.equal(after.seen['https://example.com/ancient'], undefined);
  assert.ok(after.seen['https://example.com/recent']);
});

test('run(): a broken state file is kept aside, never silently overwritten', async () => {
  freshDir('drop-brokenstate');
  fs.writeFileSync(STATE('drop-dir.json'), '{"seen": {"https://example.com/x": ');
  const lines = []; const realLog = console.log; console.log = (...a) => lines.push(a.join(' '));
  try { await run({ pageDelayMs: 0 }); } finally { console.log = realLog; }
  const aside = fs.readdirSync(DIRS.state).filter(f => f.startsWith('drop-dir.json.broken-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(DIRS.state, aside[0]), 'utf8'), '{"seen": {"https://example.com/x": ');
  assert.ok(lines.some(l => /was not valid JSON/.test(l)));
  assert.ok(stateNow().seen, 'a fresh, valid state is written');
});

// --- second review round ------------------------------------------------------------------------------------------
test('a final failure never invents a company from title punctuation: reported as unreadable, nothing written', async () => {
  const url = 'https://example.com/careers/lumenfield-pm-ai';
  const file = q('lumenfield.queue.json', [{ title: 'Lumenfield - Product Manager - AI', url }]);
  const seen = {};
  const r = await handleQueueFile(file, opts({ fetch: status(403), seen }));
  assert.equal(r.allDone, true);
  assert.equal(r.written, 0);
  assert.equal(seen[url].outcome, 'unreadable');
  assert.match(r.message, /unreadable: https:\/\/example\.com\/careers\/lumenfield-pm-ai \(HTTP 403\)/);
  assert.equal(byUrl(url), undefined);
});

test('run(): page fetches are capped by max_fetches_per_run; ATS calls do not count; the rest waits, nothing lost or fetched twice', async () => {
  const dir = freshDir('drop-cap');
  SETTINGS.sources.drop_dir.max_fetches_per_run = 2;
  const page = n => `https://example.com/careers/cap-${n}`;
  const ats = 'https://job-boards.greenhouse.io/northwind/jobs/7300001';
  q('a-cap.queue.json', [
    { title: 'Cap One: Product Owner', url: page(1) },
    { title: 'Cap Two: Product Owner', url: page(2) },
    { title: 'Cap Three: Product Owner', url: page(3) },
    { title: 'Job Application for PM at Northwind Devices', url: ats },
  ], dir);
  q('b-cap.queue.json', [{ title: 'Cap Four: Product Owner', url: page(4) }], dir);
  const calls = [];
  const fetch = async url => { calls.push(url); return url.includes('greenhouse') ? jsonRes(200, read('fetch-detail', 'greenhouse-job.json')) : htmlRes(200, read('fetch-detail', 'page-plain.html')); };
  try {
    const r1 = await run({ fetch, pageDelayMs: 0 });
    assert.deepEqual(calls.filter(u => !u.includes('greenhouse')), [page(1), page(2)], 'two pages, then the cap');
    assert.ok(calls.some(u => u.includes('greenhouse')), 'the ATS call past the cap still runs');
    assert.match(r1.report.find(l => l.startsWith('a-cap.queue.json')), /1 left for the next run \(page fetch limit of 2 reached\).*file kept/);
    assert.match(r1.report.find(l => l.startsWith('b-cap.queue.json')), /1 left for the next run/);
    assert.ok(r1.report.some(l => /page fetch limit reached \(2 per run.*2 job\(s\) left for the next run/.test(l)), r1.report.join('\n'));
    assert.ok(fs.existsSync(path.join(dir, 'a-cap.queue.json')) && fs.existsSync(path.join(dir, 'b-cap.queue.json')), 'both files stay');
    const st = stateNow();
    assert.equal(st.seen[page(3)], undefined, 'a deferred candidate is not marked');
    assert.equal(st.seen[page(4)], undefined);

    calls.length = 0;
    const r2 = await run({ fetch, pageDelayMs: 0 });
    assert.deepEqual(calls, [page(3), page(4)], 'only the deferred ones, once each');
    assert.ok(!r2.report.some(l => /limit/.test(l)), r2.report.join('\n'));
    assert.ok(!fs.existsSync(path.join(dir, 'a-cap.queue.json')) && !fs.existsSync(path.join(dir, 'b-cap.queue.json')), 'both files done');
    for (const u of [page(1), page(2), page(3), page(4)]) assert.equal(inboxJobs().filter(fm => fm.url === u).length, 1, `${u} queued once`);
    assert.ok(stateNow().seen[ats], 'the ATS candidate was handled in the first run (a duplicate of an earlier test\'s job)');
  } finally { delete SETTINGS.sources.drop_dir.max_fetches_per_run; }
});

test('run(): a dropped file that starts with a UTF-8 BOM is read normally, not sent to failed/', async () => {
  const dir = freshDir('drop-bom');
  const put = (n, body) => { fs.writeFileSync(path.join(dir, n), `﻿${body}`); fs.utimesSync(path.join(dir, n), ...old()); };
  put('win.queue.json', JSON.stringify({ candidates: [{ title: 'Bom Co: Product Owner', url: 'https://example.com/careers/bom-queue' }] }));
  put('win-job.md', '---\r\ncompany: "Bom Works"\r\nrole: "Product Analyst"\r\nurl: "https://example.com/careers/bom-md"\r\n---\r\n\r\nAnalyse product data.\r\n');
  const r = await run({ fetch: async () => htmlRes(200, read('fetch-detail', 'page-plain.html')), pageDelayMs: 0 });
  assert.match(r.report.find(l => l.startsWith('win.queue.json')), /^win\.queue\.json: 1 new/, r.report.join('\n'));
  assert.match(r.report.find(l => l.startsWith('win-job.md')), /queued/, r.report.join('\n'));
  assert.ok(!fs.existsSync(path.join(dir, 'failed')), 'nothing in failed/');
  assert.equal(byUrl('https://example.com/careers/bom-md').company, 'Bom Works');
  assert.ok(byUrl('https://example.com/careers/bom-queue'));
});

test('moveInto: when the source cannot be deleted after an EXDEV copy, the copy is removed so retries leave no duplicates', () => {
  const dir = freshDir('drop-exdev-unlink');
  const file = path.join(dir, 'y.queue.json'); fs.writeFileSync(file, '{"candidates":[]}');
  const dest = path.join(dir, 'other');
  const exdev = () => { const e = new Error('cross-device link not permitted'); e.code = 'EXDEV'; throw e; };
  const locked = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
  for (let i = 0; i < 2; i++) assert.throws(() => moveInto(file, dest, { rename: exdev, unlink: locked }), /operation not permitted/);
  assert.ok(fs.existsSync(file), 'the source stays for the next try');
  assert.deepEqual(fs.readdirSync(dest), [], 'no copy left behind');
});

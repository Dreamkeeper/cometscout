// Hirify source: every expectation in test/fixtures/hirify/expected.json, the session checks (exit 3), cookie
// refresh, state, and that the session cookie is never printed or written outside its own file.
// No network: fetch is injected and serves test/fixtures/hirify/ (or vacancies built from them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'hirify');
const ROOT = path.join(HERE, '..');
const fixture = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-hirify-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
process.env.JOBPILOT_RUN_DATE = '2026-10-01';
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));

const { run, fromHirify, isMasked, pageQuery, parseCookieHeader, CONFIDENTIAL, EXIT_SESSION } = await import('../sources/hirify.mjs');
const { DIRS, STATE } = await import('../lib/config.mjs');
const { frontMatter } = await import('../lib/queue.mjs');
const { DEMOTED_FILE } = await import('../lib/gates.mjs');

// Synthetic session values; the tests check that none of them ever leaves the cookie file.
const COOKIE = 'hsid=SYNTHETIC-session-value-123; xsrf=SYNTHETIC-xsrf-value-456';
const SECRETS = ['SYNTHETIC-session-value-123', 'SYNTHETIC-xsrf-value-456', 'REFRESHED-session-value-789'];
const ENV = { HIRIFY_COOKIE: COOKIE };
const NOW = new Date('2026-10-01T12:00:00Z');
// A fictional user: may work in ES, on-site in ES or NL, English and Spanish, no fintech.
const GATES = {
  user: { citizenships: [], work_authorization: ['ES'] },
  languages: ['en', 'es'],
  onsite_countries: ['ES', 'NL'],
  remote: { accept_worldwide: true, accept_regions: ['Europe*', 'EU'] },
  sponsorship_refusal_phrases: ['without sponsorship'],
  industries: { exclude: ['fintech'] },
};
const CFG = { enabled: true, cookie_env: 'HIRIFY_COOKIE', filters: [{ name: 'pm', query: 'search=product%20manager&work_format=remote' }],
  max_pages_per_filter: 3, max_age_days: 14, delay_ms: 0, title_exclude: ['intern'] };

const json = (status, body, headers) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const base = fixture('vacancy-900001.json').data;
let nextId = 910000;
/** A new vacancy built from the first fixture, with its own id, company and apply link (the queue dedupes by URL and by company + title). */
function vac(patch = {}) {
  const id = nextId++;
  return { ...base, id, slug: `vacancy-${id}`, company_title: `Synthetic Co ${id}`, apply_url: `https://apply.example-ats.com/t${id}`, ...patch };
}
/**
 * Fake Hirify API. list: vacancies for page 1 (or pages: [[...], [...]]); details default to the list objects.
 * on: { '/auth/user': (url, opts) => Response, ... } overrides a path. calls records every request.
 */
function server({ list, pages, details = {}, on = {}, lastPage } = {}) {
  const calls = [];
  const allPages = pages || [list || []];
  const byId = new Map(allPages.flat().map(v => [String(v.id), v]));
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: u.search, cookie: opts.headers?.Cookie });
    if (on[u.pathname]) return on[u.pathname](u, opts);
    if (u.pathname === '/auth/user') return json(200, fixture('auth-user.json'));
    if (u.pathname === '/api/vacancies') {
      const page = Number(u.searchParams.get('page'));
      return json(200, { data: allPages[page - 1] || [], meta: { current_page: page, last_page: lastPage ?? allPages.length } });
    }
    const m = u.pathname.match(/^\/api\/vacancies\/(.+)$/);
    if (m && details[m[1]] !== undefined) return typeof details[m[1]] === 'function' ? details[m[1]]() : json(200, { data: details[m[1]] });
    if (m && byId.has(m[1])) return json(200, { data: byId.get(m[1]) });
    return json(404, { message: 'not found' });
  };
  return { fetch, calls };
}
/** The fixture folder as an API. */
function fixtureServer(on = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: u.search, cookie: opts.headers?.Cookie });
    if (on[u.pathname]) return on[u.pathname](u, opts);
    if (u.pathname === '/auth/user') return json(200, fixture('auth-user.json'));
    if (u.pathname === '/api/vacancies') return json(200, u.searchParams.get('page') === '1' ? fixture('vacancies-page-1.json') : { data: [] });
    const m = u.pathname.match(/^\/api\/vacancies\/(\d+)$/);
    if (m && fs.existsSync(path.join(FIX, `vacancy-${m[1]}.json`))) return json(200, fixture(`vacancy-${m[1]}.json`));
    return json(404, {});
  };
  return { fetch, calls };
}

// Everything printed during a run, so the tests can check it never contains the cookie.
let printed = [];
async function go(opts = {}) {
  const log = console.log, err = console.error, warn = console.warn;
  const grab = (...a) => printed.push(a.map(String).join(' '));
  console.log = console.error = console.warn = grab;
  try { return await run({ cfg: CFG, gates: GATES, env: ENV, now: NOW, sleep: async () => {}, ...opts }); }
  finally { console.log = log; console.error = err; console.warn = warn; }
}
function fresh() {
  for (const f of ['hirify.json', 'hirify-cookies.json']) fs.rmSync(STATE(f), { force: true });
}
const state = () => JSON.parse(fs.readFileSync(STATE('hirify.json'), 'utf8'));
const inbox = () => fs.readdirSync(DIRS.inbox).filter(f => f.endsWith('.md')).map(f => ({ f, txt: fs.readFileSync(path.join(DIRS.inbox, f), 'utf8') }))
  .map(({ f, txt }) => ({ file: f, txt, ...frontMatter(txt) }));
const byUrl = url => inbox().find(j => j.url === url);
function noSecretsAnywhere() {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(process.env.JOBPILOT_DATA);
  for (const p of files) {
    if (path.basename(p) === 'hirify-cookies.json') continue;   // the one place refreshed values are meant to live
    const txt = fs.readFileSync(p, 'utf8');
    for (const s of SECRETS) assert.ok(!txt.includes(s), `${path.relative(tmp, p)} contains a session value`);
  }
  for (const line of printed) for (const s of SECRETS) assert.ok(!line.includes(s), `printed a session value: ${line}`);
}

test('every expectation in test/fixtures/hirify/expected.json holds', async () => {
  fresh();
  const sent = [];
  const { fetch } = fixtureServer();
  const r = await go({ fetch, send: async t => sent.push(t) });
  assert.equal(r.code, 0);
  assert.equal(sent.length, 0, 'no alert on a working session');
  const seen = state().seen;
  const expected = fixture('expected.json');
  for (const [id, what] of Object.entries(expected)) {
    const v = fixture(`vacancy-${id}.json`).data;
    const job = byUrl(v.apply_url);
    let m;
    if (/^write\b/.test(what)) {
      assert.ok(job, `${id} written (${what})`);
      assert.equal(job.company, v.company_title);
      assert.equal(seen[id].status, 'written');
    } else if (/^flag: company masked/.test(what)) {
      assert.ok(job, `${id} written with a flag (${what})`);
      assert.equal(job.company, CONFIDENTIAL);
      assert.match(job.gate_flags, /company: hidden by Hirify/);
    } else if (/^reject scam/.test(what)) {
      assert.ok(!job, `${id} not written (${what})`);
      assert.equal(seen[id].status, 'scam');
    } else if ((m = what.match(/^reject ([a-z-]+):/))) {
      assert.ok(!job, `${id} not written (${what})`);
      assert.equal(seen[id].status, `gated: ${m[1]}`, `${id}: ${what}`);
    } else if (/^unavailable/.test(what)) {
      assert.ok(!job, `${id} not written (${what})`);
      assert.equal(seen[id].status, 'unavailable');
    } else assert.fail(`expected.json has an expectation this test does not know: ${id} "${what}"`);
  }
  assert.match(printed.join('\n'), /gated 4 \(industry 1, language 1, geo-remote 1, scam 1\)/);
  noSecretsAnywhere();
});

test('a written job carries the fields the brief asks for', () => {
  const v = fixture('vacancy-900001.json').data;
  const job = byUrl(v.apply_url);
  assert.equal(job.role, 'Product Manager (IoT)');
  assert.equal(job.source, 'hirify');
  assert.equal(job.salary, '4000-6000 EUR');
  assert.equal(job.posted, '2026-09-29');
  assert.equal(job.location, 'Remote: worldwide');
  assert.equal(job.hirify_url, 'https://hirify.me/jobs/900001-vacancy-1');
  assert.equal(job.english_level, 'b2');
  assert.equal(job.posting_language, 'en');
  assert.equal(job.visa, undefined, 'visa_sponsorship null leaves the field out');
  assert.match(job.txt, /We build connected devices/);
  assert.match(job.txt, /Work format: remote/);
  const hybrid = byUrl(fixture('vacancy-900008.json').data.apply_url);
  assert.equal(hybrid.location, 'hybrid: netherlands');
});

test('a second run skips vacancies already handled (no detail calls)', async () => {
  const { fetch, calls } = fixtureServer();
  const before = inbox().length;
  const r = await go({ fetch });
  assert.equal(r.code, 0);
  assert.equal(calls.filter(c => /^\/api\/vacancies\/\d+$/.test(c.path)).length, 0);
  assert.equal(inbox().length, before);
});

test('a page where every company is masked means the session is not working: exit 3, alert, nothing written', async () => {
  fresh();
  const sent = [];
  const list = Array.from({ length: 5 }, (_, i) => vac({ company_title: ['*******', '•••••', '', '* * *', '****'][i] }));
  const { fetch, calls } = server({ list });
  const before = inbox().length;
  printed = [];
  const r = await go({ fetch, send: async t => sent.push(t) });
  assert.equal(r.code, EXIT_SESSION);
  assert.match(printed.join('\n'), /refresh HIRIFY_COOKIE/);
  assert.equal(sent.length, 1, 'Telegram alert sent');
  assert.match(sent[0], /HIRIFY_COOKIE/);
  assert.equal(inbox().length, before);
  assert.equal(calls.filter(c => /^\/api\/vacancies\/\d+$/.test(c.path)).length, 0, 'no detail calls');
  assert.deepEqual(state().seen, {}, 'nothing marked seen');
  noSecretsAnywhere();
});

test('fewer than 5 masked items, or one real name among them, is not a session failure', async () => {
  fresh();
  const four = Array.from({ length: 4 }, () => vac({ company_title: '****', title: 'Product Lead' }));
  let r = await go({ fetch: server({ list: four }).fetch });
  assert.equal(r.code, 0);
  for (const v of four) assert.equal(byUrl(v.apply_url).company, CONFIDENTIAL, 'each masked job is kept (no title dedupe on the placeholder)');
  fresh();
  const mixed = [...Array.from({ length: 5 }, () => vac({ company_title: '***' })), vac({ company_title: 'Real Name Co' })];
  r = await go({ fetch: server({ list: mixed }).fetch });
  assert.equal(r.code, 0);
});

test('a list without company_title at all is not read as a masked session', async () => {
  fresh();
  const list = Array.from({ length: 5 }, () => { const v = vac(); delete v.company_title; return v; });
  const r = await go({ fetch: server({ list }).fetch });
  assert.equal(r.code, 0);
  assert.equal(byUrl(list[0].apply_url).company, CONFIDENTIAL);
});

for (const [name, on] of [
  ['401 on /auth/user', { '/auth/user': () => json(401, { message: 'Unauthenticated' }) }],
  ['403 on /auth/user', { '/auth/user': () => json(403, {}) }],
  ['a redirect to the login page', { '/auth/user': () => new Response(null, { status: 302, headers: { location: 'https://hirify.me/login' } }) }],
  ['/auth/user with no user', { '/auth/user': () => json(200, {}) }],
  ['401 on the list', { '/api/vacancies': () => json(401, {}) }],
]) {
  test(`expired session (${name}) exits 3 with a clear message and an alert`, async () => {
    fresh();
    const sent = [];
    printed = [];
    const r = await go({ fetch: server({ list: [vac()], on }).fetch, send: async t => sent.push(t) });
    assert.equal(r.code, EXIT_SESSION);
    assert.match(printed.join('\n'), /refresh HIRIFY_COOKIE in \.env/);
    assert.equal(sent.length, 1);
    noSecretsAnywhere();
  });
}

test('a 401 on a detail call mid-run stops with exit 3 and keeps what was done', async () => {
  fresh();
  const ok = vac(), bad = vac();
  const { fetch } = server({ list: [ok, bad], details: { [bad.id]: () => json(401, {}) } });
  const r = await go({ fetch, send: async () => {} });
  assert.equal(r.code, EXIT_SESSION);
  assert.ok(byUrl(ok.apply_url));
  assert.equal(state().seen[ok.id].status, 'written', 'state saved before stopping');
  assert.equal(state().seen[bad.id], undefined);
});

test('a missing cookie exits 3 without any request', async () => {
  fresh();
  const sent = [];
  const { fetch, calls } = server({ list: [vac()] });
  printed = [];
  const r = await go({ fetch, env: {}, send: async t => sent.push(t) });
  assert.equal(r.code, EXIT_SESSION);
  assert.equal(calls.length, 0);
  assert.match(printed.join('\n'), /HIRIFY_COOKIE is not set in \.env/);
  assert.equal(sent.length, 1);
});

test('dry run: no alert, no state, nothing written', async () => {
  fresh();
  const sent = [];
  let r = await go({ fetch: server({ list: [vac()] }).fetch, env: {}, send: async t => sent.push(t), dryRun: true });
  assert.equal(r.code, EXIT_SESSION);
  assert.equal(sent.length, 0);
  const v = vac();
  r = await go({ fetch: server({ list: [v], on: { '/auth/user': () => json(200, { id: 1 }, { 'set-cookie': 'hsid=REFRESHED-session-value-789' }) } }).fetch, dryRun: true });
  assert.equal(r.code, 0);
  assert.equal(r.written, 1);
  assert.ok(!byUrl(v.apply_url));
  assert.ok(!fs.existsSync(STATE('hirify.json')));
  assert.ok(!fs.existsSync(STATE('hirify-cookies.json')));
});

test('a refreshed cookie is saved (mode 600), used next run, and dropped when .env changes', async () => {
  fresh();
  const refresh = { '/auth/user': () => json(200, fixture('auth-user.json'), { 'set-cookie': 'hsid=REFRESHED-session-value-789; Path=/; HttpOnly; Secure' }) };
  printed = [];
  let r = await go({ fetch: server({ list: [], on: refresh }).fetch });
  assert.equal(r.code, 0);
  const file = STATE('hirify-cookies.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, /REFRESHED-session-value-789/);
  assert.ok(!saved.includes('SYNTHETIC-session-value-123') && !saved.includes('SYNTHETIC-xsrf-value-456'), 'the .env value itself is not copied there');

  const next = server({ list: [] });
  r = await go({ fetch: next.fetch });
  const sentCookie = parseCookieHeader(next.calls[0].cookie);
  assert.equal(sentCookie.get('hsid'), 'REFRESHED-session-value-789', 'the refreshed value wins');
  assert.equal(sentCookie.get('xsrf'), 'SYNTHETIC-xsrf-value-456', 'other .env cookies still go');

  const pasted = server({ list: [] });
  r = await go({ fetch: pasted.fetch, env: { HIRIFY_COOKIE: 'hsid=SYNTHETIC-new-paste-000' } });
  assert.equal(parseCookieHeader(pasted.calls[0].cookie).get('hsid'), 'SYNTHETIC-new-paste-000', 'a new .env cookie replaces the saved ones');

  const expire = { '/auth/user': () => json(200, { id: 1 }, { 'set-cookie': 'hsid=; Max-Age=0; Path=/' }) };
  await go({ fetch: server({ list: [], on: expire }).fetch });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('REFRESHED'), 'a cookie the server deletes is removed');
  noSecretsAnywhere();
});

test('nothing printed contains the cookie, even when an error message echoes it', async () => {
  fresh();
  printed = [];
  const v = vac();
  const { fetch } = server({ list: [v], details: { [v.id]: () => { throw new Error(`socket closed, request had Cookie: ${COOKIE}`); } } });
  const r = await go({ fetch });
  assert.equal(r.code, 0);
  assert.ok(printed.some(l => /\[hidden\]/.test(l)), 'the error was printed, redacted');
  noSecretsAnywhere();
});

test('one failing vacancy never stops the run; it is not marked seen and state is saved', async () => {
  fresh();
  const a = vac(), b = vac(), c = vac();
  const { fetch } = server({ list: [a, b, c], details: { [b.id]: () => json(500, 'oops'), [c.id]: () => new Response('<html>not json</html>', { status: 200 }) } });
  const r = await go({ fetch });
  assert.equal(r.code, 0);
  assert.ok(byUrl(a.apply_url));
  const s = state().seen;
  assert.equal(s[a.id].status, 'written');
  assert.equal(s[b.id], undefined, 'failed: tried again next run');
  assert.equal(s[c.id], undefined);
  assert.deepEqual(r.failed.length, 2);
  // the next run tries them again
  const again = server({ list: [a, b, c] });
  await go({ fetch: again.fetch });
  assert.deepEqual(again.calls.filter(x => /^\/api\/vacancies\/\d+$/.test(x.path)).map(x => x.path).sort(), [`/api/vacancies/${b.id}`, `/api/vacancies/${c.id}`]);
});

test('an unexpected error on one vacancy is logged and the run goes on', async () => {
  fresh();
  const bad = vac({ title: 'Explode' }), good = vac();
  const check = job => { if (job.title === 'Explode') throw new Error('boom'); return { decision: 'pass', flags: [] }; };
  const r = await go({ fetch: server({ list: [bad, good] }).fetch, check });
  assert.equal(r.code, 0);
  assert.ok(byUrl(good.apply_url));
  assert.equal(state().seen[bad.id], undefined);
  assert.ok(r.failed.some(f => f.includes('boom')));
});

test('demoted jobs go through recordDemote, are not marked seen, and count as repeats later', async () => {
  fresh();
  const v = vac();
  const demote = () => ({ decision: 'demote', gate: 'headcount', reason: 'test demote', flags: [] });
  printed = [];
  let r = await go({ fetch: server({ list: [v] }).fetch, check: demote });
  assert.equal(r.code, 0);
  assert.ok(!byUrl(v.apply_url));
  assert.equal(state().seen[v.id], undefined, 'not marked seen');
  const lines = fs.readFileSync(DEMOTED_FILE(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.some(l => l.source === 'hirify' && l.url === v.apply_url && l.reason === 'test demote'));
  assert.match(printed.join('\n'), /demoted 1/);
  printed = [];
  r = await go({ fetch: server({ list: [v] }).fetch, check: demote });
  assert.match(printed.join('\n'), /1 still gated from earlier runs/);
  assert.equal(fs.readFileSync(DEMOTED_FILE(), 'utf8').trim().split('\n').filter(l => l.includes(v.apply_url)).length, 1, 'recorded once');
  // when the bar is lowered it comes back and is written
  r = await go({ fetch: server({ list: [v] }).fetch });
  assert.ok(byUrl(v.apply_url));
  assert.equal(state().demoted[v.id], undefined);
});

test('title_exclude and max_age_days skip before any detail call, without marking seen', async () => {
  fresh();
  const intern = vac({ title: 'Product Intern' });
  const old = vac({ created_at: '2026-09-01T08:00:00Z' });
  const reopened = vac({ created_at: '2026-08-01T08:00:00Z', reopened_at: '2026-09-28T08:00:00Z' });
  const { fetch, calls } = server({ list: [intern, old, reopened] });
  const r = await go({ fetch });
  assert.equal(r.excluded, 1);
  assert.equal(r.old, 1);
  assert.deepEqual(calls.filter(c => /^\/api\/vacancies\/\d+$/.test(c.path)).map(c => c.path), [`/api/vacancies/${reopened.id}`], 'reopened_at counts');
  assert.ok(byUrl(reopened.apply_url));
  assert.equal(state().seen[intern.id], undefined);
  assert.equal(state().seen[old.id], undefined);
});

test('missing or oddly written fields never reject; they are flagged', async () => {
  fresh();
  const odd = [
    vac({ work_format: null, vacancy_language: null, language_requirements: null, salary: null, created_at: null, tags: null, title: 'Product Manager A' }),
    vac({ work_format: 'remote', language_requirements: ['Klingon C2'], vacancy_language: 'xx-unknown-lang', title: 'Product Manager B' }),
    vac({ work_format: ['remote', 'teleport'], allowed_locations: [{ name: 'Spain' }], excluded_locations: ['Mars'], office_locations: ['Atlantis'], title: 'Product Manager C' }),
    vac({ visa_sponsorship: 'maybe', title: 'Product Manager D' }),
    vac({ language_requirements: [{ language: 'Английский', level: 'C1' }], title: 'Product Manager E' }),
  ];
  const r = await go({ fetch: server({ list: odd }).fetch });
  assert.equal(r.code, 0);
  for (const v of odd) assert.ok(byUrl(v.apply_url), `${v.title} written`);
  assert.match(byUrl(odd[0].apply_url).gate_flags, /posting date unknown/);
  assert.match(byUrl(odd[1].apply_url).gate_flags, /Klingon C2" wanted, not recognised/);
  assert.match(byUrl(odd[1].apply_url).gate_flags, /posting language "xx-unknown-lang" not recognised/);
  const c = byUrl(odd[2].apply_url).gate_flags;
  assert.match(c, /work format "teleport" not recognised/);
  assert.match(c, /remote: excludes "Mars", check it/);
  assert.match(c, /office location "Atlantis" not recognised/);
  assert.match(byUrl(odd[3].apply_url).gate_flags, /visa sponsorship "maybe" not recognised/);
});

test('fromHirify: languages, countries, regions, industries', () => {
  const v = fixture('vacancy-900003.json').data;
  assert.deepEqual(fromHirify(v).required_languages, [{ lang: 'de', level: 'c1' }]);
  assert.deepEqual(fromHirify(fixture('vacancy-900004.json').data).excluded_countries, ['ES']);
  const h = fromHirify(fixture('vacancy-900008.json').data);
  assert.deepEqual(h.countries, ['NL']);
  assert.deepEqual(h.locations, [{ country: 'NL', attendance: ['hybrid'] }]);
  assert.equal(h.remote_scope, null);
  assert.deepEqual(fromHirify(fixture('vacancy-900002.json').data).industries, ['IoT', 'Fintech']);
  assert.equal(fromHirify(base).remote_scope, 'worldwide');
  const r = fromHirify({ ...base, allowed_locations: ['Germany, Spain', 'portugal'] });
  assert.equal(r.remote_scope, 'geo_restricted');
  assert.deepEqual(r.allowed_regions, ['Germany, Spain', 'portugal'], 'passed through as they come');
  assert.equal(fromHirify({ ...base, company_title: '•••' }).company, null);
  assert.equal(fromHirify({ ...base, visa_sponsorship: true }).sponsorship, 'AVAILABLE');
  assert.deepEqual(fromHirify({ ...base, language_requirements: [{ language: 'Немецкий', level: 'B2' }] }).required_languages, [{ lang: 'de', level: 'b2' }]);
  assert.ok(isMasked('*******') && isMasked('') && isMasked(' • • ') && !isMasked('Acme'));
});

test('remote regions written as country names reach the gate as they come', async () => {
  fresh();
  const spain = vac({ allowed_locations: ['Spain'], title: 'Regional PM Spain' });
  const germanyOnly = vac({ allowed_locations: ['Germany'], title: 'Regional PM Germany' });
  const europe = vac({ allowed_locations: ['Europe'], title: 'Regional PM Europe' });
  const r = await go({ fetch: server({ list: [spain, germanyOnly, europe] }).fetch });
  assert.equal(r.code, 0);
  assert.ok(byUrl(spain.apply_url), 'Spain names a country the user may work in');
  assert.ok(byUrl(europe.apply_url), 'Europe matches accept_regions');
  assert.ok(!byUrl(germanyOnly.apply_url));
  assert.equal(state().seen[germanyOnly.id].status, 'gated: geo-remote');
});

test('pages: page=N replaces the saved one, stops at last_page and at max_pages_per_filter', async () => {
  fresh();
  assert.equal(pageQuery('?search=pm&page=7', 2), 'search=pm&page=2');
  assert.equal(pageQuery('https://hirify.me/jobs?work_format=remote&work_format=hybrid', 1), 'work_format=remote&work_format=hybrid&page=1');
  const pages = [[vac()], [vac()], [vac()], [vac()]];
  const s = server({ pages });
  printed = [];
  await go({ fetch: s.fetch, cfg: { ...CFG, max_pages_per_filter: 2 } });
  assert.deepEqual(s.calls.filter(c => c.path === '/api/vacancies').map(c => new URLSearchParams(c.query).get('page')), ['1', '2']);
  assert.match(printed.join('\n'), /has 4 pages; max_pages_per_filter \(2\) reached/);
  const s2 = server({ pages: [[vac()]], lastPage: 1 });
  await go({ fetch: s2.fetch });
  assert.equal(s2.calls.filter(c => c.path === '/api/vacancies').length, 1);
});

test('a vacancy listed by two filters is fetched once', async () => {
  fresh();
  const v = vac();
  const s = server({ list: [v] });
  await go({ fetch: s.fetch, cfg: { ...CFG, filters: [{ name: 'a', query: 'x=1' }, { name: 'b', query: 'x=2' }] } });
  assert.equal(s.calls.filter(c => c.path === `/api/vacancies/${v.id}`).length, 1);
});

test('all list pages failing is a failed run (exit 1), not an empty day', async () => {
  fresh();
  const r = await go({ fetch: server({ on: { '/api/vacancies': () => json(502, 'bad gateway') } }).fetch });
  assert.equal(r.code, 1);
});

test('seen entries older than 120 days are pruned', async () => {
  fresh();
  fs.writeFileSync(STATE('hirify.json'), JSON.stringify({ seen: { 1: { first_seen: '2026-05-01', status: 'written' }, 2: { first_seen: '2026-09-01', status: 'written' } }, demoted: { 3: '2026-01-01' } }));
  await go({ fetch: server({ list: [] }).fetch });
  assert.deepEqual(Object.keys(state().seen), ['2']);
  assert.deepEqual(state().demoted, {});
});

test('disabled, or no filters: no requests', async () => {
  const s = server({ list: [vac()] });
  assert.equal((await go({ fetch: s.fetch, cfg: { ...CFG, enabled: false } })).code, 0);
  assert.equal((await go({ fetch: s.fetch, cfg: { ...CFG, filters: [] } })).code, 2);
  assert.equal(s.calls.length, 0);
});

// cli.mjs: the source's exit 3 makes `sources` (and `run`) exit 3; doctor checks the cookie variable.
function cli(args) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-hirify-cli-'));
  const settings = path.join(t, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ timezone: 'UTC', sources: { hirify: { enabled: true, filters: [{ name: 'pm', query: 'search=pm' }] } } }));
  const env = { ...process.env, JOBPILOT_SETTINGS: settings, JOBPILOT_DATA: path.join(t, 'data'), HIRIFY_COOKIE: '' };
  delete env.JOBPILOT_HOME;
  return spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env, encoding: 'utf8', timeout: 60000 });
}
test('cli: a source exiting 3 makes `sources` exit 3 and name it', () => {
  const r = cli(['sources']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /HIRIFY_COOKIE is not set in \.env/);
  assert.match(r.stdout, /source\(s\) need you: hirify/);
});
test('cli: doctor checks the Hirify cookie variable', () => {
  const r = cli(['doctor']);
  assert.match(r.stdout, /TODO Hirify session cookie \(HIRIFY_COOKIE\) in \.env/);
  assert.match(r.stdout, /ok {3}Hirify filters: 1/);
  assert.ok(!/unknown source\(s\) ignored: .*hirify/.test(r.stdout));
});

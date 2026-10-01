// hh.ru alerts: email parsing, the vacancy page parser, hh-specific checks, gates, throttling, state and dry run.
// Only test/fixtures/hh/ is used, with an injected Gmail client and fetch: no network, no model calls.
// Every line of test/fixtures/hh/expected.json is checked below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'hh');
const fixture = name => fs.readFileSync(path.join(FIX, name), 'utf8');
const EXPECTED = JSON.parse(fixture('expected.json'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-hh-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
process.env.JOBPILOT_RUN_DATE = '2026-10-01';
const BASE_CFG = {
  enabled: true,
  must_reside_phrases: ['находиться на территории РФ'],
  abroad_signals: ['из любой страны', 'Кипр*', 'Европ*'],
  tax_residency_phrases: ['налоговый резидент*'],
};
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({
  timezone: 'UTC',
  sources: { hh_alerts: BASE_CFG },
  gates: { user: { work_authorization: ['CY'] }, languages: ['ru', 'en'], onsite_countries: ['CY'] },
}));

const hh = await import('../sources/hh-alerts.mjs');
const { messageHtml } = await import('../lib/gmail.mjs');
const { DIRS, SETTINGS, STATE } = await import('../lib/config.mjs');
const { frontMatter } = await import('../lib/queue.mjs');

const NOW = new Date('2026-10-01T18:00:00Z');
const STATE_FILE = STATE('hh-alerts.json');
const DEMOTED = STATE('demoted.jsonl');
const b64 = s => Buffer.from(s, 'utf8').toString('base64url');

// The writer's dedupe index lives for the whole process, so every test uses its own ids: the fixture ids
// 1234567NN become <prefix>NN, served by the fixture page vacancy-1234567NN.html.
let prefixN = 2000000;
const nextPrefix = () => String(++prefixN);
const emailHtml = prefix => fixture('alert-email.html').replaceAll('1234567', prefix);
const message = (id, subject, html, at = '2026-10-01T09:00:00Z') => ({ id, internalDate: String(Date.parse(at)),
  payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: subject }, { name: 'From', value: 'hh.ru <noreply@hh.ru>' }],
    parts: [{ mimeType: 'text/plain', body: { data: b64('Откройте письмо в HTML') } }, { mimeType: 'text/html', body: { data: b64(html) } }] } });
const fakeGmail = (messages, { failGet = [] } = {}) => ({
  queries: [], gets: [],
  async list(q) { this.queries.push(q); return messages.map(m => ({ id: m.id })); },
  async get(id) { this.gets.push(id); if (failGet.includes(id)) throw new Error('Gmail GET failed: 500'); return messages.find(m => m.id === id); },
});
const page = (status, body = '', headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Map(Object.entries(headers)), text: async () => body });
/** Serves fixture pages by the last two digits of the id; overrides: id -> response or a function returning one.
 *  The writer also treats the same company + role as a duplicate, so the company gets the id prefix unless unique is false. */
const fakeFetch = (overrides = {}, { unique = true } = {}) => {
  const f = async (url, opts) => {
    f.calls.push({ url, opts });
    const id = String(url).match(/\/vacancy\/(\d+)$/)?.[1];
    if (id && overrides[id]) return typeof overrides[id] === 'function' ? overrides[id]() : overrides[id];
    const file = id && path.join(FIX, `vacancy-1234567${id.slice(-2)}.html`);
    if (!file || !fs.existsSync(file)) return page(404);
    const html = fs.readFileSync(file, 'utf8');
    return page(200, unique ? html.replace(/(data-qa="vacancy-company-name"[^>]*>)([^<]*)/, `$1$2 ${id.slice(0, -2)}`) : html);
  };
  f.calls = [];
  return f;
};
const noSleep = () => { const s = async ms => { s.calls.push(ms); }; s.calls = []; return s; };
const SUBJECT = 'Вакансии по подписке: менеджер продукта удалённо';

function reset() {
  for (const f of [STATE_FILE, DEMOTED]) fs.rmSync(f, { force: true });
  for (const f of fs.readdirSync(DIRS.state)) if (f.startsWith('hh-alerts.json')) fs.rmSync(path.join(DIRS.state, f), { force: true });
  SETTINGS.sources.hh_alerts = { ...BASE_CFG };
}
const state = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const inboxJob = url => fs.readdirSync(DIRS.inbox).map(f => ({ f, txt: fs.readFileSync(path.join(DIRS.inbox, f), 'utf8') }))
  .map(x => ({ ...x, fm: frontMatter(x.txt) })).find(x => x.fm.url === url);
const runWith = (extra = {}) => hh.run({ messageHtml, sleep: noSleep(), now: NOW, ...extra });
const byId = (r, id) => r.results.find(x => x.id === id);

test('every line of expected.json holds for the fixture email', async () => {
  reset();
  const p = nextPrefix(), gmail = fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch = fakeFetch({}, { unique: false });
  const r = await runWith({ gmail, fetch });
  for (const [fid, want] of Object.entries(EXPECTED)) {
    if (fid.startsWith('_')) continue;
    const id = p + fid.slice(-2), got = byId(r, id);
    assert.ok(got, `${fid} handled`);
    const [, kind, gate] = want.match(/^(write|reject|unavailable)\s*([\w-]+)?/);
    if (kind === 'write') {
      assert.equal(got.outcome, 'written', `${fid}: ${want}`);
      assert.ok(got.flags.some(f => /^abroad: text suggests working from abroad is fine/.test(f) && /Кипр\*/.test(f) && /Европ\*/.test(f)), `${fid}: abroad signal flagged`);
    } else if (kind === 'reject') {
      assert.equal(got.outcome, 'rejected', `${fid}: ${want}`);
      assert.equal(got.gate, gate, `${fid}: ${want}`);
    } else {
      assert.equal(got.outcome, 'unavailable', `${fid}: ${want}`);
      assert.match(got.reason, new RegExp(want.split(': ')[1]), `${fid}: ${want}`);
    }
  }
  // the written job
  const job = inboxJob(`https://hh.ru/vacancy/${p}01`);
  assert.ok(job, 'job written with the plain vacancy url');
  assert.equal(job.fm.company, 'Северный Ветер');
  assert.equal(job.fm.role, 'Менеджер продукта IoT');
  assert.equal(job.fm.source, 'hh');
  assert.equal(job.fm.location, 'Москва; удалённо');
  assert.equal(job.fm.salary, 'от 300 000 ₽ на руки');
  assert.equal(job.fm.notes, 'hh alert: подписка: менеджер продукта удалённо');
  assert.equal(job.fm.experience, '3–6 лет');
  assert.equal(job.fm.employment, 'Полная занятость');
  assert.equal(job.fm.posting_language, 'ru');
  assert.match(job.fm.gate_flags, /abroad/);
  assert.match(job.txt, /Удалённая работа из любой страны/);
  assert.doesNotMatch(job.txt, /Product management/, 'skills block is not part of the description');
  // only one job file from this email
  assert.equal(r.written, 1);
  // state: all four seen, nothing pending, last_run set
  const s = state();
  assert.deepEqual(Object.keys(s.seen).sort(), ['01', '02', '03', '04'].map(x => p + x));
  assert.deepEqual(s.pending, {});
  assert.equal(s.last_run, NOW.toISOString());
});

test('no key= link is ever requested, logged or stored; only https://hh.ru/vacancy/<id>, without following redirects', async () => {
  reset();
  const p = nextPrefix(), fetch = fakeFetch();
  const logs = [], orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try { await runWith({ gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch }); } finally { console.log = orig; }
  assert.equal(fetch.calls.length, 4);
  for (const c of fetch.calls) {
    assert.match(c.url, /^https:\/\/hh\.ru\/vacancy\/\d{6,}$/);
    assert.equal(c.opts.redirect, 'manual');
    assert.equal(c.opts.headers['Accept-Language'], 'ru,en;q=0.8');
  }
  assert.ok(!fetch.calls.some(c => /key=|applicant/.test(c.url)));
  const stored = fs.readFileSync(STATE_FILE, 'utf8') + fs.readdirSync(DIRS.inbox).map(f => fs.readFileSync(path.join(DIRS.inbox, f), 'utf8')).join('');
  assert.doesNotMatch(stored, /LOGIN-KEY|key=/);
  assert.doesNotMatch(logs.join('\n'), /LOGIN-KEY|key=/);
});

test('a redirect is not followed: the id is kept for the next run, not marked seen', async () => {
  reset();
  const p = nextPrefix(), fetch = fakeFetch({ [`${p}01`]: page(302, '', { location: `https://hh.ru/account/login?key=LOGIN-KEY-NEVER-FOLLOW` }) });
  const r = await runWith({ gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch });
  assert.equal(byId(r, `${p}01`).outcome, 'error');
  assert.match(byId(r, `${p}01`).reason, /redirected \(HTTP 302\), not followed/);
  assert.equal(fetch.calls.filter(c => c.url.includes('login')).length, 0);
  const s = state();
  assert.equal(s.seen[`${p}01`], undefined);
  assert.equal(s.pending[`${p}01`].tries, 1);
});

test('the Gmail search: sender, both subjects, first run looks back first_run_hours, then last run minus overlap_hours', async () => {
  reset();
  const gmail = fakeGmail([]);
  const r1 = await runWith({ gmail, fetch: fakeFetch() });
  assert.equal(r1.windowHours, 72);
  assert.equal(gmail.queries[0], `from:noreply@hh.ru (subject:"Вакансии по подписке" OR subject:"Подходящие вакансии") after:${Math.floor((NOW.getTime() - 72 * 3.6e6) / 1000)}`);
  const later = new Date(NOW.getTime() + 24 * 3.6e6);
  const r2 = await runWith({ gmail, fetch: fakeFetch(), now: later });
  assert.equal(r2.windowHours, 48, '24h since the last run + 24h overlap');
  assert.match(gmail.queries[1], new RegExp(`after:${Math.floor((later.getTime() - 48 * 3.6e6) / 1000)}$`));
  const muchLater = new Date(NOW.getTime() + 30 * 864e5);
  const r3 = await runWith({ gmail, fetch: fakeFetch(), now: muchLater });
  assert.equal(r3.windowHours, 168, 'never further back than max_lookback_hours');
  const r4 = await runWith({ gmail, fetch: fakeFetch(), now: muchLater, hours: 5 });
  assert.equal(r4.windowHours, 5, '--hours wins');
});

test('alert names: the subject with the prefix shortened', () => {
  assert.equal(hh.alertName('Вакансии по подписке: менеджер продукта удалённо'), 'подписка: менеджер продукта удалённо');
  assert.equal(hh.alertName('Вакансии по подписке «Product Owner»'), 'подписка: Product Owner');
  assert.equal(hh.alertName('Подходящие вакансии по вашему резюме «Менеджер продукта»'), 'резюме: Менеджер продукта');
  assert.equal(hh.alertName('Подходящие вакансии для вас'), 'резюме');
  assert.equal(hh.alertName(''), 'hh alert');
});

test('vacancy ids: every hh.ru/vacancy/<id> once, links to other pages ignored, the key never kept', () => {
  const p = '3234567';
  assert.deepEqual(hh.vacancyIds(emailHtml(p)), ['01', '02', '03', '04'].map(x => p + x));
  assert.deepEqual(hh.vacancyIds('<a href="https://spb.hh.ru/vacancy/76543210?key=x">a</a> <a href="https://hh.ru/vacancy/76543210">again</a>'), ['76543210']);
  assert.deepEqual(hh.vacancyIds('https://click.example/r?u=https%3A%2F%2Fhh.ru%2Fvacancy%2F88888888%3Fkey%3Dx'), ['88888888']);
  assert.deepEqual(hh.vacancyIds('https://hh.ru/vacancy/12345 is too short'), []);
});

test('the page parser reads every data-qa field and cuts the description before the skills block', () => {
  const v = hh.parseVacancy(fixture('vacancy-123456701.html'));
  assert.equal(v.title, 'Менеджер продукта IoT');
  assert.equal(v.company, 'Северный Ветер');
  assert.equal(v.city, 'Москва');
  assert.equal(v.formats, 'удалённо', '"Формат работы:" is stripped');
  assert.equal(v.salary, 'от 300 000 ₽ на руки');
  assert.equal(v.experience, '3–6 лет');
  assert.equal(v.employment, 'Полная занятость');
  assert.match(v.description, /^Удалённая работа из любой страны/);
  assert.match(v.description, /- Работать с командой разработки$/);
  assert.equal(v.archived, false);
  const a = hh.parseVacancy(fixture('vacancy-123456703.html'));
  assert.equal(a.archived, true, '"В архиве" in the title');
  assert.equal(a.title, 'Менеджер продукта');
  const archivist = hh.parseVacancy(fixture('vacancy-123456704.html').replace('>Менеджер продукта</h1>', '>Специалист по работе в архиве</h1>'));
  assert.deepEqual([archivist.title, archivist.archived], ['Специалист по работе в архиве', false], 'words in the title are not the archive label');
  assert.equal(hh.parseVacancy(fixture('vacancy-123456704.html').replace('<body>', '<body><script>{"archived": true}</script>')).archived, true);
  const raw = hh.parseVacancy(fixture('vacancy-123456704.html').replace('<p data-qa="vacancy-view-location">Москва</p>', '<p data-qa="vacancy-view-raw-address">Санкт-Петербург, Невский проспект, 1</p>'));
  assert.equal(raw.city, 'Санкт-Петербург', 'raw address first, city is its first part');
  const noEnd = hh.parseVacancy('<h1 data-qa="vacancy-title">X</h1><div data-qa="vacancy-description"><div><p>Текст</p></div></div><footer>Подвал</footer>');
  assert.equal(noEnd.description, 'Текст', 'with no end marker the description element itself is used');
  assert.deepEqual(hh.parseVacancy(''), { title: '', archived: false, company: '', city: '', formats: '', salary: '', experience: '', employment: '', description: '' });
});

test('remote, attendance, city -> country and language for the gates', () => {
  assert.equal(hh.isRemote('Менеджер продукта', 'удалённо'), true);
  assert.equal(hh.isRemote('Менеджер продукта (удаленно)', ''), true);
  assert.equal(hh.isRemote('Product manager, remote', ''), true);
  assert.equal(hh.isRemote('Менеджер', 'полностью удалённая работа'), true);
  assert.equal(hh.isRemote('Менеджер', 'на месте работодателя'), false);
  assert.deepEqual(hh.attendanceOf('на месте работодателя'), ['office']);
  assert.deepEqual(hh.attendanceOf('удалённо, гибрид'), ['remote', 'hybrid']);
  assert.deepEqual(hh.attendanceOf('разъездной'), [], 'an unknown format leaves attendance empty');
  assert.equal(hh.cityCountry('Москва'), 'RU');
  assert.equal(hh.cityCountry('санкт петербург'), 'RU');
  assert.equal(hh.cityCountry('Лимасол'), 'CY');
  assert.equal(hh.cityCountry('Saint Petersburg'), 'RU');
  assert.equal(hh.cityCountry('Cyprus'), 'CY', 'English country names through lib/gates.mjs');
  assert.equal(hh.cityCountry('Урюпинск'), null);
  assert.equal(hh.cityCountry('Урюпинск', { 'Урюпинск': 'ru' }), 'RU', 'settings city_countries');
  assert.equal(hh.postingLanguage('Менеджер продукта: развивать продукт'), 'ru');
  assert.equal(hh.postingLanguage('Product Owner. We build connected devices for the whole of Europe.'), null);
  const job = hh.gatesJob(hh.parseVacancy(fixture('vacancy-123456704.html')));
  assert.deepEqual(job.countries, ['RU']);
  assert.deepEqual(job.attendance, ['office']);
  assert.deepEqual(job.languages, ['ru']);
});

test('a missing or oddly written field never rejects: unknown city, no format, no company, an English page', async () => {
  reset();
  const p = nextPrefix();
  const odd = fixture('vacancy-123456704.html').replace('Москва</p>', 'Урюпинск</p>').replace(/<p data-qa="work-formats-text">[^<]*<\/p>/, '')
    .replace(/<a data-qa="vacancy-company-name"[^>]*>[^<]*<\/a>/, '').replace('Работа в офисе в Москве, пять дней в неделю.', 'Office work, details on request.')
    .replace(/<li>[^<]*<\/li>/g, '<li>Build the product</li>');
  const fetch = fakeFetch({ [`${p}04`]: page(200, odd) });
  const r = await runWith({ ids: [`${p}04`], fetch });
  assert.equal(byId(r, `${p}04`).outcome, 'written');
  assert.equal(inboxJob(`https://hh.ru/vacancy/${p}04`).fm.company, 'Unknown');
});

test('hh checks: title_include and title_exclude skip (marked seen), tax residency flags, no abroad signal asks to confirm', async () => {
  reset();
  const p = nextPrefix();
  SETTINGS.sources.hh_alerts = { ...BASE_CFG, title_exclude: ['IoT'] };
  let r = await runWith({ ids: [`${p}01`], fetch: fakeFetch() });
  assert.deepEqual([byId(r, `${p}01`).outcome, byId(r, `${p}01`).reason], ['skipped', 'title excluded']);
  assert.ok(state().seen[`${p}01`]);
  SETTINGS.sources.hh_alerts = { ...BASE_CFG, title_include: ['аналитик', 'analyst'] };
  r = await runWith({ ids: [`${p}04`], fetch: fakeFetch() });
  assert.deepEqual([byId(r, `${p}04`).outcome, byId(r, `${p}04`).reason], ['skipped', 'title not included']);
  SETTINGS.sources.hh_alerts = { ...BASE_CFG, title_include: ['product owner'] };
  const taxed = fixture('vacancy-123456702.html').replace('кандидат должен находиться на территории РФ', 'нужен статус: налоговый резидент РФ');
  r = await runWith({ ids: [`${p}02`], fetch: fakeFetch({ [`${p}02`]: page(200, taxed) }) });
  const got = byId(r, `${p}02`);
  assert.equal(got.outcome, 'written');
  assert.ok(got.flags.includes('abroad: confirm working from your country is allowed'));
  assert.ok(got.flags.some(f => /^tax residency: text says "налоговый резидент\*"/.test(f)));
  // abroad and must-reside phrases concern remote jobs only; an empty abroad list adds no flag
  const v = hh.parseVacancy(fixture('vacancy-123456704.html').replace('Работа в офисе', 'Работа в офисе, находиться на территории РФ'));
  assert.deepEqual(hh.sourceChecks(v, { ...BASE_CFG }), { flags: [] });
  assert.deepEqual(hh.sourceChecks(hh.parseVacancy(fixture('vacancy-123456701.html')), { ...BASE_CFG, abroad_signals: [] }), { flags: [] });
});

test('a single 403 is a hidden vacancy (seen); the run goes on', async () => {
  reset();
  const p = nextPrefix();
  const r = await runWith({ gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch: fakeFetch({ [`${p}01`]: page(403) }) });
  assert.equal(byId(r, `${p}01`).outcome, 'unavailable');
  assert.equal(r.stopped, null);
  assert.equal(r.fetched, 4);
  assert.ok(state().seen[`${p}01`]);
});

test('two 403s in a row: throttled, the run stops and neither they nor the rest are marked seen', async () => {
  reset();
  const p = nextPrefix(), fetch = fakeFetch({ [`${p}02`]: page(403), [`${p}03`]: page(403) });
  const r = await runWith({ gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch });
  assert.match(r.stopped, /two 403s in a row/);
  assert.equal(fetch.calls.length, 3, 'nothing fetched after the stop');
  const s = state();
  assert.deepEqual(Object.keys(s.seen), [`${p}01`]);
  assert.deepEqual(Object.keys(s.pending).sort(), [`${p}02`, `${p}03`, `${p}04`]);
  assert.deepEqual(['02', '03', '04'].map(x => byId(r, p + x).outcome), ['deferred', 'deferred', 'deferred']);
  assert.equal(r.skipped['hidden (403)'], undefined, 'the first 403 is not counted as hidden');
});

test('a 429 stops the run; what is left is tried first on the next run, with its alert names', async () => {
  reset();
  const p = nextPrefix(), fetch = fakeFetch({ [`${p}02`]: page(429) });
  const r = await runWith({ gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch });
  assert.match(r.stopped, /HTTP 429/);
  assert.equal(fetch.calls.length, 2);
  const s = state();
  assert.deepEqual(Object.keys(s.seen), [`${p}01`]);
  assert.deepEqual(s.pending[`${p}02`], { since: '2026-10-01', alerts: ['подписка: менеджер продукта удалённо'], tries: 0 });
  assert.equal(s.last_run, NOW.toISOString(), 'every email was read, so the window moves on; the ids are in pending');
  // next run: a new email with nothing in it; the pending ids still come back, before anything new
  const fetch2 = fakeFetch();
  const r2 = await runWith({ gmail: fakeGmail([message('m2', SUBJECT, '<p>пусто</p>')]), fetch: fetch2, now: new Date(NOW.getTime() + 864e5) });
  assert.deepEqual(fetch2.calls.map(c => c.url.slice(-2)), ['02', '03', '04']);
  assert.equal(byId(r2, `${p}02`).outcome, 'rejected');
  assert.equal(inboxJob(`https://hh.ru/vacancy/${p}01`).fm.notes, 'hh alert: подписка: менеджер продукта удалённо');
  assert.deepEqual(state().pending, {});
});

test('three pages in a row without a title or description: layout changed, stop, none of them seen', async () => {
  reset();
  const p = nextPrefix(), blank = page(200, '<html><body><p>Что-то пошло не так</p></body></html>');
  const ids = ['01', '02', '03', '04'].map(x => p + x);
  // one blank page alone is unavailable and seen
  let r = await runWith({ ids: [ids[0]], fetch: fakeFetch({ [ids[0]]: blank }) });
  assert.deepEqual([byId(r, ids[0]).outcome, byId(r, ids[0]).reason], ['unavailable', 'no title or description']);
  assert.ok(state().seen[ids[0]]);
  reset();
  const fetch = fakeFetch({ [ids[0]]: blank, [ids[1]]: blank, [ids[2]]: blank });
  r = await runWith({ gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch });
  assert.match(r.stopped, /page layout probably changed/);
  assert.equal(fetch.calls.length, 3);
  const s = state();
  assert.deepEqual(s.seen, {});
  assert.deepEqual(Object.keys(s.pending).sort(), ids);
  assert.deepEqual(r.skipped, {});
});

test('one email that cannot be read does not stop the run; state is saved and the window does not move', async () => {
  reset();
  const p = nextPrefix(), gmail = fakeGmail([message('bad', SUBJECT, ''), message('m1', SUBJECT, emailHtml(p))], { failGet: ['bad'] });
  const r = await runWith({ gmail, fetch: fakeFetch() });
  assert.equal(r.emailErrors, 1);
  assert.equal(r.written, 1);
  const s = state();
  assert.equal(Object.keys(s.seen).length, 4);
  assert.equal(s.last_run, null, 'the next run reads the unread email again');
});

test('a Gmail search that fails still tries the pending ids and does not move the window', async () => {
  reset();
  const p = nextPrefix();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ last_run: '2026-09-30T18:00:00.000Z', seen: {}, pending: { [`${p}01`]: { since: '2026-09-30', alerts: ['подписка: x'], tries: 0 } } }));
  const r = await runWith({ gmail: { list: async () => { throw new Error('Gmail GET /messages failed: 500'); } }, fetch: fakeFetch() });
  assert.equal(r.searchFailed, true);
  assert.equal(byId(r, `${p}01`).outcome, 'written');
  assert.equal(state().last_run, '2026-09-30T18:00:00.000Z');
});

test('one vacancy that fails does not stop the run; it is retried up to 3 runs, then dropped without being seen', async () => {
  reset();
  const p = nextPrefix(), boom = () => { throw new Error('fetch failed'); };
  const gmail = fakeGmail([message('m1', SUBJECT, emailHtml(p))]);
  let r = await runWith({ gmail, fetch: fakeFetch({ [`${p}01`]: boom }) });
  assert.equal(byId(r, `${p}01`).outcome, 'error');
  assert.equal(byId(r, `${p}02`).outcome, 'rejected', 'the next vacancy is still handled');
  assert.equal(state().pending[`${p}01`].tries, 1);
  for (let i = 1; i <= 2; i++) await runWith({ gmail, fetch: fakeFetch({ [`${p}01`]: boom }), now: new Date(NOW.getTime() + i * 864e5) });
  const s = state();
  assert.equal(s.pending[`${p}01`], undefined, 'dropped after 3 tries');
  assert.equal(s.seen[`${p}01`], undefined, 'never marked seen');
  // an error after the fetch (here, in the gates) is handled the same way
  reset();
  r = await runWith({ ids: [`${p}01`, `${p}02`], fetch: fakeFetch(), check: () => { throw new Error('gates exploded'); } });
  assert.deepEqual(r.results.map(x => x.outcome), ['error', 'rejected']);
  assert.equal(state().seen[`${p}01`], undefined);
});

test('demoted jobs go to demoted.jsonl, are not marked seen and not kept pending', async () => {
  reset();
  const p = nextPrefix();
  const r = await runWith({ gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch: fakeFetch(),
    check: () => ({ decision: 'demote', gate: 'headcount', reason: '5000+ people (over 1000)', flags: [] }) });
  assert.equal(byId(r, `${p}01`).outcome, 'demoted');
  const lines = fs.readFileSync(DEMOTED, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.some(l => l.url === `https://hh.ru/vacancy/${p}01` && l.source === 'hh' && l.gate === 'headcount'));
  const s = state();
  assert.equal(s.seen[`${p}01`], undefined);
  assert.equal(s.pending[`${p}01`], undefined);
  assert.equal(s.seen[`${p}02`], '2026-10-01', 'the hh must-reside reject comes before the gates and is final');
});

test('--dry-run writes nothing: no job, no state, no demoted.jsonl', async () => {
  reset();
  const p = nextPrefix(), before = fs.readdirSync(DIRS.inbox).length;
  const r = await runWith({ dryRun: true, gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch: fakeFetch({ [`${p}03`]: page(429) }),
    check: () => ({ decision: 'demote', gate: 'headcount', reason: 'x', flags: [] }) });
  assert.equal(r.fetched, 3);
  assert.equal(fs.readdirSync(DIRS.inbox).length, before);
  assert.equal(fs.existsSync(STATE_FILE), false);
  assert.equal(fs.existsSync(DEMOTED), false);
  const r2 = await runWith({ dryRun: true, gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch: fakeFetch() });
  assert.equal(r2.written, 1, 'counted as it would be written');
  assert.equal(fs.readdirSync(DIRS.inbox).length, before);
  assert.equal(fs.existsSync(STATE_FILE), false);
});

test('--ids fetches the given vacancies without Gmail, even ones seen before, and keeps nothing pending', async () => {
  reset();
  const p = nextPrefix();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ last_run: null, seen: { [`${p}01`]: '2026-09-30' }, pending: {} }));
  const gmail = { list: async () => assert.fail('Gmail must not be read'), get: async () => assert.fail('Gmail must not be read') };
  const fetch = fakeFetch({ [`${p}02`]: page(429) });
  const r = await runWith({ ids: [`${p}01`, `${p}02`], gmail, fetch });
  assert.deepEqual(fetch.calls.map(c => c.url), [`https://hh.ru/vacancy/${p}01`, `https://hh.ru/vacancy/${p}02`]);
  assert.equal(byId(r, `${p}01`).outcome, 'written');
  assert.equal(inboxJob(`https://hh.ru/vacancy/${p}01`).fm.notes, 'hh alert: --ids');
  const s = state();
  assert.deepEqual(s.pending, {});
  assert.equal(s.last_run, null, '--ids does not move the window');
});

test('pages are fetched at least 2 seconds apart and at most max_fetch per run; the rest waits in pending', async () => {
  reset();
  const p = nextPrefix(), sleep = noSleep();
  SETTINGS.sources.hh_alerts = { ...BASE_CFG, delay_ms: 500, max_fetch: 2 };
  const r = await runWith({ gmail: fakeGmail([message('m1', SUBJECT, emailHtml(p))]), fetch: fakeFetch(), sleep });
  assert.equal(r.fetched, 2);
  assert.deepEqual(sleep.calls, [2000]);
  assert.deepEqual(Object.keys(state().pending).sort(), [`${p}03`, `${p}04`]);
  SETTINGS.sources.hh_alerts = { ...BASE_CFG, delay_ms: 'oops', max_fetch: 'lots' };
  const sleep2 = noSleep();
  await runWith({ gmail: fakeGmail([]), fetch: fakeFetch(), sleep: sleep2 });
  assert.deepEqual(sleep2.calls, [3000], 'a typo falls back to the defaults');
});

test('seen ids older than 120 days and pending ids older than 14 days are dropped', async () => {
  reset();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ last_run: NOW.toISOString(), seen: { 11111111: '2026-01-01', 22222222: '2026-09-01' },
    pending: { 33333333: { since: '2026-09-01', alerts: [], tries: 0 } } }));
  const fetch = fakeFetch();
  await runWith({ gmail: fakeGmail([]), fetch, now: new Date(NOW.getTime() + 1000), check: () => ({ decision: 'pass', flags: [] }) });
  const s = state();
  assert.deepEqual(Object.keys(s.seen), ['22222222']);
  assert.equal(s.pending[33333333], undefined);
  assert.equal(fetch.calls.length, 0, 'an expired pending id is not fetched again');
});

test('a broken state file is kept aside, not silently replaced', async () => {
  reset();
  fs.writeFileSync(STATE_FILE, '{ not json');
  await runWith({ gmail: fakeGmail([]), fetch: fakeFetch() });
  assert.ok(fs.readdirSync(DIRS.state).some(f => f.startsWith('hh-alerts.json.broken-')));
  assert.equal(state().last_run, NOW.toISOString());
});

test('disabled: nothing is read or written', async () => {
  reset();
  SETTINGS.sources.hh_alerts = { ...BASE_CFG, enabled: false };
  const gmail = { list: async () => assert.fail('no Gmail'), get: async () => assert.fail('no Gmail') };
  const r = await runWith({ gmail, fetch: async () => assert.fail('no fetch') });
  assert.equal(r.ran, false);
  assert.equal(fs.existsSync(STATE_FILE), false);
  delete SETTINGS.sources.hh_alerts;
  assert.equal((await runWith({ gmail, fetch: async () => assert.fail('no fetch') })).ran, false);
});

test('messageHtml returns the HTML part, with links intact', () => {
  const html = '<a href="https://hh.ru/vacancy/12345678">x</a>';
  assert.equal(messageHtml(message('m', SUBJECT, html).payload), html);
  assert.equal(messageHtml({ mimeType: 'text/plain', body: { data: b64('https://hh.ru/vacancy/12345678') } }), 'https://hh.ru/vacancy/12345678');
});

test('doctor: Gmail access and the language gate are checked when hh_alerts is on', async () => {
  const { spawnSync } = await import('node:child_process');
  const doctor = settings => {
    const file = path.join(tmp, 'settings-doctor.json');
    fs.writeFileSync(file, JSON.stringify(settings));
    const env = { ...process.env, JOBPILOT_SETTINGS: file };
    for (const k of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) delete env[k];
    return spawnSync(process.execPath, [path.join(HERE, '..', 'cli.mjs'), 'doctor'], { encoding: 'utf8', env, timeout: 60000 }).stdout;
  };
  let out = doctor({ sources: { hh_alerts: { enabled: true } }, gates: { languages: ['en', 'es'] } });
  assert.match(out, /TODO Gmail read-only access \(hh\.ru alerts\)/);
  assert.match(out, /TODO hh\.ru alerts: language gate .*add "ru"/);
  assert.match(out, /sources enabled: hh_alerts/);
  assert.doesNotMatch(out, /unknown source/);
  out = doctor({ sources: { hh_alerts: { enabled: true } }, gates: { languages: ['en', 'ru-RU'] } });
  assert.match(out, /ok {3}hh\.ru alerts: language gate/);
  out = doctor({ sources: { hh_alerts: { enabled: false } } });
  assert.doesNotMatch(out, /hh\.ru/, 'nothing changes for anyone who leaves the source off');
});

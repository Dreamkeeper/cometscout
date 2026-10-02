// The workspace's browser logic (web/lib/*.js has no DOM, so it runs here): filtering and grouping, ordering after an
// action, the keyboard map, label lookup, formatting, the API client against a fake fetch. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../web/lib/logic.js';
import { keyAction, KEYMAP, KEY_HELP, trapTab } from '../web/lib/keys.js';
import { makeT } from '../web/lib/labels.js';
import { createApi, ApiError } from '../web/lib/api.js';

const it = (file, extra = {}) => ({ file, company: file.toUpperCase(), role: 'Product Manager', location: 'Remote', source: 'ats_boards', verdict: 'strong-fit', apply_priority: 2, pack: null, later_until: null, application: null, ...extra });
const today = {
  date: '2026-10-02',
  picks: [it('a', { pack: 'p-a' }), it('b', { source: 'rtj', location: 'Málaga, Spain' })],
  pool: [it('c', { verdict: 'investable-stretch' }), it('d'), it('e', { later_until: '2026-10-05' }), it('f', { verdict: 'long-shot' }), it('g', { later_until: '2026-10-02', verdict: 'something-new' })],
};

test('groups: picks first in their order, then the pool by verdict, best first; empty groups left out', () => {
  const g = L.groupItems(today, L.DEFAULT_FILTERS);
  assert.deepEqual(g.map(x => x.key), ['picks', 'verdict:strong-fit', 'verdict:investable-stretch', 'verdict:long-shot', 'verdict:something-new']);
  assert.deepEqual(L.order(g), ['a', 'b', 'd', 'c', 'f', 'g'], 'e is put off until after today; g came back today');
  assert.deepEqual(L.order(L.groupItems(today, { ...L.DEFAULT_FILTERS, hideLater: false })), ['a', 'b', 'd', 'e', 'c', 'f', 'g']);
  assert.deepEqual(L.groupItems(null, L.DEFAULT_FILTERS), []);
  assert.deepEqual(L.groupItems({ date: 'x', picks: [], pool: [] }, L.DEFAULT_FILTERS), []);
});

test('filters: search words (accents folded), source, verdict, has pack', () => {
  const f = patch => L.order(L.groupItems(today, { ...L.DEFAULT_FILTERS, ...patch }));
  assert.deepEqual(f({ q: 'malaga' }), ['b']);
  assert.deepEqual(f({ q: 'MÁLAGA spain' }), ['b']);
  assert.deepEqual(f({ q: 'malaga berlin' }), [], 'every word must match');
  assert.deepEqual(f({ source: 'rtj' }), ['b']);
  assert.deepEqual(f({ verdict: 'investable-stretch' }), ['c']);
  assert.deepEqual(f({ hasPack: true }), ['a']);
  assert.deepEqual(f({ q: '   ' }), ['a', 'b', 'd', 'c', 'f', 'g']);
  assert.equal(L.isLater({ later_until: '2026-10-03' }, '2026-10-02'), true);
  assert.equal(L.isLater({ later_until: '2026-10-02' }, '2026-10-02'), false);
  assert.equal(L.isLater({ later_until: null }, '2026-10-02'), false);
  assert.deepEqual(L.optionsOf(today, 'source'), ['ats_boards', 'rtj']);
});

test('j/k stepping and the job that opens after an action', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(L.stepFile(list, 'a', 1), 'b');
  assert.equal(L.stepFile(list, 'c', 1), 'c', 'stays at the end');
  assert.equal(L.stepFile(list, 'a', -1), 'a');
  assert.equal(L.stepFile(list, null, 1), 'a');
  assert.equal(L.stepFile(list, null, -1), 'c');
  assert.equal(L.stepFile([], 'a', 1), null);
  assert.equal(L.nextAfterAction(['a', 'b', 'c'], 'b', ['a', 'c']), 'c', 'the next one when the job left the list');
  assert.equal(L.nextAfterAction(['a', 'b', 'c'], 'b', ['a', 'b', 'c']), 'c', 'the next one when it stays (an applied pick)');
  assert.equal(L.nextAfterAction(['a', 'b', 'c'], 'c', ['a', 'b']), 'b', 'the one before at the end');
  assert.equal(L.nextAfterAction(['a', 'b'], 'b', ['b']), 'b', 'the job itself when it is the only one left');
  assert.equal(L.nextAfterAction(['a'], 'a', []), null);
  assert.equal(L.nextAfterAction(['a'], 'x', ['q']), 'q');
});

test('keyboard map: main keys, dialogs, typing and modifiers', () => {
  const k = (key, mode, extra = {}) => keyAction({ key, ...extra }, mode);
  for (const [key, action] of Object.entries({ j: 'next', k: 'prev', a: 'applied', s: 'skip', l: 'later', o: 'open', '/': 'search', '?': 'help', Escape: 'close' })) assert.deepEqual(k(key), { action }, key);
  assert.deepEqual(k('J'), { action: 'next' }, 'caps lock still works');
  assert.equal(k('x'), null);
  assert.equal(k('a', 'main', { ctrlKey: true }), null, 'ctrl+a is the browser\'s');
  assert.equal(k('a', 'main', { metaKey: true }), null);
  assert.equal(k('j', 'main', { tag: 'INPUT' }), null, 'typing in the search box');
  assert.equal(k('s', 'main', { tag: 'textarea' }), null);
  assert.equal(k('a', 'main', { editable: true }), null);
  assert.deepEqual(k('Escape', 'main', { tag: 'INPUT' }), { action: 'close' }, 'Escape leaves the field');
  assert.deepEqual(k('2', 'skip'), { action: 'skip-reason', index: 1 });
  assert.equal(k('9', 'skip'), null);
  assert.equal(k('a', 'skip'), null, 'no main keys while a dialog is open');
  assert.deepEqual(k('3', 'later'), { action: 'later-days', days: 3 });
  assert.equal(k('2', 'later'), null);
  assert.deepEqual(k('?', 'help'), { action: 'close' });
  assert.equal(k('j', 'help'), null);
  assert.equal(keyAction(null), null);
  assert.deepEqual(KEY_HELP.map(([key]) => key).filter(x => x !== 'Esc').sort(), Object.keys(KEYMAP).filter(x => x !== 'Escape').sort(), 'the help lists every key');
});

test('labels: placeholders, fallbacks, verdict and status names', () => {
  const t = makeT({ 'ws.empty': 'No picks today; {open} open in the pool.', 'verdict.strong-fit': 'Strong fit', 'ws.status.applied': 'Applied' });
  assert.equal(t('ws.empty', { open: 4 }), 'No picks today; 4 open in the pool.');
  assert.equal(t('ws.empty'), 'No picks today; {open} open in the pool.', 'a missing value keeps the placeholder');
  assert.equal(t('ws.retry'), 'Try again', 'built-in fallback before the table loads');
  assert.equal(t('ws.unknown'), 'ws.unknown');
  assert.equal(L.verdictName('strong-fit', t), 'Strong fit');
  assert.equal(L.verdictName('brand-new', t), 'brand-new');
  assert.equal(L.verdictName(null, t), '');
  assert.equal(L.statusName('applied', t), 'Applied');
  assert.equal(L.statusName('withdrawn', t), 'withdrawn');
});

test('formatting: dates, tones, skip notes, lint hits, job text', () => {
  assert.equal(L.formatDate('2026-10-02', 'en'), 'Oct 2');
  assert.match(L.formatDate('2026-10-02', 'ru'), /^2 окт/);
  assert.equal(L.formatDate('2026-10-02T18:20:00Z', 'en'), 'Oct 2');
  assert.equal(L.formatDate('soon', 'en'), 'soon');
  assert.equal(L.formatDate(null, 'en'), '');
  assert.equal(L.daysBetween('2026-09-30', '2026-10-02'), 2);
  assert.equal(L.verdictTone('strong-fit'), 'good');
  assert.equal(L.verdictTone('gate-reject'), 'bad');
  assert.equal(L.verdictTone('x'), 'muted');
  assert.equal(L.skipNote('too_senior'), 'too senior');
  assert.equal(L.skipNote('other', '  agency   repost '), 'other: agency repost');
  assert.equal(L.skipNote('nonsense'), 'other');
  assert.equal(L.SKIP_REASONS.length, 8);
  assert.deepEqual(L.LATER_CHOICES, [1, 3, 7]);
  assert.deepEqual(L.lintHits({ lint: { cv: { errors: [{ id: 'first-pm', match: 'first PM', why: 'w' }], warns: [] }, cover_letter: { errors: [], warns: [{ id: 'fluff', match: 'passionate' }] },
    answers: [{ field: 'Why us?', errors: [], warns: [{ id: 'fluff', match: 'synergy', why: '' }] }] } }), [
    { kind: 'cv', field: '', level: 'error', id: 'first-pm', match: 'first PM', why: 'w' },
    { kind: 'cover_letter', field: '', level: 'warn', id: 'fluff', match: 'passionate', why: '' },
    { kind: 'answer', field: 'Why us?', level: 'warn', id: 'fluff', match: 'synergy', why: '' }]);
  assert.deepEqual(L.lintHits(null), []);
  assert.equal(L.bodyText('# Acme - PM\n\nThe job.\n'), 'The job.');
  assert.deepEqual(L.findItem(today, 'c').verdict, 'investable-stretch');
  assert.equal(L.findItem(today, 'zz'), null);
});

test('the API client: JSON, the X-Jobpilot header on writes, errors with the server\'s message, a job without a pack', async () => {
  const calls = [];
  const fake = async (url, opt = {}) => {
    calls.push({ url, opt });
    if (url === '/api/pack?file=x.md') return { ok: true, status: 200, json: async () => ({ file: 'x.md', dir: null, pack: null }) };
    if (url.startsWith('/api/pack')) return { ok: false, status: 404, json: async () => ({ error: 'no such job' }) };
    if (url === '/api/status') return { ok: false, status: 409, json: async () => ({ error: 'applications.json is not valid JSON' }) };
    if (url === '/api/broken') return { ok: false, status: 500, json: async () => { throw new Error('not json'); } };
    return { ok: true, status: 200, json: async () => ({ url }) };
  };
  const api = createApi({ fetch: fake });
  assert.deepEqual(await api.today(), { url: '/api/today' });
  assert.deepEqual(await api.job('2026-10-02--a b.md'), { url: '/api/job?file=2026-10-02--a%20b.md' });
  assert.deepEqual(await api.pack('x.md'), { file: 'x.md', dir: null, pack: null }, 'no pack is an answer, not an error');
  await assert.rejects(api.pack('gone.md'), e => e.status === 404 && /no such job/.test(e.message), 'an unknown job is an error');
  await assert.rejects(api.status('x.md', 'skipped', 'too senior'), e => e instanceof ApiError && e.status === 409 && /not valid JSON/.test(e.message));
  const w = calls.find(c => c.url === '/api/status');
  assert.equal(w.opt.method, 'POST');
  assert.equal(w.opt.headers['X-Jobpilot'], '1');
  assert.equal(w.opt.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(w.opt.body), { file: 'x.md', status: 'skipped', note: 'too senior' });
  await api.later('x.md', 3);
  assert.deepEqual(JSON.parse(calls.at(-1).opt.body), { file: 'x.md', days: 3 });
  assert.equal(calls.find(c => c.url === '/api/today').opt.method, undefined, 'reads are plain GETs');
  const down = createApi({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(down.today(), e => e.status === 0 && e.message === 'Failed to fetch');
  const odd = createApi({ fetch: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }) });
  await assert.rejects(odd.labels(), /HTTP 502/);
});

test('after an action on the only listed job, that job stays selected and its decode is fetched again', () => {
  assert.equal(L.nextAfterAction(['x'], 'x', ['x']), 'x');
  const jobs = { x: { data: { file: 'x' } } }, packs = { x: { data: { dir: null, pack: null } } };
  assert.deepEqual(L.toLoad('x', jobs, packs), { job: false, pack: false }, 'loaded: nothing to fetch');
  const { x: _dropped, ...afterAction } = jobs;   // act() drops the acted-on job's decode
  assert.deepEqual(L.toLoad('x', afterAction, packs), { job: true, pack: false }, 'the same selection asks for the decode again');
  assert.deepEqual(L.toLoad('x', afterAction, packs, new Set(['job:x'])), { job: false, pack: false }, 'not twice while it loads');
  assert.deepEqual(L.toLoad('y', jobs, packs), { job: true, pack: true });
  assert.deepEqual(L.toLoad(null, {}, {}), { job: false, pack: false });
});

test('the picks title names the picks date when it is not today', () => {
  const t = makeT({ 'ws.picks': "Today's picks ({n})", 'ws.picks_of': 'Picks of {date} ({n})' });
  assert.equal(L.picksTitle({ date: '2026-10-02', picks_date: '2026-10-02' }, 2, t), "Today's picks (2)");
  assert.equal(L.picksTitle({ date: '2026-10-02', picks_date: '2026-10-01' }, 2, t, 'en'), 'Picks of Oct 1 (2)');
  assert.equal(L.picksTitle({ date: '2026-10-02', picks_date: null }, 0, t), "Today's picks (0)");
});

test('filters are remembered without the search text', () => {
  const f = { q: 'acme', source: 'rtj', verdict: 'strong-fit', hasPack: true, hideLater: false };
  assert.deepEqual(L.filtersToSave(f), { source: 'rtj', verdict: 'strong-fit', hasPack: true, hideLater: false });
  assert.deepEqual(L.filtersFromSaved(L.filtersToSave(f)), { ...f, q: '' });
  assert.deepEqual(L.filtersFromSaved({ q: 'old search', source: 5, hideLater: 'yes', extra: 1 }), L.DEFAULT_FILTERS, 'wrong types and the search are ignored');
  assert.deepEqual(L.filtersFromSaved(null), L.DEFAULT_FILTERS);
});

test('the pack view: pack.json when there is one; answers.md otherwise, never claiming what no file recorded', () => {
  assert.equal(L.packView({ file: 'x', dir: null, pack: null }), null);
  assert.equal(L.packView({ dir: 'd', pack: { flags: [], answers: [] } }).hits, null, 'a pack.json without a lint record claims no lint result');
  const full = L.packView({ dir: 'd', pack: { flags: [], answers: [{ field: 'Why?', answer: 'A' }], lint: { cv: { errors: [], warns: [] } }, raw: { positioning: 'P' }, built: '2026-10-02T18:00:00Z' } });
  assert.deepEqual(full, { fromMd: false, flags: [], hits: [], answers: [{ field: 'Why?', answer: 'A' }], positioning: 'P', built: '2026-10-02T18:00:00Z' }, 'with pack.json an empty list means nothing was flagged');
  const md = L.packView({ dir: 'd', pack: null, from_answers: { flags: ['Check the dates.'], answers: [{ field: 'Why?', answer: 'B', own_words: true }], positioning: null } });
  assert.equal(md.fromMd, true);
  assert.deepEqual(md.flags, ['Check the dates.']);
  assert.equal(md.hits, null, 'no lint record: unknown, not clean');
  const bare = L.packView({ dir: 'd', pack: null, from_answers: { flags: null, answers: null } });
  assert.equal(bare.flags, null, 'no "Check before sending" section: unknown, not "nothing flagged"');
  assert.equal(bare.answers, null);
});

test('Tab inside a dialog wraps at both ends', () => {
  assert.equal(trapTab(3, 0), 1);
  assert.equal(trapTab(3, 2), 0, 'Tab on the last goes to the first');
  assert.equal(trapTab(3, 0, true), 2, 'Shift+Tab on the first goes to the last');
  assert.equal(trapTab(3, -1), 0, 'focus outside the dialog comes back in');
  assert.equal(trapTab(3, -1, true), 2);
  assert.equal(trapTab(0, 0), -1);
});

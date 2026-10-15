// lib/rtj.mjs: the search works before and after RTJ's rename to snake_case (2026-10-17), pages through either cursor
// style, caps the page size at the API's maximum, and prunes old position ids. A fake API; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAll, searchBody, nextCursorOf, wrongStyle, pruneSeen, MAX_PAGE_SIZE } from '../lib/rtj.mjs';

/** A fake RTJ that accepts one style and answers in it; pages of the given position ids. */
function fakeRtj(style, pages) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    const wrong = style === 'snake' ? 'pageSize' : 'page_size';
    if (wrong in body) return { ok: false, status: 400, text: async () => JSON.stringify({ message: `Invalid position search request: ${style === 'snake' ? 'page_size' : 'pageSize'}: Invalid input: expected number, received undefined; request: Unrecognized key: "${wrong}"` }) };
    const i = body.cursor ? Number(body.cursor.slice(1)) : 0;
    const next = i + 1 < pages.length ? `c${i + 1}` : null;
    const out = { positions: pages[i].map(id => ({ position: { id, title: `Role ${id}` } })), [style === 'snake' ? 'next_cursor' : 'nextCursor']: next };
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  return { fetch, calls };
}
const window = { token: 't', after: '2026-10-15T00:00:00.000Z', before: '2026-10-16T00:00:00.000Z', pageSize: 100, maxPages: 5 };

test('after the rename: snake_case works first time and pages through next_cursor', async () => {
  const api = fakeRtj('snake', [['a', 'b'], ['c']]);
  const r = await searchAll({ ...window, fetch: api.fetch });
  assert.deepEqual(r.positions.map(p => p.position.id), ['a', 'b', 'c']);
  assert.equal(r.style, 'snake'); assert.equal(r.retried, false); assert.equal(r.truncated, false);
  assert.deepEqual(api.calls.map(c => [c.page_size, c.cursor]), [[100, undefined], [100, 'c1']]);
});

test('before the rename: a 400 naming pageSize switches to camelCase once, for every page', async () => {
  const api = fakeRtj('camel', [['a'], ['b'], ['c']]);
  const lines = [];
  const r = await searchAll({ ...window, fetch: api.fetch, log: l => lines.push(l) });
  assert.deepEqual(r.positions.map(p => p.position.id), ['a', 'b', 'c']);
  assert.equal(r.style, 'camel'); assert.equal(r.retried, true);
  assert.equal(api.calls.length, 4, 'one refused request, then three pages');
  assert.ok('page_size' in api.calls[0] && api.calls.slice(1).every(c => 'pageSize' in c && !('page_size' in c)));
  assert.match(lines.join('\n'), /camel case/);
});

test('any other error is thrown, and a wrong style is retried only once', async () => {
  const down = async () => ({ ok: false, status: 503, text: async () => 'maintenance' });
  await assert.rejects(searchAll({ ...window, fetch: down }), /RTJ 503: maintenance/);
  let n = 0;
  const neither = async () => { n++; return { ok: false, status: 400, text: async () => 'pageSize: expected number' }; };
  await assert.rejects(searchAll({ ...window, fetch: neither }), /RTJ 400/);
  assert.equal(n, 2, 'snake, then camel, then give up');
});

test('max pages leaves the search truncated; the page size never exceeds the API maximum', async () => {
  const api = fakeRtj('snake', [['a'], ['b'], ['c']]);
  const r = await searchAll({ ...window, pageSize: 999, maxPages: 2, fetch: api.fetch });
  assert.equal(r.truncated, true); assert.equal(r.positions.length, 2);
  assert.equal(api.calls[0].page_size, MAX_PAGE_SIZE);
});

test('helpers: request bodies, cursors in both styles, the wrong-style signal, pruning seen ids', () => {
  assert.deepEqual(searchBody({ after: 'a', before: 'b', pageSize: 10 }), { after: 'a', before: 'b', page_size: 10 });
  assert.deepEqual(searchBody({ after: 'a', before: 'b', pageSize: 10, cursor: 'x' }, 'camel'), { after: 'a', before: 'b', pageSize: 10, cursor: 'x' });
  assert.equal(nextCursorOf({ next_cursor: 's' }), 's'); assert.equal(nextCursorOf({ nextCursor: 'c' }), 'c'); assert.equal(nextCursorOf({ next_cursor: null }), null);
  assert.equal(wrongStyle(400, 'page_size: Invalid input'), true); assert.equal(wrongStyle(400, 'after: Invalid date'), false); assert.equal(wrongStyle(401, 'pageSize'), false);
  assert.deepEqual(pruneSeen({ old: '2026-06-01', recent: '2026-10-01', bad: 5 }, '2026-10-15', 90), { recent: '2026-10-01' });
  assert.deepEqual(pruneSeen(undefined, '2026-10-15'), {});
});

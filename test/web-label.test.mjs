// The labelling screen's browser logic (web/lib/label.js, no DOM) and its API calls (web/lib/api.js against a fake
// fetch): keys on Latin and Cyrillic layouts, typing in the reason field, Unsure needing a reason, where a save goes
// next, progress, the set from the URL. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelKey, canSave, afterSave, progress, step, setFromSearch, rubricBlocks } from '../web/lib/label.js';
import { createApi } from '../web/lib/api.js';

test('keys: Y N U choose (by key or by code), Enter saves, arrows move, a field takes letters and arrows', () => {
  assert.deepEqual(labelKey({ key: 'y' }), { action: 'choose', surface: 'yes' });
  assert.deepEqual(labelKey({ key: 'N' }), { action: 'choose', surface: 'no' });
  assert.deepEqual(labelKey({ key: 'г', code: 'KeyU' }), { action: 'choose', surface: 'unsure' }, 'a Cyrillic layout');
  assert.deepEqual(labelKey({ key: 'Enter', tag: 'BODY' }), { action: 'save' });
  assert.deepEqual(labelKey({ key: 'Enter', tag: 'INPUT' }), { action: 'save' }, 'Enter in the reason field saves');
  assert.equal(labelKey({ key: 'Enter', tag: 'BUTTON' }), null, 'a focused button keeps its own Enter');
  assert.equal(labelKey({ key: 'Enter', tag: 'SELECT' }), null);
  assert.deepEqual(labelKey({ key: 'ArrowRight' }), { action: 'next' }); assert.deepEqual(labelKey({ key: 'ArrowLeft' }), { action: 'prev' });
  assert.equal(labelKey({ key: 'y', tag: 'INPUT' }), null, 'typing a reason');
  assert.equal(labelKey({ key: 'ArrowLeft', tag: 'INPUT' }), null, 'moving the caret');
  assert.deepEqual(labelKey({ key: 'Escape', tag: 'INPUT' }), { action: 'blur' });
  assert.equal(labelKey({ key: 'y', ctrlKey: true }), null); assert.equal(labelKey({ key: 'x' }), null); assert.equal(labelKey(null), null);
});

test('saving: Unsure needs a reason; after a save the next unlabelled job, wrapping; progress; steps stay in range', () => {
  assert.equal(canSave(null, ''), false); assert.equal(canSave('yes', ''), true); assert.equal(canSave('no', ''), true);
  assert.equal(canSave('unsure', '  '), false); assert.equal(canSave('unsure', 'remote scope'), true);
  const files = ['a', 'b', 'c', 'd'];
  assert.equal(afterSave(files, { a: 1 }, 0), 1);
  assert.equal(afterSave(files, { a: 1, b: 1, c: 1 }, 1), 3, 'skips labelled ones');
  assert.equal(afterSave(files, { b: 1, c: 1, d: 1 }, 3), 0, 'wraps to an earlier gap');
  assert.equal(afterSave(files, { a: 1, b: 1, c: 1, d: 1 }, 1), 2, 'all labelled: the next one');
  assert.equal(afterSave(files, { a: 1, b: 1, c: 1, d: 1 }, 3), 3);
  assert.deepEqual(progress(files, { a: 1, c: 1 }), { done: 2, total: 4 });
  assert.equal(step(files, 0, -1), 0); assert.equal(step(files, 3, 1), 3); assert.equal(step(files, 1, 1), 2);
  assert.equal(setFromSearch('?set=week-40'), 'week-40'); assert.equal(setFromSearch(''), ''); assert.equal(setFromSearch('?set=a%20b'), 'a b');
});

test('api: the label calls send the header and the JSON the server expects', async () => {
  const seen = [];
  const fetch = async (url, opts = {}) => { seen.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const api = createApi({ fetch });
  await api.labelSet(''); await api.labelSet('w 40'); await api.labelJob('w 40', '2026-10-01--a&b.md');
  await api.saveLabel('w 40', 'x.md', 'no', 'too junior', 'too_junior'); await api.saveLabel('w 40', 'x.md', 'yes');
  assert.deepEqual(seen.slice(0, 3).map(s => s.url), ['/api/label', '/api/label?set=w%2040', '/api/label/job?set=w%2040&file=2026-10-01--a%26b.md']);
  assert.equal(seen[3].opts.headers['X-CometScout'], '1');
  assert.deepEqual(JSON.parse(seen[3].opts.body), { set: 'w 40', file: 'x.md', surface: 'no', reason: 'too junior', failure_mode: 'too_junior' });
  assert.deepEqual(JSON.parse(seen[4].opts.body), { set: 'w 40', file: 'x.md', surface: 'yes', reason: '' });
});

test('the rubric panel: headings, list items and paragraphs from Markdown, marks dropped, no HTML', () => {
  assert.deepEqual(rubricBlocks('## Worth it?\n\n**Yes** when:\n- remote in `Europe`\n1. logistics\n\n<b>raw</b>'), [
    { kind: 'h', text: 'Worth it?' }, { kind: 'p', text: 'Yes when:' }, { kind: 'li', text: 'remote in Europe' }, { kind: 'li', text: 'logistics' }, { kind: 'p', text: '<b>raw</b>' }]);
  assert.deepEqual(rubricBlocks(null), []);
});

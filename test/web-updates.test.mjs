// The workspace's update banner and What is new logic (web/lib/updates.js) and their API calls, with a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerFor, showValue, hasNotes, fieldFor, acceptPatch } from '../web/lib/updates.js';
import { createApi } from '../web/lib/api.js';

test('the banner: a newer version that was not skipped; Tonight shows as pending', () => {
  assert.equal(bannerFor(null), null);
  assert.equal(bannerFor({ available: false, latest: '0.1.0', current: '0.1.0' }), null);
  assert.equal(bannerFor({ available: true, skipped: true, latest: '0.2.0', current: '0.1.0' }), null);
  assert.deepEqual(bannerFor({ available: true, skipped: false, latest: '0.2.0', current: '0.1.0', pending: '0.2.0', behaviour_changes: true }), { version: '0.2.0', current: '0.1.0', pending: true, behaviour: true });
});

test('values, notes, the settings fields and the accept patch', () => {
  assert.equal(showValue(['a', 'b']), 'a, b'); assert.equal(showValue('18:00'), '"18:00"'); assert.equal(showValue(null), 'none'); assert.equal(showValue(2), '2');
  assert.equal(hasNotes({ highlights: [], new: ['x'] }), true); assert.equal(hasNotes({ highlights: [] }), false);
  assert.equal(fieldFor('time'), 'setting-time'); assert.equal(fieldFor('__proto__'), null); assert.equal(fieldFor(null), null);
  assert.deepEqual(acceptPatch({ key: 'time', default: '19:00' }), { time: '19:00' });
  assert.equal(acceptPatch({ key: null, default: 3 }), null);
});

test('the API client: GET /api/update and /api/whats-new; POSTs carry the header and a JSON body', async () => {
  const calls = [];
  const api = createApi({ fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; } });
  await api.update(); await api.whatsNew(); await api.updateAction('tonight', '0.2.0'); await api.whatsNewSeen('0.2.0');
  assert.deepEqual(calls.map(c => [c.url, c.opts.method || 'GET']), [['/api/update', 'GET'], ['/api/whats-new', 'GET'], ['/api/update', 'POST'], ['/api/whats-new', 'POST']]);
  assert.equal(calls[2].opts.headers['X-CometScout'], '1');
  assert.deepEqual(JSON.parse(calls[2].opts.body), { action: 'tonight', version: '0.2.0' });
  assert.deepEqual(JSON.parse(calls[3].opts.body), { seen: '0.2.0' });
});

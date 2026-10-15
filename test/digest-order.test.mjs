// decoder/digest.mjs: the "Worth applying" list follows the picks' ranking (apply_priority, then strong fit before
// stretch), not the decode order. Found on the first test-stand install (2026-10-14): p2 was listed above p1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestText, byPriority } from '../decoder/digest.mjs';

const job = (file, company, verdict, apply_priority) => ({ file, fm: { company, role: 'Product Manager', location: 'Remote', url: `https://jobs.example/${company}` }, v: { verdict, apply_priority, action: `Apply to ${company}.` } });

test('Worth applying lists priority 1 before priority 2, whatever the decode order', () => {
  // decode order is file-name order: "ready" sorts before "scoreplay"
  const done = [job('2026-10-14--ready--pm.md', 'Ready', 'investable-stretch', 2), job('2026-10-14--scoreplay--pm.md', 'ScorePlay', 'strong-fit', 1)];
  const text = digestText({ name: 'Sam Example', date: '2026-10-14', done });
  assert.ok(text.indexOf('1. ScorePlay') >= 0 && text.indexOf('2. Ready') > text.indexOf('1. ScorePlay'), text);
});

test('the order: priority (none counts as 5), then strong fit before a stretch, then the decode order', () => {
  const list = [job('a', 'A', 'investable-stretch', 1), job('b', 'B', 'strong-fit', undefined), job('c', 'C', 'strong-fit', 1), job('d', 'D', 'investable-stretch', 3), job('e', 'E', 'strong-fit', 1)];
  assert.deepEqual(list.sort(byPriority).map(d => d.fm.company), ['C', 'E', 'A', 'D', 'B']);
});

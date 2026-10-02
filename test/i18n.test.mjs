// settings.locale: the en and ru tables cover the same labels; the digest, picks block and pack message rendered
// with ru keep no English label from the table; en output is unchanged; model text is passed through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-i18n-'));
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = path.join(tmp, 'data');
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({ timezone: 'UTC', locale: 'ru' }));

const { LABELS, translator, localeOk } = await import('../lib/i18n.mjs');
const { digestText, picksText, verdictLabel } = await import('../decoder/digest.mjs');
const { packMessage } = await import('../pack/message.mjs');

// Synthetic decodes; the model's words (action, rationale, answers) are in Russian, as a ru user's model would write.
const job = (company, role, verdict, extra = {}) => ({ file: `2026-10-01--${company.toLowerCase()}.md`, fm: { company, role, location: 'Удалённо', url: `https://jobs.example/${company.toLowerCase()}`, source: 'hh' },
  v: { verdict, apply_priority: 2, action: 'Откликнуться через сайт компании.', rationale: 'Совпадает опыт.', ...extra } });
const done = [
  job('Северон', 'Продакт-менеджер', 'strong-fit', { fact_flags: [{ id: 'x', why: 'Проверьте стаж.' }] }),
  job('Ладога', 'Владелец продукта', 'investable-stretch'),
  job('Кедр', 'Аналитик', 'long-shot', { hold_reason: 'Нужен опыт в финтехе.' }),
  job('Сокол', 'Менеджер', 'unreadable'),
  job('Пихта', 'Директор', 'gate-reject', { gate: 'язык' }),
  job('Ёлка', 'Стажёр', 'weak-fit'),
];
const pk = { picks: [done[0], done[1]], open: 4 };
const all = { name: 'Кандидат', date: '2026-10-01', dry: true, done, failed: [{ file: 'a.md' }], gaveUp: [{ file: 'b.md' }], pk, left: 3, cap: 30, maxTries: 3 };
const pack = { fm: { company: 'Северон', role: 'Продакт-менеджер', url: 'https://jobs.example/severon' }, flags: ['Проверьте даты.'], form: true,
  answers: [{ field: 'Почему мы?', answer: 'Потому что.', own_words: true }], clNeed: 'text', clText: 'Здравствуйте.' };

// The English words of every label: the text around the {placeholders}, where it has a word of 3+ letters.
const englishParts = Object.values(LABELS.en).flatMap(v => v.split(/\{\w+\}/)).map(s => s.trim()).filter(s => /[A-Za-z]{3,}/.test(s));

test('en and ru have the same keys, and every ru label is translated', () => {
  assert.deepEqual(Object.keys(LABELS.ru).sort(), Object.keys(LABELS.en).sort());
  for (const [k, v] of Object.entries(LABELS.ru)) {
    assert.notEqual(v, LABELS.en[k], k);
    assert.deepEqual((v.match(/\{\w+\}/g) || []).sort(), (LABELS.en[k].match(/\{\w+\}/g) || []).sort(), `${k}: same placeholders`);
    assert.ok(!v.includes('—') && !LABELS.en[k].includes('—'), `${k}: no em dash`);
  }
});

test('the digest, picks block and pack message in ru keep no English label', () => {
  const ru = translator('ru');
  const outputs = { digest: digestText(all, ru), picks: picksText(pk, ru).join('\n'), none: ru('picks.none', { open: 0 }), pack: packMessage(pack, ru),
    packNoForm: packMessage({ ...pack, answers: [], form: null, clNeed: 'none' }, ru), packNoQuestions: packMessage({ ...pack, answers: [], form: true }, ru) };
  for (const [name, text] of Object.entries(outputs)) for (const part of englishParts) assert.ok(!text.includes(part), `${name} still has "${part}":\n${text}`);
  assert.match(outputs.digest, /🎯 Откликнуться сегодня \(2; всего открыто: 4\)/);
  assert.match(outputs.digest, /Сильное совпадение, p2, источник: hh/);
  assert.match(outputs.digest, /- Ёлка: слабое совпадение/);
  assert.match(outputs.digest, /- Пихта: язык/, 'the gate the model named is passed through');
  assert.match(outputs.digest, /Откликнуться через сайт компании\./, 'model text is not translated');
  assert.match(outputs.pack, /^📎 Пакет для отклика: Северон, Продакт-менеджер/);
});

test('settings.locale ru is the default translator here; unknown locales fall back to English', () => {
  assert.equal(verdictLabel('strong-fit'), 'Сильное совпадение');
  assert.equal(verdictLabel('something-new'), 'something-new');
  assert.equal(translator('xx')('digest.held', { n: 2 }), 'Held (2)');
  assert.equal(localeOk('ru'), true); assert.equal(localeOk('en'), true); assert.equal(localeOk('xx'), false); assert.equal(localeOk(undefined), true);
});

test('en output is the same text as before locales existed', () => {
  const en = translator('en');
  const text = digestText(all, en).split('\n');
  for (const line of ['🎯 Apply today (2; 4 open in the pipeline)', '1. Северон: Продакт-менеджер [Удалённо] Strong fit, p2, via hh', '   How: Откликнуться через сайт компании.',
    'Кандидат: 6 decoded 2026-10-01 (dry run)', 'Worth applying (2)', '   Fact check: Проверьте стаж.', 'Held (2)', '   Why held: Нужен опыт в финтехе.', 'Rejected (2)', '- Ёлка: weak fit',
    'Failed (1), will retry: a.md', 'Gave up after 3 failed tries (1), moved to rejected/: b.md', 'Waiting (3): decoder.cap 30 reached, the rest are decoded next run.']) assert.ok(text.includes(line), `missing: ${line}`);
  assert.deepEqual(picksText({ picks: [], open: 3 }, en), []);
  assert.equal(packMessage(pack, en).split('\n')[0], '📎 Application pack: Северон, Продакт-менеджер');
  assert.match(packMessage(pack, en), /Check before sending:\n• Проверьте даты\.\n\nForm answers:\n\n▸ Почему мы\? \(your words\)\n\nПотому что\.\n\nCover letter \(paste as text\):\n\nЗдравствуйте\./);
});

// The targeted merge of GigaAM and Whisper words (lib/transcribe-merge.mjs) and the glossary from the user's own data
// (lib/transcribe-glossary.mjs). Pure functions on synthetic words: no Python, model or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as M from '../lib/transcribe-merge.mjs';
import * as G from '../lib/transcribe-glossary.mjs';

/** Words one after another from "text@probability" tokens, 0.4 s each with a 0.05 s gap; "|" makes a 1.5 s pause. */
function words(line, { start = 0, p = 0.95 } = {}) {
  const out = []; let t = start;
  for (const tok of line.split(' ')) {
    if (tok === '|') { t += 1.5; continue; }
    const [text, prob] = tok.split('@');
    out.push({ text, start: t, end: t + 0.4, probability: prob ? Number(prob) : p });
    t += 0.45;
  }
  return out;
}
const merged = (g, w, opts) => M.mergeWords(words(g), words(w), opts);
const text = r => M.joinWords(r.words.map(x => ({ ...x, t: x.text })));

test('sound keys: transliteration, English spellings and abbreviations read out', () => {
  assert.equal(M.squash('роадмап'), M.squash('roadmap'));
  assert.equal(M.squash('зигби'), M.squash('Zigbee'));
  assert.equal(M.squash('брайтгрид'), M.squash('Brightgrid'));
  assert.ok(M.latinKeys('KPI').has(M.squash('кейпиай')), 'KPI read letter by letter');
  assert.ok(M.latinKeys('B2B').has(M.squash('BB')));
  assert.equal(M.dratio('abc', 'abc'), 0); assert.equal(M.dratio('abcd', 'abxd'), 0.25);
  assert.equal(M.latinLookalike('Е27.'), 'E27.', 'a Cyrillic Е in a code becomes the Latin E');
  assert.equal(M.latinLookalike('Ест'), 'Ест', 'a word without digits stays');
  assert.equal(M.latinLookalike('Т5'), 'T5');
});

test('a transliterated English term is replaced, with GigaAM\'s punctuation and capital; Russian words stay', () => {
  const r = merged('Расскажите про роадмап, пожалуйста. Зигби работает.', 'Расскажите про roadmap пожалуйста. Zigbee работает.');
  assert.equal(text(r), 'Расскажите про roadmap, пожалуйста. Zigbee работает.');
  assert.deepEqual(r.substitutions.map(x => [x.before, x.after, x.source, x.kind]), [['роадмап,', 'roadmap,', 'whisper', 'latin'], ['Зигби', 'Zigbee', 'whisper', 'latin']]);
  assert.deepEqual(r.words.map(x => x.source), ['gigaam', 'gigaam', 'whisper', 'gigaam', 'whisper', 'gigaam']);
  // a correct Russian word: Whisper wrote the same Cyrillic word, or a Latin word that does not sound like it
  const kept = merged('Мы делаем продукт для дома.', 'Мы делаем roadmap для дома.');
  assert.equal(text(kept), 'Мы делаем продукт для дома.');
  assert.match(kept.misses[0].why, /^too different/);
  // Latin against Latin: the same thresholds
  assert.equal(text(merged('Работает на Zigbe.', 'Работает на Zigbee.')), 'Работает на Zigbee.');
  assert.equal(merged('Есть iPhone.', 'Есть iPhone.').substitutions.length, 0);
});

test('short or loose matches need a confident Whisper', () => {
  // distance 0.5 is above 0.45: replaced only when Whisper is 0.85 or more sure
  const g = 'Это кубер кластер.', w = p => `Это Kubernetes@${p} кластер.`;
  assert.equal(M.dratio(M.squash('кубер'), M.squash('Kubernetes')), 0.5);
  assert.equal(text(merged(g, w(0.9))), 'Это Kubernetes кластер.');
  assert.equal(text(merged(g, w(0.6))), g);
  assert.equal(text(merged('Нужен апи сервис.', 'Нужен API сервис.')), 'Нужен API сервис.', 'an abbreviation');
});

test('a hyphenated word is split and decided part by part', () => {
  assert.equal(text(merged('Позвоните в айти-отдел.', 'Позвоните в IT-отдел.')), 'Позвоните в IT-отдел.', 'the English part only');
  assert.equal(text(merged('Есть вай-фай дома.', 'Есть Wi-Fi дома.')), 'Есть Wi-Fi дома.', 'both parts');
  const r = merged('Это какие-то лампы.', 'Это какие-то лампы.');
  assert.equal(text(r), 'Это какие-то лампы.');
  assert.deepEqual(r.words.map(x => [x.text, !!x.hy]), [['Это', false], ['какие', false], ['то', true], ['лампы.', false]]);
});

test('numbers: digits only for exact values of 10 or more; ordinals keep their suffix', () => {
  assert.equal(text(merged('Мы продали двадцать пять устройств.', 'Мы продали 25 устройств.')), 'Мы продали 25 устройств.');
  assert.equal(text(merged('Это было семь лет назад.', 'Это было 7 лет назад.')), 'Это было семь лет назад.', 'below 10: words');
  assert.equal(text(merged('Мы продали двадцать шесть устройств.', 'Мы продали 25 устройств.')), 'Мы продали двадцать шесть устройств.', 'the values differ');
  assert.equal(text(merged('С двадцать пятого числа.', 'С 25 числа.')), 'С двадцать пятого числа.', 'an ordinal and Whisper gave no suffix');
  assert.equal(text(merged('С двадцать пятого числа.', 'С 25-го числа.')), 'С 25-го числа.', 'with its suffix');
  assert.equal(text(merged('Это второй раз.', 'Это 2-й раз.')), 'Это второй раз.', 'an ordinal below 10');
  assert.equal(text(merged('Команда сто двадцать человек.', 'Команда 120 человек.')), 'Команда 120 человек.');
  assert.equal(M.digitsValue('1 200'), 1200); assert.deepEqual([...M.parseRuNumber(['двадцать', 'пять'])], [25]);
  assert.equal(M.numValue('стол'), null, 'not a numeral');
});

test('Russian brands stay in Cyrillic; settings add more forms', () => {
  const r = merged('Я работал в Сбере и Яндексе.', 'Я работал в Sber и Yandex.');
  assert.equal(text(r), 'Я работал в Сбере и Яндексе.');
  assert.deepEqual(r.misses.map(x => x.why), ['Cyrillic brand kept', 'Cyrillic brand kept']);
  assert.equal(text(merged('Звонил в Ростелеком.', 'Звонил в Rostelecom.')), 'Звонил в Rostelecom.');
  assert.equal(text(merged('Звонил в Ростелеком.', 'Звонил в Rostelecom.', { keep: ['Ростелеком'] })), 'Звонил в Ростелеком.');
});

test('a code typed with Cyrillic look-alikes becomes Latin', () => {
  const r = merged('Цоколь Е27, не Е14.', 'Цоколь E27, не E14.');
  assert.equal(text(r), 'Цоколь E27, не E14.');
  assert.ok(/^[A-Z0-9,. ]+$/.test(r.words[1].text), 'Latin letters');
  assert.equal(r.substitutions.length, 0, 'the same code: nothing to list');
});

test('review: Cyrillic words the engines heard differently are listed, never applied', () => {
  const r = merged('Купили датчеков пять штук.', 'Купили датчиков@0.97 пять штук.');
  assert.equal(text(r), 'Купили датчеков пять штук.', 'the text keeps GigaAM\'s word');
  assert.deepEqual(r.review.map(x => [x.gigaam, x.whisper, x.probability]), [['датчеков', 'датчиков', 0.97]]);
  assert.equal(merged('Купили датчеков пять штук.', 'Купили датчиков@0.5 пять штук.').review.length, 0, 'Whisper not confident');
  assert.equal(merged('Купили датчеков пять штук.', 'Купили датчиков@0.5 пять штук.', { known: new Set(['датчиков']) }).review.length, 1, 'the glossary knows Whisper\'s word');
  assert.equal(merged('Мы сделали это.', 'Мы сделал@0.99 это.').review.length, 0, 'an ending only');
});

test('segments: GigaAM\'s sentence ends after 2 seconds, pauses, a comma after 8 seconds, never past 12', () => {
  const ws = (line, start) => words(line, { start }).map(w => ({ ...w, source: 'gigaam' }));
  // "Да." is too short to end a segment alone; the second sentence ends one
  let segs = M.buildSegments(ws('Да. Мы делали это три года подряд.', 0));
  assert.deepEqual(segs.map(s => s.text), ['Да. Мы делали это три года подряд.']);
  segs = M.buildSegments(ws('Мы делали это три года подряд. Потом | было другое.', 0));
  assert.deepEqual(segs.map(s => s.text), ['Мы делали это три года подряд.', 'Потом', 'было другое.'], 'a sentence end, then a pause');
  const long = ws(Array.from({ length: 40 }, (_, i) => (i === 20 ? 'слово,' : 'слово')).join(' '), 0);
  segs = M.buildSegments(long);
  assert.ok(segs.every(s => s.end - s.start <= 12), 'never more than 12 s');
  assert.equal(segs[0].text.endsWith('слово,'), true, 'a long one is cut at the comma after 8 s');
  assert.equal(M.buildSegments([]).length, 0);
});

// ---------- the glossary ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-glossary-'));
function synthetic() {
  const data = path.join(tmp, 'data'), profile = path.join(tmp, 'profile');
  for (const d of ['state', 'decoded', 'inbox']) fs.mkdirSync(path.join(data, d), { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(data, 'state', 'applications.json'), JSON.stringify({
    a: { company: 'Northwind Robotics GmbH', role: 'Product Manager', status: 'interview', updated: '2026-09-30', events: [{ date: '2026-09-30', type: 'interview' }] },
    b: { company: 'Lumenhaus', role: 'PM', status: 'applied', updated: '2026-08-01' },
  }));
  const job = (dir, file, company, found) => fs.writeFileSync(path.join(data, dir, file), `---\ncompany: "${company}"\nrole: "PM"\nfound: ${found}\n---\n\n# ${company}\n`);
  job('decoded', '2026-09-20--lumenhaus--pm.md', 'Lumenhaus', '2026-09-20');
  job('decoded', '2026-01-02--oldco--pm.md', 'Oldcorp Labs', '2026-01-02');
  job('inbox', '2026-10-05--quillwave--pm.md', 'Quillwave', '2026-10-05');
  fs.writeFileSync(path.join(profile, 'cv-library.json'), JSON.stringify({
    experience: [{ company: 'Brightgrid (fictional)  |  Madrid', roles: [{ title: 'Senior Product Manager', bullets: [{ id: 'x', text: 'Shipped a Zigbee hub with the Philips Hue bridge.' }] }] }],
    skills: [{ id: 's', label: 'Tools', text: 'Amplitude, SQL, pricing, roadmapping' }],
  }));
  fs.writeFileSync(path.join(profile, 'profile.md'), '# Who I am\n- Product manager. I used Zigbee and KPI trees a lot.\n- Говорю о B2B SaaS и Matter.\n');
  fs.writeFileSync(path.join(profile, 'glossary.txt'), '# my own words\nKPI = кейпиай\nТехноПарк\n\nVoltwise = вольтвайз, вольтвайс\n');
  return { data, profileDir: profile };
}

test('glossary: built from applications, recent queue files, the CV library, profile.md and glossary.txt', () => {
  const { data, profileDir } = synthetic();
  const settings = { modules: { transcribe: { glossary: ['Flussomat'] } }, queue: { aliases: [['Northwind Robotics', 'NWR']] } };
  const g = G.buildGlossary({ data, profileDir, settings, now: new Date('2026-10-07T12:00:00Z') });
  const terms = g.map(t => t.term);
  assert.deepEqual(terms.slice(0, 4), ['KPI', 'ТехноПарк', 'Voltwise', 'Flussomat'], 'the user\'s own terms first, in their order');
  assert.deepEqual(g[0].spoken, ['кейпиай']); assert.deepEqual(g[2].spoken, ['вольтвайз', 'вольтвайс']);
  for (const t of ['Northwind Robotics', 'NWR', 'Lumenhaus', 'Quillwave', 'Brightgrid', 'Zigbee', 'Philips Hue', 'Amplitude', 'SQL', 'B2B SaaS', 'Matter']) assert.ok(terms.includes(t), t);
  for (const t of ['Oldcorp Labs', 'pricing', 'roadmapping', 'Who', 'Product manager']) assert.ok(!terms.includes(t), `${t} is not a term here`);
  assert.equal(new Set(terms.map(t => t.toLowerCase())).size, terms.length, 'no duplicates');
  // Lumenhaus is in applications and the queue: more often seen than Quillwave, so it comes first
  assert.ok(terms.indexOf('Lumenhaus') < terms.indexOf('Quillwave'));
  assert.equal(G.buildGlossary({ data, profileDir, settings, max: 5 }).length, 5, 'capped');
  assert.equal(G.GLOSSARY_MAX, 200);
  assert.equal(G.renderGlossary(g.slice(0, 3)), 'KPI = кейпиай\nТехноПарк\nVoltwise = вольтвайз, вольтвайс\n');
  assert.equal(G.hotwords(g.slice(0, 3)), 'KPI, ТехноПарк, Voltwise');
  assert.deepEqual(G.buildGlossary({}), [], 'nothing to read: empty');
  assert.equal(G.companyTerm('Acme Robotics GmbH'), 'Acme Robotics'); assert.equal(G.companyTerm('ООО Ромашка'), 'ООО Ромашка'); assert.equal(G.companyTerm('Brightgrid (fictional) | Madrid'), 'Brightgrid');
  assert.deepEqual(G.parseGlossary('A = а, б\n# x\n\nB # note'), [{ term: 'A', spoken: ['а', 'б'] }, { term: 'B', spoken: [] }]);
});

test('glossary: GigaAM words that sound like a term take its spelling; common words and prepositions never', () => {
  const terms = [{ term: 'Brightgrid' }, { term: 'Philips Hue' }, { term: 'KPI', spoken: ['кейпиай'] }, { term: 'Products' }, { term: 'Lumo' }].map(t => ({ spoken: [], ...t }));
  const ws = line => words(line).map(w => ({ text: w.text, start: w.start, end: w.end, source: 'gigaam' }));
  const r = G.applyGlossary(ws('Я работал в брайтгрит, там филипс хью и кейпиай. Наш продукт рос.'), terms);
  assert.equal(r.words.map(w => w.text).join(' '), 'Я работал в Brightgrid, там Philips Hue и KPI. Наш продукт рос.');
  assert.deepEqual(r.substitutions.map(x => [x.before, x.after, x.source]), [['брайтгрит,', 'Brightgrid,', 'glossary'], ['филипс хью', 'Philips Hue', 'glossary'], ['кейпиай.', 'KPI.', 'glossary']]);
  assert.deepEqual(r.words.filter(w => w.source === 'glossary').map(w => w.text), ['Brightgrid,', 'Philips Hue', 'KPI.']);
  // the threshold: close is replaced, a word that only shares some sounds is not; 4 letters must match exactly
  assert.equal(G.applyGlossary(ws('Это брантгрок.'), terms).substitutions.length, 0);
  assert.equal(G.applyGlossary(ws('Это люмо.'), terms).substitutions.length, 1);
  assert.equal(G.applyGlossary(ws('Это лума.'), terms).substitutions.length, 0);
  assert.deepEqual([G.glossaryThreshold(3), G.glossaryThreshold(5), G.glossaryThreshold(7), G.glossaryThreshold(12)], [-1, 0, 0.15, 0.2]);
  // only GigaAM's own words: what Whisper gave in the merge stays
  assert.equal(G.applyGlossary([{ text: 'брайтгрид', start: 0, end: 1, source: 'whisper' }], terms).substitutions.length, 0);
  assert.ok(G.knownWords([{ term: 'Philips Hue', spoken: ['филипс'] }]).has('филипс'));
});

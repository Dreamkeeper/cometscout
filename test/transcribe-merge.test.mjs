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
  for (const t of ['Northwind Robotics', 'NWR', 'Lumenhaus', 'Quillwave', 'Brightgrid', 'Zigbee', 'Philips Hue', 'Amplitude', 'SQL', 'B2B SaaS']) assert.ok(terms.includes(t), t);
  // names only: "Matter" is a common English word, so only glossary.txt or the settings can make it a term
  for (const t of ['Oldcorp Labs', 'pricing', 'roadmapping', 'Who', 'Product manager', 'Matter']) assert.ok(!terms.includes(t), `${t} is not a term here`);
  assert.ok(g.filter(t => t.source === 'glossary.txt' || t.source === 'settings').every(t => !t.auto), 'the user\'s own terms are not automatic');
  assert.ok(g.filter(t => t.source === 'cv-library').every(t => t.auto));
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

// ---------- review fixes (PR 25) ----------
test('numbers: number words match whole words, so look-alike words never block a substitution', () => {
  for (const w of ['однако', 'Однако', 'ставка', 'семинар', 'стоп', 'столица', 'пятно', 'семья', 'одежда', 'сотрудник', 'тренер']) assert.equal(M.numValue(w), null, w);
  assert.deepEqual(['двадцать', 'двадцати', 'пятого', 'второй', 'тысячи', 'тысяч', 'миллионов', 'сорока', 'двухсот', 'девяносто'].map(M.numValue), [20, 20, 5, 2, 1000, 1000, 1e6, 40, 200, 90]);
  assert.equal(text(merged('Однако двадцать пять человек пришли.', 'Однако 25 человек пришли.')), 'Однако 25 человек пришли.');
  assert.equal(text(merged('Ставка двадцать пять процентов.', 'Ставка 25 процентов.')), 'Ставка 25 процентов.');
  assert.equal(text(merged('Семинар сто двадцать минут.', 'Семинар 120 минут.')), 'Семинар 120 минут.');
  // a scale word after the number stays a word when Whisper wrote it as a word too
  assert.equal(text(merged('Это двадцать пять тысяч рублей.', 'Это 25 тысяч рублей.')), 'Это 25 тысяч рублей.');
  assert.equal(text(merged('Это двадцать пять тысяч рублей.', 'Это 25000 рублей.')), 'Это 25000 рублей.', 'the whole value in digits');
  assert.equal(text(merged('Это две тысячи двадцать пять.', 'Это 2025.')), 'Это 2025.');
  assert.equal(text(merged('Это двадцать пять тысяч рублей.', 'Это 26 тысяч рублей.')), 'Это двадцать пять тысяч рублей.', 'the value still has to match');
});

test('a replaced word keeps GigaAM\'s times, so words and subtitles never overlap', () => {
  const g = [['Мы', 0, 0.4], ['про', 0.5, 0.9], ['роадмап', 1.0, 1.6], ['говорили.', 1.7, 2.2]].map(([text, start, end]) => ({ text, start, end }));
  const w = [['Мы', 0, 0.4], ['про', 0.5, 0.7], ['roadmap', 0.75, 1.9], ['говорили.', 1.7, 2.2]].map(([text, start, end]) => ({ text, start, end, probability: 0.95 }));
  const r = M.mergeWords(g, w);
  const rm = r.words.find(x => x.text === 'roadmap');
  assert.deepEqual([rm.start, rm.end, rm.source], [1.0, 1.6, 'whisper']);
  r.words.forEach((x, i) => { if (i) assert.ok(x.start >= r.words[i - 1].end, `${x.text} starts after ${r.words[i - 1].text} ends`); });
});

test('a short Russian word needs a confident Whisper and a Latin word that is not just that word transliterated', () => {
  assert.equal(text(merged('Нет, я так не думаю.', 'Net, я так не думаю.')), 'Нет, я так не думаю.');
  assert.equal(text(merged('Нет, я так не думаю.', 'Net@0.99, я так не думаю.')), 'Нет, я так не думаю.', 'a common word, however sure');
  assert.equal(text(merged('Да, так.', 'Da@0.97, так.')), 'Да, так.');
  assert.equal(text(merged('Нужен апи сервис.', 'Нужен API@0.6 сервис.')), 'Нужен апи сервис.', '3 letters: Whisper must be 0.85 sure');
  assert.equal(text(merged('Нужен апи сервис.', 'Нужен API@0.9 сервис.')), 'Нужен API сервис.');
});

test('review: only a sure Whisper (0.9) or a close word (0.3) is listed, never a glossary word GigaAM already wrote', () => {
  assert.equal(M.dratio(M.squash('корова'), M.squash('карава')) > 0.3, true);
  assert.equal(merged('Там корова стоит.', 'Там карава@0.87 стоит.').review.length, 0, 'a loose pair with Whisper under 0.9');
  assert.equal(merged('Там корова стоит.', 'Там карава@0.93 стоит.').review.length, 1);
  assert.equal(merged('Купили датчеков пять штук.', 'Купили датчиков@0.87 пять штук.').review.length, 1, 'a close pair at 0.87');
  const known = new Set(['лунабанк']);
  assert.equal(merged('Был в Лунабанк вчера.', 'Был в Лунобанк@0.97 вчера.').review.length, 1);
  assert.equal(merged('Был в Лунабанк вчера.', 'Был в Лунобанк@0.97 вчера.', { known }).review.length, 0, 'GigaAM wrote the glossary word');
});

test('glossary: an inflected Cyrillic form never rewrites a correct GigaAM word, and free text keeps such forms for Whisper only', () => {
  const ws = line => words(line).map(w => ({ text: w.text, start: w.start, end: w.end, source: 'gigaam' }));
  const curated = [{ term: 'Лунабанке', spoken: [] }];
  const r = G.applyGlossary(ws('Я работал в Лунабанк долго.'), curated);
  assert.equal(r.substitutions.length, 0, 'differs only in the ending');
  assert.equal(G.applyGlossary(ws('Я работал в Лунобанк долго.'), [{ term: 'Лунабанк', spoken: [] }]).substitutions.length, 1, 'a real sound match still applies');
  // free text: "Лунабанке" alone is an inflected form, kept as a Whisper hint but never matched on GigaAM's words
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-glossary-inflected-'));
  fs.writeFileSync(path.join(dir, 'profile.md'), 'Я долго работал в Лунабанке. Потом пришёл в Квазар и в Звездолёте.\n');
  let g = G.buildGlossary({ profileDir: dir });
  const by = t => g.find(x => x.term === t);
  assert.equal(by('Лунабанке').match, false); assert.equal(by('Звездолёте').match, false);
  assert.equal(by('Квазар').match, true, 'a form with no ending is a base form');
  assert.match(G.renderGlossary(g), /^Лунабанке  # Whisper hint only$/m);
  assert.equal(G.applyGlossary(ws('Я был в Лунобанке вчера.'), g).substitutions.length, 0, 'a hint-only term is not matched');
  // the base form seen elsewhere in the text absorbs the inflected one
  fs.writeFileSync(path.join(dir, 'profile.md'), 'Я долго работал в Лунабанке. Потом Лунабанк закрылся.\n');
  g = G.buildGlossary({ profileDir: dir });
  assert.deepEqual(g.filter(x => /^Лунабанк/.test(x.term)).map(x => [x.term, x.match, x.count]), [['Лунабанк', true, 2]]);
  // curated terms are matched whatever their ending
  fs.writeFileSync(path.join(dir, 'glossary.txt'), 'Звездолёте\n');
  assert.equal(G.buildGlossary({ profileDir: dir }).find(x => x.term === 'Звездолёте').match, true);
});

test('hotwords: at most 50 terms go to Whisper, most important first', () => {
  const terms = Array.from({ length: 60 }, (_, i) => ({ term: `Term${i}`, spoken: [] }));
  assert.equal(G.HOTWORDS_MAX, 50);
  assert.equal(G.hotwords(terms).split(', ').length, 50);
  assert.equal(G.hotwords(terms).split(', ')[0], 'Term0');
  assert.equal(G.hotwordCount(terms), 50); assert.equal(G.hotwordCount(terms.slice(0, 3)), 3);
});

// ---------- task 23: real recordings ----------
test('glossary from the data: names only, never a common word of either language', () => {
  for (const w of ['Products', 'product', 'Manager', 'hardware', 'companies', 'batteries', 'продакт', 'продактов', 'менеджерами', 'Продукт']) assert.equal(G.commonWord(w), true, w);
  for (const w of ['Zigbee', 'Aqara', 'Brightgrid', 'Лунабанк', 'KPI']) assert.equal(G.commonWord(w), false, w);
  assert.equal(G.soundsCommonEnglish('продакт'), true, 'a loanword of "product"');
  assert.equal(G.soundsCommonEnglish('брайтгрид'), false);
  for (const t of ['Philips Hue', 'Claude Code', 'Zigbee', 'iPhone', 'E27', 'B2B SaaS', 'Квазар']) assert.equal(G.nameLike(t), true, t);
  for (const t of ['Products', 'Product Manager', 'Smart Home', 'asking about working', 'IoT product lifecycle', 'his', 'квазар']) assert.equal(G.nameLike(t), false, t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-glossary-names-'));
  fs.writeFileSync(path.join(dir, 'cv-library.json'), JSON.stringify({
    experience: [{ company: 'Brightgrid', roles: [{ title: 'Senior Product Manager', bullets: [{ id: 'a', text: 'Led the Products team and shipped Aqara sensors with Philips Hue.' }, { id: 'b', text: 'Вёл продукт, писал PRDs и считал companies и contracts.' }] }] }],
    skills: [{ id: 's', text: 'Hardware, Firmware, Amplitude, Product Strategy' }],
  }));
  const g = G.buildGlossary({ profileDir: dir }), terms = g.map(t => t.term);
  for (const t of ['Brightgrid', 'Aqara', 'Philips Hue', 'PRDs', 'Amplitude']) assert.ok(terms.includes(t), t);
  for (const t of ['Products', 'Senior Product Manager', 'Hardware', 'Firmware', 'Product Strategy', 'companies', 'contracts']) assert.ok(!terms.includes(t), `${t} is vocabulary, not a name`);
  assert.ok(g.every(t => t.auto), 'all of them found in the data');
  // the same word written into glossary.txt is the user's choice and is kept
  fs.writeFileSync(path.join(dir, 'glossary.txt'), 'Products\n');
  assert.deepEqual(G.buildGlossary({ profileDir: dir }).filter(t => t.term === 'Products').map(t => [t.source, !!t.auto]), [['glossary.txt', false]]);
});

test('an automatic term needs a strong match on a whole word and never replaces a common word; the user\'s terms work as before', () => {
  const ws = line => words(line).map(w => ({ text: w.text, start: w.start, end: w.end, source: 'gigaam' }));
  const apply = (line, terms) => M.joinWords(G.applyGlossary(M.prepare(ws(line)).map(w => ({ text: w.t, start: w.s, end: w.e, source: 'gigaam', ...(w.hy ? { hy: true } : {}) })), terms).words.map(w => ({ ...w, t: w.text })));
  const auto = t => ({ term: t, spoken: [], auto: true }), mine = t => ({ term: t, spoken: [] });
  // the failure seen on a real recording: a common Russian phrase turned into an English word from the CV
  assert.equal(apply('Нам нужен продакт-менеджер.', [auto('Products')]), 'Нам нужен продакт-менеджер.');
  assert.equal(apply('Наш продакт сказал.', [auto('Products')]), 'Наш продакт сказал.', 'a loanword of a common English word');
  assert.equal(apply('Я работал в брайтгрит.', [auto('Brightgrid')]), 'Я работал в Brightgrid.', 'a strong match on a name');
  assert.equal(apply('Купили вольтвизе.', [auto('Voltwise')]), 'Купили вольтвизе.', 'too loose for an automatic term (0.125)');
  assert.equal(apply('Взяли зигби-модуль.', [auto('Zigbee')]), 'Взяли зигби-модуль.', 'one part of a hyphenated word is not a whole word');
  assert.equal(apply('Взяли зигби модуль.', [auto('Zigbee')]), 'Взяли Zigbee модуль.');
  assert.equal(apply('Офис в Бранденвике.', [auto('Brandenvik')]), 'Офис в Бранденвике.', 'a Russian case form of a name is Russian, not a mishearing');
  // terms the user wrote: as before
  assert.equal(apply('Взяли зигби-модуль.', [mine('Zigbee')]), 'Взяли Zigbee-модуль.');
  assert.equal(apply('Купили вольтвизе.', [mine('Voltwise')]), 'Купили Voltwise.');
});

test('a glossary term settles a disagreement: Whisper\'s Latin word, a Cyrillic pair, and mixed scripts', () => {
  const terms = [{ term: 'Aqara', spoken: [], auto: true }, { term: 'Диммер', spoken: [] }];
  const m = G.glossaryMatcher(terms), glossary = t => m.find(t);
  const run = (g, w) => { const r = M.mergeWords(words(g), words(w), { glossary, known: G.knownWords(terms) }); const a = G.applyGlossary(r.words, terms); return { r, text: M.joinWords(a.words.map(x => ({ ...x, t: x.text }))) }; };
  // GigaAM heard the term, Whisper an English-looking word: the term
  let x = run('Поставили датчики акара в зале.', 'Поставили датчики Takara@0.95 в зале.');
  assert.equal(x.text, 'Поставили датчики Aqara в зале.');
  assert.match(x.r.misses.find(y => y.whisper === 'Takara').why, /glossary term/);
  // Whisper's word put in by the merge is matched on what GigaAM heard there
  const merged = [{ text: 'Takara', start: 0, end: 0.5, source: 'whisper', heard: 'акара' }];
  assert.equal(G.applyGlossary(merged, terms).words[0].text, 'Aqara');
  assert.equal(G.applyGlossary([{ text: 'roadmap', start: 0, end: 0.5, source: 'whisper', heard: 'роадмап' }], [{ term: 'Roadmunk', spoken: [], auto: true }]).substitutions.length, 0, 'a common word stays');
  // Cyrillic: Whisper's variant is the glossary term (another ending is the same term), GigaAM's a mishearing
  x = run('Поставили демеры в зал.', 'Поставили диммеры@0.7 в зал.');
  assert.equal(x.text, 'Поставили диммеры в зал.');
  assert.deepEqual(x.r.substitutions.map(y => [y.before, y.after, y.kind]), [['демеры', 'диммеры', 'glossary']]);
  assert.equal(run('Поставили диммеры в зал.', 'Поставили демеры@0.99 в зал.').text, 'Поставили диммеры в зал.', 'GigaAM\'s word is the term: it stays');
  assert.equal(M.mergeWords(words('Поставили демеры в зал.'), words('Поставили диммеры@0.7 в зал.')).substitutions.length, 0, 'no glossary: today\'s rule');
  assert.equal(run('Купили стол в зал.', 'Купили диммеры@0.99 в зал.').text, 'Купили стол в зал.', 'a different word, not a variant');
  assert.equal(run('Поставили демеры в зал.', 'Поставили диммеры@0.3 в зал.').text, 'Поставили демеры в зал.', 'Whisper not sure enough: GigaAM\'s word stays');
  // an automatic term is also one of Whisper's hotwords: a low-confidence one over a different word never replaces it
  const autoZ = G.glossaryMatcher([{ term: 'Zigbee', spoken: [], auto: true }]).find;
  const runZ = (g, w) => M.mergeWords(words(g), words(w), { glossary: autoZ });
  assert.equal(runZ('Купили зубы вчера.', 'Купили Зигби@0.2 вчера.').substitutions.length, 0, 'an unsure hotword');
  assert.equal(runZ('Купили зубы вчера.', 'Купили Зигби@0.95 вчера.').substitutions.length, 0, 'sure, but too far from GigaAM\'s word for an automatic term');
  // Whisper wrote a Latin term in Cyrillic and GigaAM misheard it: Whisper's word wins, then takes the term's spelling
  assert.equal(run('Купили окара датчики.', 'Купили Акара@0.9 датчики.').text, 'Купили Aqara датчики.');
  assert.equal(run('Он сказал вчера.', 'Он Акара@0.9 вчера.').text, 'Он сказал вчера.', 'too different to be the same word');
  // a token that mixes Latin and Cyrillic letters is never put in
  assert.equal(M.mixedScript('Zigbeeшный'), true); assert.equal(M.mixedScript('IT-отдел'), false); assert.equal(M.mixedScript('Zigbee'), false);
  x = run('Подключили зигбишный хаб.', 'Подключили Zigbeeшный@0.99 хаб.');
  assert.equal(x.text, 'Подключили зигбишный хаб.');
  assert.match(x.r.misses[0].why, /mixes Latin and Cyrillic/);
  assert.equal(run('Позвоните в айти-отдел.', 'Позвоните в IT-отдел.').text, 'Позвоните в IT-отдел.', 'a hyphen between the scripts is fine');
});

test('a word the merge doubled is dropped; a repeat GigaAM heard itself stays', () => {
  const w = (text, start, source, heard) => ({ text, start, end: start + 0.4, source, ...(heard ? { heard } : {}) });
  let r = M.dropRepeats([w('Купили', 0, 'gigaam'), w('Zigbee', 0.5, 'whisper', 'зигби'), w('Zigbee,', 1, 'glossary', 'зикбе,'), w('хаб.', 1.5, 'gigaam')]);
  assert.deepEqual(r.words.map(x => x.text), ['Купили', 'Zigbee,', 'хаб.'], 'one word, the punctuation kept');
  assert.deepEqual([r.words[1].start, r.words[1].end, r.dropped.length], [0.5, 1.4, 1]);
  r = M.dropRepeats([w('это', 0, 'gigaam'), w('это', 0.5, 'gigaam'), w('Zigbee', 1, 'whisper', 'зигби'), w('Zigbee', 1.5, 'whisper', 'зигби')]);
  assert.deepEqual(r.words.map(x => x.text), ['это', 'это', 'Zigbee', 'Zigbee'], 'GigaAM said it twice: speech, not a seam');
  assert.equal(M.dropRepeats([w('Zigbee', 0, 'whisper', 'зигби'), w('Zigbee', 3, 'whisper', 'зикбе')]).dropped.length, 0, 'far apart');
});

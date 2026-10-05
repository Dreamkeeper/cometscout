// Lint rules from the profile: paragraphs from WordprocessingML, hits and limits, the CLI, doctor, and the pack's
// use of them (vetted fallback, refusing a CV, flags for the cover letter and answers). Synthetic data only; the
// pack's model call goes to a fake `claude` (settings.llm.bin), so there is no network and no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FIX = path.join(HERE, 'fixtures', 'lint');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-lint-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));

const L = await import('../lib/lint.mjs');
const RULES_JSON = JSON.parse(fs.readFileSync(path.join(FIX, 'lint-rules.json'), 'utf8'));
const RULES = L.compileRules(RULES_JSON);
const DOC = fs.readFileSync(path.join(FIX, 'document.xml'), 'utf8');
const LIB = JSON.parse(fs.readFileSync(path.join(FIX, 'cv-library.json'), 'utf8'));
const HAS_PY = spawnSync('python3', ['--version']).status === 0;

test('paragraphs: kinds, joined runs, tabs as spaces, empty paragraphs dropped', () => {
  const paras = L.paragraphsFromXml(DOC);
  assert.deepEqual(paras.map(p => p.kind), ['heading', 'summary', 'bullet', 'line', 'line']);
  assert.equal(paras[0].text, 'PROFESSIONAL SUMMARY');
  assert.ok(paras[1].words > 60);
  assert.equal(paras[3].text, 'Northwind Clinics Jan 2020 - present');
  // bold but 140 characters or more: not a heading
  assert.ok(paras[4].text.length >= 140);
  assert.equal(paras[2].words, paras[2].text.split(' ').length);
});

test('paragraphs: entities decoded and whitespace collapsed', () => {
  const [, , bullet] = L.paragraphsFromXml(DOC);
  assert.equal(bullet.text, 'Billing: Launched billing for 300 clinics & their <front desks>, the \u201cfirst\u201d clinic\u2019s in two regions.');
  assert.equal(L.decodeEntities('&quot;a&quot; &apos;b&apos; &#65;&#x42; &unknown;'), '"a" \'b\' AB &unknown;');
});

test('lint: one hit per rule per paragraph, with id, paragraph (from 1), kind, match, why and cut text', () => {
  const text = 'I was the first PM here, the first PM ever, and passionate.\n\nPassionate about synergy.\n\nNothing to see.';
  const r = L.lintText(text, RULES);
  assert.deepEqual(r.errors.map(h => [h.id, h.para, h.kind, h.match]), [['first-pm', 1, 'line', 'first PM']]);
  assert.deepEqual(r.warns.map(h => [h.id, h.para, h.match]), [['fluff', 1, 'passionate'], ['fluff', 2, 'Passionate']]);
  assert.equal(r.errors[0].why, 'Not the first PM anywhere.');
  const long = L.lintText(`The first PM. ${'word '.repeat(60)}`, RULES).errors[0];
  assert.equal(long.text.length, 120);
  assert.match(r.info, /^3 paragraphs, 0 bullets, longest bullet 0 words, summary 0 words$/);
});

test('lint: bullet and summary limits are warnings; no limits, no warnings', () => {
  const r = L.lintDocumentXml(DOC, L.compileRules({ limits: { bullet_max_words: 10, summary_max_words: 50 } }));
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.warns.map(h => [h.id, h.kind, h.match]), [['summary-length', 'summary', '82 words'], ['bullet-length', 'bullet', '16 words']]);
  assert.match(r.info, /5 paragraphs, 1 bullets, longest bullet 16 words, summary 82 words/);
  assert.equal(L.lintDocumentXml(DOC, L.compileRules({ limits: { bullet_max_words: 'many', summary_max_words: 0 } })).warns.length, 0);
  assert.equal(L.lintDocumentXml(DOC, L.compileRules(null)).warns.length, 0);
});

test('lint: patterns use giu, so Cyrillic matches case-insensitively', () => {
  const r = L.lintText('Я ЛУЧШИЙ менеджер.\n\nНаилучший результат.', RULES);
  assert.deepEqual(r.warns.map(h => [h.id, h.para, h.match]), [['best-ru', 1, 'ЛУЧШИЙ']]);
  // the same rule compiled without "u" would fail on \p{L}: the flag really is there
  assert.equal(RULES.warn.find(x => x.id === 'best-ru').re.flags, 'giu');
});

test('rules: a bad pattern is skipped and reported, the rest still work', () => {
  const r = L.compileRules({ banned_claims: [{ id: 'broken', pattern: '(unclosed', why: 'x' }, { id: 'nopat' }, { id: 'ok', pattern: 'cto' }], warn_claims: 'oops' });
  assert.deepEqual(r.banned.map(x => x.id), ['ok']);
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0], /^broken: /);
  assert.match(r.problems[1], /nopat: no pattern/);
  assert.match(r.problems[2], /warn_claims: not a list/);
  assert.equal(L.lintText('Worked with the CTO.', r).errors.length, 1);
});

test('formatReport names each hit with its level, paragraph and why', () => {
  const out = L.formatReport(L.lintText('The first PM.\n\nSo passionate.', RULES), 'Cover letter');
  assert.match(out, /^Cover letter: 1 error\(s\), 1 warning\(s\)\. 2 paragraphs/);
  assert.match(out, /- error first-pm \(paragraph 1, line\): "first PM": Not the first PM anywhere\./);
  assert.match(out, /- warning fluff \(paragraph 2, line\): "passionate"/);
  assert.doesNotMatch(out, /\u2014/);
});

test('matchesWhole: a universal check covers a lint hit only when it is the whole hit', () => {
  assert.equal(L.matchesWhole(/\b(he|his|him)\b/i, 'his'), true);
  assert.equal(L.matchesWhole(/\b(he|his|him)\b/i, 'his team of 40'), false);
  assert.equal(L.matchesWhole(/\u2014/g, '\u2014'), true, 'g and y flags are dropped');
});

test('libraryTexts: company blurbs are linted too', () => {
  const lib = { experience: [{ key: 'acme', company: 'Acme', blurb: 'Smart home devices, 40 people', roles: [{ bullets: [{ id: 'b1', text: 'Shipped a hub' }] }] }] };
  assert.ok(L.libraryTexts(lib).some(x => x.item === 'acme (blurb)' && x.text === 'Smart home devices, 40 people' && x.kind === 'line'));
  const r = L.lintLibrary(lib, L.compileRules({ banned_claims: [{ id: 'size', pattern: '\\b40 people\\b', why: 'Not 40.' }] }));
  assert.deepEqual(r.errors.map(e => e.item), ['acme (blurb)']);
});

test('lintLibrary: banned hits and warnings (limits included) in vetted text, by item id', () => {
  const r = L.lintLibrary(LIB, RULES);
  assert.deepEqual(r.errors, [{ item: 'nw-team', id: 'big-team', match: 'team of 40', why: 'Never managed a team that size.' }]);
  // bullets are linted as bullets, so the bullet limit applies to them
  assert.deepEqual(r.warns, [{ item: 'nw-growth', id: 'bullet-length', match: '28 words', why: 'a bullet over 20 words' }]);
  assert.ok(L.libraryTexts(LIB).some(x => x.item === 'sk-product' && x.text === 'Product: Discovery, pricing, SQL' && x.kind === 'line'));
});

test('cyrillicBoundary: \\b next to a Cyrillic letter is detected, lookarounds and Latin are not', () => {
  assert.equal(L.cyrillicBoundary('\\bлучший\\b'), true);
  assert.equal(L.cyrillicBoundary('(?<!\\p{L})лучший(?!\\p{L})'), false);
  assert.equal(L.cyrillicBoundary('\\bfirst pm\\b'), false);
});

const lintCli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'lib', 'lint.mjs'), ...a], { encoding: 'utf8', env: process.env });

test('CLI: document.xml and plain text, --json, exit 1 on errors', () => {
  const rules = path.join(FIX, 'lint-rules.json');
  const xml = lintCli(path.join(FIX, 'document.xml'), '--rules', rules);
  assert.equal(xml.status, 0, xml.stdout + xml.stderr);
  assert.match(xml.stdout, /document\.xml: 0 error\(s\), 1 warning\(s\)/);
  const txt = path.join(tmp, 'answer.txt'); fs.writeFileSync(txt, 'I was the first product manager there.\n\nPassionate.');
  const t = lintCli(txt, '--rules', rules, '--json');
  assert.equal(t.status, 1);
  const j = JSON.parse(t.stdout);
  assert.deepEqual([j.errors.map(h => h.id), j.warns.map(h => h.id)], [['first-pm'], ['fluff']]);
  assert.equal(lintCli().status, 2);
});

test('CLI: reads a .docx (deflated zip) without dependencies', { skip: !HAS_PY && 'python3 is not installed' }, () => {
  const xml = path.join(tmp, 'doc.xml'); fs.writeFileSync(xml, DOC.replace('Launched billing', 'As the first PM, launched billing'));
  const docx = path.join(tmp, 'cv.docx');
  const p = spawnSync('python3', [path.join(ROOT, 'pack', 'pack.py'), path.join(ROOT, 'pack', 'templates', 'tpl_cv'), xml, docx], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const r = lintCli(docx, '--rules', path.join(FIX, 'lint-rules.json'), '--json');
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).errors.map(h => [h.id, h.kind]), [['first-pm', 'bullet']]);
  assert.throws(() => L.unzipEntry(Buffer.from('not a zip at all, just some text that is long enough'), 'word/document.xml'), /not a zip/);
});

// ---------- a home with the synthetic profile ----------
function home(name, { lintRules = RULES_JSON, settings = {} } = {}) {
  const h = path.join(tmp, name); const prof = path.join(h, 'profile'); fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'profile.md'), '# Jordan Vale (synthetic)\n\nProduct manager, six years in clinic software.\n');
  for (const f of ['cv-library.json', 'fact-rules.json']) fs.copyFileSync(path.join(FIX, f), path.join(prof, f));
  if (lintRules) fs.writeFileSync(path.join(prof, 'lint-rules.json'), JSON.stringify(lintRules));
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({ timezone: 'UTC', candidate_name: 'Jordan Vale', ...settings }));
  return h;
}
const envFor = h => ({ ...process.env, COMETSCOUT_HOME: h, COMETSCOUT_DATA: path.join(h, 'data'), COMETSCOUT_SETTINGS: path.join(h, 'settings.json'), PACK_NO_PDF: '1', COMETSCOUT_RUN_DATE: '2026-10-02' });
const doctor = h => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'doctor'], { encoding: 'utf8', env: envFor(h), timeout: 60000 }).stdout;

test('doctor: rule counts, a broken pattern, vetted text that breaks a rule, warnings once, \b next to Cyrillic', () => {
  const h = home('doctor', { lintRules: { ...RULES_JSON, banned_claims: [...RULES_JSON.banned_claims, { id: 'broken', pattern: '(oops' }],
    warn_claims: [...RULES_JSON.warn_claims, { id: 'ru-b', pattern: '\\bлучший\\b', why: 'x' }] } });
  const out = doctor(h);
  assert.match(out, /TODO lint rules: 3 banned, 3 warn {2}-> {2}rule\(s\) skipped: broken: /);
  assert.match(out, /TODO vetted CV text passes your lint rules {2}-> {2}vetted text breaks your own rule: nw-team \(big-team\)/);
  // warnings and limits on the vetted library: reported by doctor, once
  assert.equal(out.match(/^warn vetted CV text/gm).length, 1);
  assert.match(out, /^warn vetted CV text has 1 lint warning\(s\): nw-growth \(bullet-length, 28 words\)$/m);
  // \b does not see Cyrillic word edges: named, not rewritten; best-ru (lookarounds) is fine
  assert.match(out, /^warn \\b next to Cyrillic never matches a word edge: ru-b {2}-> {2}use \(\?<!\\p\{L\}\)/m);
  assert.doesNotMatch(out, /word edge: [^\n]*best-ru/);
  const none = doctor(home('doctor-none', { lintRules: null }));
  assert.match(none, /ok {3}lint rules: none \(optional: profile\/lint-rules\.json\)/);
  assert.doesNotMatch(none, /vetted CV text|^warn/m);
});

test('doctor: the example profile has lint rules and its library passes them', () => {
  const h = path.join(tmp, 'doctor-example'); fs.mkdirSync(h, { recursive: true });
  fs.cpSync(path.join(ROOT, 'profile.example'), path.join(h, 'profile.example'), { recursive: true });
  fs.writeFileSync(path.join(h, 'settings.json'), '{}');
  const out = doctor(h);
  assert.match(out, /ok {3}lint rules: 2 banned, 2 warn/);
  assert.match(out, /ok {3}vetted CV text passes your lint rules/);
  assert.doesNotMatch(out, /^warn/m);
});

// ---------- the pack ----------
const JOB = '2026-10-01--examplecare--product-manager.md';
// A home with a fake model and a fake Telegram: fetch is replaced (--import) and every Telegram message is appended
// to tg.jsonl; the fake `claude` appends a line to calls.log for every model call.
function packHome(name, response, opts = {}) {
  const h = home(name, opts);
  const fake = path.join(h, 'fake-claude.mjs');
  // stands in for `claude -p --output-format json`: reads the prompt, answers with the canned pack
  fs.writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(path.join(h, 'calls.log'))}, 'call\\n');\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify({ structured_output: response, total_cost_usd: 0 }))}));\n`, { mode: 0o755 });
  const s = JSON.parse(fs.readFileSync(path.join(h, 'settings.json'), 'utf8'));
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({ ...s, llm: { provider: 'claude', model: 'sonnet', pack_model: 'opus', bin: fake }, delivery: { telegram: { enabled: true } } }));
  fs.writeFileSync(path.join(h, 'mock-fetch.mjs'), `import fs from 'node:fs';
globalThis.fetch = async (url, o = {}) => {
  if (!String(url).startsWith('https://api.telegram.org/')) return new Response('<html>A synthetic open posting.</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  fs.appendFileSync(${JSON.stringify(path.join(h, 'tg.jsonl'))}, JSON.stringify({ method: String(url).split('/').pop(), text: o.body?.get?.('text') ?? null }) + '\\n');
  return new Response('{"ok":true,"result":{}}', { status: 200, headers: { 'content-type': 'application/json' } });
};`);
  const dec = path.join(h, 'data', 'decoded'); fs.mkdirSync(dec, { recursive: true });
  fs.writeFileSync(path.join(dec, JOB), '---\ncompany: "ExampleCare"\nrole: "Product Manager"\nurl: "https://example.com/jobs/42"\nlocation: "Remote"\nfound: 2026-10-01\n---\n\n# ExampleCare - Product Manager\n\nSynthetic posting.\n\n## Decode Result\nverdict: strong-fit\n');
  return h;
}
const tgEnv = h => ({ ...envFor(h), TELEGRAM_BOT_TOKEN: 'synthetic-bot-token', TELEGRAM_CHAT_ID: '4242' });
const readLines = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
function runPack(h, args = ['--no-telegram']) {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(h, 'mock-fetch.mjs')).href, path.join(ROOT, 'pack', 'pack.mjs'), '--file', JOB, ...args], { encoding: 'utf8', env: tgEnv(h), timeout: 60000 });
  const packs = path.join(h, 'data', 'packs');
  const dirs = fs.existsSync(packs) ? fs.readdirSync(packs) : [];
  const dir = dirs[0] ? path.join(packs, dirs[0]) : null;
  return { r, h, dirs, dir, json: dir ? JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')) : null, md: dir ? fs.readFileSync(path.join(dir, 'answers.md'), 'utf8') : '',
    calls: readLines(path.join(h, 'calls.log')).length, tg: readLines(path.join(h, 'tg.jsonl')).map(l => JSON.parse(l)),
    record: (JSON.parse(fs.existsSync(path.join(h, 'data', 'state', 'packs.json')) ? fs.readFileSync(path.join(h, 'data', 'state', 'packs.json'), 'utf8') : '{}'))[JOB] };
}
const packRun = (name, response, opts) => runPack(packHome(name, response, opts));
const cvPick = (extra = {}) => ({ tagline: 'Product Manager  |  Clinic software', summary: 'Product manager for clinic software.', order: ['experience', 'skills'], ai_work_ids: [],
  experience: [{ key: 'northwind', bullet_ids: ['nw-launch', 'nw-growth'] }], skill_ids: ['sk-product'], award_ids: [], ...extra });

test('pack: a banned claim in the model tagline or summary brings back the vetted ones', { skip: !HAS_PY && 'python3 is not installed' }, () => {
  const p = packRun('pack-fallback', { positioning: 'Clinic billing.', flags: [], answers: [],
    cv: cvPick({ tagline: 'The first PM for clinic software', summary: 'As the first product manager at a clinic startup, I built billing.' }) });
  assert.equal(p.r.status, 0, p.r.stdout + p.r.stderr);
  assert.ok(p.json.flags.includes('CV lint: first-pm in model text, vetted summary used'), p.json.flags.join('\n'));
  assert.equal(p.json.cv.tagline, LIB.taglines[0].text);
  assert.equal(p.json.cv.summary, LIB.summaries[0].text);
  assert.deepEqual(p.json.lint.cv.errors, []);
  // nw-growth (vetted) is 28 words, over the 20-word bullet limit: kept in pack.json and answers.md, not flagged
  assert.deepEqual(p.json.lint.cv.warns.map(h => [h.id, h.kind]), [['bullet-length', 'bullet']]);
  assert.ok(!p.json.flags.some(f => /^CV lint warning/.test(f)), p.json.flags.join('\n'));
  assert.match(p.md, /## Lint\nCV: 0 error\(s\), 1 warning\(s\)[^\n]*\n- warning bullet-length \(paragraph \d+, bullet\): "28 words"/);
  // paragraph numbers in pack.json count from 1, as in the report
  const para = p.json.lint.cv.warns[0].para;
  assert.match(p.md, new RegExp(`bullet-length \\(paragraph ${para}, bullet\\)`));
  // the CV that was written is clean: lint the DOCX itself
  const docx = fs.readdirSync(p.dir).find(f => f.endsWith('.docx'));
  const c = lintCli(path.join(p.dir, docx), '--rules', path.join(FIX, 'lint-rules.json'), '--json');
  assert.equal(c.status, 0, c.stdout);
  assert.equal(JSON.parse(c.stdout).warns[0].text, p.json.lint.cv.warns[0].text);
  assert.ok(p.record.built);
});

test('pack: vetted text that still breaks a rule: refused, one Telegram line, remembered and skipped until the library or rules change', { skip: !HAS_PY && 'python3 is not installed' }, () => {
  const h = packHome('pack-refuse', { positioning: 'Team lead.', flags: [], answers: [{ field: 'Why us?', answer: 'Clinics.', own_words: false }],
    cv: cvPick({ summary: 'As the first PM, I led clinics.', experience: [{ key: 'northwind', bullet_ids: ['nw-launch', 'nw-team'] }] }) });
  const p = runPack(h, []);
  assert.equal(p.r.status, 0, 'a refused pack does not fail the run: ' + p.r.stdout + p.r.stderr);
  assert.match(p.r.stdout, new RegExp(`pack ${JOB}: CV still breaks big-team after the vetted fallback; fix profile/cv-library\\.json`));
  assert.match(p.r.stdout, new RegExp(`pack: refused \\(the CV breaks a lint rule with vetted text\\): ${JOB} \\(big-team\\)`));
  assert.deepEqual(p.dirs, [], 'no pack folder, no DOCX, no PDF');
  assert.equal(p.calls, 1);
  assert.deepEqual(p.tg, [{ method: 'sendMessage', text: 'Pack not built: ExampleCare, Product Manager. The CV still breaks big-team with vetted text; fix profile/cv-library.json.' }]);
  const prof = path.join(h, 'profile');
  assert.deepEqual(p.record, { refused: ['big-team'], date: '2026-10-02', at: p.record.at, library_mtime: fs.statSync(path.join(prof, 'cv-library.json')).mtimeMs,
    rules_mtime: fs.statSync(path.join(prof, 'lint-rules.json')).mtimeMs, company: 'ExampleCare', role: 'Product Manager' });
  // the next run skips it: no model call, no message
  const again = runPack(h, []);
  assert.equal(again.r.status, 0);
  assert.match(again.r.stdout, /skipped, its CV broke big-team on 2026-10-02; tried again when profile\/cv-library\.json or profile\/lint-rules\.json changes/);
  assert.equal(again.calls, 1);
  assert.equal(again.tg.length, 1);
  // a change to the library (or the rules) brings it back
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(prof, 'cv-library.json'), later, later);
  const third = runPack(h, ['--no-telegram']);
  assert.match(third.r.stdout, /changed since the refusal on 2026-10-02; building again/);
  assert.equal(third.calls, 2);
  assert.equal(third.record.library_mtime, fs.statSync(path.join(prof, 'cv-library.json')).mtimeMs);
  fs.utimesSync(path.join(prof, 'lint-rules.json'), later, later);
  assert.equal(runPack(h, ['--no-telegram']).calls, 3);
});

test('pack: cover letter and answers get lint flags, errors and warnings, each rule once, no repeat of a fact rule or a universal check', { skip: !HAS_PY && 'python3 is not installed' }, () => {
  const lintRules = { ...RULES_JSON, warn_claims: [...RULES_JSON.warn_claims, { id: 'third-person', pattern: '\\b(he|she)\\b', why: 'Write in the first person.' }] };
  const p = packRun('pack-flags', { positioning: 'Clinic billing.', flags: [], cv: cvPick({ summary: 'Passionate product manager for clinic software.' }),
    cover_letter: { blocks: [{ kind: 'p', text: 'I was the first PM at a clinic startup.' }, { kind: 'p', text: 'I am passionate about clinics.' },
      { kind: 'p', text: 'Passionate again, and the first PM again.' }, { kind: 'p', text: 'My last manager said he would vouch for me.' }, { kind: 'sign', text: 'Jordan Vale' }] },
    answers: [{ field: 'Why us?', answer: 'I am passionate about your mission.', own_words: false },
      { field: 'Past roles', answer: 'I worked next to a CTO for two years.', own_words: false },
      { field: 'Team', answer: 'I led a team of 12 people.', own_words: true }] }, { lintRules });
  assert.equal(p.r.status, 0, p.r.stdout + p.r.stderr);
  const f = p.json.flags;
  // "he": the universal third-person check reports it; the lint rule third-person adds nothing
  assert.deepEqual(f.filter(x => x.startsWith('Cover letter')), ['Cover letter needs a look: third person.', 'Cover letter: first-pm (Not the first PM anywhere.)', 'Cover letter, warning: fluff (Empty words.)']);
  assert.ok(f.includes('Answer "Why us?", warning: fluff (Empty words.)'), f.join('\n'));
  assert.ok(f.includes('Answer "Team": big-team (Never managed a team that size.)'), f.join('\n'));
  // the fact rule no-cto already flags this answer; the lint rule with the same id adds nothing
  assert.deepEqual(f.filter(x => x.startsWith('Answer "Past roles"')), ['Answer "Past roles": fact rule no-cto: Never a CTO.']);
  // a warning in model-written CV text is flagged; the vetted bullet over the limit is not
  assert.deepEqual(f.filter(x => x.startsWith('CV lint')), ['CV lint warning: fluff ("Passionate", Empty words.).']);
  assert.deepEqual(p.json.lint.cv.warns.map(h => h.id).sort(), ['bullet-length', 'fluff']);
  assert.match(p.md, /## Check before sending\n[\s\S]*- Cover letter: first-pm \(Not the first PM anywhere\.\)/);
  // pack.json keeps every hit, per paragraph (from 1), as { errors, warns } like the CV and the answers
  const cl = p.json.lint.cover_letter;
  assert.deepEqual([cl.errors.map(h => [h.id, h.para]), cl.warns.map(h => [h.id, h.para])], [[['first-pm', 1], ['first-pm', 3]], [['fluff', 2], ['fluff', 3], ['third-person', 4]]]);
  assert.deepEqual(p.json.lint.answers.map(a => [a.field, a.errors.map(h => h.id), a.warns.map(h => h.id)]),
    [['Why us?', [], ['fluff']], ['Past roles', ['no-cto'], []], ['Team', ['big-team'], []]]);
  assert.ok(!f.some(x => /CV lint: /.test(x)), 'clean model text: no fallback');
});

test('run: a refused pack is listed in run_done and the closing line, and does not fail the run', { skip: !HAS_PY && 'python3 is not installed' }, () => {
  const h = packHome('run-refused', { positioning: 'Team lead.', flags: [], answers: [],
    cv: cvPick({ experience: [{ key: 'northwind', bullet_ids: ['nw-launch', 'nw-team'] }] }) });
  // a decoded strong fit from today, so the decoder makes it today's pick and the pack step takes it
  const day = new Date().toISOString().slice(0, 10);
  const dec = path.join(h, 'data', 'decoded', JOB);
  fs.writeFileSync(dec, fs.readFileSync(dec, 'utf8').replace('verdict: strong-fit\n', `verdict: strong-fit\nconfidence: high\napply_priority: 1\nrationale: synthetic\naction: apply\n\nDecoded ${day}\n`));
  const appender = path.join(h, 'append-stdin.mjs'), hookOut = path.join(h, 'run_done.jsonl');
  fs.writeFileSync(appender, `import fs from 'node:fs'; let s=''; process.stdin.on('data', d => s += d).on('end', () => fs.appendFileSync(process.argv[2], s + '\\n'));`);
  const st = JSON.parse(fs.readFileSync(path.join(h, 'settings.json'), 'utf8'));
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({ ...st, hooks: { run_done: `node "${appender}" "${hookOut}"` } }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'run'], { encoding: 'utf8', timeout: 120000,
    env: { ...tgEnv(h), COMETSCOUT_RUN_DATE: day, NODE_OPTIONS: `--import=${pathToFileURL(path.join(h, 'mock-fetch.mjs')).href}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /cometscout: run finished; refused pack\(s\): ExampleCare, Product Manager \(big-team\)/);
  const done = readLines(hookOut).map(l => JSON.parse(l)).find(e => e.event === 'run_done');
  assert.equal(done.pack_exit, 0);
  assert.deepEqual(done.refused, [{ file: JOB, company: 'ExampleCare', role: 'Product Manager', rules: ['big-team'] }]);
  assert.deepEqual(done.sources_failed, []);
  assert.ok(readLines(path.join(h, 'tg.jsonl')).some(l => JSON.parse(l).text?.startsWith('Pack not built: ExampleCare, Product Manager.')));
});

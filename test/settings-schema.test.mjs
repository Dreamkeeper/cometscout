// The settings table (lib/settings-schema.mjs) and the pieces the MCP server writes through, tested in this process:
// the table covers every settings key doctor reads (recorded while doctor runs on settings with every feature on)
// and every key of settings.example.json; settingsProblems refuses what doctor refuses; redaction; the unified diff
// and setSetting (layout and CRLF kept, timer reinstalled on a time or timezone change); .env writes; the one-time
// secrets links (single use, expiry); add_job from a link with a fake fetch. Synthetic data only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-schema-'));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8'));
// every feature on, so doctor walks every branch
const ALL_ON = structuredClone(EXAMPLE);
for (const s of Object.values(ALL_ON.sources)) s.enabled = true;
ALL_ON.sources.drop_dir.dir = path.join(tmp, 'drop'); ALL_ON.sources.drop_dir.move_processed_to = path.join(tmp, 'drop', 'processed');
ALL_ON.sources.career_ops.path = path.join(tmp, 'career-ops');
ALL_ON.delivery.telegram.enabled = true; ALL_ON.tracker_export.enabled = true; ALL_ON.sources_report.enabled = true;
ALL_ON.modules.coach.enabled = true; ALL_ON.modules.coach.path = path.join(tmp, 'coach');
ALL_ON.modules.transcribe.enabled = true; ALL_ON.modules.transcribe.path = path.join(tmp, 'transcribe');
ALL_ON.health.ping_url = 'https://hc.example/ping/synthetic-uuid';
ALL_ON.hooks = { decoded: 'echo synthetic', timeout_sec: 30 };
ALL_ON.llm.bin = 'cometscout-no-such-cli';
ALL_ON.pack.soffice = 'cometscout-no-such-soffice';
ALL_ON.decoder.context_files = ['notes.md'];
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(ALL_ON, null, 2));
fs.writeFileSync(path.join(tmp, '.env'), 'RTJ_API_TOKEN=synthetic-rtj-token-0001\nTELEGRAM_CHAT_ID=12345678\n');
// the machine running the tests may have real secrets in its environment: none of them may reach these tests
for (const k of Object.keys(process.env)) if (/^(RTJ_|TELEGRAM_|GMAIL_|HIRIFY_)|TOKEN|SECRET|COOKIE|PASSW|API_?KEY/i.test(k) && !/^(ANTHROPIC|CLAUDE|OPENAI|CODEX)_/.test(k)) delete process.env[k];
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');

const { SETTINGS, SECRET_VALUES, parseEnv } = await import('../lib/config.mjs');
const schema = await import('../lib/settings-schema.mjs');
const { doctorItems } = await import('../lib/doctor.mjs');
const { setSetting, unifiedDiff } = await import('../lib/settings-writer.mjs');
const { setEnvValues } = await import('../lib/secrets.mjs');
const form = await import('../lib/secrets-form.mjs');
const { createServer, resolveScope } = await import('../lib/mcp.mjs');
const { toolContext, validate, redactArgs, TOOLS } = await import('../lib/mcp-tools.mjs');

/** Run fn with every read of SETTINGS recorded as a dotted path. */
function recordReads(obj, fn) {
  const seen = new Set();
  const skip = p => typeof p !== 'string' || p in Object.prototype || p === 'toJSON' || p === 'then';
  const wrap = (v, at) => (v && typeof v === 'object' && !Array.isArray(v) ? new Proxy(v, {
    get(t, p, r) { if (!skip(p)) seen.add(`${at}.${p}`); return wrap(Reflect.get(t, p, r), `${at}.${p}`); },
  }) : v);
  const own = Object.keys(obj), saved = Object.fromEntries(own.map(k => [k, obj[k]])), proto = Object.getPrototypeOf(obj);
  for (const k of own) Object.defineProperty(obj, k, { configurable: true, enumerable: true, get: () => { seen.add(k); return wrap(saved[k], k); } });
  Object.setPrototypeOf(obj, new Proxy({}, { get(t, p) { if (!skip(p)) seen.add(p); return Reflect.get(Object.prototype, p); } }));
  try { fn(); } finally {
    Object.setPrototypeOf(obj, proto);
    for (const k of own) Object.defineProperty(obj, k, { configurable: true, enumerable: true, writable: true, value: saved[k] });
  }
  return [...seen].sort();
}

test('the table covers every settings key doctor reads', () => {
  const read = recordReads(SETTINGS, () => doctorItems());
  assert.ok(read.length > 40, `doctor read only ${read.length} keys; the recorder is not seeing them`);
  for (const k of ['sources.rtj.token_env', 'delivery.telegram.token_env', 'modules.transcribe.threads', 'gates.headcount.reject_keywords_over', 'update.channel', 'backup.nightly']) assert.ok(read.includes(k), `doctor should read ${k}`);
  const unknown = read.filter(k => !schema.knownPath(k.split('.')));
  assert.deepEqual(unknown, [], `settings doctor reads that lib/settings-schema.mjs does not describe: ${unknown.join(', ')}`);
});

test('the table describes every key of settings.example.json, and the example passes its checks', () => {
  assert.deepEqual(schema.unknownKeys([], EXAMPLE), []);
  assert.deepEqual(schema.settingsProblems(EXAMPLE), []);
  for (const x of schema.SCHEMA) {
    assert.ok(x.help && !x.help.includes(String.fromCharCode(8212)), `${x.key}: one line of help, no em dash`);
    if (x.default !== undefined && x.default !== null) assert.deepEqual(schema.valueProblems(x, x.default), [], `${x.key}: its default fails its own type`);
  }
  assert.deepEqual(Object.keys(schema.SOURCES).sort(), Object.keys(EXAMPLE.sources).sort(), 'every source has an example block');
});

test('settingsProblems refuses what doctor refuses', () => {
  const p = s => schema.settingsProblems({ ...EXAMPLE, ...s }).join('\n');
  assert.match(p({ schedule: { days: [1], time: '25:00' } }), /schedule\.time must be HH:MM/);
  assert.match(p({ schedule: { days: [0, 8], time: '18:00' } }), /schedule\.days/);
  assert.match(p({ llm: { provider: 'claude', model: 'gpt-5', pack_model: 'opus' } }), /gpt-5 is not a claude model/);
  assert.match(p({ locale: 'xx' }), /locale/);
  assert.match(p({ sources: { ...EXAMPLE.sources, nosuch: { enabled: true } } }), /unknown source\(s\): nosuch/);
  assert.match(p({ gates: { ...EXAMPLE.gates, nosuch: 1 } }), /unknown key\(s\) under gates: nosuch/);
  assert.match(p({ hooks: { nosuch: 'x' } }), /unknown hook event/);
  assert.match(p({ picks: { ...EXAMPLE.picks, per_day: 99 } }), /picks\.per_day must be from 0 to 10/);
  assert.match(p({ picks: { ...EXAMPLE.picks, per_day: 'two' } }), /picks\.per_day must be an integer/);
  assert.match(p({ update: { channel: 'nightly' } }), /update\.channel/);
  assert.match(p({ timezone: 'Mars/Olympus' }), /not a time zone/);
  assert.equal(p({}), '');
});

test('redaction: sensitive keys, secret-named keys, loaded secret values, URLs with credentials; *_env names stay', () => {
  const r = schema.redactSettings({ health: { ping_url: 'https://hc.example/x' }, sources: { rtj: { token_env: 'RTJ_API_TOKEN' }, x: { api_token: 'abc' } }, note: 'has synthetic-rtj-token-0001 inside', u: 'https://user:pw@host/', q: 'https://h/?token=1' }, { secrets: SECRET_VALUES() });
  assert.equal(r.health.ping_url, schema.REDACTED);
  assert.equal(r.sources.rtj.token_env, 'RTJ_API_TOKEN');
  assert.equal(r.sources.x.api_token, schema.REDACTED);
  assert.equal(r.note, schema.REDACTED);
  assert.equal(r.u, schema.REDACTED); assert.equal(r.q, schema.REDACTED);
  const a = redactArgs(TOOLS.find(t => t.name === 'settings_set'), { path: 'health.ping_url', value: 'https://hc.example/secret' }, []);
  assert.equal(a.value, schema.REDACTED);
  const b = redactArgs(TOOLS.find(t => t.name === 'add_job'), { text: `x synthetic-rtj-token-0001 y`, company: 'A', cookie: 'c' }, ['synthetic-rtj-token-0001']);
  assert.deepEqual(b, { text: schema.REDACTED, company: 'A', cookie: schema.REDACTED });
});

test('unifiedDiff: hunks with context, nothing for equal texts', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
  const n = k => Array.from({ length: k }, (_, x) => String(x + 1));
  const two = unifiedDiff(n(14).join('\n'), n(14).map(l => (l === '5' ? 'five' : l === '14' ? 'fourteen' : l)).join('\n'));
  assert.equal(two, ['--- settings.json', '+++ settings.json', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8', '@@ -11,4 +11,4 @@', ' 11', ' 12', ' 13', '-14', '+fourteen', ''].join('\n'));
  // changes six lines apart share one hunk, as diff -u does
  const one = unifiedDiff(n(12).join('\n'), n(12).map(l => (l === '5' ? 'five' : l === '12' ? 'twelve' : l)).join('\n'));
  assert.match(one, /^@@ -2,11 \+2,11 @@$/m); assert.equal(one.match(/^@@/gm).length, 1);
});

test('setSetting: dry run writes nothing; a write keeps layout and CRLF; timezone and time reinstall the timer', () => {
  const f = path.join(tmp, 'crlf-settings.json');
  const text = '{\r\n  "_comment": "keep me",\r\n  "timezone": "UTC",\r\n  "picks": { "per_day": 2 },\r\n  "schedule": { "days": [1, 2, 3, 4, 5], "time": "18:00" }\r\n}\r\n';
  fs.writeFileSync(f, text);
  const dry = setSetting(['picks', 'per_day'], 3, { file: f });
  assert.equal(dry.ok, true); assert.equal(dry.written, false); assert.equal(fs.readFileSync(f, 'utf8'), text);
  assert.match(dry.diff, /^-  "picks": \{ "per_day": 2 \},$/m); assert.match(dry.diff, /^\+  "picks": \{ "per_day": 3 \},$/m);
  const calls = [];
  const w = setSetting(['picks', 'per_day'], 3, { file: f, dryRun: false, reinstall: t => { calls.push(t); return { done: true }; } });
  assert.equal(w.written, true); assert.equal(w.timer, null); assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(f, 'utf8'), text.replace('"per_day": 2', '"per_day": 3'));
  const tz = setSetting(['timezone'], 'Europe/Madrid', { file: f, dryRun: false, reinstall: t => { calls.push(t); return { done: false }; } });
  assert.equal(tz.timer, 'manual'); assert.deepEqual(calls, ['18:00']);
  const tm = setSetting(['schedule', 'time'], '07:30', { file: f, dryRun: false, reinstall: t => { calls.push(t); return { done: true }; } });
  assert.equal(tm.timer, 'reinstalled'); assert.deepEqual(calls, ['18:00', '07:30']);
  assert.match(fs.readFileSync(f, 'utf8'), /"_comment": "keep me",\r\n/);
  const refused = setSetting(['picks', 'per_day'], 50, { file: f, dryRun: false, validate: next => ({ problems: schema.settingsProblems(next) }) });
  assert.equal(refused.ok, false); assert.match(refused.problems.join(), /per_day/);
  assert.equal(setSetting(['x'], 1, { file: path.join(ROOT, 'settings.example.json') }).ok, false);
});

test('setEnvValues: replaces in place, appends, quotes edge spaces, keeps CRLF; parseEnv reads it back', () => {
  const f = path.join(tmp, 'test.env');
  fs.writeFileSync(f, '# keep\r\nA=1\r\nexport B=2\r\n');
  setEnvValues({ B: 'two', C: ' spaced ', D: '"quoted"' }, f);
  const t = fs.readFileSync(f, 'utf8');
  assert.equal(t, "# keep\r\nA=1\r\nB=two\r\nC=' spaced '\r\nD='\"quoted\"'\r\n");
  assert.deepEqual(parseEnv(t).values, { A: '1', B: 'two', C: ' spaced ', D: '"quoted"' });
  assert.throws(() => setEnvValues({ E: 'a\nF=b' }, f), /one line/);
  assert.throws(() => setEnvValues({ 'E-1': 'x' }, f), /not a variable name/);
});

test('secrets links: known names only, single use, expire after 15 minutes, store only a hash', () => {
  const file = path.join(tmp, 'links.json'), envFile = path.join(tmp, 'links.env');
  assert.throws(() => form.issueLink(['PATH'], { file }), /cannot be set here/);
  const t0 = Date.parse('2026-10-07T10:00:00Z');
  const a = form.issueLink(['RTJ_API_TOKEN'], { file, now: t0 });
  assert.ok(!fs.readFileSync(file, 'utf8').includes(a.token), 'the token itself is never stored');
  assert.deepEqual(form.peekLink(a.token, { file, now: t0 + 60000 }).keys, ['RTJ_API_TOKEN']);
  assert.equal(form.useLink(a.token, { OTHER: 'x' }, { file, envFile, now: t0 }).status, 400);
  assert.equal(form.useLink(a.token, { RTJ_API_TOKEN: '' }, { file, envFile, now: t0 }).status, 400);
  assert.deepEqual(form.useLink(a.token, { RTJ_API_TOKEN: '  synthetic-new-token  ' }, { file, envFile, now: t0 + 1000 }), { ok: true, saved: ['RTJ_API_TOKEN'] });
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'RTJ_API_TOKEN=synthetic-new-token\n');
  assert.equal(form.useLink(a.token, { RTJ_API_TOKEN: 'again' }, { file, envFile, now: t0 + 2000 }).status, 410, 'single use');
  const b = form.issueLink(['TELEGRAM_CHAT_ID'], { file, now: t0 });
  assert.equal(form.peekLink(b.token, { file, now: t0 + form.LINK_TTL_MS + 1 }), null, 'expired');
  assert.equal(form.useLink(b.token, { TELEGRAM_CHAT_ID: '1' }, { file, envFile, now: t0 + form.LINK_TTL_MS + 1 }).status, 410);
  const needs = form.secretNeeds(SETTINGS);
  assert.deepEqual(needs.find(n => n.feature === 'rtj').keys, [{ name: 'RTJ_API_TOKEN', set: true }]);
  assert.ok(!JSON.stringify(needs).includes('synthetic-rtj-token-0001'), 'never a value');
});

test('resolveScope: the lower of the flag and settings wins; a broken setting means read', () => {
  assert.equal(resolveScope(undefined, undefined), 'operate');
  assert.equal(resolveScope('admin', 'operate'), 'operate');
  assert.equal(resolveScope('read', 'admin'), 'read');
  assert.equal(resolveScope('admin', 'bogus'), 'read');
  assert.throws(() => resolveScope('root'), /--scope/);
});

test('add_job from a link: fetched through lib/fetch-detail.mjs with an injected fetch, queued in the inbox, deduped', async () => {
  const urls = [];
  const fakeFetch = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ title: 'Product Manager, Synthetic', location: { name: 'Remote' }, content: '&lt;p&gt;A synthetic posting about a product role.&lt;/p&gt;', absolute_url: 'https://boards.greenhouse.io/examplecorp/jobs/123' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const s = createServer({ scope: 'operate', ctx: toolContext({ fetch: fakeFetch, logFile: path.join(tmp, 'mcp-log.jsonl') }) });
  const call = async (name, args) => (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } })).result;
  const r = await call('add_job', { url: 'https://boards.greenhouse.io/examplecorp/jobs/123' });
  assert.equal(r.isError, false, JSON.stringify(r));
  assert.equal(r.structuredContent.written, true); assert.equal(r.structuredContent.fetched, true);
  assert.equal(r.structuredContent.company, 'Examplecorp'); assert.equal(r.structuredContent.role, 'Product Manager, Synthetic');
  assert.ok(urls.some(u => u.includes('boards-api.greenhouse.io')), urls.join());
  const job = fs.readFileSync(path.join(tmp, 'data', 'inbox', r.structuredContent.file), 'utf8');
  assert.match(job, /source: "mcp"/); assert.match(job, /A synthetic posting about a product role\./);
  const again = await call('add_job', { url: 'https://boards.greenhouse.io/examplecorp/jobs/123' });
  assert.equal(again.structuredContent.written, false); assert.match(again.structuredContent.reason, /already in/);
  assert.deepEqual(validate(TOOLS.find(t => t.name === 'add_job').outputSchema, again.structuredContent), []);
  const priv = await call('add_job', { url: 'http://127.0.0.1:8787/x' });
  assert.equal(priv.isError, true); assert.match(priv.content[0].text, /could not read the link/);
  const log = fs.readFileSync(path.join(tmp, 'mcp-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(l => [l.tool, l.ok]), [['add_job', true], ['add_job', true], ['add_job', false]]);
});

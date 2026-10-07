// The MCP server (node cli.mjs mcp) spoken to over stdio, as a client would: version negotiation (initialize for the
// handshake era, per-request _meta and server/discover for 2026-07-28), the tools per scope, every tool's happy path on
// the example profile with synthetic jobs (structuredContent checked against outputSchema), settings_set (dry-run diff,
// a real write keeping the layout, refusals), the run lock, the audit log without secrets, the one-time secrets link
// through the workspace, resources and prompts, malformed input, and nothing but protocol messages on stdout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-mcp-'));
const DATA = path.join(tmp, 'data');
const DAY = new Date().toISOString().slice(0, 10);
const addDays = n => { const d = new Date(`${DAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const SECRET = 'synthetic-rtj-token-0001', PING = 'https://hc.example/ping/synthetic-uuid-0001', TG_VALUE = 'synthetic:telegram-bot-token-9999';

// ---------- a home from the example profile, with synthetic jobs ----------
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8'));
settings.timezone = 'UTC';
settings.llm.bin = 'cometscout-no-such-cli';   // doctor answers fast: no model CLI is started
settings.health.ping_url = PING;
settings.sources.rtj.enabled = true;
const SETTINGS_TEXT = JSON.stringify(settings, null, 2).replace(/\n/g, '\r\n') + '\r\n';   // CRLF, as an editor on Windows saves it
fs.writeFileSync(path.join(tmp, 'settings.json'), SETTINGS_TEXT);
fs.writeFileSync(path.join(tmp, '.env'), `RTJ_API_TOKEN=${SECRET}\n`);
fs.cpSync(path.join(ROOT, 'profile.example'), path.join(tmp, 'profile'), { recursive: true });
for (const d of ['inbox', 'decoded', 'rejected', 'state', 'digests', 'packs']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
const job = (dir, company, role, { verdict = 'strong-fit', priority = 2, ago = 1 } = {}) => {
  const d = addDays(-ago), file = `${d}--${company.toLowerCase()}--${role.toLowerCase().replace(/\W+/g, '-')}.md`;
  const decode = dir === 'inbox' ? [] : ['## Decode Result', `Decoded ${d} by CometScout (claude/sonnet).`, `verdict: ${verdict}`, 'confidence: high', `apply_priority: ${priority}`, 'rationale: Fits the synthetic profile.', 'fit_signals: APIs', 'gaps: none', 'action: Apply today.', ''];
  fs.writeFileSync(path.join(DATA, dir, file), ['---', `company: "${company}"`, `role: "${role}"`, `url: "https://jobs.example/${file}"`, 'source: "ats_boards"', 'location: "Remote"', `found: ${d}`, '---', '', `# ${company} - ${role}`, '', 'Synthetic job text.', '', ...decode].join('\n'));
  return file;
};
const F = { pick: job('decoded', 'Alderwick', 'Product Manager'), pool: job('decoded', 'Birchfield', 'Product Owner', { ago: 2 }), rej: job('rejected', 'Corvale', 'Data Scientist', { verdict: 'weak-fit' }), inbox: job('inbox', 'Dunmore', 'Platform PM') };
fs.writeFileSync(path.join(DATA, 'state', 'picks.json'), JSON.stringify({ [F.pick]: { shown: 1, last: DAY } }));
const APPS = path.join(DATA, 'state', 'applications.json');
fs.writeFileSync(APPS, JSON.stringify({ 'manual:eastvale|pm': { company: 'Eastvale', role: 'PM', status: 'rejected', updated: addDays(-3), events: [{ date: addDays(-3), type: 'rejected', source: 'gmail' }] } }, null, 1));
fs.writeFileSync(path.join(DATA, 'state', 'runs.jsonl'), `${JSON.stringify({ date: addDays(-1), started: `${addDays(-1)}T18:00:00Z`, finished: `${addDays(-1)}T18:05:00Z`, seconds: 300, exit: 0, off_day: false, sources: [{ source: 'ats_boards', exit: 0 }, { source: 'rtj', exit: 2 }], decoder_exit: 0, pack_exit: 0, refused: [], counts: { new_jobs: 3, decoded: 2, worth_applying: 1, picks: 1 } })}\n`);
const DIGEST = `Sam: 2 decoded ${addDays(-1)}\n\nWorth applying (1)\n`;
fs.writeFileSync(path.join(DATA, 'digests', `${addDays(-1)}.md`), DIGEST);

// no real secret from the machine running the tests reaches the server
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(/^(RTJ_|TELEGRAM_|GMAIL_|HIRIFY_)|TOKEN|SECRET|COOKIE|PASSW|API_?KEY/i.test(k) && !/^(ANTHROPIC|CLAUDE|OPENAI|CODEX)_/.test(k)) && !/^(COMETSCOUT|JOBPILOT)_/.test(k)));
Object.assign(ENV, { COMETSCOUT_HOME: tmp, COMETSCOUT_DATA: DATA, COMETSCOUT_SETTINGS: path.join(tmp, 'settings.json') });
Object.assign(process.env, { COMETSCOUT_HOME: tmp, COMETSCOUT_DATA: DATA, COMETSCOUT_SETTINGS: path.join(tmp, 'settings.json') });
const { validate, TOOLS } = await import('../lib/mcp-tools.mjs');

// ---------- the client side ----------
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'cometscout-test', version: '1' } };
const allLines = [], children = [];
function startMcp(args = ['--scope', 'admin'], env = ENV) {
  const child = spawn(process.execPath, [CLI, 'mcp', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const msgs = [], waiters = [];
  let buf = '', stderr = '', next = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => {
    buf += c;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); allLines.push(l);
      let m = null; try { m = JSON.parse(l); } catch { /* checked by the stdout test */ }
      msgs.push(m);
      for (const w of [...waiters]) if (m && w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    }
  });
  child.stderr.on('data', c => { stderr += c; });
  const waitFor = (pred, what) => {
    const hit = msgs.find(m => m && pred(m)); if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer for ${what} in 90 s; stderr:\n${stderr}`)), 90000);
      waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m); } });
    });
  };
  const send = raw => child.stdin.write(`${raw}\n`);
  const request = (method, params, id = next++) => { send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })); return waitFor(m => m.id === id, method); };
  const modern = (method, params = {}) => request(method, { ...params, _meta: META });
  const call = async (name, args = {}) => (await modern('tools/call', { name, arguments: args })).result;
  const close = () => new Promise(resolve => { if (child.exitCode !== null) return resolve(child.exitCode); child.once('exit', resolve); child.stdin.end(); });
  return { child, send, request, modern, call, waitFor, close, stderr: () => stderr };
}
after(async () => { for (const c of children) if (c.exitCode === null) c.kill(); });
const structured = (name, r) => {
  assert.equal(r.isError, false, `${name}: ${r.content?.[0]?.text}`);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent, `${name}: the text is the structured content`);
  const schema = TOOLS.find(t => t.name === name).outputSchema;
  assert.deepEqual(validate(schema, r.structuredContent, name), [], `${name}: structuredContent matches outputSchema`);
  return r.structuredContent;
};

test('version negotiation: initialize for the handshake era; per-request _meta and server/discover for 2026-07-28', async () => {
  const s = startMcp(['--scope', 'read']);
  assert.deepEqual((await s.request('ping')).result, {});
  const early = await s.request('tools/list');
  assert.equal(early.error.code, -32602); assert.match(early.error.message, /initialize/);
  const disc = await s.modern('server/discover');
  assert.equal(disc.result.resultType, 'complete');
  assert.deepEqual(disc.result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
  assert.deepEqual(Object.keys(disc.result.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.equal(disc.result._meta['io.modelcontextprotocol/serverInfo'].name, 'cometscout');
  assert.ok(disc.result.ttlMs >= 0); assert.equal(disc.result.cacheScope, 'private');
  const old = await s.request('tools/list', { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } });
  assert.equal(old.error.code, -32022); assert.deepEqual(old.error.data, { supported: disc.result.supportedVersions, requested: '1999-01-01' });
  const noCaps = await s.request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
  assert.equal(noCaps.error.code, -32602);
  const modernList = await s.modern('tools/list');
  assert.equal(modernList.result.resultType, 'complete'); assert.ok(modernList.result.tools.length > 0);
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'cometscout'); assert.ok(init.result.capabilities.tools);
  s.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const legacyList = await s.request('tools/list');
  assert.equal(legacyList.result.resultType, undefined, 'no 2026 fields for a client of the handshake era');
  assert.deepEqual(legacyList.result.tools.map(t => t.name), modernList.result.tools.map(t => t.name));
  const newer = await s.request('initialize', { protocolVersion: '2030-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(newer.result.protocolVersion, '2025-11-25', 'an unknown version gets our newest of that era');
  assert.equal(await s.close(), 0);
});

test('tools per scope: read, operate, admin; settings mcp.scope lowers --scope; a bad --scope stops', async () => {
  const names = async (args, env) => { const s = startMcp(args, env); const r = (await s.modern('tools/list')).result.tools.map(t => t.name); await s.close(); return r; };
  const read = ['status', 'doctor', 'run_log', 'settings_get', 'settings_schema', 'onboarding_state', 'today', 'jobs_search', 'job_get', 'applications_list', 'secrets_status'];
  assert.deepEqual(await names(['--scope', 'read']), read);
  assert.deepEqual(await names([]), [...read, 'set_status', 'record_interview', 'add_job'], 'operate is the default');
  assert.deepEqual(await names(['--scope', 'admin']), [...read, 'set_status', 'record_interview', 'add_job', 'settings_set', 'secrets_form']);
  const low = path.join(tmp, 'settings-read-scope.json');
  fs.writeFileSync(low, JSON.stringify({ ...settings, mcp: { scope: 'read' } }));
  assert.deepEqual(await names(['--scope', 'admin'], { ...ENV, COMETSCOUT_SETTINGS: low }), read);
  const s = startMcp(['--scope', 'read']);
  const r = await s.modern('tools/call', { name: 'set_status', arguments: { file: F.pick, status: 'applied' } });
  assert.equal(r.error.code, -32602); assert.match(r.error.message, /needs the operate scope/);
  await s.close();
  for (const t of (await (async () => { const a = startMcp(['--scope', 'admin']); const l = (await a.modern('tools/list')).result.tools; await a.close(); return l; })())) {
    assert.equal(t.inputSchema.type, 'object'); assert.equal(t.outputSchema.type, 'object');
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    assert.equal(t.annotations.readOnlyHint, TOOLS.find(x => x.name === t.name).scope === 'read', `${t.name}: readOnlyHint matches its scope`);
  }
  const bad = startMcp(['--scope', 'root']);
  assert.equal(await new Promise(res => bad.child.once('exit', res)), 2);
  assert.match(bad.stderr(), /--scope must be read, operate or admin/);
});

test('read tools answer on the example profile, each matching its outputSchema', async () => {
  const s = startMcp(['--scope', 'read']);
  const st = structured('status', await s.call('status'));
  assert.equal(st.home, tmp); assert.equal(st.scope, 'read'); assert.deepEqual(st.last_run.counts, { new_jobs: 3, decoded: 2, worth_applying: 1, picks: 1 });
  assert.deepEqual(st.last_run.failures, ['source rtj exited 2']);
  assert.deepEqual(st.sources.find(x => x.name === 'rtj'), { name: 'rtj', enabled: true, last_exit: 2 });
  assert.equal(st.next_run.time, '18:00'); assert.equal(st.next_run.timezone, 'UTC');
  const doc = structured('doctor', await s.call('doctor'));
  assert.ok(doc.items.some(i => i.level === 'todo' && /cometscout-no-such-cli|claude CLI not found/.test(i.text + i.fix)), 'the missing model CLI is a todo');
  assert.ok(doc.items.some(i => i.level === 'ok' && /RealtimeJobs token/.test(i.text)));
  assert.equal(structured('run_log', await s.call('run_log', { limit: 5 })).runs.length, 1);
  const all = structured('settings_get', await s.call('settings_get'));
  assert.equal(all.value.health.ping_url, '[redacted]'); assert.equal(all.value.sources.rtj.token_env, 'RTJ_API_TOKEN');
  assert.ok(!JSON.stringify(all).includes(SECRET) && !JSON.stringify(all).includes(PING));
  assert.deepEqual(structured('settings_get', await s.call('settings_get', { path: 'picks.per_day' })), { file: path.join(tmp, 'settings.json'), path: 'picks.per_day', value: 2, set: true, default: 2 });
  const unknown = await s.call('settings_get', { path: 'picks.nosuch' });
  assert.equal(unknown.isError, true); assert.match(unknown.content[0].text, /settings_schema/);
  const sch = structured('settings_schema', await s.call('settings_schema', { path: 'schedule' }));
  assert.deepEqual(sch.settings.map(x => x.key), ['schedule', 'schedule.days', 'schedule.time']);
  assert.equal(structured('settings_schema', await s.call('settings_schema', { path: 'hooks' })).settings.every(x => x.settable === false), true);
  const ob = structured('onboarding_state', await s.call('onboarding_state'));
  assert.equal(ob.steps.find(x => x.id === 'profile').done, true); assert.equal(ob.steps.find(x => x.id === 'first_result').done, true);
  assert.equal(ob.next, 'delivery');
  const today = structured('today', await s.call('today'));
  assert.deepEqual(today.picks.map(p => p.file), [F.pick]); assert.ok(today.pool.some(p => p.file === F.pool));
  assert.deepEqual(structured('jobs_search', await s.call('jobs_search', { query: 'birch' })).jobs.map(j => j.file), [F.pool]);
  const rejected = structured('jobs_search', await s.call('jobs_search', { folder: 'rejected', verdict: 'weak-fit' }));
  assert.deepEqual(rejected.jobs, [{ file: F.rej, folder: 'rejected', company: 'Corvale', role: 'Data Scientist', verdict: 'weak-fit', date: addDays(-1) }]);
  assert.equal(structured('jobs_search', await s.call('jobs_search', { from: DAY })).total, 0);
  const one = structured('job_get', await s.call('job_get', { file: F.pick }));
  assert.equal(one.decode.verdict, 'strong-fit'); assert.match(one.text, /Synthetic job text/);
  assert.equal(structured('job_get', await s.call('job_get', { file: F.inbox })).decode, null);
  assert.equal((await s.call('job_get', { file: '../settings.json' })).isError, true);
  assert.deepEqual(structured('applications_list', await s.call('applications_list', { status: 'rejected' })).applications.map(a => a.company), ['Eastvale']);
  const sec = structured('secrets_status', await s.call('secrets_status'));
  assert.deepEqual(sec.features.find(f => f.feature === 'rtj').keys, [{ name: 'RTJ_API_TOKEN', set: true }]);
  assert.ok(!JSON.stringify(sec).includes(SECRET));
  await s.close();
});

test('operate tools write through the same writers as the CLI; the run lock refuses writes; the audit log keeps no secret', async () => {
  const s = startMcp(['--scope', 'operate']);
  const st = structured('set_status', await s.call('set_status', { file: F.pick, status: 'applied', note: 'sent through the MCP test' }));
  assert.equal(st.application.status, 'applied');
  const apps = JSON.parse(fs.readFileSync(APPS, 'utf8'));
  assert.deepEqual(apps[F.pick].events.at(-1), { date: DAY, type: 'applied', note: 'sent through the MCP test', source: 'mcp' });
  const iv = structured('record_interview', await s.call('record_interview', { company: 'Birchfield', date: addDays(3), time: '10:30', round: 'round 1' }));
  assert.match(iv.message, /interview on .* 10:30 \(round 1\)/);
  const bad = await s.call('set_status', { file: F.pick, status: 'hired' });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /Invalid arguments: arguments\.status must be one of/);
  const added = structured('add_job', await s.call('add_job', { text: `Pasted synthetic posting. ${SECRET}`, company: 'Fernhill', role: 'Product Manager, Growth' }));
  assert.equal(added.written, true); assert.equal(added.fetched, false);
  assert.ok(fs.existsSync(path.join(DATA, 'inbox', added.file)));
  // a run holds the lock: every write is refused and nothing changes
  fs.writeFileSync(path.join(DATA, 'state', 'run.lock'), String(process.pid));
  const before = fs.readFileSync(APPS, 'utf8');
  const busy = await s.call('set_status', { file: F.pool, status: 'skipped' });
  assert.equal(busy.isError, true); assert.match(busy.content[0].text, /busy/);
  assert.equal((await s.call('add_job', { text: 'x', company: 'Glenrock', role: 'PM' })).isError, true);
  assert.equal(fs.readFileSync(APPS, 'utf8'), before);
  fs.rmSync(path.join(DATA, 'state', 'run.lock'));
  await s.close();
  const log = fs.readFileSync(path.join(DATA, 'state', 'mcp-log.jsonl'), 'utf8');
  const lines = log.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.tool, l.ok]), [['set_status', true], ['record_interview', true], ['set_status', false], ['add_job', true], ['set_status', false], ['add_job', false]]);
  for (const l of lines) { assert.ok(l.at && l.summary, JSON.stringify(l)); assert.equal(typeof l.args, 'object'); }
  assert.equal(lines[3].args.text, '[redacted]');
  assert.ok(!log.includes(SECRET), 'no secret value in the audit log');
});

test('settings_set: a dry run returns the diff; a real write keeps the layout and CRLF; unknown, secret, locked and invalid changes are refused', async () => {
  const file = path.join(tmp, 'settings.json');
  const s = startMcp(['--scope', 'admin']);
  const dry = structured('settings_set', await s.call('settings_set', { path: 'picks.per_day', value: 3 }));
  assert.equal(dry.dry_run, true); assert.equal(dry.written, false); assert.equal(dry.changed, true);
  assert.match(dry.diff, /^-    "per_day": 2,$/m); assert.match(dry.diff, /^\+    "per_day": 3,$/m);
  assert.equal(fs.readFileSync(file, 'utf8'), SETTINGS_TEXT, 'a dry run writes nothing');
  const w = structured('settings_set', await s.call('settings_set', { path: 'picks.per_day', value: 3, dry_run: false }));
  assert.equal(w.written, true); assert.equal(w.diff, dry.diff);
  assert.equal(fs.readFileSync(file, 'utf8'), SETTINGS_TEXT.replace('"per_day": 2,', '"per_day": 3,'), 'only that value changed; CRLF kept');
  assert.equal(structured('settings_get', await s.call('settings_get', { path: 'picks.per_day' })).value, 3, 'the server sees its own write');
  const near = structured('settings_set', await s.call('settings_set', { path: 'backup.nightly', value: false }));
  assert.match(near.diff, /"ping_url": "\[redacted\]"/, 'a secret in the diff context is hidden');
  assert.ok(!near.diff.includes(PING));
  const refused = async (args, re) => { const r = await s.call('settings_set', args); assert.equal(r.isError, true, JSON.stringify(args)); assert.match(r.content[0].text, re); };
  await refused({ path: 'picks.nosuch', value: 1 }, /not a known setting/);
  await refused({ path: 'picks', value: { per_day: 2, nosuch: 1 } }, /unknown key\(s\) in the value: picks\.nosuch/);
  await refused({ path: 'delivery.telegram.bot_token', value: 'x' }, /looks like a secret/);
  await refused({ path: 'hooks.decoded', value: 'curl evil.example' }, /hooks\.decoded is locked/);
  await refused({ path: 'sources.drop_dir', value: { enabled: false, dir: '/etc' } }, /sources\.drop_dir\.dir is locked/);
  await refused({ path: 'llm.bin', value: '/bin/sh' }, /locked/);
  await refused({ path: 'schedule.time', value: '25:00' }, /schedule\.time must be HH:MM/);
  await refused({ path: 'llm.model', value: 'gpt-5' }, /gpt-5 is not a claude model/);
  await refused({ path: 'picks.per_day', value: 'two' }, /must be an integer/);
  await refused({ path: 'candidate_name', value: `Sam ${SECRET}` }, /contains a secret/);
  assert.equal(fs.readFileSync(file, 'utf8'), SETTINGS_TEXT.replace('"per_day": 2,', '"per_day": 3,'), 'no refused change was written');
  const warn = structured('settings_set', await s.call('settings_set', { path: 'delivery.telegram.enabled', value: true }));
  assert.ok(warn.warnings.some(x => /telegram needs TELEGRAM_BOT_TOKEN: use secrets_form/.test(x)), warn.warnings.join('\n'));
  await s.close();
  const log = fs.readFileSync(path.join(DATA, 'state', 'mcp-log.jsonl'), 'utf8');
  assert.ok(!log.includes(SECRET) && !log.includes(PING));
  assert.match(log, /"summary":"wrote picks\.per_day"/);
});

test('secrets_form: a one-time link the workspace serves once; the value never reaches a tool result or a log', async () => {
  const serve = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(serve);
  let serveOut = '';
  const base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`serve did not start:\n${serveOut}`)), 30000);
    const on = c => { serveOut += c; const m = serveOut.match(/cometscout workspace: (http:\/\/\S+\/)/); if (m) { clearTimeout(t); resolve(m[1]); } };
    serve.stdout.on('data', on); serve.stderr.on('data', on);
  });
  const port = Number(new URL(base).port);
  const s = startMcp(['--scope', 'admin']);
  const no = await s.call('secrets_form', { keys: ['PATH'] });
  assert.equal(no.isError, true); assert.match(no.content[0].text, /cannot be set here/);
  const link = structured('secrets_form', await s.call('secrets_form', { keys: ['TELEGRAM_BOT_TOKEN'], port }));
  assert.equal(link.workspace_running, true);
  assert.match(link.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/secrets\\?t=[A-Za-z0-9_-]{20,}$`));
  assert.ok(link.steps.some(x => x.includes(`ssh -L ${port}:127.0.0.1:${port}`)));
  const token = new URL(link.url).searchParams.get('t');
  const page = await fetch(link.url);
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /form-action 'none'/);
  const html = await page.text();
  assert.match(html, /name="TELEGRAM_BOT_TOKEN" type="password"/); assert.match(html, /\/web\/secrets\.js/);
  assert.equal((await fetch(new URL('/web/secrets.js', base))).status, 200);
  const post = (body, headers = { 'X-CometScout': '1' }) => fetch(new URL('/api/secrets', base), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ t: token, values: { TELEGRAM_BOT_TOKEN: TG_VALUE } }, {})).status, 403, 'the header is required');
  const ok = await post({ t: token, values: { TELEGRAM_BOT_TOKEN: TG_VALUE } });
  assert.equal(ok.status, 200); const okBody = await ok.json();
  assert.deepEqual(okBody, { ok: true, saved: ['TELEGRAM_BOT_TOKEN'] });
  assert.match(fs.readFileSync(path.join(tmp, '.env'), 'utf8'), new RegExp(`^TELEGRAM_BOT_TOKEN=${TG_VALUE}$`, 'm'));
  assert.equal((await post({ t: token, values: { TELEGRAM_BOT_TOKEN: 'again' } })).status, 410, 'single use');
  assert.equal((await fetch(link.url)).status, 410);
  const sec = structured('secrets_status', await s.call('secrets_status'));
  assert.deepEqual(sec.features.find(f => f.feature === 'telegram').keys.find(k => k.name === 'TELEGRAM_BOT_TOKEN'), { name: 'TELEGRAM_BOT_TOKEN', set: true });
  await s.close();
  serve.kill();
  const everything = [allLines.join('\n'), fs.readFileSync(path.join(DATA, 'state', 'mcp-log.jsonl'), 'utf8'), serveOut, fs.readFileSync(path.join(DATA, 'state', 'secrets-links.json'), 'utf8')].join('\n');
  assert.ok(!everything.includes(TG_VALUE), 'the value is in no tool result, log or state file');
  assert.ok(!fs.readFileSync(path.join(DATA, 'state', 'mcp-log.jsonl'), 'utf8').includes(token), 'the token is not logged');
});

test('resources and prompts', async () => {
  const s = startMcp(['--scope', 'read']);
  const list = (await s.modern('resources/list')).result;
  assert.deepEqual(list.resources.map(r => r.uri), ['cometscout://settings/schema', 'cometscout://digest/latest', 'cometscout://doctor', 'cometscout://onboarding']);
  const read = async uri => (await s.modern('resources/read', { uri })).result.contents[0];
  assert.ok(JSON.parse((await read('cometscout://settings/schema')).text).settings.some(x => x.key === 'schedule.time'));
  assert.equal((await read('cometscout://digest/latest')).text, DIGEST);
  assert.ok(Array.isArray(JSON.parse((await read('cometscout://doctor')).text).items));
  assert.equal(JSON.parse((await read('cometscout://onboarding')).text).next, 'delivery');
  const missing = await s.modern('resources/read', { uri: 'cometscout://nope' });
  assert.equal(missing.error.code, -32602); assert.deepEqual(missing.error.data, { uri: 'cometscout://nope' });
  const prompts = (await s.modern('prompts/list')).result.prompts;
  assert.deepEqual(prompts.map(p => p.name), ['setup', 'tune-gates', 'weekly-review']);
  const setup = (await s.modern('prompts/get', { name: 'setup' })).result;
  assert.equal(setup.messages[0].role, 'user'); assert.match(setup.messages[0].content.text, /onboarding_state/);
  assert.match(setup.messages[0].content.text, /not in the admin scope/, 'a read-scope server says it cannot write settings');
  assert.match((await s.modern('prompts/get', { name: 'tune-gates', arguments: { days: '30' } })).result.messages[0].content.text, new RegExp(`from "${addDays(-30)}"`));
  assert.match((await s.modern('prompts/get', { name: 'weekly-review' })).result.messages[0].content.text, /applications_list/);
  assert.equal((await s.modern('prompts/get', { name: 'nope' })).error.code, -32602);
  for (const name of ['setup', 'tune-gates', 'weekly-review']) assert.ok(!(await s.modern('prompts/get', { name })).result.messages[0].content.text.includes(String.fromCharCode(8212)), `${name}: no em dash`);
  await s.close();
});

test('malformed input gets JSON-RPC errors and the server keeps going; stdout carries protocol messages only', async () => {
  const s = startMcp(['--scope', 'read']);
  s.send('this is not json');
  assert.equal((await s.waitFor(m => m.id === null && m.error?.code === -32700, 'parse error')).error.code, -32700);
  s.send('[{"jsonrpc":"2.0","id":90,"method":"ping"}]');
  assert.match((await s.waitFor(m => m.id === null && m.error?.code === -32600, 'batch')).error.message, /Batches/);
  s.send('{"jsonrpc":"2.0","id":91}');
  assert.equal((await s.waitFor(m => m.id === 91, 'no method')).error.code, -32600);
  s.send('{"jsonrpc":"1.0","id":92,"method":"ping"}');
  assert.equal((await s.waitFor(m => m.id === 92, 'old jsonrpc')).error.code, -32600);
  assert.equal((await s.modern('nosuch/method')).error.code, -32601);
  assert.equal((await s.request('tools/list', ['positional'])).error.code, -32602);
  assert.equal((await s.modern('tools/call', { name: 'nosuch', arguments: {} })).error.code, -32602);
  const extra = (await s.modern('tools/call', { name: 'status', arguments: { verbose: true } })).result;
  assert.equal(extra.isError, true); assert.match(extra.content[0].text, /verbose is not a known argument/);
  assert.deepEqual((await s.request('ping')).result, {}, 'still answering');
  assert.equal(await s.close(), 0);
  // every line any server wrote in this file is one JSON-RPC 2.0 message
  assert.ok(allLines.length > 50);
  for (const l of allLines) { const m = JSON.parse(l); assert.equal(m.jsonrpc, '2.0', l.slice(0, 200)); assert.ok('result' in m || 'error' in m, l.slice(0, 200)); }
});

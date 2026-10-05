// The workspace API (lib/workspace.mjs, lib/server.mjs) on a temp data folder: today's picks and the pool (closed roles
// left out, later_until), the job and pack payloads, 404s, path traversal on /files/packs/, the Host header check,
// POST without X-CometScout refused, /api/status writing what cli.mjs status writes, a broken applications.json refused,
// and "later" entries that picks, dedupe, history and the tracker export do not count. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-ws-'));
const DATA = path.join(tmp, 'data');
const DAY = new Date().toISOString().slice(0, 10);
const addDays = n => { const d = new Date(`${DAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = DATA;
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
process.env.COMETSCOUT_RUN_DATE = DAY;
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC', picks: { per_day: 2, window_days: 14, max_shown: 3, exclude_location_regex: 'atlantis' } }));
fs.mkdirSync(path.join(tmp, 'profile'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'profile', 'profile.md'), '# Sam Example (synthetic)\n');
fs.writeFileSync(path.join(tmp, 'profile', 'fact-rules.json'), JSON.stringify({ rules: [{ id: 'team-size', pattern: 'team of \\d+', why: 'Sam never managed a team.' }] }));
for (const d of ['decoded', 'rejected', 'inbox', 'state', 'packs']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
const APPS = path.join(DATA, 'state', 'applications.json');
const PDF = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'workspace', 'tiny.pdf'));

const job = (dir, company, role, { verdict = 'strong-fit', priority = 2, location = 'Remote', ago = 1, source = 'ats_boards', band, flags } = {}) => {
  const d = addDays(-ago);
  const file = `${d}--${company.toLowerCase().replace(/\W+/g, '-')}--${role.toLowerCase().replace(/\W+/g, '-')}.md`;
  fs.writeFileSync(path.join(DATA, dir, file), ['---', `company: "${company}"`, `role: "${role}"`, `url: "https://jobs.example/${file}"`, `source: "${source}"`, `location: "${location}"`,
    ...(band ? [`band: "${band}"`] : []), `found: ${d}`, '---', '', `# ${company} - ${role}`, '', 'Synthetic job text about the role.', '', '## Decode Result', `Decoded ${d} by CometScout (claude/sonnet).`,
    `verdict: ${verdict}`, 'confidence: high', `apply_priority: ${priority}`, 'rationale: Fits the synthetic profile.', 'fit_signals: APIs; logistics', 'gaps: none', 'action: Apply today.',
    ...(flags ? [`fact_flags: ${flags}`] : []), ''].join('\n'));
  return file;
};
const F = {
  pickA: job('decoded', 'Alderwick', 'Product Manager, Payments', { priority: 1, band: 1, flags: 'team-size' }),
  pickB: job('decoded', 'Birchfield', 'Product Owner, Data', { ago: 2 }),
  oldPick: job('decoded', 'Corvale', 'Senior Product Manager', { verdict: 'investable-stretch', priority: 3, ago: 3 }),
  pool: job('decoded', 'Dunmore', 'Platform Product Manager', { priority: 2 }),
  later: job('decoded', 'Eastvale', 'Growth Product Manager', { priority: 3 }),
  closedOwn: job('decoded', 'Fernhill', 'Product Manager', {}),
  closedRole: job('decoded', 'Glenrock', 'Product Manager, Billing', {}),
  excluded: job('decoded', 'Hollins', 'Product Manager', { location: 'Atlantis' }),
  tooOld: job('decoded', 'Ivybridge', 'Product Manager', { ago: 30 }),
  rejected: job('rejected', 'Juniper', 'Data Scientist', { verdict: 'weak-fit' }),
  inbox: job('inbox', 'Kestrel', 'Product Manager', {}),
};
fs.writeFileSync(path.join(DATA, 'state', 'picks.json'), JSON.stringify({
  [F.pickA]: { shown: 1, last: DAY }, [F.pickB]: { shown: 2, last: DAY }, [F.oldPick]: { shown: 1, last: addDays(-2) }, 'gone-file.md': { shown: 1, last: DAY },
}, null, 1));
const APPS0 = {
  [F.closedOwn]: { company: 'Fernhill', role: 'Product Manager', status: 'applied', updated: addDays(-1), events: [{ date: addDays(-1), type: 'applied', source: 'cli' }] },
  'manual:glenrock|pm billing': { company: 'Glenrock', role: 'Product Manager Billing', status: 'rejected', updated: addDays(-5) },
  [F.later]: { company: 'Eastvale', role: 'Growth Product Manager', events: [{ date: DAY, type: 'later', until: addDays(3), source: 'workspace' }] },
};
fs.writeFileSync(APPS, JSON.stringify(APPS0, null, 1));
// Packs: pickA through packs.json, pickB found by folder name (the newest of two), pool's refused pack has none.
const pack = (dir, extra = {}) => {
  const abs = path.join(DATA, 'packs', dir); fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'Sam Example CV - X (Y).pdf'), PDF);
  fs.writeFileSync(path.join(abs, 'Sam Example CV - X (Y).docx'), 'not really a docx');
  fs.writeFileSync(path.join(abs, 'notes.txt'), 'not served');
  fs.writeFileSync(path.join(abs, 'answers.md'), `# X: Y\n\n## Check before sending\n- nothing flagged\n\n## Cover letter (paste as text)\nDear team,\n\nSynthetic letter.\n\n## Lint\nCV: no lint hits.\n`);
  fs.writeFileSync(path.join(abs, 'pack.json'), JSON.stringify({ cover_letter: 'text', flags: ['Check the dates.'], answers: [{ field: 'Why us?', answer: 'Synthetic answer.' }], lint: { cv: { errors: [], warns: [] } }, ...extra }));
  return dir;
};
const packA = pack(`${DAY}--alderwick--product-manager-payments`);
pack(`${addDays(-3)}--birchfield--product-owner-data`);
const packB = pack(`${DAY}--birchfield--product-owner-data`);
fs.writeFileSync(path.join(DATA, 'state', 'packs.json'), JSON.stringify({ [F.pickA]: { built: DAY, dir: packA }, [F.pool]: { refused: ['first-pm'], date: DAY } }));

const ws = await import('../lib/workspace.mjs');
const { startServer, allowedHosts, isLoopback } = await import('../lib/server.mjs');
const srv = await startServer({ port: 0, log: () => {} });
after(() => srv.close());

/** A raw request, so paths reach the server exactly as written (fetch would normalise "..") and any Host can be sent. */
function request(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: { Host: `127.0.0.1:${srv.port}`, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, buf, json }); });
    });
    req.on('error', reject); if (body !== undefined) req.write(body); req.end();
  });
}
const post = (p, obj, headers = {}) => request('POST', p, { headers: { 'Content-Type': 'application/json', 'X-CometScout': '1', ...headers }, body: JSON.stringify(obj) });
const resetApps = () => fs.writeFileSync(APPS, JSON.stringify(APPS0, null, 1));

test('/api/today: the latest picks in their order, the pool without closed, excluded or old roles', async () => {
  const r = await request('GET', '/api/today');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const d = r.json;
  assert.equal(d.date, DAY);
  assert.equal(d.picks_date, DAY);
  assert.deepEqual(d.picks.map(p => p.file), [F.pickA, F.pickB], 'yesterday\'s pick and a file that is gone are not today\'s picks');
  const pool = d.pool.map(p => p.file);
  assert.deepEqual(new Set(pool), new Set([F.oldPick, F.pool, F.later]));
  for (const f of [F.closedOwn, F.closedRole, F.excluded, F.tooOld, F.rejected, F.inbox, F.pickA]) assert.ok(!pool.includes(f), f);
  const a = d.picks[0];
  assert.deepEqual({ ...a, url: undefined }, { file: F.pickA, company: 'Alderwick', role: 'Product Manager, Payments', location: 'Remote', source: 'ats_boards', url: undefined,
    verdict: 'strong-fit', apply_priority: 1, band: 1, decoded_on: addDays(-1), shown: 1, application: null, pack: packA, later_until: null });
  assert.equal(d.picks[1].pack, packB, 'without a packs.json entry, the newest folder for the role');
  assert.equal(d.pool.find(p => p.file === F.pool).pack, null, 'a refused pack is no pack');
  assert.equal(d.pool.find(p => p.file === F.later).later_until, addDays(3));
});

test('/api/job: front matter, text without the decode block, the parsed decode with fact flags, history', async () => {
  const r = await request('GET', `/api/job?file=${encodeURIComponent(F.pickA)}`);
  assert.equal(r.status, 200);
  const j = r.json;
  assert.equal(j.fm.company, 'Alderwick');
  assert.equal(j.dir, 'decoded');
  assert.match(j.text, /Synthetic job text/);
  assert.doesNotMatch(j.text, /Decode Result|verdict:/);
  assert.equal(j.decode.verdict, 'strong-fit');
  assert.deepEqual(j.decode.fit_signals, ['APIs', 'logistics']);
  assert.deepEqual(j.decode.gaps, [], '"none" is no gaps');
  assert.deepEqual(j.decode.fact_flags, [{ id: 'team-size', why: 'Sam never managed a team.' }]);
  assert.deepEqual(j.history, []);
  assert.equal(j.application, null);
  const g = (await request('GET', `/api/job?file=${encodeURIComponent(F.closedRole)}`)).json;
  assert.equal(g.history.length, 1);
  assert.match(g.history[0], /Product Manager Billing: rejected$/, 'the history line, without the note meant for the model');
  const rej = await request('GET', `/api/job?file=${encodeURIComponent(F.rejected)}`);
  assert.equal(rej.status, 200, 'rejected/ is readable too');
});

test('/api/job and /api/pack answer 404 for anything that is not a decoded or rejected job; a job without a pack is { pack: null }', async () => {
  for (const f of [F.inbox, 'nope.md', '../state/applications.json', '..%2Fstate%2Fapplications.json', `decoded/${F.pickA}`, `decoded\\${F.pickA}`, '', 'x.json']) {
    for (const api of ['job', 'pack']) {
      const r = await request('GET', `/api/${api}?file=${encodeURIComponent(f)}`);
      assert.equal(r.status, 404, `${api} ${f}`);
      assert.ok(r.json.error);
    }
  }
  const none = await request('GET', `/api/pack?file=${encodeURIComponent(F.pool)}`);
  assert.equal(none.status, 200, 'a job that exists but has no pack');
  assert.deepEqual(none.json, { file: F.pool, dir: null, pack: null });
  assert.equal((await request('GET', '/api/nothing')).status, 404);
});

test('/api/pack: answers, pack.json, the cover letter text and the files with URLs', async () => {
  const r = await request('GET', `/api/pack?file=${encodeURIComponent(F.pickA)}`);
  assert.equal(r.status, 200);
  const p = r.json;
  assert.equal(p.dir, packA);
  assert.match(p.answers, /## Check before sending/);
  assert.deepEqual(p.pack.flags, ['Check the dates.']);
  assert.deepEqual(p.cover_letter, { mode: 'text', text: 'Dear team,\n\nSynthetic letter.' });
  assert.deepEqual(p.files.map(f => f.name), ['Sam Example CV - X (Y).docx', 'Sam Example CV - X (Y).pdf', 'answers.md', 'pack.json'], 'only the served types');
  const pdf = p.files.find(f => f.type === 'pdf');
  assert.equal(p.cv_pdf, pdf.url);
  assert.equal(pdf.url, `/files/packs/${encodeURIComponent(packA)}/${encodeURIComponent('Sam Example CV - X (Y).pdf')}`);
  const got = await request('GET', pdf.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'application/pdf');
  assert.ok(got.buf.equals(PDF), 'the same bytes');
  const docx = await request('GET', p.files[0].url);
  assert.match(docx.headers['content-type'], /wordprocessingml/);
  assert.match(docx.headers['content-disposition'], /^attachment;/);
  assert.match((await request('GET', p.files.find(f => f.name === 'answers.md').url)).headers['content-type'], /^text\/markdown/);
});

test('/files/packs/ refuses traversal, absolute paths, backslashes, other types and links out of the folder', async () => {
  const outside = path.join(DATA, 'state');
  let linked = false;
  try { fs.symlinkSync(outside, path.join(DATA, 'packs', 'linked'), 'junction'); linked = true; } catch { /* no links here */ }
  try { fs.symlinkSync(APPS, path.join(DATA, 'packs', packA, 'apps.json'), 'file'); } catch { /* Windows without the right: the junction covers it */ }
  const bad = [
    `${packA}/../../state/applications.json`, `${packA}/%2e%2e/%2e%2e/state/applications.json`, '%2e%2e/state/applications.json', `..%2Fstate%2Fapplications.json`,
    `${packA}%2F..%2F..%2Fstate/applications.json`, `${encodeURIComponent(APPS)}`, `%2Fetc/passwd`, `${packA}/%2Fetc%2Fpasswd`,
    `${packA}%5C..%5C..%5Cstate/applications.json`, `${packA}/..%5C..%5Cstate%5Capplications.json`, `C%3A%5CWindows/win.ini`, `${packA}/C%3A%5Cx.pdf`,
    `${packA}/notes.txt`, `${packA}`, `${packA}/`, `${packA}/sub/answers.md`, `linked/applications.json`, `${packA}/apps.json`, `${packA}/%00.pdf`, `${packA}/%E0%A4%A.pdf`,
  ];
  for (const p of bad) {
    const r = await request('GET', `/files/packs/${p}`);
    assert.equal(r.status, 404, p);
    assert.ok(!r.buf.toString('utf8').includes('Eastvale'), `${p}: nothing from applications.json`);
  }
  if (linked) assert.ok(fs.existsSync(path.join(DATA, 'packs', 'linked', 'applications.json')), 'the link itself works, the server refuses it');
  for (const l of [path.join(DATA, 'packs', 'linked'), path.join(DATA, 'packs', packA, 'apps.json')]) try { fs.unlinkSync(l); } catch { /* not created */ }
  assert.equal(ws.resolvePackFile(`${packA}/answers.md`).name, 'answers.md');
  assert.equal(ws.resolvePackFile('a/b/c.md'), null);
});

test('only the bound host and port are answered (DNS rebinding); loopback names with the same port are fine', async () => {
  for (const host of ['evil.example', `evil.example:${srv.port}`, `127.0.0.1:${srv.port + 1}`, '127.0.0.1', `0.0.0.0:${srv.port}`]) {
    const r = await request('GET', '/api/today', { headers: { Host: host } });
    assert.equal(r.status, 421, `Host: ${host}`);
  }
  for (const host of [`127.0.0.1:${srv.port}`, `localhost:${srv.port}`, `LOCALHOST:${srv.port}`]) assert.equal((await request('GET', '/api/today', { headers: { Host: host } })).status, 200, host);
  assert.deepEqual([...allowedHosts('192.0.2.7', 9000)], ['192.0.2.7:9000'], 'a non-loopback host allows only itself');
  assert.ok(allowedHosts('::1', 9000).has('[::1]:9000'));
  assert.equal(isLoopback('127.0.0.1'), true); assert.equal(isLoopback('localhost'), true); assert.equal(isLoopback('0.0.0.0'), false); assert.equal(isLoopback('192.168.1.2'), false);
  await assert.rejects(startServer({ host: '0.0.0.0', port: 0, log: () => {} }), /refusing to listen on 0\.0\.0\.0/);
});

test('POST needs X-CometScout: 1 and a JSON body; nothing is written otherwise', async () => {
  resetApps();
  const before = fs.readFileSync(APPS, 'utf8');
  const body = { file: F.pool, status: 'applied' };
  assert.equal((await post('/api/status', body, { 'X-CometScout': '' })).status, 403);
  assert.equal((await request('POST', '/api/status', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403, 'no header');
  assert.equal((await request('POST', '/api/status', { headers: { 'X-CometScout': '1', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'file=x&status=applied' })).status, 415, 'a form post');
  assert.equal((await request('POST', '/api/status', { headers: { 'X-CometScout': '1', 'Content-Type': 'text/plain' }, body: JSON.stringify(body) })).status, 415);
  assert.equal((await request('POST', '/api/status', { headers: { 'X-CometScout': '1', 'Content-Type': 'application/json' }, body: '{nope' })).status, 400);
  assert.equal((await request('POST', '/api/status', { headers: { 'X-CometScout': '1', 'Content-Type': 'application/json' }, body: '[1]' })).status, 400);
  assert.equal((await post('/api/status', { file: F.pool, status: 'hired' })).status, 400, 'unknown status');
  assert.equal((await post('/api/status', { file: F.inbox, status: 'applied', note: 3 })).status, 400, 'note must be text');
  assert.equal((await post('/api/status', { file: '../x.md', status: 'applied' })).status, 404);
  assert.equal((await post('/api/status', { file: 'nope.md', status: 'applied' })).status, 404);
  assert.equal((await post('/api/nothing', body)).status, 404);
  assert.equal((await request('POST', '/api/status', { headers: { 'X-CometScout': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, note: 'x'.repeat(70000) }) })).status, 413);
  assert.equal((await request('PUT', '/api/status', { headers: { 'X-CometScout': '1' } })).status, 405);
  assert.equal(fs.readFileSync(APPS, 'utf8'), before);
});

test('the header from before the rename (X-Jobpilot: 1) is still accepted; X-CometScout is what the client sends', async () => {
  resetApps();
  const body = JSON.stringify({ file: F.pool, status: 'applied' });
  assert.equal((await request('POST', '/api/status', { headers: { 'X-Jobpilot': '1', 'Content-Type': 'application/json' }, body })).status, 200);
  resetApps();
  assert.equal((await request('POST', '/api/status', { headers: { 'X-CometScout': '1', 'Content-Type': 'application/json' }, body })).status, 200);
  resetApps();
  assert.equal((await request('POST', '/api/status', { headers: { 'X-Jobpilot': '0', 'Content-Type': 'application/json' }, body })).status, 403);
});

test('/api/status writes exactly what cli.mjs status writes for the same input, apart from the event source', async () => {
  resetApps();
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'status', 'Dunmore', 'skipped', 'Platform', '--note', 'too senior'], { encoding: 'utf8', env: process.env, timeout: 60000 });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(cli.stdout, 'Dunmore: Platform Product Manager -> skipped\n', 'the command line prints what it always printed');
  const byCli = JSON.parse(fs.readFileSync(APPS, 'utf8'));
  resetApps();
  const r = await post('/api/status', { file: F.pool, status: 'skipped', note: 'too senior' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const byApi = JSON.parse(fs.readFileSync(APPS, 'utf8'));
  assert.equal(byCli[F.pool].events[0].source, 'cli');
  assert.equal(byApi[F.pool].events[0].source, 'workspace');
  byApi[F.pool].events[0].source = 'cli';
  assert.deepEqual(byApi, byCli);
  assert.deepEqual(byApi[F.pool], { company: 'Dunmore', role: 'Platform Product Manager', status: 'skipped', updated: DAY, note: 'too senior', events: [{ date: DAY, type: 'skipped', note: 'too senior', source: 'cli' }] });
  assert.ok(!(await request('GET', '/api/today')).json.pool.some(p => p.file === F.pool), 'a skipped role leaves the pool');
  // the same for a role that has a "later" entry: the status is set, the later event stays in the history
  const l = await post('/api/status', { file: F.later, status: 'applied' });
  assert.equal(l.status, 200);
  assert.deepEqual(l.json.application.events.map(e => e.type), ['later', 'applied']);
  resetApps();
});

test('a broken applications.json is refused by every API that reads or writes it, and stays as it was', async () => {
  const BROKEN = '{ "x": { "company": "A", ';
  fs.writeFileSync(APPS, BROKEN);
  for (const r of [await post('/api/status', { file: F.pool, status: 'applied' }), await post('/api/later', { file: F.pool, days: 1 }),
    await request('GET', '/api/today'), await request('GET', `/api/job?file=${encodeURIComponent(F.pickA)}`)]) {
    assert.equal(r.status, 409);
    assert.match(r.json.error, /applications\.json is not valid JSON/);
  }
  assert.equal(fs.readFileSync(APPS, 'utf8'), BROKEN);
  resetApps();
});

test('/api/later: 1 to 7 days, an event on the entry, the status unchanged; today shows later_until', async () => {
  resetApps();
  for (const days of [0, 8, 2.5, '3', null, -1]) assert.equal((await post('/api/later', { file: F.pool, days })).status, 400, `days ${days}`);
  assert.equal((await post('/api/later', { file: F.inbox, days: 1 })).status, 404, 'inbox jobs are not on the screen');
  const r = await post('/api/later', { file: F.pool, days: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.json.later_until, addDays(7));
  const apps = JSON.parse(fs.readFileSync(APPS, 'utf8'));
  assert.deepEqual(apps[F.pool], { company: 'Dunmore', role: 'Platform Product Manager', events: [{ date: DAY, type: 'later', until: addDays(7), source: 'workspace' }] });
  const today = (await request('GET', '/api/today')).json;
  assert.equal(today.pool.find(p => p.file === F.pool).later_until, addDays(7), 'still in the pool, with the day it comes back');
  // on a role with a status, the status stays
  await post('/api/later', { file: F.closedOwn, days: 1 });
  const after = JSON.parse(fs.readFileSync(APPS, 'utf8'))[F.closedOwn];
  assert.equal(after.status, 'applied');
  assert.equal(after.updated, addDays(-1));
  assert.deepEqual(after.events.map(e => e.type), ['applied', 'later']);
  resetApps();
});

test('a later-only entry is no application: picks skip the job until then, dedupe, history and the tracker ignore it', async () => {
  resetApps();
  const d = await import('../decoder/decoder.mjs');
  const q = await import('../lib/queue.mjs');
  const { isApplication } = await import('../lib/tracker.mjs');
  const later = APPS0[F.later];
  assert.equal(q.laterOnly(later), true);
  assert.equal(q.laterOnly(APPS0[F.closedOwn]), false);
  assert.equal(isApplication(later), false);
  assert.equal(d.closedRole({ file: F.later, fm: { company: 'Eastvale', role: 'Growth Product Manager' } }, APPS0), false);
  assert.equal(q.inApplications('Eastvale', 'Growth Product Manager'), null);
  assert.equal(d.history('Eastvale', { excludeFile: F.later }), '(nothing before with this company)');
  const pk = await d.buildPicks([], { fetch: async () => ({ ok: true, status: 200, url: '', text: async () => '' }) });
  assert.ok(!pk.picks.some(p => p.file === F.later), 'not a pick before its day');
  fs.writeFileSync(APPS, JSON.stringify({ ...APPS0, [F.later]: { ...later, events: [{ ...later.events[0], until: DAY }] } }));
  assert.ok(d.picksPool().open.some(p => p.file === F.later), 'from that day on it is open again');
});

test('/api/labels: the locale table with English for missing keys', async () => {
  const r = await request('GET', '/api/labels');
  assert.equal(r.status, 200);
  assert.equal(r.json.locale, 'en');
  assert.equal(r.json.labels['ws.act.applied'], 'Applied');
  assert.equal(r.json.labels['verdict.strong-fit'], 'Strong fit');
  const ru = ws.labelsPayload('ru');
  assert.equal(ru.locale, 'ru');
  assert.equal(ru.labels['ws.act.skip'], 'Пропустить');
  assert.equal(ws.labelsPayload('xx').locale, 'en');
});

test('the page has a CSP that allows only its import map inline; static files stay inside web/', async () => {
  const r = await request('GET', '/');
  assert.equal(r.status, 200);
  const csp = r.headers['content-security-policy'];
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  for (const p of ['/web/../lib/config.mjs', '/web/%2e%2e/lib/config.mjs', '/web/..%2Flib%2Fconfig.mjs', '/web/lib%5C..%5C..%5Ccli.mjs', '/web/missing.js', '/web/', '/vendor/preact/package.json', '/vendor/../package.json', '/vendor/compat.module.js'])
    assert.equal((await request('GET', p)).status, 404, p);
  const js = await request('GET', '/web/lib/logic.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
});

test('older pack folders named <date>--<company> are found when no <date>--<company>--<role> folder exists', async () => {
  const mk = (dir, md) => { fs.mkdirSync(path.join(DATA, 'packs', dir), { recursive: true }); if (md != null) fs.writeFileSync(path.join(DATA, 'packs', dir, 'answers.md'), md); return dir; };
  mk(`${addDays(-6)}--corvale`, '# old\n');
  const newest = mk(`${addDays(-1)}--corvale`, '# newer\n');
  mk(`${DAY}--corvalex`, '# another company\n');
  mk(`${DAY}--corvale--data-analyst`, '# another role at the same company\n');
  assert.equal(ws.packDirFor(F.oldPick), newest, 'the newest company-only folder; not another company, not another role');
  assert.equal((await request('GET', '/api/today')).json.pool.find(p => p.file === F.oldPick).pack, newest);
  const exact = mk(`${addDays(-3)}--corvale--senior-product-manager`, '# exact\n');
  assert.equal(ws.packDirFor(F.oldPick), exact, 'a folder for the role wins over a newer company-only one');
  fs.rmSync(path.join(DATA, 'packs', exact), { recursive: true });
  assert.equal(ws.packDirFor(F.oldPick, null, {}), newest, 'an export without packs.json');
  assert.equal(ws.packDirFor(F.later), null, 'no folder at all');
  const other = mk(`${DAY}--corvale`, '# Corvale: Data Analyst\n');
  assert.equal(ws.packDirFor(F.oldPick, null, {}), newest, 'a newer company-only folder built for another role is passed over');
  fs.writeFileSync(path.join(DATA, 'packs', other, 'answers.md'), '# Corvale: Senior Product Manager, Payments\n');
  assert.equal(ws.packDirFor(F.oldPick, null, {}), other, 'the same role (with more words) is taken');
  fs.rmSync(path.join(DATA, 'packs', other), { recursive: true });
});

const OLD_MD = ['# Corvale: Senior Product Manager', '', 'Link: https://jobs.example/corvale', '', '**CV leads with:** Payments platform work', '',
  '## Check before sending', '- Salary expectation is yours to set.', '- The form asks for a start date.', '', '## Form answers (drafts)',
  '### Why Corvale? (rewrite in your own words)', '', 'Because of the synthetic reasons.', 'Two lines of them.', '_Keep it short._', '', '### Notice period', '', 'Four weeks.', '',
  '## Lint', 'CV: no lint hits.', ''].join('\n');

test('a pack without pack.json: answers.md is read for the checks and the answers; nothing is assumed for what it lacks', async () => {
  const dir = `${addDays(-1)}--corvale`;
  fs.writeFileSync(path.join(DATA, 'packs', dir, 'answers.md'), OLD_MD);
  fs.writeFileSync(path.join(DATA, 'packs', dir, 'Sam Example CV - Corvale.pdf'), PDF);
  const r = await request('GET', `/api/pack?file=${encodeURIComponent(F.oldPick)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.dir, dir);
  assert.equal(r.json.pack, null);
  assert.deepEqual(r.json.from_answers, {
    flags: ['Salary expectation is yours to set.', 'The form asks for a start date.'],
    answers: [{ field: 'Why Corvale?', answer: 'Because of the synthetic reasons.\nTwo lines of them.', own_words: true, note: 'Keep it short.' }, { field: 'Notice period', answer: 'Four weeks.', own_words: false }],
    positioning: 'Payments platform work',
  });
  assert.match(r.json.cv_pdf, /Corvale\.pdf$/);
  assert.deepEqual(ws.parseAnswersMd('# Only a title\n\nSome text.\n'), { flags: null, answers: null, positioning: null }, 'missing sections stay unknown');
  assert.deepEqual(ws.parseAnswersMd('## Check before sending\n- nothing flagged\n\n## Form answers (drafts)\nFree text without fields.\n').answers, [{ field: '', answer: 'Free text without fields.' }]);
  assert.equal(ws.parseAnswersMd('## Check before sending\r\n- A\r\n').flags[0], 'A', 'Windows line ends');
  const full = await request('GET', `/api/pack?file=${encodeURIComponent(F.pickA)}`);
  assert.equal(full.json.from_answers, null, 'with pack.json, answers.md is not parsed');
});

test('a note over 500 characters is refused by the command line and the API alike; nothing is written', async () => {
  resetApps();
  const before = fs.readFileSync(APPS, 'utf8');
  const long = 'x'.repeat(501);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'status', 'Dunmore', 'skipped', 'Platform', '--note', long], { encoding: 'utf8', env: process.env, timeout: 60000 });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /^The note is 501 characters; keep it to 500 or fewer\. Nothing was recorded\.$/m);
  const api = await post('/api/status', { file: F.pool, status: 'skipped', note: long });
  assert.equal(api.status, 400);
  assert.match(api.json.error, /The note is 501 characters/);
  assert.equal(fs.readFileSync(APPS, 'utf8'), before);
  const ok = await post('/api/status', { file: F.pool, status: 'skipped', note: 'y'.repeat(500) });
  assert.equal(ok.status, 200, 'exactly 500 is fine');
  assert.equal(ok.json.application.note.length, 500);
  resetApps();
});

test('while the run lock is held, writes answer 409 "busy" and applications.json is untouched; reads still work', async () => {
  resetApps();
  const LOCK = path.join(DATA, 'state', 'run.lock'), before = fs.readFileSync(APPS, 'utf8');
  fs.writeFileSync(LOCK, String(process.ppid));   // a live process that is not this one (the test runner)
  try {
    for (const r of [await post('/api/status', { file: F.pool, status: 'applied' }), await post('/api/later', { file: F.pool, days: 1 })]) {
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'CometScout is busy, try again in a minute');
    }
    assert.equal(fs.readFileSync(APPS, 'utf8'), before);
    assert.equal((await request('GET', '/api/today')).status, 200);
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'decode', '--no-telegram'], { encoding: 'utf8', env: process.env, timeout: 60000 });
    assert.match(cli.stdout, /another CometScout run is in progress/, 'the command line sees the same lock');
    fs.writeFileSync(LOCK, '999999999');   // a pid that is not running: a stale lock
    assert.equal((await post('/api/later', { file: F.pool, days: 1 })).status, 200);
  } finally { fs.rmSync(LOCK, { force: true }); resetApps(); }
});

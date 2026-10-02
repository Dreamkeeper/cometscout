// Daily picks: closed roles by alias family and role overlap, no company no pick, band, shape bonus, on-site exclusion,
// archived links, and the "screen" status from the command line. fetch is injected; synthetic companies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-picks-'));
const DATA = path.join(tmp, 'data');
process.env.JOBPILOT_HOME = tmp;
process.env.JOBPILOT_DATA = DATA;
process.env.JOBPILOT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.JOBPILOT_SETTINGS, JSON.stringify({
  timezone: 'UTC',
  queue: { aliases: [['Acme Robotics', 'Acme'], ['Northwind Labs', 'Northwind', 'NWL Group']] },
  picks: { per_day: 10, window_days: 14, max_shown: 3, exclude_onsite_location_regex: 'germany',
    shape_bonus: [{ location_regex: 'barcelona', rank: 0.5 }, { location_regex: 'spain', rank: 1 }] },
}));
for (const d of ['decoded', 'state']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
const DAY = new Date().toISOString().slice(0, 10);
const APPS = path.join(DATA, 'state', 'applications.json');

let n = 0;
const job = (company, role, location, { priority = 2, band, url } = {}) => {
  const file = `${DAY}--job-${++n}.md`;
  fs.writeFileSync(path.join(DATA, 'decoded', file), ['---', `company: "${company}"`, `role: "${role}"`, `url: "${url || `https://jobs.example/${n}`}"`, `location: "${location}"`,
    ...(band ? [`band: "${band}"`] : []), `found: ${DAY}`, '---', '', `# ${company} - ${role}`, '', 'text', '', '## Decode Result', `Decoded ${DAY} by jobpilot (claude/sonnet).`,
    'verdict: strong-fit', 'confidence: high', `apply_priority: ${priority}`, 'rationale: r', 'action: Apply now.', ''].join('\n'));
  return file;
};
const files = {
  acme: job('Acme Robotics', 'Product Manager, Robotics', 'Remote'),
  lumen: job('Lumenfield', 'Platform Product Owner', 'Remote'),
  quarry: job('Quarry Systems', 'Data Platform PM', 'Remote'),
  harbor: job('Harborline', 'Payments Product Manager', 'Remote'),
  unknown: job('Unknown', 'Product Manager', 'Remote', { priority: 1 }),
  empty: job('', 'Product Manager', 'Remote', { priority: 1 }),
  northwind: job('Northwind', 'Product Manager', 'Remote', { priority: 1, band: 1 }),
  nwl: job('NWL Group', 'Data Product Manager', 'Remote', { priority: 1, band: 2 }),
  ironbark: job('Ironbark', 'Product Manager', 'Remote', { band: 1 }),
  driftwood: job('Driftwood', 'Growth Product Manager', 'Remote', { band: 3 }),
  moss: job('Moss', 'Product Manager', 'Remote, Germany', { band: 4 }),
  halcyon: job('Halcyon', 'Product Manager', 'Barcelona, Spain'),
  juniper: job('Juniper', 'Product Manager', 'Madrid, Spain (Hybrid)'),
  larch: job('Larch', 'Product Manager', 'Berlin, Germany'),
  kite: job('Kite', 'Product Manager', 'London, UK', { url: 'https://hh.ru/vacancy/123' }),
};
fs.writeFileSync(APPS, JSON.stringify({
  'manual:acme|senior pm robotics': { company: 'Acme', role: 'Senior PM, Robotics', status: 'applied', updated: '2026-09-02' },
  [files.lumen]: { company: 'Lumenfield', role: 'Platform Product Owner', status: 'saved' },
  'manual:quarry systems|pm': { company: 'Quarry Systems', role: 'PM', status: 'interview', updated: '2026-09-03' },
  'manual:harborline|payments product': { company: 'Harborline', role: 'Payments Product', status: 'saved', events: [{ date: '2026-09-04', type: 'application_received', source: 'gmail' }] },
  'manual:driftwood|data analyst': { company: 'Driftwood', role: 'Data Analyst', status: 'applied', updated: '2026-09-05' },
}, null, 1));

const d = await import('../decoder/decoder.mjs');
const page = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, url: '', text: async () => body, json: async () => JSON.parse(body) });
const fakeFetch = pages => { const calls = []; const f = async url => { calls.push(url); const p = pages[url]; if (p instanceof Error) throw p; return p || page('<html>open</html>'); }; f.calls = calls; return f; };
const name = p => p.fm.company;

test('picks: closed roles, no company, one per employer, band, shape bonus, on-site exclusion, archived link', async () => {
  const fetch = fakeFetch({ 'https://hh.ru/vacancy/123': page('<h1>PM</h1><span data-qa="vacancy-title-archived-text">archived</span>') });
  const r = await d.buildPicks([], { fetch });
  assert.deepEqual(r.picks.map(name), ['Northwind', 'Ironbark', 'Driftwood', 'Moss', 'Halcyon', 'Juniper']);
  assert.equal(r.open, 8, 'Northwind, NWL Group, Ironbark, Driftwood, Moss, Halcyon, Juniper and Kite are open');
  assert.ok(fetch.calls.includes('https://hh.ru/vacancy/123'), 'Kite was checked and dropped as archived');
});

test('closedRole: own file, closed status or any event, alias family and role overlap or an unreadable role', () => {
  const A = JSON.parse(fs.readFileSync(APPS, 'utf8'));
  const c = (company, role, file = 'x.md') => d.closedRole({ file, fm: { company, role } }, A);
  assert.equal(c('Acme Robotics', 'Product Manager, Robotics'), true, 'alias family, roles overlap');
  assert.equal(c('Acme Robotics', 'Firmware Engineer'), false, 'same employer, another role');
  assert.equal(c('Lumenfield', 'Anything', files.lumen), true, 'its own file is an application');
  assert.equal(c('Lumenfield', 'Platform Product Owner'), false, 'status "saved" with no events is not a process');
  assert.equal(c('Quarry Systems', 'Anything At All'), true, 'the application role has no words: same process');
  assert.equal(c('Harborline', 'Payments Product Lead'), true, 'any event counts');
  assert.equal(c('Driftwood', 'Growth Product Manager'), false);
  const B = { 'manual:larkspur|lead engineer': { company: 'Larkspur', role: 'Lead Engineer', status: 'applied' },
    'manual:marlow|senior product manager': { company: 'Marlow', role: 'Senior Product Manager', status: 'rejected' } };
  assert.equal(d.closedRole({ file: 'y.md', fm: { company: 'Larkspur', role: 'Data Scientist' } }, B), false, 'no stoplist: "Lead Engineer" still has words, none shared');
  assert.equal(d.closedRole({ file: 'y.md', fm: { company: 'Marlow', role: 'Product Manager, Payments' } }, B), true, 'two of three words shared');
});

test('picks: on-site exclusion and location regexes on real location strings', async () => {
  const lisbon = job('Nettlefield', 'Product Manager', 'Lisbon, PT (remote_scope: none)', { priority: 1 });
  const sevilla = job('Oakhurst', 'Product Manager', 'Sevilla, España', { priority: 1 });
  const voronezh = job('Pinecrest', 'Product Manager', 'Воронеж (удалённо)', { priority: 1 });
  const madrid = job('Quillon', 'Product Manager', 'Madrid, ES (remote_scope: geo_restricted, regions: Europe)', { priority: 1 });
  const porto = job('Rowanby', 'Product Manager', 'Porto, PT (remote_scope: country)', { priority: 1 });
  const { SETTINGS } = await import('../lib/config.mjs');
  const keep = { ...SETTINGS.picks };
  Object.assign(SETTINGS.picks, { exclude_onsite_location_regex: 'lisbon|воронеж|madrid|porto', exclude_location_regex: 'espana' });
  try {
    const files = (await d.buildPicks([], { fetch: fakeFetch({}) })).picks.map(p => p.file);
    assert.ok(!files.includes(lisbon), 'remote_scope: none is on-site, so the on-site exclusion applies');
    assert.ok(!files.includes(sevilla), '"espana" matches "España"');
    assert.ok(files.includes(voronezh), 'a fully remote job from an excluded on-site city stays');
    assert.ok(files.includes(madrid), 'remote_scope: geo_restricted is remote, so the on-site exclusion does not drop it');
    assert.ok(files.includes(porto), 'remote_scope: country too');
  } finally { SETTINGS.picks = keep; }
});

test('shapeRank: remote words, office days, on-site, and the first matching shape bonus', () => {
  const bonus = [{ location_regex: 'barcelona', rank: 0.5 }, { location_regex: 'spain', rank: 1 }];
  for (const loc of ['Remote', 'Remoto, España', 'Anywhere', 'Worldwide', 'Удаленно', 'Воронеж (удалённо)', 'Remote-first, EU']) assert.equal(d.shapeRank(loc, bonus), 0, loc);
  assert.equal(d.shapeRank('Lisbon, PT (remote_scope: none)', bonus), 2, '"remote" inside remote_scope is not remote work');
  assert.equal(d.shapeRank('Madrid, ES (remote_scope: geo_restricted, regions: Europe)', bonus), 0, 'any remote_scope but none is remote');
  assert.equal(d.shapeRank('Porto, PT (remote_scope: country)', bonus), 0);
  assert.equal(d.shapeRank('Berlin (Hybrid; remote_scope: country)', bonus), 1.5, 'office words still count');
  assert.equal(d.shapeRank('Sevilla, España', [{ location_regex: 'espana', rank: 0.25 }]), 0.25, 'a regex matches the normalised location too');
  assert.equal(d.shapeRank('Sevilla, España', [{ location_regex: 'España', rank: 0.25 }]), 0.25, 'and the location as written');
  assert.equal(d.shapeRank('Remote, Barcelona', bonus), 0, 'fully remote stays 0');
  assert.equal(d.shapeRank('Remote with office days, London', bonus), 1.5);
  assert.equal(d.shapeRank('London, UK', bonus), 2);
  assert.equal(d.shapeRank('Barcelona, Spain', bonus), 0.5);
  assert.equal(d.shapeRank('Barcelona (Hybrid, Remote)', bonus), 0.5, 'the bonus also sets a remote job with office days');
  assert.equal(d.shapeRank('Valencia, Spain', bonus), 1);
  assert.equal(d.shapeRank('Valencia, Spain', []), 2);
});

test('linkAlive: hh.ru and Hirify archive markers; 403, 429 and network errors stay alive', async () => {
  const alive = (url, p) => d.linkAlive(url, { fetch: fakeFetch({ [url]: p }) });
  const hh = 'https://spb.hh.ru/vacancy/555';
  assert.equal(await alive(hh, page('<span data-qa="vacancy-title-archived-text">x</span>')), false);
  assert.equal(await alive(hh, page('<p>В архиве с 12 сентября</p>')), false);
  assert.equal(await alive(hh, page('<div class="vacancy-archived">x</div>')), false);
  assert.equal(await alive(hh, page('<p>Вакансия в архиве</p>')), false);
  // the page's embedded state lists other vacancies, some archived: that says nothing about this one
  assert.equal(await alive(hh, page('<h1>Product Manager</h1><template>{&quot;archived&quot;: true}</template>')), true);
  assert.equal(await alive(hh, page('<h1>Product Manager</h1><script>{"vacancies":[{"id":1,"archived" : true}],"archived":true}</script>')), true);
  assert.equal(await alive(hh, page('{&#34;archived&#34;:true} <h1>Product Manager</h1>')), true);
  assert.equal(await alive('https://jobs.example/9', page('<div class="vacancy-archived">x</div>')), true, 'hh markers only count on hh.ru');
  const hf = 'https://hirify.me/jobs/42';
  assert.equal(await alive(hf, page('<div>Эта вакансия в архиве</div>')), false);
  assert.equal(await alive(hf, page('<div>This vacancy is archived</div>')), false);
  assert.equal(await alive(hf, page('<div>Open</div>')), true);
  assert.equal(await alive(hh, page('', 403)), true);
  assert.equal(await alive(hh, page('', 429)), true);
  assert.equal(await alive(hh, new Error('network down')), true);
  assert.equal(await alive(hh, page('', 404)), false);
});

test('"screen" is a status: cli.mjs status records it and picks treat the role as closed', async () => {
  const file = job('Kestrel', 'Payments Product Lead', 'Remote', { priority: 1 });
  const before = await d.buildPicks([], { fetch: fakeFetch({}) });
  assert.ok(before.picks.some(p => p.file === file));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'status', 'Kestrel', 'screen', 'Payments'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Kestrel: Payments Product Lead -> screen/);
  assert.equal(JSON.parse(fs.readFileSync(APPS, 'utf8'))[file].status, 'screen');
  const after = await d.buildPicks([], { fetch: fakeFetch({}) });
  assert.ok(!after.picks.some(p => p.file === file));
});

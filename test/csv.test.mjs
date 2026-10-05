// export --csv: BOM, CRLF, quoting of commas, quotes and line breaks, Cyrillic, formula guard, columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-csv-'));
process.env.COMETSCOUT_HOME = tmp;
process.env.COMETSCOUT_DATA = path.join(tmp, 'data');
process.env.COMETSCOUT_SETTINGS = path.join(tmp, 'settings.json');
fs.writeFileSync(process.env.COMETSCOUT_SETTINGS, JSON.stringify({ timezone: 'UTC' }));
const { DATA } = await import('../lib/config.mjs');
const { applicationsCsv, csvCell, CSV_HEADER } = await import('../lib/csv.mjs');

const APPS = {
  '2026-09-01--acme--pm.md': { company: 'Acme, Inc.', role: 'Product Manager', status: 'interview', updated: '2026-09-10',
    events: [{ date: '2026-09-01', type: 'applied', source: 'cli' }, { date: '2026-09-10', type: 'interview', note: 'Call with "Sam"\nsecond line' }] },
  'manual:ромашка|продакт': { company: 'Ромашка', role: 'Продакт-менеджер', status: 'skipped', updated: '2026-09-05', events: [{ date: '2026-09-05', type: 'skipped', note: '=too junior' }] },
};
fs.mkdirSync(path.join(DATA, 'decoded'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'decoded', '2026-09-01--acme--pm.md'), '---\ncompany: "Acme, Inc."\nrole: "Product Manager"\nsource: "ats:greenhouse"\nurl: "https://boards.example.com/acme/1"\n---\ntext\n');

test('quoting: commas, quotes and line breaks; a formula-looking value is defused', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('one\ntwo'), '"one\ntwo"');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell(null), '');
});

test('applications as CSV: BOM, header, CRLF rows, Cyrillic, applied date only when applied', () => {
  const text = applicationsCsv({ apps: APPS, date: '2026-10-02' });
  assert.ok(text.startsWith('﻿'));
  const lines = text.slice(1).split('\r\n');
  assert.equal(lines[0], CSV_HEADER.join(','));
  assert.equal(lines[0], 'Company,Role,Status,Applied,Last activity,Source,Link,Notes');
  assert.equal(lines[1], '"Acme, Inc.",Product Manager,interview,2026-09-01,2026-09-10,ats:greenhouse,https://boards.example.com/acme/1,"Call with ""Sam""\nsecond line"');
  assert.equal(lines[2], "Ромашка,Продакт-менеджер,skipped,,2026-09-05,,,'=too junior");
  assert.equal(lines[3], ''); assert.equal(lines.length, 4);
});

test('cli.mjs export --csv writes the file; a broken applications.json stops it', () => {
  fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'state', 'applications.json'), JSON.stringify(APPS));
  const out = path.join(tmp, 'out', 'applications.csv');
  let r = spawnSync(process.execPath, [CLI, 'export', '--csv', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Wrote 2 application\(s\)/);
  const buf = fs.readFileSync(out);
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM');
  assert.ok(buf.toString('utf8').includes('Ромашка'));
  fs.writeFileSync(path.join(DATA, 'state', 'applications.json'), '{ broken');
  r = spawnSync(process.execPath, [CLI, 'export', '--csv', out], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stdout, /Export stopped: .*not valid JSON/);
});

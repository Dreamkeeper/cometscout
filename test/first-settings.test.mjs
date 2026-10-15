// deploy/first-settings.mjs: a fresh install's settings.json takes this machine's time zone, keeps the example's layout,
// falls back through timedatectl, /etc/timezone and Intl, and never touches an existing settings.json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { firstSettings, systemTimezone, validZone } from '../deploy/first-settings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cometscout-first-settings-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the example settings get the machine\'s zone; nothing else changes', () => {
  const { text, zone } = firstSettings(EXAMPLE, 'Europe/Berlin');
  assert.equal(zone, 'Europe/Berlin');
  const a = JSON.parse(EXAMPLE), b = JSON.parse(text);
  assert.equal(b.timezone, 'Europe/Berlin');
  assert.deepEqual({ ...b, timezone: a.timezone }, a, 'every other value as in the example');
  assert.equal(text.split('\n').length, EXAMPLE.split('\n').length, 'the layout is kept');
});

test('an unknown zone keeps the example\'s', () => {
  for (const z of ['', null, 'Mars/Olympus', 'not a zone']) assert.deepEqual(firstSettings(EXAMPLE, z), { text: EXAMPLE, zone: null });
  assert.equal(validZone('UTC'), true);
  assert.equal(validZone('Europe/Berlin'), true);
});

test('the zone comes from timedatectl, then /etc/timezone, then Intl; a source that fails or gives junk is skipped', () => {
  const fail = () => { throw new Error('not here'); };
  assert.equal(systemTimezone({ timedatectl: () => 'Europe/Berlin\n', etcTimezone: fail, intl: fail }), 'Europe/Berlin');
  assert.equal(systemTimezone({ timedatectl: fail, etcTimezone: () => 'Asia/Tbilisi\n', intl: fail }), 'Asia/Tbilisi');
  assert.equal(systemTimezone({ timedatectl: () => 'n/a', etcTimezone: fail, intl: () => 'America/New_York' }), 'America/New_York');
  assert.equal(systemTimezone({ timedatectl: fail, etcTimezone: fail, intl: fail }), '');
});

test('the command writes a new settings.json with a valid zone and leaves an existing one alone', () => {
  fs.copyFileSync(path.join(ROOT, 'settings.example.json'), path.join(tmp, 'settings.example.json'));
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'deploy', 'first-settings.mjs'), tmp], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Tokyo' } });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Time zone: /);
  const written = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  assert.ok(validZone(written.timezone), written.timezone);
  fs.writeFileSync(path.join(tmp, 'settings.json'), '{ "timezone": "Europe/Lisbon", "mine": true }\n');
  const again = run();
  assert.equal(again.status, 0);
  assert.equal(again.stdout, '', 'says nothing when settings.json exists');
  assert.equal(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'), '{ "timezone": "Europe/Lisbon", "mine": true }\n');
});

#!/usr/bin/env node
// jobpilot command line.
//   node cli.mjs run                 # the evening run: every enabled source, then decode + picks + digest, then packs
//   node cli.mjs sources|decode|pack|picks
//   node cli.mjs applied <company> [role words]   # record an application (picks stop showing it)
//   node cli.mjs status <company> <applied|interview|offer|rejected|skipped|closed> [role words] [--note "..."]
//   node cli.mjs list                # what is recorded
//   node cli.mjs doctor              # check the setup, one line per item
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SETTINGS, SETTINGS_FILE, PROFILE, DIRS, STATE, readJson, secret, today } from './lib/config.mjs';
import { frontMatter, norm } from './lib/queue.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const node = (file, extra = []) => spawnSync(process.execPath, [path.join(ROOT, file), ...extra], { stdio: 'inherit' }).status;
const SOURCES = { ats_boards: 'sources/ats-boards.mjs', rtj: 'sources/rtj.mjs', linkedin_alerts: 'sources/linkedin-alerts.mjs' };
const APPS = STATE('applications.json');

function runSources() { for (const [k, f] of Object.entries(SOURCES)) if (SETTINGS.sources[k]?.enabled) node(f); }
function findRole(company, words) {
  const c = norm(company), w = norm(words || '');
  const hits = [];
  for (const dir of ['decoded', 'rejected', 'inbox']) for (const f of fs.readdirSync(DIRS[dir])) {
    if (!f.endsWith('.md')) continue; const fm = frontMatter(fs.readFileSync(path.join(DIRS[dir], f), 'utf8').replace(/\r\n/g, '\n'));
    if (norm(fm.company).includes(c) && (!w || norm(fm.role).includes(w))) hits.push({ file: f, company: fm.company, role: fm.role });
  }
  return hits;
}
function setStatus(company, status, words, note) {
  const hits = findRole(company, words); const apps = readJson(APPS, {});
  if (hits.length > 1) { console.log(`Several roles match; add role words:\n${hits.map(h => `  ${h.company}: ${h.role}`).join('\n')}`); return 1; }
  const key = hits[0]?.file || `manual:${norm(company)}|${norm(words)}`;
  apps[key] = { company: hits[0]?.company || company, role: hits[0]?.role || words || '', status, updated: today(), ...(note ? { note } : {}) };
  fs.writeFileSync(APPS, JSON.stringify(apps, null, 1)); console.log(`${apps[key].company}: ${apps[key].role || '(role not given)'} -> ${status}`); return 0;
}
function doctor() {
  const ok = (good, text, fix = '') => console.log(`${good ? 'ok  ' : 'TODO'} ${text}${!good && fix ? `  ->  ${fix}` : ''}`);
  const ver = bin => { const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? (r.stdout || '').trim().split('\n')[0] : null; };
  ok(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node}`, 'install Node 20 or newer');
  const llm = SETTINGS.llm.bin || SETTINGS.llm.provider; const v = ver(llm);
  ok(!!v, `${SETTINGS.llm.provider} CLI${v ? `: ${v}` : ' not found'}`, SETTINGS.llm.provider === 'claude' ? 'install Claude Code and run `claude` once to sign in' : 'install Codex CLI and run `codex login`');
  ok(path.basename(SETTINGS_FILE) === 'settings.json', `settings: ${path.basename(SETTINGS_FILE)}`, 'copy settings.example.json to settings.json and edit it (the onboarding does this)');
  ok(!PROFILE.isExample, `profile: ${path.basename(PROFILE.dir)}`, 'create profile/ with your own facts (the onboarding does this)');
  ok(!!PROFILE.cvLibrary, 'CV library (profile/cv-library.json)', 'needed for application packs');
  const enabled = Object.keys(SOURCES).filter(k => SETTINGS.sources[k]?.enabled);
  ok(enabled.length > 0, `sources enabled: ${enabled.join(', ') || 'none'}`, 'enable at least one source in settings.json');
  if (SETTINGS.sources.rtj?.enabled) ok(!!secret(SETTINGS.sources.rtj.token_env || 'RTJ_API_TOKEN'), 'RealtimeJobs token in .env', 'add RTJ_API_TOKEN=... to .env');
  if (SETTINGS.sources.linkedin_alerts?.enabled) ok(['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].every(k => secret(k)), 'Gmail read-only access (LinkedIn alerts)', 'add GMAIL_CLIENT_ID/SECRET to .env, then run `node tools/gmail-auth.mjs`');
  const tg = SETTINGS.delivery.telegram;
  ok(!tg.enabled || (secret(tg.token_env) && secret(tg.chat_id_env)), `Telegram delivery: ${tg.enabled ? 'on' : 'off (digest is written to data/digests only)'}`, 'add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env');
  const so = ver(process.env.SOFFICE || SETTINGS.pack.soffice || 'soffice');
  ok(!!so || process.platform === 'win32', `PDF export: ${so ? 'LibreOffice' : process.platform === 'win32' ? 'Word (Windows)' : 'LibreOffice not found'}`, 'sudo apt install libreoffice-writer-nogui fonts-liberation');
  ok(!!spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version']).stdout, 'Python 3 (packs the DOCX files)', 'install python3');
}

const codes = {
  run: () => { runSources(); node('decoder/decoder.mjs'); if (SETTINGS.pack.enabled) node('pack/pack.mjs'); return 0; },
  sources: () => { runSources(); return 0; },
  decode: () => node('decoder/decoder.mjs', rest),
  picks: () => node('decoder/decoder.mjs', ['--picks']),
  pack: () => node('pack/pack.mjs', rest),
  applied: () => setStatus(rest[0], 'applied', rest.slice(1).join(' ')),
  status: () => { const i = rest.indexOf('--note'); const note = i >= 0 ? rest.slice(i + 1).join(' ') : ''; const r = i >= 0 ? rest.slice(0, i) : rest; return setStatus(r[0], r[1], r.slice(2).join(' '), note); },
  list: () => { for (const a of Object.values(readJson(APPS, {}))) console.log(`${a.updated}  ${a.status.padEnd(9)} ${a.company}: ${a.role}`); return 0; },
  doctor: () => { doctor(); return 0; },
};
if (!codes[cmd]) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n')); process.exit(cmd ? 1 : 0); }
process.exitCode = codes[cmd]() || 0;

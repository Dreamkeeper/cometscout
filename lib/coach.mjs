// The interview coach module: Noam Segal's interview-coach skill (github.com/noamseg/interview-coach-skill, MIT),
// installed from its own upstream into a folder next to the home and never copied into this repository.
//   bash deploy/modules/coach.sh | deploy/modules/coach.ps1   # install or update (both run: node lib/coach.mjs install)
//   node cli.mjs coach-handoff [--out <file>]                    # what the coach's kickoff asks for, from the user's own files
// settings.modules.coach = { enabled: false, path: null, repo: "https://github.com/noamseg/interview-coach-skill.git" }
//   path: null means <home>/../interview-coach; a relative path is relative to the home. enabled: doctor checks it.
// GIT names the git command (an executable, or a .mjs/.js script run with node; tests use a fake one).
// The installer clones once (git clone --depth 1) and then only runs git pull --ff-only: the coach's own files in that
// folder (coaching_state.md, materials/, anything else it writes) are never deleted or rewritten. The one file it
// creates is CLAUDE.md, the copy of SKILL.md that activates the skill in Claude Code (the coach's README asks for it);
// an existing CLAUDE.md is never overwritten. git runs without prompts (GIT_TERMINAL_PROMPT=0), so a private or
// mistyped repo fails at once instead of waiting for a password, and an existing checkout is pulled only when its
// origin is modules.coach.repo.
// The hand-off goes to materials/cometscout-handoff.md in the coach's folder (materials/ is in the coach's .gitignore);
// cli.mjs run refreshes it when modules.coach.enabled is true.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SETTINGS, PROFILE, STATE, SECRET_VALUES, read, readConfig, readJson, today, isMain } from './config.mjs';
import { binCommand } from './llm.mjs';
import { isApplication } from './tracker.mjs';

export const COACH_REPO = 'https://github.com/noamseg/interview-coach-skill.git';
export const COACH_HOME_PAGE = 'https://github.com/noamseg/interview-coach-skill';
export const HANDOFF_FILE = 'cometscout-handoff.md';
export const HANDOFF_DIR = 'materials';
const WIN = process.platform === 'win32';
export const INSTALL_COMMAND = WIN ? 'powershell -ExecutionPolicy Bypass -File deploy\\modules\\coach.ps1' : 'bash deploy/modules/coach.sh';

/** settings.modules.coach with defaults; `path` resolved against the home (null: <home>/../interview-coach). */
export function coachSettings(settings = SETTINGS, root = ROOT) {
  const c = settings?.modules?.coach || {};
  let p = typeof c.path === 'string' && c.path.trim() ? c.path.trim() : null;
  if (p && /^~([/\\]|$)/.test(p)) p = path.join(os.homedir(), p.slice(1));
  return {
    enabled: c.enabled === true,
    path: p ? path.resolve(root, p) : path.resolve(root, '..', 'interview-coach'),
    repo: typeof c.repo === 'string' && c.repo.trim() ? c.repo.trim() : COACH_REPO,
  };
}

// No username or password prompt from git or Git Credential Manager: a private or mistyped repo fails fast.
export const GIT_NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
/** One git command, never interactive: { ok, out, err }. */
export function runGit(args) {
  const [cmd, argv] = binCommand(process.env.GIT || 'git', args);
  const env = { ...process.env, ...GIT_NO_PROMPT };
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 300000, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() || (r.error ? r.error.message : '') };
}

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readOr = (p, d = null) => { try { return fs.readFileSync(p, 'utf8'); } catch { return d; } };
const installed = dir => fs.existsSync(path.join(dir, '.git'));
/** "abc1234, 2026-09-30" for the checked-out commit, or null. */
export function installedCommit(dir, git = runGit) {
  const r = git(['-C', dir, 'log', '-1', '--format=%h %cs']);
  const [hash, date] = r.ok ? r.out.split(/\s+/) : [];
  return hash ? `${hash}${date ? `, ${date}` : ''}` : null;
}
// Two addresses of one repository: case, a trailing slash and a trailing .git do not count.
const sameRepo = u => String(u || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
export const startLine = dir => (WIN ? `cd "${dir}"; claude` : `cd "${dir}" && claude`);

/**
 * Install (first time) or update the coach. Returns 0 when the folder holds an up-to-date checkout, 1 otherwise;
 * never deletes anything in the folder.
 */
export function installCoach({ settings = SETTINGS, root = ROOT, git = runGit, log = console.log } = {}) {
  const { enabled, path: dir, repo } = coachSettings(settings, root);
  if (repo.startsWith('-')) { log(`modules.coach.repo "${repo}" is not a repository address; fix it in settings.json.`); return 1; }
  const empty = isDir(dir) && fs.readdirSync(dir).length === 0;
  const skill = path.join(dir, 'SKILL.md'), active = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(dir) || empty) {
    log(`Installing the interview coach into ${dir}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = git(['clone', '--depth', '1', '--', repo, dir]);
    if (!r.ok) { log(`git clone failed: ${r.err || 'no message'}`); return 1; }
  } else if (isDir(dir) && installed(dir)) {
    const origin = git(['-C', dir, 'remote', 'get-url', 'origin']);
    if (!origin.ok || sameRepo(origin.out) !== sameRepo(repo)) {
      log(`${dir} is a checkout of ${origin.ok && origin.out ? origin.out : 'no origin'}, not of modules.coach.repo (${repo}), so CometScout does not update it.`);
      log('If that checkout is the one you want, set modules.coach.repo in settings.json to its address; otherwise point modules.coach.path at another folder.');
      return 1;
    }
    log(`Updating the interview coach in ${dir}`);
    const r = git(['-C', dir, 'pull', '--ff-only']);
    if (!r.ok) {
      log(`git pull --ff-only failed: ${r.err || 'no message'}`);
      log(`Nothing in ${dir} was changed by CometScout. To see what differs from the coach's own version, run: git -C "${dir}" status`);
      log('If you edited the coach\'s own files, keep a copy of your edits somewhere else before you update again.');
      return 1;
    }
  } else {
    log(`${dir} exists and is not a git checkout of the coach, so CometScout leaves it alone.`);
    log('Set modules.coach.path in settings.json to another folder, or move this one away, then run the installer again.');
    return 1;
  }
  // Claude Code reads CLAUDE.md in the folder it starts in; the coach's README asks for SKILL.md under that name.
  // CLAUDE.md is in the coach's .gitignore, so this copy never blocks a pull. An existing one is never overwritten.
  const now = readOr(skill);
  if (now == null) log(`No SKILL.md in ${dir}; the coach may have changed how it is set up. See its README.`);
  else {
    const current = readOr(active);
    if (current == null) {
      // wx: if a CLAUDE.md appeared meanwhile, it is kept
      try { fs.writeFileSync(active, now, { flag: 'wx' }); log('Activated the coach for Claude Code (CLAUDE.md is a copy of SKILL.md).'); } catch (e) { log(`CLAUDE.md was not written: ${e.code === 'EEXIST' ? 'it exists now and is left as it is' : e.message}`); }
    }
    else if (current !== now) log(`CLAUDE.md differs from SKILL.md and was left as it is. To take the coach's current version, copy SKILL.md over CLAUDE.md in ${dir}.`);
  }
  const commit = installedCommit(dir, git);
  log(`Interview coach: ${dir}${commit ? ` (${commit})` : ''}`);
  log(`By Noam Segal, MIT license: ${COACH_HOME_PAGE}`);
  log('Hand it what CometScout knows about you: node cli.mjs coach-handoff');
  log(`Start it: ${startLine(dir)}`);
  log('Then say: kickoff');
  if (!enabled) log('Set modules.coach.enabled to true in settings.json so node cli.mjs doctor checks it.');
  return 0;
}

/** True when `name` is an executable on PATH (PATHEXT on Windows). */
export function onPath(name, { env = process.env, platform = process.platform } = {}) {
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  const dirs = String(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  return dirs.some(d => exts.some(e => isFile(path.join(d, name + e)) || isFile(path.join(d, name + e.toLowerCase()))));
}

/** Doctor lines { level: ok|todo, text, fix } for the coach. */
export function coachDoctor({ settings = SETTINGS, root = ROOT, git = runGit, hasClaude = () => onPath('claude') } = {}) {
  const c = coachSettings(settings, root);
  if (!c.enabled) return [{ level: 'ok', text: `interview coach: off (optional: ${INSTALL_COMMAND}, README: Interview coach)` }];
  const out = [];
  if (!isDir(c.path) || (!installed(c.path) && fs.readdirSync(c.path).length === 0)) out.push({ level: 'todo', text: `interview coach: not installed at ${c.path}`, fix: INSTALL_COMMAND });
  else if (!installed(c.path)) out.push({ level: 'todo', text: `interview coach: ${c.path} is not a git checkout of the coach`, fix: 'set modules.coach.path in settings.json to another folder, or move this one away' });
  else {
    const commit = installedCommit(c.path, git);
    out.push({ level: 'ok', text: `interview coach: ${c.path} (${commit || 'commit unknown'})` });
    if (!fs.existsSync(path.join(c.path, 'CLAUDE.md'))) out.push({ level: 'todo', text: 'interview coach: not activated (no CLAUDE.md in its folder)', fix: INSTALL_COMMAND });
  }
  const claude = hasClaude();
  out.push({ level: claude ? 'ok' : 'todo', text: `claude on the PATH (the coach runs in Claude Code)${claude ? '' : ': not found'}`, fix: 'install Claude Code: npm install -g @anthropic-ai/claude-code' });
  return out;
}

// ---------- the hand-off file ----------

// Headings of the user's own files go two levels down, so they sit under this file's own sections.
const demote = text => {
  let fence = false;
  return text.split('\n').map(l => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    return !fence && /^#{1,6}\s/.test(l) ? `##${l}`.replace(/^#{7,}/, '######') : l;
  }).join('\n').trim();
};
const SCOPE = /scope guard|never claim/i;
const HEADING = /^#{1,6}\s/;
const scopeHeading = l => HEADING.test(l) && SCOPE.test(l);
// Scope guards are what the user must never claim; their heading says so even when the user named it differently.
// Only headings count: a bullet that mentions scope guards is not a section.
const labelScope = text => text.split('\n').map(l => (scopeHeading(l) && !/never claim/i.test(l) ? `${l} (never claim)` : l)).join('\n');
const plain = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Bullet texts under the profile's scope-guard headings, for deduplication. */
function scopeBullets(text) {
  const out = new Set(); let inScope = false;
  for (const l of text.split('\n')) {
    if (HEADING.test(l)) { inScope = scopeHeading(l); continue; }
    const m = inScope && l.match(/^\s*[-*+]\s+(.*)$/); if (m) out.add(plain(m[1]));
  }
  return out;
}
const cell = v => String(v ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

/** The vetted CV library as a plain resume in Markdown (no contact line). */
export function renderLibrary(lib) {
  const out = [];
  if (lib.name) out.push(`### ${lib.name}`, '');
  const list = (title, items) => { const t = (items || []).filter(x => x?.text); if (t.length) out.push(`#### ${title}`, '', ...t.map(x => `- ${x.text}`), ''); };
  list('Taglines (approved variants)', lib.taglines);
  list('Summaries (approved variants)', lib.summaries);
  if (lib.experience?.length) {
    out.push('#### Experience', '');
    for (const e of lib.experience) {
      out.push(`**${e.company || '?'}**${e.dates ? `, ${e.dates}` : ''}`, '');
      if (e.blurb) out.push(e.blurb, '');
      for (const r of e.roles || []) {
        if (r.title) out.push(`*${r.title}*`, '');
        const seen = new Set();
        for (const b of r.bullets || []) {
          if (!b?.text) continue;
          const variant = b.group && seen.has(b.group); if (b.group) seen.add(b.group);
          out.push(`- ${b.text}${variant ? ' (same fact as an earlier bullet, other wording)' : ''}`);
        }
        out.push('');
      }
    }
  }
  if (lib.ai_work?.items?.length) list(lib.ai_work.heading || 'Selected work', lib.ai_work.items.map(x => ({ text: `${x.lead || ''}${x.text || ''}` })));
  const skills = (lib.skills || []).filter(s => s?.text);
  if (skills.length) out.push('#### Skills', '', ...skills.map(s => `- ${s.label ? `${s.label}: ` : ''}${s.text}`), '');
  const edu = (Array.isArray(lib.education) ? lib.education : lib.education ? [lib.education] : []).filter(e => e && (e.left || e.right));
  if (edu.length) out.push('#### Education', '', ...edu.map(e => `- ${[e.left, e.right].filter(Boolean).join(', ')}`), '');
  list(lib.awards_heading || 'Awards and certifications', lib.awards);
  return out.join('\n').trim();
}

// Events that say nothing about where an application stands: "not now" reminders, registry status syncs, contacts.
const SKIP_EVENTS = new Set(['later', 'registry-status', 'contact']);
const lastEvent = a => [...(Array.isArray(a.events) ? a.events : [])].reverse().find(e => e && !SKIP_EVENTS.has(e.type)) || null;
const lastDate = a => String(lastEvent(a)?.date || a.updated || a.applied || '').slice(0, 10);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;   // an interview's event_time (HH:MM, settings.timezone), when known
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The applications statuses (cli.mjs status, the workspace) and the Gmail outcome types, in words.
const EVENT_NAME = {
  applied: 'applied', screen: 'screen', interview: 'interview', offer: 'offer', accepted: 'accepted', rejected: 'rejected', skipped: 'skipped', closed: 'closed',
  application_received: 'application received', rejection: 'rejection email', test_task: 'test task', reopened: 'reopened',
};
const eventName = t => EVENT_NAME[t] || String(t || '').replace(/[_-]+/g, ' ');
const IN_PROGRESS = new Set(['interview', 'screen', 'offer']);
const FINISHED = new Set(['rejected', 'skipped', 'closed', 'withdrawn']);
// A job the user holds (an offer taken, now working there): not in progress, nothing coming up but an interview date.
const HELD = new Set(['accepted']);
// round is an integer from Gmail outcomes but free text in imported records ("final, with the CTO").
const roundText = r => (Number.isInteger(r) && r > 0 ? `round ${r}` : typeof r === 'string' && r.trim() ? r.replace(/\s+/g, ' ').trim().slice(0, 120) : '');
const latestRound = a => { for (const e of [...(Array.isArray(a.events) ? a.events : [])].reverse()) { const t = roundText(e?.round); if (t) return t; } return roundText(a.round); };

/**
 * What is coming up, as of `date`: dated items first, soonest first (an interview or test task with an event_date
 * on or after `date`, and any event dated `date` or later), then the applications in progress (status interview,
 * screen or offer) that have no dated item. An application that is rejected, skipped or closed has nothing coming up.
 * A job the user holds (accepted) is never in progress; only an interview dated `date` or later is listed, marked
 * held, since it can be a probation review.
 */
export function upcoming(apps, date) {
  const dated = [], keys = new Set(), progress = [];
  for (const [key, a] of Object.entries(apps || {})) {
    if (!a || typeof a !== 'object' || FINISHED.has(a.status)) continue;
    const seen = new Set(), held = HELD.has(a.status);
    const add = (d, type, e) => {
      const time = type === 'interview' && TIME.test(String(e?.event_time || '')) ? e.event_time : '';
      const id = `${d}|${type}|${time}`; if (seen.has(id)) return; seen.add(id); keys.add(key);
      dated.push({ date: d, time, type, round: roundText(e?.round), company: a.company, role: a.role, ...(held ? { held: true } : {}) });
    };
    for (const e of Array.isArray(a.events) ? a.events : []) {
      if (!e || SKIP_EVENTS.has(e.type) || (held && e.type !== 'interview')) continue;
      if (['interview', 'test_task'].includes(e.type) && DAY.test(e.event_date || '') && e.event_date >= date) add(e.event_date, e.type, e);
      else if (DAY.test(String(e.date || '').slice(0, 10)) && String(e.date).slice(0, 10) >= date) add(String(e.date).slice(0, 10), e.type, e);
    }
    if (IN_PROGRESS.has(a.status) && !keys.has(key)) progress.push({ status: a.status, round: latestRound(a), since: lastDate(a), company: a.company, role: a.role });
  }
  dated.sort((x, y) => x.date.localeCompare(y.date) || (x.time || '99').localeCompare(y.time || '99') || String(x.company).localeCompare(String(y.company)));
  progress.sort((x, y) => y.since.localeCompare(x.since) || String(x.company).localeCompare(String(y.company)));
  return { dated, progress };
}

const datedLine = u => `- ${u.date}${u.time ? ` ${u.time}` : ''}: ${u.type === 'test_task' ? 'test task due' : eventName(u.type)}${u.round ? ` (${u.round})` : ''}, ${u.company || '?'}, ${u.role || 'role not recorded'}${u.held ? ' (a job I hold: this may be a probation review)' : ''}`;
const progressLine = p => `- in progress: ${eventName(p.status)}${p.round ? ` (${p.round})` : ''}, ${p.company || '?'}, ${p.role || 'role not recorded'}${p.since ? `, last news ${p.since}` : ''}`;

/** The jobs the user holds (status accepted), newest first: { company, role, since } (the day of the last accepted event). */
export function heldJobs(apps) {
  const out = [];
  for (const a of Object.values(apps || {})) {
    if (!a || typeof a !== 'object' || !HELD.has(a.status)) continue;
    const ev = [...(Array.isArray(a.events) ? a.events : [])].reverse().find(e => e && HELD.has(e.type) && DAY.test(String(e.date || '').slice(0, 10)));
    out.push({ company: a.company, role: a.role, since: ev ? String(ev.date).slice(0, 10) : String(a.updated || '').slice(0, 10) });
  }
  return out.sort((x, y) => y.since.localeCompare(x.since) || String(x.company).localeCompare(String(y.company)));
}
const heldLine = h => `- ${h.company || '?'}, ${h.role || 'role not recorded'}${h.since ? `, since ${h.since}` : ''}`;

function standing(apps, date) {
  const out = [];
  const held = heldJobs(apps);
  if (held.length) out.push('### Jobs I hold', '', 'Offers I accepted and work in now. I am still looking; these are not open processes.', '', ...held.map(heldLine), '');
  const { dated, progress } = upcoming(apps, date);
  out.push('### Coming up', '');
  if (dated.length || progress.length) out.push(...dated.map(datedLine), ...progress.map(progressLine));
  else out.push('Nothing with a date ahead or in progress is recorded.');
  out.push('');
  const rows = Object.values(apps || {}).filter(a => a && typeof a === 'object' && isApplication(a))
    .sort((x, y) => lastDate(y).localeCompare(lastDate(x)) || String(x.company).localeCompare(String(y.company)));
  out.push('### Applications (newest first)', '');
  if (!rows.length) out.push('No applications recorded yet.');
  else {
    out.push('| Company | Role | Status | Last event | Date |', '|---|---|---|---|---|');
    for (const a of rows) { const e = lastEvent(a); out.push(`| ${cell(a.company)} | ${cell(a.role)} | ${cell(a.status)} | ${cell(e ? eventName(e.type) : '')} | ${cell(lastDate(a))} |`); }
  }
  return out.join('\n').trim();
}

/**
 * The hand-off as Markdown, built only from the user's own files: profile.md, cv-library.json, voice.md and the
 * applications. Never .env, tokens, cookies, packs or job texts. Throws when the profile is missing, or when a value
 * from .env would end up in the file.
 */
export function buildHandoff({ profileDir = PROFILE.dir, apps = readJson(STATE('applications.json'), {}), date = today(), now = new Date(), secrets = SECRET_VALUES() } = {}) {
  const facts = read(path.join(profileDir, 'profile.md')).trim();
  if (!facts) throw new Error(`No profile to hand off: ${path.join(profileDir, 'profile.md')} is missing or empty. Finish the onboarding first (AGENTS.md, step 2).`);
  const example = path.basename(profileDir) === 'profile.example';
  const lib = readConfig(path.join(profileDir, 'cv-library.json'));
  const voice = read(path.join(profileDir, 'voice.md')).trim();
  let who = labelScope(demote(facts));
  // The fact rules' reasons are scope guards too: always listed, minus the ones the profile already says word for word.
  const hasScope = facts.split('\n').some(scopeHeading), said = scopeBullets(facts);
  const why = [...new Set((readConfig(path.join(profileDir, 'fact-rules.json'), { rules: [] }).rules || []).map(r => String(r?.why || '').trim()).filter(Boolean))]
    .filter(w => !said.has(plain(w)));
  if (why.length) who += `\n\n### ${hasScope ? 'Scope guards from my fact rules (never claim)' : 'Scope guards (never claim)'}\n\n${why.map(w => `- ${w}`).join('\n')}`;
  const stamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)} UTC`;
  const text = [
    '# CometScout hand-off for the interview coach',
    '',
    `Made by CometScout on ${stamp} for the coach's kickoff, only from the user's own files: profile.md, cv-library.json, voice.md and the applications record.`,
    'It is a snapshot: CometScout keeps the live record. With the coach module enabled, the evening run writes a fresh one; `node cli.mjs coach-handoff` does it now.',
    'It holds no passwords, tokens, job postings or application packs.',
    ...(example ? ['', 'Note: this was made from the fictional example profile (profile.example/), not a real person.'] : []),
    '',
    '## Who I am and what I want',
    '',
    who,
    '',
    '## My CV',
    '',
    lib ? `The approved wording from my CV library. Every line is true and checked by me; use it as written.\n\n${renderLibrary(lib)}` : 'No CV library yet (profile/cv-library.json).',
    '',
    '## How I write',
    '',
    voice ? demote(voice) : 'No voice card yet (profile/voice.md is optional).',
    '',
    '## Where I stand',
    '',
    `As of ${date}.`,
    '',
    standing(apps, date),
    '',
  ].join('\n');
  const leaked = secrets.filter(s => s && text.includes(s));
  if (leaked.length) throw new Error('The hand-off would contain a value from .env (a token or password), so it was not written. Check profile/ for a pasted secret.');
  return { text, example };
}

/** cli.mjs coach-handoff [--out <file>]: writes the file, returns the exit code. */
export function coachHandoff({ out, settings = SETTINGS, root = ROOT, profileDir = PROFILE.dir, log = console.log, ...opts } = {}) {
  const c = coachSettings(settings, root);
  let file;
  if (out) file = path.resolve(out);
  else {
    if (!isDir(c.path)) { log(`The coach is not installed at ${c.path}. Install it first (${INSTALL_COMMAND}), or give --out <file>.`); return 1; }
    file = path.join(c.path, HANDOFF_DIR, HANDOFF_FILE);
  }
  let r; try { r = buildHandoff({ profileDir, ...opts }); } catch (e) { log(e.message); return 1; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.text);
  if (r.example) log('Note: built from the fictional example profile; finish the onboarding to hand off your own.');
  log(`Wrote ${file}`);
  log(`In the coach, say: kickoff, and give it ${out ? path.basename(file) : `${HANDOFF_DIR}/${HANDOFF_FILE}`}`);
  return 0;
}

/**
 * The evening run's refresh (cli.mjs run, when modules.coach.enabled): the same file as coach-handoff, no network.
 * Never throws; a coach that is not installed or a hand-off that cannot be written is one log line.
 */
export function refreshHandoff({ settings = SETTINGS, log = console.log, ...opts } = {}) {
  if (!coachSettings(settings).enabled) return null;
  const lines = [];
  let code = 1;
  try { code = coachHandoff({ settings, log: l => lines.push(l), ...opts }); } catch (e) { lines.push(e.message); }
  if (code === 0) log(`coach-handoff: refreshed ${lines.find(l => l.startsWith('Wrote '))?.slice(6) || ''}`.trim());
  else log(`coach-handoff: not refreshed: ${lines.join(' ')}`);
  return code;
}

if (isMain(import.meta.url)) {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'install') process.exitCode = installCoach();
  else { console.log('Usage: node lib/coach.mjs install   (or bash deploy/modules/coach.sh)'); process.exitCode = 1; }
}

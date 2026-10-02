// The interview coach module: Noam Segal's interview-coach skill (github.com/noamseg/interview-coach-skill, MIT),
// installed from its own upstream into a folder next to the home and never copied into this repository.
//   bash deploy/modules/coach.sh | deploy/modules/coach.ps1   # install or update (both run: node lib/coach.mjs install)
//   node cli.mjs coach-handoff [--out <file>]                    # what the coach's kickoff asks for, from the user's own files
// settings.modules.coach = { enabled: false, path: null, repo: "https://github.com/noamseg/interview-coach-skill.git" }
//   path: null means <home>/../interview-coach; a relative path is relative to the home. enabled: doctor checks it.
// GIT names the git command (an executable, or a .mjs/.js script run with node; tests use a fake one).
// The installer clones once (git clone --depth 1) and then only runs git pull --ff-only: the coach's own files in that
// folder (coaching_state.md, materials/, anything else it writes) are never deleted or rewritten. The one file it
// writes is CLAUDE.md, the copy of SKILL.md that activates the skill in Claude Code (the coach's README asks for it);
// a CLAUDE.md the user edited is left as it is.
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

/** One git command: { ok, out, err }. */
export function runGit(args) {
  const [cmd, argv] = binCommand(process.env.GIT || 'git', args);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 300000 });
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
  let before = null;
  if (!fs.existsSync(dir) || empty) {
    log(`Installing the interview coach into ${dir}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = git(['clone', '--depth', '1', '--', repo, dir]);
    if (!r.ok) { log(`git clone failed: ${r.err || 'no message'}`); return 1; }
  } else if (isDir(dir) && installed(dir)) {
    log(`Updating the interview coach in ${dir}`);
    before = readOr(skill);
    const r = git(['-C', dir, 'pull', '--ff-only']);
    if (!r.ok) {
      log(`git pull --ff-only failed: ${r.err || 'no message'}`);
      log(`Nothing in ${dir} was changed by jobpilot. If you edited the coach's own files there, keep your copy elsewhere and run git -C "${dir}" checkout -- . before updating again.`);
      return 1;
    }
  } else {
    log(`${dir} exists and is not a git checkout of the coach, so jobpilot leaves it alone.`);
    log('Set modules.coach.path in settings.json to another folder, or move this one away, then run the installer again.');
    return 1;
  }
  // Claude Code reads CLAUDE.md in the folder it starts in; the coach's README asks for SKILL.md under that name.
  // CLAUDE.md is in the coach's .gitignore, so this copy never blocks a pull.
  const now = readOr(skill);
  if (now == null) log(`No SKILL.md in ${dir}; the coach may have changed how it is set up. See its README.`);
  else {
    const current = readOr(active);
    if (current == null) { fs.writeFileSync(active, now); log('Activated the coach for Claude Code (CLAUDE.md is a copy of SKILL.md).'); }
    else if (current !== now && before != null && current === before) { fs.writeFileSync(active, now); log('CLAUDE.md updated to the new SKILL.md.'); }
    else if (current !== now) log(`CLAUDE.md differs from SKILL.md (edited by you?) and was left as it is. To take the new version, copy SKILL.md over CLAUDE.md in ${dir}.`);
  }
  const commit = installedCommit(dir, git);
  log(`Interview coach: ${dir}${commit ? ` (${commit})` : ''}`);
  log(`By Noam Segal, MIT license: ${COACH_HOME_PAGE}`);
  log('Hand it what jobpilot knows about you: node cli.mjs coach-handoff');
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
// Scope guards are what the user must never claim; their heading says so even when the user named it differently.
const labelScope = text => text.split('\n').map(l => (/^#{1,6}\s/.test(l) && SCOPE.test(l) && !/never claim/i.test(l) ? `${l} (never claim)` : l)).join('\n');
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

const lastEvent = a => [...(a.events || [])].reverse().find(e => e && e.type !== 'later') || null;
const lastDate = a => String(lastEvent(a)?.date || a.updated || a.applied || '').slice(0, 10);
const EVENT_NAME = { interview: 'interview', test_task: 'test task due', application_received: 'application received', rejection: 'rejection' };

/** Upcoming interviews (and test-task deadlines) on or after `date`, soonest first. */
export function upcoming(apps, date) {
  const out = [];
  for (const a of Object.values(apps || {})) {
    if (!a || typeof a !== 'object') continue;
    for (const e of a.events || []) {
      if (!['interview', 'test_task'].includes(e?.type) || !/^\d{4}-\d{2}-\d{2}$/.test(e.event_date || '') || e.event_date < date) continue;
      out.push({ date: e.event_date, type: e.type, round: e.round, company: a.company, role: a.role });
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || String(x.company).localeCompare(String(y.company)));
}

function standing(apps, date) {
  const out = [];
  const next = upcoming(apps, date);
  out.push('### Coming up', '');
  if (next.length) out.push(...next.map(u => `- ${u.date}: ${EVENT_NAME[u.type]}${u.round ? ` (round ${u.round})` : ''}, ${u.company || '?'}, ${u.role || 'role not recorded'}`));
  else out.push('No interview with a date ahead is recorded.');
  out.push('');
  const rows = Object.values(apps || {}).filter(a => a && typeof a === 'object' && isApplication(a))
    .sort((x, y) => lastDate(y).localeCompare(lastDate(x)) || String(x.company).localeCompare(String(y.company)));
  out.push('### Applications (newest first)', '');
  if (!rows.length) out.push('No applications recorded yet.');
  else {
    out.push('| Company | Role | Status | Last event | Date |', '|---|---|---|---|---|');
    for (const a of rows) { const e = lastEvent(a); out.push(`| ${cell(a.company)} | ${cell(a.role)} | ${cell(a.status)} | ${cell(e ? (EVENT_NAME[e.type] || e.type) : '')} | ${cell(lastDate(a))} |`); }
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
  if (!SCOPE.test(facts)) {
    const why = (readConfig(path.join(profileDir, 'fact-rules.json'), { rules: [] }).rules || []).map(r => r?.why).filter(Boolean);
    if (why.length) who += `\n\n### Scope guards (never claim)\n\n${why.map(w => `- ${w}`).join('\n')}`;
  }
  const stamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)} UTC`;
  const text = [
    '# CometScout hand-off for the interview coach',
    '',
    `Made by CometScout (jobpilot) on ${stamp} for the coach's kickoff, only from the user's own files: profile.md, cv-library.json, voice.md and the applications record.`,
    'It is a snapshot: CometScout keeps the live record. Run `node cli.mjs coach-handoff` again for a fresh one.',
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
    file = path.join(c.path, HANDOFF_FILE);
  }
  let r; try { r = buildHandoff({ profileDir, ...opts }); } catch (e) { log(e.message); return 1; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.text);
  if (r.example) log('Note: built from the fictional example profile; finish the onboarding to hand off your own.');
  log(`Wrote ${file}`);
  log(`In the coach, say: kickoff, and give it ${path.basename(file)}`);
  return 0;
}

if (isMain(import.meta.url)) {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'install') process.exitCode = installCoach();
  else { console.log('Usage: node lib/coach.mjs install   (or bash deploy/modules/coach.sh)'); process.exitCode = 1; }
}

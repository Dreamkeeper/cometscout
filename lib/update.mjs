// Updates: notify only. Nothing installs without the user's tap or command; there is no setting for auto-install.
// settings.update = { channel: "stable", check: true, repo: "Dreamkeeper/cometscout" }
//   channel: "stable" (tags without a pre-release suffix) or "edge" (pre-releases too)
//   check:   false turns the check after the evening run off (cli.mjs update --check still works)
// data/state/update.json keeps the last answer and what the user chose:
//   { checked_at, channel, latest: { version, tag, url, zip_url, sha256, min_node, highlights, behaviour_changes },
//     error_day, notified, skipped: [versions], pending (Tonight), history: [{ from, to, at, result, step }],
//     whats_new_pending, whats_new_from, last_seen }
// An update (runUpdate): preflight, a backup, the new release unpacked next to the old one, its migrations, the
// app/current switch, a check with the new code; any failure switches back and restores the backup exactly.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, SETTINGS, DATA, STATE, CODE_DIR, readJson, log as logLine } from './config.mjs';
import { compareVersions, validVersion, bare, isPrerelease, parseReleaseBody, readReleases, notesFor, releasesBetween, mediaPathOk } from './release.mjs';
import { currentVersion, hasAppLayout, releaseDir, currentLink, pointCurrent, installedReleases, localEdits, writeFileList, npmInstall, pruneReleases, sha256 } from './layout.mjs';
import { lockHolder, takeLock } from './lock.mjs';
import { backup, listBackups, fmtBytes, cleanLabel } from './backup.mjs';
import { openArchive, importArchive, collect, APP_VERSION } from './archive.mjs';
import { readZip, extractEntry, entryPath } from './zip.mjs';
import { systemdHost, UNITS } from './ops.mjs';
import { telegramOn, sendText } from './telegram.mjs';
import { translator } from './i18n.mjs';
import { scheduleOf, prepOf } from './schedule.mjs';

const UA = 'cometscout-update-check';
export const STATE_FILE = () => STATE('update.json');
export const CHANNELS = ['stable', 'edge'];
/** settings.update with defaults. */
export function updateSettings(s = SETTINGS) {
  const u = s?.update && typeof s.update === 'object' ? s.update : {};
  return { channel: CHANNELS.includes(u.channel) ? u.channel : 'stable', check: u.check !== false, repo: typeof u.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(u.repo) ? u.repo : 'Dreamkeeper/cometscout', problems: [
    ...(u.channel !== undefined && !CHANNELS.includes(u.channel) ? [`update.channel must be "stable" or "edge", got ${JSON.stringify(u.channel)}`] : []),
    ...(u.repo !== undefined && !(typeof u.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(u.repo)) ? [`update.repo must be "owner/name", got ${JSON.stringify(u.repo)}`] : []),
  ] };
}

// ---------- state ----------
export const readState = (file = STATE_FILE()) => { const s = readJson(file, {}); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; };
/** Merge `patch` into update.json (atomic). Returns the new state. */
export function writeState(patch, file = STATE_FILE()) {
  const next = { ...readState(file), ...patch };
  const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + '\n'); fs.renameSync(tmp, file);
  return next;
}
const remember = (state, entry) => [...(Array.isArray(state.history) ? state.history : []), entry].slice(-20);

/** What the user sees: { current, latest, available, skipped, pending, behaviour_changes, highlights, checked_at, channel }. */
export function status(state = readState(), current = APP_VERSION) {
  const latest = validVersion(state.latest?.version) ? bare(state.latest.version) : null;
  const skipped = Array.isArray(state.skipped) ? state.skipped : [];
  return { current, latest, available: !!latest && compareVersions(latest, current) > 0, skipped: !!latest && skipped.includes(latest),
    pending: validVersion(state.pending) ? bare(state.pending) : null, behaviour_changes: !!state.latest?.behaviour_changes,
    highlights: Array.isArray(state.latest?.highlights) ? state.latest.highlights : [], checked_at: state.checked_at || null, channel: state.channel || updateSettings().channel };
}

// ---------- the GitHub check ----------
async function github(apiPath, { fetch, repo }) {
  const r = await fetch(`https://api.github.com/repos/${repo}${apiPath}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub answered ${r.status}${r.status === 403 ? ' (rate limit; it resets within an hour)' : ''}`);
  return r.json();
}
/** One GitHub release as update.json keeps it. */
export function releaseInfo(gh, repo) {
  const tag = String(gh.tag_name || '');
  return { version: bare(tag), tag, prerelease: !!gh.prerelease || isPrerelease(tag), published_at: gh.published_at || null, url: gh.html_url || null,
    zip_url: `https://github.com/${repo}/archive/refs/tags/${tag}.zip`, ...parseReleaseBody(gh.body) };
}
/** The newest release on a channel from GitHub's list (drafts and tags that are not versions are ignored), or null. */
export function newestRelease(list, channel = 'stable') {
  const ok = (Array.isArray(list) ? list : []).filter(r => r && !r.draft && validVersion(r.tag_name) && (channel === 'edge' || (!r.prerelease && !isPrerelease(r.tag_name))));
  return ok.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] || null;
}
/**
 * Ask GitHub for the newest release on the channel and cache it in update.json. maxAgeH: use a cached answer that
 * young (same channel). Never throws: a failure is logged once a day and the cached answer is returned with error.
 */
export async function checkForUpdate({ fetch = globalThis.fetch, now = new Date(), maxAgeH = 0, settings = updateSettings(), current = APP_VERSION, log = logLine } = {}) {
  const state = readState();
  if (maxAgeH && state.channel === settings.channel && state.checked_at && now - new Date(state.checked_at) < maxAgeH * 3600000) return { ok: true, cached: true, ...status(state, current) };
  try {
    const gh = newestRelease(await github('/releases?per_page=30', { fetch, repo: settings.repo }), settings.channel);
    const next = writeState({ checked_at: now.toISOString(), channel: settings.channel, latest: gh ? releaseInfo(gh, settings.repo) : null });
    return { ok: true, cached: false, ...status(next, current) };
  } catch (e) {
    const day = now.toISOString().slice(0, 10), msg = e?.name === 'TimeoutError' ? 'timed out' : e.message;
    if (state.error_day !== day) { log(`update check failed: ${msg} (logged once a day; it is tried again after the next run)`); writeState({ error_day: day }); }
    return { ok: false, error: msg, ...status(readState(), current) };
  }
}

// ---------- telling the user ----------
/** The bot is running when it polled in the last 3 minutes (it touches bot.json after each long poll). */
export function botRunning({ file = STATE('bot.json'), now = Date.now() } = {}) {
  try { return now - fs.statSync(file).mtimeMs < 180000; } catch { return false; }
}
export const updateButtons = (version, t = translator()) => ({ inline_keyboard: [[
  { text: t('update.btn_now'), callback_data: `upd:now:${version}` }, { text: t('update.btn_tonight'), callback_data: `upd:tonight:${version}` }, { text: t('update.btn_skip'), callback_data: `upd:skip:${version}` }]] });
/** The Telegram notice: three lines (version, the first highlights, behaviour changes), buttons, and commands without the bot. */
export function noticeMessage(st, { t = translator(), bot = botRunning() } = {}) {
  const lines = [t('update.available', { version: st.latest, current: st.current })];
  if (st.highlights.length) lines.push(st.highlights.slice(0, 2).join(' '));
  if (st.behaviour_changes) lines.push(t('update.behaviour'));
  if (!bot) lines.push('', t('update.commands', { version: st.latest }));
  return { text: lines.join('\n'), reply_markup: updateButtons(st.latest, t) };
}
/** Send a message with buttons through the Bot API (lib/bot.mjs). */
async function sendWithButtons(text, reply_markup) {
  const tg = SETTINGS.delivery.telegram, { telegramTransport } = await import('./bot.mjs');
  const token = process.env[tg.token_env], chat = process.env[tg.chat_id_env];
  return telegramTransport({ token }).call('sendMessage', { chat_id: chat, text, reply_markup, disable_web_page_preview: true }, 30000);
}
const tell = async (text, send) => { try { if (send) await send(text); else if (telegramOn()) await sendText(text); } catch (e) { logLine(`update: Telegram failed: ${e.message}`); } };

// ---------- running it detached ----------
const cliPath = () => (hasAppLayout(ROOT) ? path.join(currentLink(ROOT), 'cli.mjs') : path.join(CODE_DIR, 'cli.mjs'));
const stampNow = (now = new Date()) => now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
/**
 * Start `cli.mjs <args>` outside this process, so it survives the bot or the run unit ending (the update restarts the
 * bot itself): systemd-run --user on a systemd host, else a detached child writing to data/runs/update-<time>.log.
 * run (spawnSync), spawn and systemd are injected by tests. Returns { ok, how, unit?, log? }.
 */
export function launchDetached(args, { run = spawnSync, spawn: sp = spawn, systemd = systemdHost(), node = process.execPath, now = new Date() } = {}) {
  const cli = cliPath(), env = { COMETSCOUT_HOME: ROOT };
  for (const k of ['COMETSCOUT_DATA', 'COMETSCOUT_SETTINGS']) if (process.env[k]) env[k] = process.env[k];
  if (systemd) {
    const unit = `cometscout-update-${stampNow(now)}`;
    const r = run('systemd-run', ['--user', '--collect', '--no-block', `--unit=${unit}`, ...Object.entries({ ...env, PATH: process.env.PATH || '' }).map(([k, v]) => `--setenv=${k}=${v}`), node, cli, ...args], { stdio: 'ignore' });
    if (r && !r.error && r.status === 0) return { ok: true, how: 'systemd-run', unit };
    // on a systemd host a plain detached child stays in the bot's (or the run's) cgroup, and the update's own restart of
    // the bot would kill it halfway: refuse instead
    const why = r?.error?.message || `exit ${r?.status}`;
    logLine(`update: systemd-run failed (${why}); not started`);
    return { ok: false, how: 'refused', message: `Could not start the update outside the bot (systemd-run: ${why}). Run node cli.mjs update in a shell instead.` };
  }
  const file = path.join(DATA, 'runs', `update-${stampNow(now)}.log`); fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    const child = sp(node, [cli, ...args], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env }, cwd: ROOT, windowsHide: true });
    child.unref?.();
    return { ok: true, how: 'detached', log: file };
  } finally { fs.closeSync(fd); }
}

/**
 * The bot's and the workspace's buttons: "now" starts the update detached, "tonight" sets pending, "skip" adds the
 * version to skipped. Returns { ok, message, changed } (changed false when the state was already so).
 */
export function updateAction(action, version, { launch = launchDetached, busy = lockHolder, current = APP_VERSION, t = translator() } = {}) {
  const ACTIONS = { now: 1, tonight: 1, skip: 1 };
  const v = bare(version);
  if (!Object.hasOwn(ACTIONS, String(action)) || !v) return { ok: false, changed: false, message: t('bot.unknown') };
  const state = readState(), skipped = Array.isArray(state.skipped) ? state.skipped : [];
  if (action === 'skip') {
    if (skipped.includes(v) && state.pending !== v) return { ok: true, changed: false, message: t('update.skipped', { version: v }) };
    writeState({ skipped: [...new Set([...skipped, v])], pending: state.pending === v ? null : state.pending ?? null });
    return { ok: true, changed: true, message: t('update.skipped', { version: v }) };
  }
  if (compareVersions(v, current) <= 0) return { ok: false, changed: false, message: t('update.not_newer', { version: v }) };
  if (action === 'tonight') {
    if (state.pending === v) return { ok: true, changed: false, message: t('update.tonight_set', { version: v }) };
    writeState({ pending: v, skipped: skipped.filter(x => x !== v) });
    return { ok: true, changed: true, message: t('update.tonight_set', { version: v }) };
  }
  if (busy()) return { ok: false, changed: false, message: t('update.busy') };
  const r = launch(['update', '--to', `v${v}`]);
  return { ok: !!r?.ok, changed: !!r?.ok, message: r?.ok ? t('update.started', { version: v }) : t('update.launch_failed') };
}
/** /update in the bot and the workspace banner's text: the installed and the newest version. */
export function statusText(st, t = translator()) {
  const lines = [t('update.status', { current: st.current, channel: st.channel, latest: st.latest ? `v${st.latest}` : t('update.unknown') })];
  if (st.checked_at) lines.push(t('update.checked', { at: String(st.checked_at).slice(0, 16).replace('T', ' ') }));
  if (st.pending) lines.push(t('update.pending_note', { version: st.pending }));
  if (st.available && st.skipped) lines.push(t('update.skipped_note', { version: st.latest }));
  if (st.available && st.highlights.length) lines.push(st.highlights.slice(0, 2).join(' '));
  if (st.available && st.behaviour_changes) lines.push(t('update.behaviour'));
  if (!st.available && st.latest) lines.push(t('update.none'));
  return lines.join('\n');
}

/**
 * After the evening run: check (settings.update.check), tell the user once per new version (not on an off day, not a
 * skipped one), and start a Tonight update (pending) once the run has let go of the lock. Never throws.
 */
export async function afterRun({ fetch = globalThis.fetch, quiet = false, send = null, launch = launchDetached, now = new Date(), t = translator(), current = APP_VERSION } = {}) {
  try {
    const st = updateSettings().check ? await checkForUpdate({ fetch, now, current }) : status(readState(), current);
    const state = readState();
    if (updateSettings().check && st.available && !st.skipped && state.notified !== st.latest && st.pending !== st.latest && !quiet && (send || telegramOn())) {
      const m = noticeMessage(st, { t });
      try { await (send || sendWithButtons)(m.text, m.reply_markup); writeState({ notified: st.latest }); logLine(`update: v${st.latest} is out; told you on Telegram`); }
      catch (e) { logLine(`update: the Telegram notice failed: ${e.message}`); }
    }
    if (st.pending) {
      if (compareVersions(st.pending, current) <= 0) writeState({ pending: null });
      else {
        const r = launch(['update', '--to', `v${st.pending}`, '--wait-lock']);
        // a refused start keeps pending, so the next run tries again
        logLine(r?.ok ? `update: Tonight: the update to v${st.pending} starts after this run (${r.how}${r.log ? `, log ${r.log}` : ''})` : `update: Tonight: could not start the update to v${st.pending} (${r?.message || 'launch failed'}); trying again after the next run`);
      }
    }
    return st;
  } catch (e) { logLine(`update: ${e.message}`); return null; }
}

// ---------- the update ----------
const nodeOk = min => Number(process.versions.node.split('.')[0]) >= Number(min || 20);
/** Run the given release's cli.mjs with this home, under this process's lock; the model call is a canned answer. */
export function runCli(dir, args, { stdio = 'pipe', env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(dir, 'cli.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', stdio, timeout: 10 * 60000,
    env: { ...process.env, COMETSCOUT_HOME: ROOT, COMETSCOUT_LOCK_PARENT: String(process.pid), COMETSCOUT_LLM_FAKE: '1', COMETSCOUT_NO_LINK_CHECK: '1', ...env } });
  return { ok: !r.error && r.status === 0, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error?.message };
}
const lastLines = s => String(s || '').trim().split('\n').slice(-3).join(' / ').slice(0, 300);
const todos = out => new Set(String(out || '').split('\n').filter(l => /^TODO /.test(l)).map(l => l.trim()));
/**
 * The checks with the new code: doctor, serve --check, one decoded job decoded again (dry run, canned model), picks
 * (no link checks: verify makes no network calls). doctor always exits 0, so its TODO lines are compared with the
 * previous release's (before): a TODO the old code did not print fails the update.
 */
export function defaultVerify(dir, { cli = runCli, before = null } = {}) {
  const decoded = fs.existsSync(path.join(DATA, 'decoded')) ? fs.readdirSync(path.join(DATA, 'decoded')).filter(f => f.endsWith('.md')).sort().pop() : null;
  const steps = [['doctor', ['doctor']], ['serve --check', ['serve', '--check']], ...(decoded ? [['decode --dry-run', ['decode', '--dry-run', '--file', decoded]]] : []), ['picks', ['picks']]];
  const was = before && fs.existsSync(path.join(before, 'cli.mjs')) ? todos(cli(before, ['doctor']).out) : null;
  for (const [name, args] of steps) {
    const r = cli(dir, args); if (!r.ok) return { ok: false, step: name, detail: r.error || lastLines(r.out) };
    if (name === 'doctor' && was) { const fresh = [...todos(r.out)].filter(l => !was.has(l)); if (fresh.length) return { ok: false, step: name, detail: `new TODO: ${fresh.join(' / ').slice(0, 300)}` }; }
  }
  return { ok: true, steps: steps.map(s => s[0]) };
}
/** Regenerate the units with the code app/current points at (systemd hosts only), then restart the bot onto it. */
export function defaultUnits({ run = spawnSync, systemd = systemdHost() } = {}) {
  if (!systemd) return { code: 0, lines: ['Not a systemd host: no units to regenerate.'] };
  const r = run(process.execPath, [path.join(currentLink(ROOT), 'cli.mjs'), 'timer'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, COMETSCOUT_HOME: ROOT } });
  if (r.error || r.status !== 0) return { code: 1, lines: ['node cli.mjs timer failed'] };
  run('systemctl', ['--user', 'try-restart', UNITS.bot], { stdio: 'ignore' });
  return { code: 0, lines: [] };
}
async function defaultDownload(url, { fetch = globalThis.fetch } = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60000) });
  if (!r.ok) throw new Error(`the download answered ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Unpack a source zip into `dir` (GitHub puts everything under one top folder, which is dropped). Returns the file list. */
export async function unpackRelease(zipFile, dir) {
  const zip = readZip(zipFile), files = zip.entries.filter(e => !e.dir);
  const tops = new Set(files.map(e => e.name.split('/')[0]));
  const strip = tops.size === 1 && files.every(e => e.name.includes('/')) ? `${[...tops][0]}/` : '';
  const out = [];
  for (const e of files) { const rel = e.name.slice(strip.length); await extractEntry(zip, e, entryPath(dir, rel)); out.push(rel); }
  return out.sort();
}

// update.json (the update record) and bot.json (the bot's offset: an older one would answer old button presses again)
// stay as they are when a backup is restored exactly.
export const KEEP_ON_RESTORE = ['data/state/update.json', 'data/state/bot.json'];
/**
 * Restore a backup exactly: every file it holds goes back, and files in the same areas that it does not hold are
 * removed (what a migration added), except KEEP_ON_RESTORE. Returns { restored, removed }.
 */
export async function restoreExact(file, { olderSchema = false } = {}) {
  const abs = rel => entryPath(DATA, rel.slice('data/'.length));
  const kept = KEEP_ON_RESTORE.map(rel => [abs(rel), fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel)) : null]);
  const archive = await openArchive(file, { olderSchema });
  try {
    const r = await importArchive({ archive, onConflict: 'theirs', saveReplaced: false });
    const removed = [];
    for (const f of collect().files) if (!(f.rel in archive.manifest.files) && !KEEP_ON_RESTORE.includes(f.rel)) { fs.rmSync(f.abs, { force: true }); removed.push(f.rel); }
    for (const [p, buf] of kept) { if (buf) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); } else fs.rmSync(p, { force: true }); }
    return { restored: r.plan.add.length + r.plan.conflict.length, removed };
  } finally { archive.cleanup(); }
}

/**
 * cli.mjs update [--to vX.Y.Z]. Everything outside is injected so the tests need no network and no systemd:
 * fetch (GitHub API), download(url) -> Buffer, install(dir) (npm ci), units() (cli.mjs timer), verify(dir), send(text).
 * Returns { code, lines, from, to, step }.
 */
export async function runUpdate({ to = null, waitLock = false, fetch = globalThis.fetch, download = url => defaultDownload(url, { fetch }), install = dir => npmInstall(dir),
  units = () => defaultUnits(), verify = (dir, o) => defaultVerify(dir, o), send = null, statfs = fs.statfsSync, wait = ms => new Promise(r => setTimeout(r, ms)), say = console.log, t = translator() } = {}) {
  const lines = [], out = (...l) => { for (const x of l) { lines.push(x); say(x); } };
  const done = (code, extra = {}) => ({ code, lines, ...extra });
  if (!hasAppLayout(ROOT)) { out(`This install runs its code from ${CODE_DIR} (a git clone). Run node cli.mjs update --adopt once to move the code into app/releases; updates work from then on.`); return done(1); }
  const from = currentVersion(ROOT);
  if (waitLock) for (let i = 0; i < 720 && lockHolder(); i++) await wait(5000);   // Tonight: wait (up to an hour) for the run to finish
  const busy = takeLock(); if (busy) { out(`Not updating: ${busy}.`); return done(1, { from }); }
  const settings = updateSettings();
  if (!to) {
    const st = await checkForUpdate({ fetch, current: from, settings });
    if (!st.ok) { out(`The update check failed: ${st.error}.`); return done(1, { from }); }
    if (!st.available) { out(`You have the newest version (v${from}) on the ${settings.channel} channel.`); return done(0, { from }); }
    to = st.latest;
  }
  if (!validVersion(to)) { out(`"${to}" is not a version; use --to v1.2.3`); return done(1, { from }); }
  to = bare(to);
  if (compareVersions(to, from) <= 0) { out(`v${to} is not newer than v${from}.${installedReleases(ROOT).includes(to) ? ` node cli.mjs rollback --to v${to} goes back to it.` : ''}`); return done(1, { from, to }); }
  const refuse = why => { out(`Not updating to v${to}: ${why}`); return done(1, { from, to, step: 'preflight' }); };

  // 1. preflight: nothing is written until every check passed
  let gh; try { gh = await github(`/releases/tags/v${to}`, { fetch, repo: settings.repo }); } catch (e) { return refuse(`GitHub could not be asked (${e.message}).`); }
  if (!gh || gh.draft) return refuse(`there is no release v${to} on GitHub (${settings.repo}).`);
  const info = releaseInfo(gh, settings.repo);
  if (!nodeOk(info.min_node)) return refuse(`it needs Node ${info.min_node} or newer; this is Node ${process.versions.node}.`);
  const last = listBackups()[0];
  try {
    const s = statfs(ROOT), free = Number(s.bavail) * Number(s.bsize), need = (last?.bytes || 0) * 3;
    if (free < need) return refuse(`free disk space is ${fmtBytes(free)}, less than three times the last backup (${fmtBytes(last.bytes)}).`);
  } catch { /* statfs not available here */ }
  const edits = localEdits(releaseDir(ROOT, from));
  if (edits?.length) return refuse(`the code in app/current was edited in place (${edits.slice(0, 5).map(e => `${e.rel} ${e.why}`).join(', ')}${edits.length > 5 ? ', ...' : ''}). Put the change in settings, profile/ or a hook, and restore the file.`);
  if (!info.sha256) return refuse('the release names no sha256 for its source zip, so the download cannot be checked.');
  let zipBuf; try { zipBuf = await download(info.zip_url); } catch (e) { return refuse(`the download failed (${e.message}).`); }
  if (sha256(zipBuf) !== info.sha256) return refuse('the downloaded source zip does not match the sha256 the release names.');
  const state = readState();
  // before the backup, so a rollback keeps it cleared: a failed Tonight update is not tried again every night
  if (validVersion(state.pending) && compareVersions(state.pending, to) <= 0) writeState({ pending: null });

  // 2. backup
  out(`Updating CometScout v${from} to v${to}.`);
  let pre; try { pre = await backup({ label: cleanLabel(`pre-update-v${from}-to-v${to}`) }); out(`Backup: ${path.basename(pre.file)}`); }
  catch (e) { out(`Not updating: the backup failed (${e.message}).`); return done(1, { from, to, step: 'backup' }); }

  const dest = releaseDir(ROOT, to), partial = `${dest}.partial`, zipFile = path.join(path.dirname(dest), `.download-v${to}.zip`);
  let step = 'install', switched = false;
  const fail = async detail => {
    out(`The update failed at ${step}${detail ? `: ${detail}` : ''}. Rolling back.`);
    try {
      if (switched) pointCurrent(ROOT, from);
      await restoreExact(pre.file);
      if (switched) units();
    } catch (e) { out(`The rollback itself failed (${e.message}). Your data is in ${pre.file}: node cli.mjs restore ${path.basename(pre.file)}`); }
    writeState({ history: remember(readState(), { from, to, at: new Date().toISOString(), result: 'rolled back', step }) });
    const msg = t('update.failed', { to, step, from });
    out(msg); await tell(msg, send);
    return done(1, { from, to, step });
  };
  try {
    // 3. install side by side (a failed earlier attempt of the same version is replaced)
    fs.rmSync(partial, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true }); fs.writeFileSync(zipFile, zipBuf);
    const files = await unpackRelease(zipFile, partial);
    const pkg = readJson(path.join(partial, 'package.json'), {});
    if (pkg.version !== to) return await fail(`the source zip holds version ${pkg.version || '?'}, not ${to}`);
    const entry = readReleases(path.join(partial, 'release.json')).find(e => e.version === to);
    if (!entry) return await fail(`its release.json has no entry for ${to}`);
    if (!nodeOk(entry.min_node)) return await fail(`it needs Node ${entry.min_node}`);
    writeFileList(partial, files, to);
    if (!install(partial)) return await fail('npm ci --omit=dev failed');
    fs.renameSync(partial, dest);
    // 4. migrate, with the new code
    step = 'migrate';
    const m = runCli(dest, ['migrate']);
    if (!m.ok) return await fail(m.error || lastLines(m.out));
    // 5. switch and regenerate the units
    step = 'switch';
    pointCurrent(ROOT, to); switched = true;
    const u = units(); if (u.code) return await fail((u.lines || []).join(' '));
    // 6. verify with the new code
    step = 'verify';
    const v = verify(dest, { before: from ? releaseDir(ROOT, from) : null });   // doctor TODOs compared with the old release
    if (!v.ok) { step = `verify (${v.step})`; return await fail(v.detail); }
  } catch (e) { return await fail(e.message); } finally { fs.rmSync(zipFile, { force: true }); }

  // 7. done
  const pruned = pruneReleases(ROOT, { also: [from] });
  writeState({ history: remember(readState(), { from, to, at: new Date().toISOString(), result: 'ok' }), whats_new_pending: to, whats_new_from: from, notified: to });
  out(`Updated to v${to}.${pruned.length ? ` Removed old release folders: ${pruned.map(v => `v${v}`).join(', ')}.` : ''} node cli.mjs rollback goes back to v${from}.`);
  const notes = notesFor(readReleases(path.join(dest, 'release.json')).find(e => e.version === to) || {});
  const link = SETTINGS.workspace?.url ? String(SETTINGS.workspace.url) : t('update.open_workspace');
  await tell([t('update.done', { version: to, from }), ...(notes.highlights[0] ? [notes.highlights[0]] : []), t('update.whats_new', { link })].join('\n'), send);
  return done(0, { from, to, step: 'done' });
}

// ---------- rollback ----------
const relDir = rel => (rel.startsWith('data/') ? rel.split('/').slice(0, 2).join('/') : rel.startsWith('profile/') ? 'profile' : rel);
/**
 * What restoring `file` would lose: files that are new or changed since it (by folder) and application events added
 * since (by company). Returns { folders: { "data/decoded": { new, changed } }, events: { company: n }, total }.
 */
export async function lostSince(file, { olderSchema = true } = {}) {
  const archive = await openArchive(file, { olderSchema });
  try {
    const folders = {}, bump = (rel, k) => { const d = relDir(rel); folders[d] ??= { new: 0, changed: 0 }; folders[d][k]++; };
    for (const f of collect().files) {
      if (KEEP_ON_RESTORE.includes(f.rel)) continue;
      const h = archive.manifest.files[f.rel];
      if (!h) bump(f.rel, 'new'); else if (sha256(fs.readFileSync(f.abs)) !== h) bump(f.rel, 'changed');
    }
    const appsRel = 'data/state/applications.json', then = archive.manifest.files[appsRel] ? readJson(entryPath(archive.dir, appsRel), {}) : {};
    const nowApps = readJson(path.join(DATA, 'state', 'applications.json'), {}), events = {};
    for (const [k, a] of Object.entries(nowApps || {})) {
      const before = new Set((then?.[k]?.events || []).map(e => JSON.stringify(e)));
      const added = (Array.isArray(a?.events) ? a.events : []).filter(e => !before.has(JSON.stringify(e))).length + (then?.[k] ? 0 : 1);
      if (added) events[a.company || k] = (events[a.company || k] || 0) + added;
    }
    const total = Object.values(folders).reduce((n, f) => n + f.new + f.changed, 0);
    return { folders, events, total };
  } finally { archive.cleanup(); }
}
export const lostLines = lost => [
  ...Object.entries(lost.folders).sort().map(([d, c]) => `  ${d}: ${[c.new ? `${c.new} new` : null, c.changed ? `${c.changed} changed` : null].filter(Boolean).join(', ')}`),
  ...(Object.keys(lost.events).length ? ['  application events:', ...Object.entries(lost.events).sort().map(([c, n]) => `    ${c}: ${n}`)] : []),
];

/**
 * cli.mjs rollback [--to vX.Y.Z] [--restore-data] [--yes]. Default: switch the code back (safe: data changes are
 * expand-then-contract) and regenerate the units. --restore-data also restores the backup made before the update to
 * this version, after listing what it would lose and a backup of the current state. Returns { code, lines }.
 */
export async function runRollback({ to = null, restoreData = false, yes = false, units = () => defaultUnits(), say = console.log } = {}) {
  const lines = [], out = (...l) => { for (const x of l) { lines.push(x); say(x); } };
  if (!hasAppLayout(ROOT)) { out('There is no app/current here, so nothing to roll back (node cli.mjs update --adopt sets it up).'); return { code: 1, lines }; }
  const busy = takeLock(); if (busy) { out(`Not rolling back: ${busy}.`); return { code: 1, lines }; }
  const cur = currentVersion(ROOT), have = installedReleases(ROOT);
  if (to && !validVersion(to)) { out(`"${to}" is not a version; use --to v1.2.3`); return { code: 1, lines }; }
  // by default the version the last update to this one came from (a failed attempt's folder is never chosen), else the newest older one
  const came = [...(readState().history || [])].reverse().find(h => h?.result === 'ok' && h.to === cur)?.from;
  const target = to ? bare(to) : have.includes(came) ? came : have.find(v => compareVersions(v, cur) < 0);
  if (!target) { out(`There is no release older than v${cur} in app/releases.`); return { code: 1, lines }; }
  if (target === cur) { out(`v${cur} is already the current release.`); return { code: 1, lines }; }
  if (!have.includes(target)) { out(`app/releases has no v${target}. Installed: ${have.map(v => `v${v}`).join(', ')}.`); return { code: 1, lines }; }
  let fresh = null;
  if (restoreData) {
    const label = cleanLabel(`pre-update-v${target}-to-v${cur}`), pre = listBackups().find(b => b.label === label);
    if (!pre) { out(`There is no backup labelled ${label}. Roll back the code only (without --restore-data), or pick a backup from node cli.mjs backups and restore it.`); return { code: 1, lines }; }
    const lost = await lostSince(pre.file);
    out(`Restoring ${pre.name} loses what changed since ${pre.date} ${pre.time.replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2')}:`, ...(lost.total || Object.keys(lost.events).length ? lostLines(lost) : ['  nothing']));
    if (!yes) { out(`Run again with --yes to go back to v${target} and restore it. The current state is backed up first.`); return { code: 1, lines }; }
    fresh = await backup({ label: cleanLabel(`pre-rollback-v${cur}`), prune: false, copy: false });
    out(`Backed up the current state: ${path.basename(fresh.file)}`);
    await restoreExact(pre.file, { olderSchema: true });
    out(`Restored ${pre.name}.`);
  }
  pointCurrent(ROOT, target);
  const u = units();
  const state = readState();
  writeState({ history: remember(state, { from: cur, to: target, at: new Date().toISOString(), result: restoreData ? 'rolled back with data' : 'rolled back' }), whats_new_pending: null });
  out(`app/current points at v${target} again.${u.code ? ' Regenerating the units failed: run node cli.mjs timer.' : ''} v${cur} stays in app/releases; node cli.mjs update --to v${cur} returns to it.`);
  if (fresh) out(`To bring back the newer items listed above: node cli.mjs import --from ${fresh.file} --on-conflict keep --data-only`);
  return { code: u.code ? 1 : 0, lines };
}

// ---------- What is new ----------
// Settings the workspace's settings dialog can write: release notes name them by their path in settings.json.
export const WRITABLE = { 'schedule.days': 'days', 'schedule.time': 'time', 'picks.prep.days_before': 'prep_days' };
const valueAt = (setting, s = SETTINGS) => {
  if (setting === 'schedule.days') return scheduleOf(s).days; if (setting === 'schedule.time') return scheduleOf(s).time;
  if (setting === 'picks.prep.days_before') return prepOf(s).days_before;
  return String(setting).split('.').reduce((o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), s);
};
/**
 * GET /api/whats-new: the notes between the version before the last update and the running one, once (until the user
 * marks them seen). { show, from, current, releases: [{ version, date, behaviour_changes, highlights, new, changed,
 * action_needed: [{ text, setting, key }], changed_defaults: [{ setting, default, yours, text, key }], media: [{ url, alt }] }] }
 */
export function whatsNew({ locale = SETTINGS.locale || 'en', state = readState(), current = APP_VERSION, list = readReleases(), settings = SETTINGS } = {}) {
  const pending = validVersion(state.whats_new_pending) ? bare(state.whats_new_pending) : null;
  const show = !!pending && pending === bare(current);
  const releases = show ? releasesBetween(state.whats_new_from, current, list).map(e => {
    const n = notesFor(e, locale);
    return { version: e.version, date: e.date, behaviour_changes: !!e.behaviour_changes, highlights: n.highlights, new: n.new, changed: n.changed,
      action_needed: n.action_needed.map(a => ({ text: a.text, setting: a.setting || null, key: Object.hasOwn(WRITABLE, a.setting || '') ? WRITABLE[a.setting] : null })),
      changed_defaults: n.changed_defaults.map(d => ({ setting: d.setting, default: d.default, yours: valueAt(d.setting, settings) ?? null, text: d.text, key: Object.hasOwn(WRITABLE, d.setting) ? WRITABLE[d.setting] : null })),
      media: (e.media || []).filter(m => mediaPathOk(m.path)).map(m => ({ url: `/media/${m.path}`, alt: m.alt })) };
  }) : [];
  return { show: show && releases.length > 0, from: state.whats_new_from || null, current: bare(current), releases };
}
/** POST /api/whats-new { seen }: the screen is not shown again for this version. */
export function markSeen(version = APP_VERSION) { writeState({ whats_new_pending: null, last_seen: bare(version) }); return { ok: true }; }
/** A /media/ path: only images release.json names, under the code folder. */
export function mediaFile(rel, list = readReleases()) {
  if (!mediaPathOk(rel) || !list.some(e => (e.media || []).some(m => m.path === rel))) return null;
  const p = path.join(CODE_DIR, ...rel.split('/'));
  return fs.existsSync(p) ? p : null;
}

// ---------- doctor ----------
export function updateDoctor() {
  const u = updateSettings(), st = status(), out = [];
  for (const p of u.problems) out.push({ level: 'todo', text: 'update settings', fix: p });
  const cur = currentVersion(ROOT);
  out.push(cur ? { level: 'ok', text: `code: app/releases/v${cur} (app/current); ${installedReleases(ROOT).length} release(s) installed` }
    : { level: 'ok', text: `code: ${CODE_DIR} (a git clone; node cli.mjs update --adopt moves it to app/releases, which updates need)` });
  const what = st.available ? `v${st.latest} is out${st.skipped ? ' (you skipped it)' : ''}${st.pending ? `; Tonight: v${st.pending}` : ''}` : st.latest ? 'up to date' : 'not checked yet';
  out.push({ level: 'ok', text: `updates: ${u.check ? 'checked after the evening run' : 'check off (update.check)'}, ${u.channel} channel, v${APP_VERSION}, ${what}` });
  return out;
}

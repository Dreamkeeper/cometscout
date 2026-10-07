// Secrets without the chat: which secrets each feature needs (and whether each is set, never its value), and the
// one-time links the MCP server's secrets_form tool hands out. The user opens the link in a browser on their own
// computer (through an SSH tunnel to the workspace), types the value into the workspace's /secrets page, and the
// workspace writes .env through lib/secrets.mjs. The value never passes through the MCP server or the AI client.
// A link is single use and expires after 15 minutes. data/state/secrets-links.json keeps only a SHA-256 of each token,
// the variable names it may set and when it expires; the token itself is never stored or logged.
// The names a link may set are a fixed list (FORM_SECRETS in lib/env-names.mjs, the secrets the code reads by
// default), never derived from settings: a *_env setting pointed at NODE_OPTIONS or at another feature's secret must
// not turn into a form that writes it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, SETTINGS, STATE, read, readJson, parseEnv } from './config.mjs';
import { setEnvValues } from './secrets.mjs';
import { FORM_SECRETS, GMAIL_SECRETS, secretEnvName } from './env-names.mjs';

export const LINK_TTL_MS = 15 * 60 * 1000;
export const LINKS_FILE = () => STATE('secrets-links.json');
const ENV_FILE = () => path.join(ROOT, '.env');

/** The .env values as the file holds them now (this process loaded .env once, at its start). */
const envNow = () => parseEnv(read(ENV_FILE())).values;
/** True when the variable has a value, in this process or in .env as it is now. */
export const secretSet = (key, file = envNow()) => !!(process.env[key] || file[key]);

/**
 * Every feature that needs a secret: { feature, enabled, keys: [{ name, set }], how, form, problems? }. `how` says where
 * the value comes from; `form` is true when secrets_form can set every key (only the fixed FORM_SECRETS names). A *_env
 * setting that names a refused variable or another feature's secret shows as not set, with the reason in problems.
 * Values are never read into the result.
 */
export function secretNeeds(s = SETTINGS) {
  const src = s.sources || {}, tg = s.delivery?.telegram || {}, env = envNow();
  const gmail = ['linkedin_alerts', 'outcomes', 'hh_alerts'].filter(k => src[k]?.enabled);
  const named = (key, value, dflt) => ({ key, value, ...secretEnvName(value, dflt) });
  const fixed = n => ({ name: n, problem: null });
  const rows = [
    { feature: 'rtj', enabled: !!src.rtj?.enabled, keys: [named('sources.rtj.token_env', src.rtj?.token_env, 'RTJ_API_TOKEN')], how: 'your RealtimeJobs API token' },
    { feature: 'gmail', enabled: gmail.length > 0, used_by: gmail, keys: GMAIL_SECRETS.slice(0, 2).map(fixed), how: 'a Google Cloud OAuth client of type Desktop app (AGENTS.md step 6)' },
    { feature: 'gmail', enabled: gmail.length > 0, used_by: gmail, keys: [fixed('GMAIL_REFRESH_TOKEN')], how: 'written by node tools/gmail-auth.mjs after you sign in; no form needed', form: false },
    { feature: 'hirify', enabled: !!src.hirify?.enabled, keys: [named('sources.hirify.cookie_env', src.hirify?.cookie_env, 'HIRIFY_COOKIE')], how: 'the Cookie header of a request to api.hirify.me (README: Hirify)' },
    { feature: 'telegram', enabled: !!tg.enabled, keys: [named('delivery.telegram.token_env', tg.token_env, 'TELEGRAM_BOT_TOKEN'), named('delivery.telegram.chat_id_env', tg.chat_id_env, 'TELEGRAM_CHAT_ID')], how: 'a bot from @BotFather and your chat id' },
  ];
  return rows.map(r => {
    const problems = r.keys.filter(k => k.problem).map(k => `${k.key}: ${k.problem}`);
    const keys = r.keys.map(k => (k.name ? { name: k.name, set: secretSet(k.name, env) } : { name: String(k.value), set: false }));
    const form = r.form !== false && r.keys.every(k => FORM_SECRETS.includes(k.name));
    const how = form || r.form === false ? r.how : `${r.how}; a name of your own is set in .env over SSH`;
    return { ...r, how, form, keys, ...(problems.length ? { problems } : {}) };
  });
}

const hash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
function readLinks(now, file) {
  const j = readJson(file, {}), links = Array.isArray(j?.links) ? j.links : [];
  return links.filter(l => l && typeof l.hash === 'string' && Date.parse(l.expires) > now);
}
function writeLinks(links, file) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ links }, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
}

/** A new link for these variable names: { token, expires_at }. Expired links are dropped on the way. */
export function issueLink(keys, { now = Date.now(), file = LINKS_FILE(), allowed = FORM_SECRETS } = {}) {
  const want = [...new Set(keys || [])];
  if (!want.length) throw new Error('name at least one secret');
  const bad = want.filter(k => !allowed.includes(k) || !FORM_SECRETS.includes(k));
  if (bad.length) throw new Error(`${bad.join(', ')} cannot be set here; the secrets are: ${FORM_SECRETS.filter(k => allowed.includes(k)).join(', ')}`);
  const token = crypto.randomBytes(24).toString('base64url'), expires = new Date(now + LINK_TTL_MS).toISOString();
  writeLinks([...readLinks(now, file), { hash: hash(token), keys: want, expires }], file);
  return { token, expires_at: expires };
}

/** The live link for a token: { keys, expires_at }, or null when it is unknown, used or expired. Nothing changes. */
export function peekLink(token, { now = Date.now(), file = LINKS_FILE() } = {}) {
  if (typeof token !== 'string' || !token) return null;
  const l = readLinks(now, file).find(x => x.hash === hash(token));
  return l ? { keys: l.keys, expires_at: l.expires } : null;
}

/**
 * Use a link: values { KEY: value } for keys the link names (empty ones are left out). Checked first; then the link
 * is removed (single use) and .env is written. Returns { ok, saved: [keys] } or { ok: false, status, error }.
 */
export function useLink(token, values, { now = Date.now(), file = LINKS_FILE(), envFile = ENV_FILE() } = {}) {
  const link = peekLink(token, { now, file });
  if (!link) return { ok: false, status: 410, error: 'this link was used already or has expired; ask for a new one' };
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { ok: false, status: 400, error: 'send the values' };
  // spaces around a pasted token are a paste accident, never part of it
  const given = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string' && v.trim() !== '').map(([k, v]) => [k, v.trim()]));
  // a link stored before the list was fixed (or a hand-edited links file) still writes only the known secrets
  const extra = Object.keys(given).filter(k => !link.keys.includes(k) || !FORM_SECRETS.includes(k));
  if (extra.length) return { ok: false, status: 400, error: `this link cannot set ${extra.join(', ')}` };
  if (!Object.keys(given).length) return { ok: false, status: 400, error: 'type at least one value' };
  if (Object.values(given).some(v => /[\r\n\0]/.test(v))) return { ok: false, status: 400, error: 'a value must be one line' };
  writeLinks(readLinks(now, file).filter(l => l.hash !== hash(token)), file);
  return { ok: true, saved: setEnvValues(given, envFile) };
}

// Environment variable names: which ones .env may never set, and the secrets CometScout knows.
// .env holds secrets only. A name that changes how a program starts (NODE_OPTIONS, PATH, LD_PRELOAD, PYTHONPATH ...),
// where traffic goes (the proxy variables) or which certificates are trusted would turn a line in .env into code
// execution or interception on the next run, so lib/secrets.mjs never writes one and lib/config.mjs never loads one
// from .env (doctor lists the refused lines). The same goes for CometScout's own control variables (COMETSCOUT_*, and
// the names from before the rename through lib/legacy-names.mjs): they belong in the environment of a command.
// No imports but lib/legacy-names.mjs: lib/config.mjs uses this file while it loads.
import { isControlName } from './legacy-names.mjs';

const REFUSED = [
  [/^NODE_/i, 'it changes how Node.js starts'],
  [/^(PATH|PATHEXT|HOME|SHELL|ENV|BASH_ENV|IFS|COMSPEC|SYSTEMROOT|USERPROFILE|APPDATA|LOCALAPPDATA|TMP|TEMP|TMPDIR)$/i, 'the system uses it to find programs and files'],
  [/^(LD_|DYLD_)/i, 'it loads code into programs'],
  [/^(PYTHON|PERL|RUBY)/i, 'it changes how a script interpreter starts'],
  [/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i, 'it sends network traffic through another server'],
  [/^(SSL_CERT_|REQUESTS_CA_BUNDLE$|CURL_CA_BUNDLE$)/i, 'it changes which certificates are trusted'],
  [/^(GIT|SOFFICE)$|^GIT_/i, 'it names a program CometScout runs, or changes how git runs'],
  [/^npm_config_/i, 'it changes how npm installs code'],
  [/^(XDG_|DBUS_)/i, 'systemd uses it to find the user session'],
];

/** Why `name` may never be set from .env, or null when it may. */
export function refusedEnvName(name) {
  const k = String(name);
  if (isControlName(k)) return 'it is a CometScout control variable: set it in the environment of the command, never in .env';
  const hit = REFUSED.find(([re]) => re.test(k));
  return hit ? hit[1] : null;
}

// ---------- the secrets CometScout uses ----------
// A fixed list built from the code's own defaults, never from settings: the secrets link offers only these names.
/** The settings that name a secret's .env variable, with the name the code uses by default. */
export const SECRET_ENV_SETTINGS = [
  { feature: 'rtj', key: 'sources.rtj.token_env', default: 'RTJ_API_TOKEN' },
  { feature: 'hirify', key: 'sources.hirify.cookie_env', default: 'HIRIFY_COOKIE' },
  { feature: 'telegram', key: 'delivery.telegram.token_env', default: 'TELEGRAM_BOT_TOKEN' },
  { feature: 'telegram', key: 'delivery.telegram.chat_id_env', default: 'TELEGRAM_CHAT_ID' },
];
/** Read-only Gmail (lib/gmail.mjs, tools/gmail-auth.mjs): fixed names. */
export const GMAIL_SECRETS = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
/** Every secret name CometScout reads. */
export const KNOWN_SECRETS = [...SECRET_ENV_SETTINGS.map(x => x.default), ...GMAIL_SECRETS];
/** The names the one-time secrets link may set (GMAIL_REFRESH_TOKEN is written by tools/gmail-auth.mjs). */
export const FORM_SECRETS = KNOWN_SECRETS.filter(k => k !== 'GMAIL_REFRESH_TOKEN');
// the model CLI's own login variables (lib/config.mjs CLI_OWN): never a source's token
const MODEL_CLI = /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_)/i;

/**
 * The .env variable a *_env setting names, checked: { name, problem }. Unset means the default. A name that is not a
 * variable name, is refused in .env, belongs to the model CLI or is another secret CometScout knows gives name ''
 * (the feature then has no secret) and the problem, so one feature's secret is never sent to another's service.
 */
export function secretEnvName(value, dflt) {
  if (value === undefined || value === null || value === '') return { name: dflt, problem: null };
  const v = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return { name: '', problem: `${JSON.stringify(v)} is not a variable name` };
  const why = refusedEnvName(v);
  if (why) return { name: '', problem: `${v} cannot hold a secret: ${why}` };
  if (MODEL_CLI.test(v)) return { name: '', problem: `${v} is the model CLI's own login variable, never a source's secret` };
  const other = KNOWN_SECRETS.find(k => k.toUpperCase() === v.toUpperCase() && k !== dflt);
  if (other) return { name: '', problem: `${v} is the secret of another feature; CometScout never sends one feature's secret to another` };
  return { name: v, problem: null };
}
const at = (s, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), s);
/** The checked variable name for one of SECRET_ENV_SETTINGS in a settings object ('' when refused). */
export function secretEnvOf(s, key) {
  const x = SECRET_ENV_SETTINGS.find(e => e.key === key);
  if (!x) throw new Error(`${key} does not name a secret`);
  return secretEnvName(at(s, key), x.default).name;
}
/** Problems of the *_env settings in a settings object: ["sources.rtj.token_env: ..."] (doctor, settings_set). */
export const secretEnvProblems = s => SECRET_ENV_SETTINGS.map(x => [x.key, secretEnvName(at(s, x.key), x.default).problem]).filter(([, p]) => p).map(([k, p]) => `${k}: ${p}`);

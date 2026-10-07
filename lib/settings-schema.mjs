// Every known setting in settings.json, in one table: its type, default, allowed values and one line of help. The MCP
// server's settings_schema tool and the cometscout://settings/schema resource are this table; settings_set checks a
// change against it and against doctor's own checks (settingsProblems below); test/settings-schema.test.mjs checks
// that it covers every key doctor reads. The source names (SOURCES) live here too, so the table and cli.mjs agree.
//
// An entry: { key, type, default, allowed?, min?, max?, pattern?, items?, nullable?, help, locked?, sensitive? }
//   key        dotted path; "*" stands for any name (sources_report.prices.*)
//   type       string | integer | number | boolean | array | object | text-or-list (a string or a list of strings)
//   locked     settings_set never changes it: it runs a program, reads or writes a path, fetches code, or is a secret.
//              The reason is the value. These are edited by hand over SSH.
//   sensitive  the value is a secret of its own (a ping URL): redacted wherever the MCP server shows settings
// Every key ending in _env names an environment variable and is locked, whatever its entry says (checked below).
import { SETTINGS, SECRETISH } from './config.mjs';
import { GATE_KEYS, describeGates } from './gates.mjs';
import { HOOK_EVENTS } from './hooks.mjs';
import { LOCALES } from './i18n.mjs';
import { CHANNELS, updateSettings } from './update.mjs';
import { scheduleProblems, PREP_MAX_DAYS } from './schedule.mjs';
import { transcribeSettings, ENGINES, VADS, VAD_OPTIONS, DEFAULT_ENGINES, LANGUAGE_FLOOR } from './transcribe.mjs';

/** Source name -> its script. cli.mjs runs them in this order; doctor and the schema read the names from here. */
export const SOURCES = { ats_boards: 'sources/ats-boards.mjs', rtj: 'sources/rtj.mjs', linkedin_alerts: 'sources/linkedin-alerts.mjs',
  hh_alerts: 'sources/hh-alerts.mjs', hirify: 'sources/hirify.mjs', career_ops: 'sources/career-ops.mjs', drop_dir: 'sources/drop-dir.mjs', outcomes: 'sources/outcomes.mjs' };

const RUNS = 'it names a program CometScout runs';
const PATH = 'it is a path on the server';
const CODE = 'it decides where code is installed from';
const SHELL = 'hooks run shell commands';
const SECRET = 'treat it as a secret';
const SCOPE = 'the MCP scope is set by hand';
const ENV_VAR = 'it names an environment variable: a wrong name could load code from .env or send one feature\'s secret to another service';
const LINK = 'the secrets link is built from it, so a changed address could send a secret to another site';
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

const e = (key, type, def, help, extra = {}) => ({ key, type, default: def, help, ...extra });
const list = (key, help, def = [], extra = {}) => e(key, 'array', def, help, { items: 'string', ...extra });
const int = (key, def, help, min = 0, max, extra = {}) => e(key, 'integer', def, help, { min, ...(max !== undefined ? { max } : {}), ...extra });
const flag = (key, def, help, extra = {}) => e(key, 'boolean', def, help, extra);
const obj = (key, help, extra = {}) => e(key, 'object', undefined, help, extra);
const str = (key, def, help, extra = {}) => e(key, 'string', def, help, extra);
const enabled = (name, help) => flag(`sources.${name}.enabled`, false, help);

export const SCHEMA = [
  str('candidate_name', 'the candidate', 'Your name, as the digest and the packs write it.'),
  str('timezone', 'UTC', 'IANA time zone for the run time, dates and interview times (for example Europe/Madrid).'),
  str('locale', 'en', 'Language of CometScout\'s own messages: the digest, Telegram, the workspace.', { allowed: LOCALES }),
  str('run_time', null, 'Old name for schedule.time; doctor suggests moving it. Set schedule.time instead.', { nullable: true, locked: 'it is replaced by schedule.time' }),

  obj('schedule', 'When the evening run happens and on which days the digest is sent.'),
  e('schedule.days', 'array', [1, 2, 3, 4, 5, 6, 7], 'Digest days, ISO weekdays (1 = Monday ... 7 = Sunday). Other days collect and decode but send nothing.', { items: 'integer' }),
  str('schedule.time', '18:00', 'Time of the evening run, HH:MM in timezone. Changing it reinstalls the timer.', { pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }),

  obj('llm', 'The model CLI every model step calls.'),
  str('llm.provider', 'claude', 'Which CLI to call: Claude Code or Codex.', { allowed: ['claude', 'codex'] }),
  str('llm.model', 'sonnet', 'Model for decoding (a mid-size model is enough).'),
  str('llm.pack_model', 'opus', 'Model for application packs (use the strongest you have).'),
  int('llm.timeout_sec', 300, 'Seconds one model call may take.', 10, 7200),
  str('llm.bin', null, 'Path of the CLI when it is not on the PATH.', { nullable: true, locked: RUNS }),

  obj('decoder', 'The decode step.'),
  int('decoder.cap', 30, 'Most jobs decoded per run; the rest wait for the next run.', 1),
  str('decoder.prompt_file', null, 'Your own decoder prompt instead of decoder/prompt.md (absolute, or relative to profile/).', { nullable: true, locked: PATH }),
  list('decoder.context_files', 'Extra files from profile/ given to the decoder as context.', [], { locked: PATH }),
  int('decoder.context_max_chars', 40000, 'Most characters of context files sent with each decode.', 1000),
  int('decoder.max_tries', 3, 'Failed decodes of one job before it moves to rejected/.', 1),
  int('decoder.settle_sec', 0, 'Seconds a new inbox file must sit before it is decoded (for producers writing into data/inbox).', 0),

  obj('queue', 'Duplicates and company names.'),
  int('queue.dedupe_days', 60, 'Days the same company and title count as a duplicate.', 0),
  e('queue.aliases', 'array', [], 'Company name families: [["Acme Robotics", "Acme"]].', { items: 'array' }),
  list('queue.role_stopwords', 'Your own generic title words, ignored when titles are compared.'),

  obj('picks', 'Daily picks: the best open roles to apply to.'),
  int('picks.per_day', 2, 'Picks per evening, one per employer.', 0, 10),
  int('picks.window_days', 14, 'Only decodes from the last N days can be picks.', 1),
  int('picks.max_shown', 3, 'A job is shown as a pick at most this many times.', 1),
  str('picks.exclude_location_regex', '', 'Never pick a job whose location matches (a regular expression).'),
  str('picks.exclude_onsite_location_regex', '', 'Never pick a job whose location matches unless it is fully remote.'),
  e('picks.shape_bonus', 'array', [], 'Rank offices you like with remote roles: [{ "location_regex": "...", "rank": 1 }].', { items: 'object' }),
  obj('picks.prep', 'Interview prep mode: fewer, fresher picks right before an interview.'),
  int('picks.prep.days_before', 2, 'Days before an interview prep mode starts; 0 turns it off.', 0, PREP_MAX_DAYS),
  int('picks.prep.max', 1, 'Most picks a day in prep mode.', 0, 10),
  list('picks.prep.verdicts', 'Verdicts a pick may have in prep mode.', ['strong-fit']),
  int('picks.prep.max_priority', 1, 'Highest apply priority (1 is best) a pick may have in prep mode.', 1, 5),
  int('picks.prep.fresh_days', 2, 'A prep-mode pick must have been decoded in the last N days.', 1, 30),

  obj('sources', 'Where jobs come from; every source is optional.'),
  enabled('ats_boards', 'Read public Greenhouse, Ashby and Lever boards of the companies you list.'),
  e('sources.ats_boards.companies', 'array', [], 'Companies: [{ "name": "...", "ats": "greenhouse|ashby|lever", "board": "<slug>" }].', { items: 'object' }),
  list('sources.ats_boards.title_include', 'A title must match one of these (empty: every title).'),
  list('sources.ats_boards.title_exclude', 'Titles that match one of these are skipped.'),
  list('sources.ats_boards.location_include', 'A location must match one of these (empty: every location).'),
  int('sources.ats_boards.max_per_run', 30, 'Most jobs queued per run.', 1),
  enabled('rtj', 'RealtimeJobs API (needs RTJ_API_TOKEN in .env).'),
  str('sources.rtj.token_env', 'RTJ_API_TOKEN', 'Name of the .env variable that holds the RealtimeJobs token.', { pattern: ENV_NAME.source, locked: ENV_VAR }),
  int('sources.rtj.hours', 24, 'Hours of postings read on the first run.', 1),
  int('sources.rtj.overlap_hours', 6, 'Hours each run reads again before the last one.', 0),
  int('sources.rtj.page_size', 100, 'Postings per API page.', 1, 500),
  int('sources.rtj.max_pages', 3, 'API pages per run.', 1),
  int('sources.rtj.max_lookback_hours', 168, 'Furthest back a run reads after a pause.', 1),
  int('sources.rtj.max_headcount', null, 'Skip companies larger than this (null: no limit).', 1, undefined, { nullable: true }),
  list('sources.rtj.title_exclude', 'Titles that match one of these are skipped.'),
  enabled('linkedin_alerts', 'LinkedIn job-alert emails from Gmail (needs the Gmail secrets).'),
  str('sources.linkedin_alerts.sender', 'jobalerts-noreply@linkedin.com', 'Sender address of the alert emails.'),
  int('sources.linkedin_alerts.first_run_hours', 48, 'Hours of email read on the first run.', 1),
  int('sources.linkedin_alerts.overlap_hours', 24, 'Hours each run reads again before the last one.', 0),
  int('sources.linkedin_alerts.max_fetch', 40, 'Most job pages fetched per run.', 1),
  int('sources.linkedin_alerts.delay_ms', 3000, 'Milliseconds between page fetches.', 0),
  list('sources.linkedin_alerts.title_exclude', 'Titles that match one of these are skipped.'),
  str('sources.linkedin_alerts.location_exclude_regex', '', 'Skip jobs whose location matches (a regular expression).'),
  enabled('hh_alerts', 'hh.ru alert emails from Gmail (needs the Gmail secrets).'),
  str('sources.hh_alerts.sender', 'noreply@hh.ru', 'Sender address of the alert emails.'),
  int('sources.hh_alerts.first_run_hours', 72, 'Hours of email read on the first run.', 1),
  int('sources.hh_alerts.overlap_hours', 24, 'Hours each run reads again before the last one.', 0),
  int('sources.hh_alerts.max_lookback_hours', 168, 'Furthest back a run reads after a pause.', 1),
  int('sources.hh_alerts.max_fetch', 40, 'Most vacancy pages fetched per run.', 1),
  int('sources.hh_alerts.delay_ms', 3000, 'Milliseconds between page fetches.', 0),
  list('sources.hh_alerts.title_include', 'A title must match one of these (empty: every title).'),
  list('sources.hh_alerts.title_exclude', 'Titles that match one of these are skipped.'),
  list('sources.hh_alerts.must_reside_phrases', 'Phrases that mean a remote job needs you in a given country (a hit rejects it).'),
  list('sources.hh_alerts.abroad_signals', 'Phrases that suggest working from abroad is fine.'),
  list('sources.hh_alerts.tax_residency_phrases', 'Phrases that flag a tax residency requirement.'),
  obj('sources.hh_alerts.city_countries', 'Extra city to country pairs: { "City": "CY" }.'),
  str('sources.hh_alerts.city_countries.*', undefined, 'Country code for a city.'),
  enabled('hirify', 'Hirify saved filters, read with your session cookie (HIRIFY_COOKIE in .env).'),
  str('sources.hirify.cookie_env', 'HIRIFY_COOKIE', 'Name of the .env variable that holds the Hirify session cookie.', { pattern: ENV_NAME.source, locked: ENV_VAR }),
  e('sources.hirify.filters', 'array', [], 'Saved filters: [{ "name": "...", "query": "<the part after ? on hirify.me>" }].', { items: 'object' }),
  int('sources.hirify.max_pages_per_filter', 3, 'Pages read per filter.', 1),
  int('sources.hirify.max_age_days', 14, 'Skip jobs posted longer ago.', 0),
  int('sources.hirify.delay_ms', 1500, 'Milliseconds between requests.', 0),
  list('sources.hirify.title_exclude', 'Titles that match one of these are skipped.'),
  enabled('career_ops', 'Jobs a career-ops checkout found (read only).'),
  str('sources.career_ops.path', null, 'The career-ops checkout.', { nullable: true, locked: PATH }),
  flag('sources.career_ops.include_evaluated', false, 'Also take rows career-ops already evaluated.'),
  int('sources.career_ops.max_per_run', 30, 'Most jobs handled per run.', 1),
  str('sources.career_ops.pipeline_file', 'data/pipeline.md', 'Pipeline file, relative to path.', { locked: PATH }),
  str('sources.career_ops.scan_history_file', 'data/scan-history.tsv', 'Scan history file, relative to path.', { locked: PATH }),
  enabled('drop_dir', 'Job files and *.queue.json files another program drops into a folder.'),
  str('sources.drop_dir.dir', null, 'The folder to read.', { nullable: true, locked: PATH }),
  int('sources.drop_dir.settle_sec', 60, 'Seconds a file must sit before it is read.', 0),
  str('sources.drop_dir.move_processed_to', null, 'Where read files go (default: <dir>/processed).', { nullable: true, locked: PATH }),
  int('sources.drop_dir.max_fetches_per_run', 40, 'Most job pages fetched per run.', 1),
  enabled('outcomes', 'Answers to your applications from Gmail (needs the Gmail secrets).'),
  str('sources.outcomes.query', 'newer_than:3d -category:promotions -category:social', 'Gmail search for the first run.'),
  int('sources.outcomes.max_emails', 50, 'Most emails sent to the model per run.', 1, 500),
  int('sources.outcomes.overlap_hours', 24, 'Hours each run reads again before the last one.', 0),
  int('sources.outcomes.account_index', 0, 'The N in mail.google.com/mail/u/N/ for links.', 0, 99),
  str('sources.outcomes.model', null, 'Model for classifying emails (null: llm.model).', { nullable: true }),

  obj('gates', 'Hard rules every source applies before a job is queued; every key is optional.'),
  obj('gates.user', 'Who you are, legally.'),
  list('gates.user.citizenships', 'Your citizenships (country codes).'),
  list('gates.user.work_authorization', 'Countries you may work in (country codes).'),
  list('gates.languages', 'Languages you work in (en, es, ru ...).'),
  list('gates.onsite_countries', 'Countries where on-site or hybrid jobs are fine.'),
  obj('gates.remote', 'Which remote jobs are fine.'),
  flag('gates.remote.accept_worldwide', true, 'Accept remote jobs open worldwide.'),
  list('gates.remote.accept_regions', 'Remote regions you accept ("Europe*", "EU", "EMEA").'),
  list('gates.sponsorship_refusal_phrases', 'Phrases that mean no visa sponsorship.'),
  list('gates.must_reside_phrases', 'Phrases that mean you must live in a given country.'),
  obj('gates.headcount', 'Company size limits (null: no limit).'),
  int('gates.headcount.demote_over', null, 'Hold back jobs at companies larger than this.', 1, undefined, { nullable: true }),
  int('gates.headcount.reject_over', null, 'Reject jobs at companies larger than this.', 1, undefined, { nullable: true }),
  list('gates.headcount.demote_unless', 'Exceptions to demote_over: remote_worldwide, remote_region, sponsorship.'),
  obj('gates.headcount.reject_keywords_over', 'Reject large companies with one of these keywords in industries or title.'),
  int('gates.headcount.reject_keywords_over.min', null, 'Headcount above which the keywords reject.', 1, undefined, { nullable: true }),
  list('gates.headcount.reject_keywords_over.keywords', 'Keywords for that rule.'),
  obj('gates.companies', 'Companies never to queue.'),
  list('gates.companies.exclude', 'Companies to skip.'),
  list('gates.companies.agencies', 'Recruiting agencies to skip.'),
  obj('gates.industries', 'Industries never to queue.'),
  list('gates.industries.exclude', 'Industries to skip.'),
  e('gates.industries.exclude_combos', 'array', [], 'Skip when every term of one entry matches: [["gaming", "mobile"]].', { items: 'array' }),

  obj('delivery', 'Where the digest goes.'),
  obj('delivery.telegram', 'Telegram delivery and the bot.'),
  flag('delivery.telegram.enabled', false, 'Send the digest and packs to Telegram (needs the Telegram secrets).'),
  str('delivery.telegram.token_env', 'TELEGRAM_BOT_TOKEN', 'Name of the .env variable that holds the bot token.', { pattern: ENV_NAME.source, locked: ENV_VAR }),
  str('delivery.telegram.chat_id_env', 'TELEGRAM_CHAT_ID', 'Name of the .env variable that holds your chat id.', { pattern: ENV_NAME.source, locked: ENV_VAR }),

  obj('pack', 'Application packs: tailored CV, cover letter, form answers.'),
  flag('pack.enabled', true, 'Build a pack for each pick.'),
  str('pack.pdf', 'auto', 'How PDFs are made: auto, or libreoffice to skip Word on Windows.', { allowed: ['auto', 'libreoffice'] }),
  str('pack.soffice', null, 'Path of LibreOffice when it is not on the PATH.', { nullable: true, locked: RUNS }),

  obj('tracker_export', 'Applications as a job-pipeline-tracker import file.'),
  flag('tracker_export.enabled', false, 'Write the file at the end of every run.'),
  str('tracker_export.out', 'tracker/pipeline.json', 'The file, relative to data/.', { locked: PATH }),

  obj('sources_report', 'Which source earns its price.'),
  flag('sources_report.enabled', false, 'Build the source scorecard after every run.'),
  int('sources_report.window_days', 30, 'Days the scorecard looks back.', 1, 3650),
  obj('sources_report.prices', 'Price per source: { "rtj": { "price_month": 10, "currency": "USD" } }.'),
  obj('sources_report.prices.*', 'One source\'s price.'),
  e('sources_report.prices.*.price_month', 'number', undefined, 'Price a month.', { min: 0 }),
  str('sources_report.prices.*.currency', undefined, 'Currency code.'),
  str('sources_report.prices.*.renews', undefined, 'Renewal date, YYYY-MM-DD.', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  str('sources_report.prices.*.decision', undefined, 'Your note on it.'),
  flag('sources_report.prices.*.feed', true, 'false for a paid service that is not a job feed.'),

  obj('health', 'Running unattended.'),
  str('health.ping_url', '', 'A healthchecks.io style URL pinged after every run.', { locked: SECRET, sensitive: true }),

  obj('backup', 'Nightly backups.'),
  flag('backup.nightly', true, 'Back up after every evening run.'),
  str('backup.copy_to', '', 'A second folder each backup is copied to.', { locked: PATH }),
  int('backup.zip_codepage', null, 'Code page for file names in the zip (null: UTF-8).', 0, undefined, { nullable: true }),

  obj('update', 'Updates from GitHub releases.'),
  str('update.channel', 'stable', 'Which releases to offer.', { allowed: CHANNELS }),
  flag('update.check', true, 'Check for a new version after the evening run.'),
  str('update.repo', 'Dreamkeeper/cometscout', 'GitHub repository of the releases.', { locked: CODE }),

  obj('workspace', 'The workspace (cli.mjs serve).'),
  str('workspace.url', null, 'The address you open the workspace at (through a tunnel); messages and the secrets link use it.', { nullable: true, locked: LINK }),

  obj('modules', 'Optional modules installed from their own projects.'),
  obj('modules.coach', 'Noam Segal\'s interview coach.'),
  flag('modules.coach.enabled', false, 'Doctor checks the install and the run refreshes the hand-off file.'),
  str('modules.coach.path', null, 'Its folder (null: interview-coach next to this one).', { nullable: true, locked: PATH }),
  str('modules.coach.repo', 'https://github.com/noamseg/interview-coach-skill.git', 'Where it is installed from.', { locked: CODE }),
  obj('modules.transcribe', 'Speech to text on this server\'s CPU.'),
  flag('modules.transcribe.enabled', false, 'Turn the transcription module on.'),
  str('modules.transcribe.path', null, 'Its folder (null: cometscout-transcribe next to this one).', { nullable: true, locked: PATH }),
  str('modules.transcribe.model', 'large-v3-turbo', 'Whisper model.'),
  str('modules.transcribe.compute_type', 'int8', 'Compute type for the model.'),
  int('modules.transcribe.threads', 2, 'CPU threads.', 1, 256),
  int('modules.transcribe.nice', 10, 'CPU priority (0 to 19, higher is gentler).', 0, 19),
  str('modules.transcribe.language', null, 'Language code, or null to detect it.', { nullable: true }),
  str('modules.transcribe.inbox', 'data/audio/inbox', 'Folder for audio to transcribe.', { locked: PATH }),
  e('modules.transcribe.keep_audio_days', 'number', 30, 'Days audio is kept after transcription.', { min: 0, max: 36500 }),
  e('modules.transcribe.max_upload_mb', 'number', 500, 'Largest upload in the workspace, in MB.', { min: 1, max: 100000 }),
  flag('modules.transcribe.telegram_attach', true, 'Attach transcript.md to the Transcript ready message.'),
  obj('modules.transcribe.engines', 'Engine per language: { "ru": "gigaam+whisper", "default": "whisper" } (GigaAM needs transcribe.sh --with-gigaam).'),
  str('modules.transcribe.engines.default', DEFAULT_ENGINES.default, 'Engine for languages not listed.', { allowed: ENGINES }),
  str('modules.transcribe.engines.*', undefined, 'Engine for this language code.', { allowed: ENGINES }),
  e('modules.transcribe.language_floor', 'number', LANGUAGE_FLOOR, 'How sure the language detection must be (0 to 1).', { min: 0, max: 1 }),
  str('modules.transcribe.language_fallback', 'auto', 'What an unsure detection does: auto (Whisper alone) or a language code such as ru.', { pattern: '^(auto|[a-z]{2,3})$' }),
  str('modules.transcribe.vad', 'silero', 'How GigaAM finds speech.', { allowed: VADS }),
  obj('modules.transcribe.vad_options', 'Speech detection settings, tuned for cutting long audio.'),
  ...Object.entries(VAD_OPTIONS).map(([k, [def, min, max]]) => e(`modules.transcribe.vad_options.${k}`, 'number', def, `Speech detection: ${k.replace(/_/g, ' ')}.`, { min, max })),
  list('modules.transcribe.keep_cyrillic', 'More brand forms the merge keeps in Cyrillic.'),
  list('modules.transcribe.glossary', 'More terms, like lines of profile/glossary.txt.'),

  obj('hooks', 'Your own commands run on pipeline events.', { locked: SHELL }),
  ...HOOK_EVENTS.map(ev => e(`hooks.${ev}`, 'text-or-list', null, `Command(s) run on the ${ev} event.`, { nullable: true, locked: SHELL })),
  int('hooks.timeout_sec', 60, 'Seconds a hook may run.', 1, 3600, { locked: SHELL }),

  obj('mcp', 'The MCP server (cli.mjs mcp).'),
  str('mcp.scope', 'operate', 'Highest scope the MCP server allows: read, operate or admin (the lower of this and --scope wins).', { allowed: ['read', 'operate', 'admin'], locked: SCOPE }),
];

// a key named like an environment variable setting is locked even when its entry forgets to say so
for (const x of SCHEMA) if (/_env$/i.test(x.key.split('.').pop()) && !x.locked) x.locked = ENV_VAR;

/** Key names that reach into Object.prototype: never a setting, not even under a wildcard ("sources_report.prices.*"). */
export const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
const forbidden = k => FORBIDDEN_KEYS.includes(String(k));
/** Dotted paths in `keys` and in every key of `value` (at any depth) that use a forbidden name ([] when none). */
export function forbiddenKeys(keys, value) {
  const out = [];
  const parts = Array.isArray(keys) ? keys : String(keys).split('.');
  if (parts.some(forbidden)) out.push(parts.join('.'));
  const walk = (at, v) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk([...at, String(i)], x)); return; }
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) { const p = [...at, k]; if (forbidden(k)) out.push(p.join('.')); else walk(p, v[k]); }
  };
  walk(parts, value);
  return out;
}

const BY_KEY = new Map(SCHEMA.map(x => [x.key, x]));
/** The entry for a path (array of keys or dotted string), wildcards included, or null. */
export function entryFor(keys) {
  const parts = Array.isArray(keys) ? keys : String(keys).split('.');
  if (parts.some(forbidden)) return null;
  const exact = BY_KEY.get(parts.join('.'));
  if (exact) return exact;
  for (const x of SCHEMA) {
    const k = x.key.split('.');
    if (k.length === parts.length && k.every((p, i) => p === '*' || p === parts[i])) return x;
  }
  return null;
}
/** True when some entry lies under this path (it is a container the schema knows). */
export function isContainer(keys) {
  const parts = Array.isArray(keys) ? keys : String(keys).split('.');
  if (parts.some(forbidden)) return false;
  return SCHEMA.some(x => { const k = x.key.split('.'); return k.length > parts.length && parts.every((p, i) => k[i] === '*' || k[i] === p); });
}
/** True when the path names a key the schema knows: an entry, a wildcard match or a container of entries. */
export const knownPath = keys => !!entryFor(keys) || isContainer(keys);

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
/** A key name that holds a secret itself (a token, a cookie); "*_env" names an .env variable and is not one. */
export const secretKey = name => SECRETISH.test(String(name)) && !/_env$/i.test(String(name));

/** What is wrong with one value for its entry ([] when fine). */
export function valueProblems(x, v, where = x.key) {
  if (v === undefined) return [];
  if (v === null) return x.nullable ? [] : [`${where} must not be null`];
  const t = typeOf(v), out = [];
  const ok = x.type === 'number' ? t === 'integer' || t === 'number' : x.type === 'text-or-list' ? t === 'string' || (t === 'array' && v.every(s => typeof s === 'string')) : t === x.type;
  if (!ok) return [`${where} must be ${x.type === 'text-or-list' ? 'a string or a list of strings' : `${/^[aeiou]/.test(x.type) ? 'an' : 'a'} ${x.type}`}, got ${JSON.stringify(v)}`];
  if (x.allowed && !x.allowed.includes(v)) out.push(`${where} must be one of ${x.allowed.join(', ')}, got ${JSON.stringify(v)}`);
  if ((x.type === 'integer' || x.type === 'number') && ((x.min !== undefined && v < x.min) || (x.max !== undefined && v > x.max)))
    out.push(`${where} must be from ${x.min ?? '-infinity'} to ${x.max ?? 'infinity'}, got ${v}`);
  if (x.pattern && t === 'string' && !(x.nullable && v === '') && !new RegExp(x.pattern).test(v)) out.push(`${where} has the wrong form: ${JSON.stringify(v)}`);
  if (x.type === 'array' && x.items) {
    const bad = v.find(i => (x.items === 'integer' ? !Number.isInteger(i) : typeOf(i) !== x.items && !(x.items === 'number' && typeof i === 'number')));
    if (bad !== undefined) out.push(`${where} must be a list of ${x.items}s, got ${JSON.stringify(bad)} in it`);
  }
  return out;
}

/** Keys under an object value that the schema does not know (dotted paths), "_comment" style keys aside. */
export function unknownKeys(keys, value) {
  const out = [];
  const walk = (at, v) => {
    if (!isObj(v)) return;
    const x = entryFor(at);
    if (x && x.type !== 'object') return;   // an array of objects or a text value: its own type check covers it
    for (const [k, child] of Object.entries(v)) {
      if (k.startsWith('_')) continue;
      const p = [...at, k];
      if (!knownPath(p)) { out.push(p.join('.')); continue; }
      walk(p, child);
    }
  };
  walk(keys, value);
  return out;
}

/** Type and range problems of every known key present in a settings object. */
export function typeProblems(s) {
  const out = [];
  const walk = (at, v) => {
    if (at.length) { const x = entryFor(at); if (x) { out.push(...valueProblems(x, v, at.join('.'))); if (x.type !== 'object') return; } }
    if (isObj(v)) for (const [k, child] of Object.entries(v)) if (!k.startsWith('_')) walk([...at, k], child);
  };
  walk([], s);
  return out;
}

/**
 * What doctor would call wrong with this settings object, without looking at the disk or .env: types and ranges from
 * the table, the schedule and prep checks, unknown sources, hooks and gate keys, models that do not fit the provider,
 * the locale, the update settings and the time zone. settings_set refuses a change that adds any of these.
 */
export function settingsProblems(s) {
  if (!isObj(s)) return ['settings.json must be a JSON object'];
  const out = [...typeProblems(s), ...scheduleProblems(s)];
  const sources = isObj(s.sources) ? s.sources : {};
  const unknownSources = Object.keys(sources).filter(k => !SOURCES[k] && !k.startsWith('_'));
  if (unknownSources.length) out.push(`unknown source(s): ${unknownSources.join(', ')} (known: ${Object.keys(SOURCES).join(', ')})`);
  const unknownHooks = Object.keys(isObj(s.hooks) ? s.hooks : {}).filter(k => k !== 'timeout_sec' && !HOOK_EVENTS.includes(k) && !k.startsWith('_'));
  if (unknownHooks.length) out.push(`unknown hook event(s): ${unknownHooks.join(', ')} (known: ${HOOK_EVENTS.join(', ')})`);
  const gates = describeGates(s.gates);
  if (gates.unknown.length) out.push(`unknown key(s) under gates: ${gates.unknown.join(', ')} (known: ${GATE_KEYS.join(', ')})`);
  const llm = isObj(s.llm) ? s.llm : {}, provider = llm.provider || 'claude';
  const claudeish = m => /^(sonnet|opus|haiku|claude)/i.test(String(m || '')), openaiish = m => /^(gpt|o\d|codex)/i.test(String(m || ''));
  const wrong = [llm.model, llm.pack_model].filter(m => m && (provider === 'codex' ? claudeish(m) : openaiish(m)));
  if (wrong.length) out.push(`${wrong.join(', ')} is not a ${provider} model; set llm.model and llm.pack_model`);
  if (s.locale != null && !LOCALES.includes(s.locale) && !out.some(p => p.startsWith('locale'))) out.push(`unknown locale "${s.locale}"; use one of ${LOCALES.join(', ')}`);
  out.push(...updateSettings(s).problems.filter(p => !out.includes(p)));
  // the transcription module checks its own block (engines, vad, language_floor ...); doctor reports the same lines
  out.push(...transcribeSettings(s).problems.filter(p => !out.some(o => o.startsWith(p.split(/[: ]/)[0]))));
  if (typeof s.timezone === 'string') { try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); } catch { out.push(`timezone "${s.timezone}" is not a time zone (use a name like Europe/Madrid)`); } }
  if (sources.hh_alerts?.enabled) { const l = [].concat(s.gates?.languages ?? []).map(x => String(x).toLowerCase()); if (l.length && !l.some(x => /^(ru|rus|russian)([-_].*)?$/.test(x))) out.push('hh.ru alerts are on but gates.languages has no "ru", so every Russian posting would be rejected'); }
  return [...new Set(out)];
}

const REDACTED = '[redacted]';
/**
 * A copy of a settings object with every secret-looking value replaced: sensitive keys from the table, key names
 * that look like a secret (not "*_env", which names an .env variable), values equal to a loaded secret, and URLs with
 * a password or a token in them.
 */
export function redactSettings(v, { secrets = [], at = [] } = {}) {
  const leak = s => typeof s === 'string' && s && (secrets.some(x => x && s.includes(x)) || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(s) || /[?&](token|key|secret|password|sig|signature)=/i.test(s));
  if (Array.isArray(v)) return v.map((x, i) => redactSettings(x, { secrets, at: [...at, String(i)] }));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => {
    const p = [...at, k], entry = entryFor(p);
    if ((entry?.sensitive || secretKey(k)) && x != null && x !== '') return [k, REDACTED];
    return [k, redactSettings(x, { secrets, at: p })];
  }));
  return leak(v) ? REDACTED : v;
}
export { REDACTED };

/** The table as settings_schema returns it: one object per key, with the current value's type check left to the caller. */
export const schemaView = () => SCHEMA.map(x => ({
  key: x.key, type: x.type, ...(x.default !== undefined ? { default: x.default } : {}), ...(x.allowed ? { allowed: x.allowed } : {}),
  ...(x.min !== undefined ? { min: x.min } : {}), ...(x.max !== undefined ? { max: x.max } : {}), ...(x.pattern ? { pattern: x.pattern } : {}),
  ...(x.items ? { items: x.items } : {}), ...(x.nullable ? { nullable: true } : {}), help: x.help,
  settable: !x.locked, ...(x.locked ? { locked_because: x.locked } : {}), ...(x.sensitive ? { sensitive: true } : {}),
}));

/** The effective settings with secrets redacted (SETTINGS by default). */
export const redactedSettings = (s = SETTINGS, secrets = []) => redactSettings(s, { secrets });

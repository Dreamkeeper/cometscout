// One structured-output call to the user's own subscription CLI: Claude Code (`claude -p`) or Codex (`codex exec`).
// No tools, no session, JSON schema enforced. Returns { value, cost, ms }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SETTINGS, DIRS, modelEnv, SECRET_VALUES } from './config.mjs';

// OpenAI strict mode: every object lists all properties as required and forbids extras; optional ones become nullable.
function strictify(s) {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(strictify);
  const o = { ...s };
  if (o.properties) {
    const req = new Set(o.required || []);
    o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => {
      const sv = strictify(v);
      if (req.has(k)) return [k, sv];
      if (sv.enum) return [k, { ...sv, type: [].concat(sv.type || 'string', 'null'), enum: [...sv.enum, null] }];
      return [k, { ...sv, type: [].concat(sv.type || 'string', 'null') }];
    }));
    o.required = Object.keys(o.properties); o.additionalProperties = false;
  }
  if (o.items) o.items = strictify(o.items);
  for (const k of ['minimum', 'maximum', 'maxLength', 'minLength', 'maxItems', 'minItems']) delete o[k];
  return o;
}
const dropNulls = v => Array.isArray(v) ? v.map(dropNulls) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)])) : v;

function run(bin, args, input, timeoutMs, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env: modelEnv(), stdio: ['pipe', 'pipe', 'pipe'] });   // no jobpilot secrets in the model's environment
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const t = setTimeout(() => { p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 5000); }, timeoutMs);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    p.stdin.on('error', () => {}); p.stdin.end(input);
  });
}

export async function callJson(req) {
  const r = await callRaw(req);
  // Last line of defence: if a job text tricked the model into reading a secret (env or a file on disk), the
  // answer is thrown away before it can reach a decoded file, a pack or Telegram.
  const out = JSON.stringify(r.value);
  if (SECRET_VALUES().some(s => out.includes(s))) throw new Error('model output contained a secret value from .env and was discarded (possible prompt injection in the job text)');
  return r;
}
async function callRaw({ prompt, schema, model, timeoutSec }) {
  const cfg = SETTINGS.llm; const provider = cfg.provider; const t0 = Date.now();
  const timeoutMs = (timeoutSec || cfg.timeout_sec) * 1000;
  // Run outside the repo: Claude Code and Codex load CLAUDE.md / AGENTS.md from the working directory and its
  // parents, and jobpilot's own files are onboarding instructions that must not leak into a decode or pack call.
  const cwd = path.join(os.tmpdir(), 'jobpilot-llm'); fs.mkdirSync(cwd, { recursive: true });
  if (provider === 'claude') {
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', '', '--strict-mcp-config', '--max-turns', '3', '--no-session-persistence', ...(model ? ['--model', model] : [])];
    const r = await run(cfg.bin || 'claude', args, prompt, timeoutMs, cwd);
    let env; try { env = JSON.parse(r.out); } catch { throw new Error(`claude exit ${r.code}: ${(r.err || r.out).slice(0, 300)}`); }
    if (r.code !== 0 || env.is_error) throw new Error(`claude: ${String(env.result || r.err).slice(0, 300)}`);
    let v = env.structured_output;
    if (!v && typeof env.result === 'string') { const m = env.result.match(/\{[\s\S]*\}/); if (m) v = JSON.parse(m[0]); }
    if (!v) throw new Error('claude returned no structured output');
    return { value: v, cost: env.total_cost_usd || 0, ms: Date.now() - t0 };
  }
  if (provider === 'codex') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-'));
    const schemaFile = path.join(tmp, 'schema.json'), outFile = path.join(tmp, 'out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(strictify(schema)));
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--output-schema', schemaFile, '-o', outFile, ...(model ? ['-m', model] : []), '-'];
    const r = await run(cfg.bin || 'codex', args, prompt, timeoutMs, cwd);
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    fs.rmSync(tmp, { recursive: true, force: true });
    if (r.code !== 0 || !text) throw new Error(`codex exit ${r.code}: ${(r.err || r.out).slice(-300)}`);
    return { value: dropNulls(JSON.parse(text)), cost: 0, ms: Date.now() - t0 };
  }
  throw new Error(`unknown llm.provider "${provider}" (use "claude" or "codex")`);
}

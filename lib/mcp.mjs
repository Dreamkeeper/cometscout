// The MCP server (node cli.mjs mcp [--scope read|operate|admin]): CometScout as a set of tools, resources and prompts
// for an AI client (Claude Code, Claude Desktop, Codex), over stdio. Reached on a VPS through SSH:
//   claude mcp add cometscout -- ssh <host> cometscout mcp
// It is a third front end next to the command line and the workspace, never a new way to write state: every write goes
// through the existing writers (lib/applications.mjs, lib/settings-writer.mjs, lib/queue.mjs writeJob, lib/secrets.mjs).
//
// Protocol: JSON-RPC 2.0, one message per line on stdin and stdout, written here with no SDK. It follows the MCP
// specification revision 2026-07-28 (https://modelcontextprotocol.io/specification/2026-07-28), the "modern" era where
// every request names its protocol version in params._meta["io.modelcontextprotocol/protocolVersion"] and the server
// answers server/discover, and it also serves "legacy" clients that open with initialize (revisions 2025-11-25,
// 2025-06-18 and 2025-03-26): a dual-era server, as the 2026-07-28 versioning page describes. Results of the modern era
// carry resultType "complete", the serverInfo in _meta, and ttlMs / cacheScope on lists and reads.
// Tools return structuredContent matching their outputSchema and the same JSON as text; a problem the model can fix
// (bad arguments, a refused write, the run lock) is a tool result with isError: true, while an unknown tool, method or
// resource is a JSON-RPC error. stdout carries protocol messages only: console.log is sent to stderr while this runs.
import { SETTINGS } from './config.mjs';
import { APP_VERSION } from './archive.mjs';
import { TOOLS, RESOURCES, PROMPTS, ToolError, validate, audit, toolContext } from './mcp-tools.mjs';

export const SPEC = '2026-07-28';
export const MODERN = ['2026-07-28'];
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SCOPES = ['read', 'operate', 'admin'];
const M = 'io.modelcontextprotocol/';
const SERVER_INFO = { name: 'cometscout', title: 'CometScout', version: APP_VERSION };
const INSTRUCTIONS = 'CometScout is a self-hosted job search pipeline. Start with status and onboarding_state; doctor lists what is missing. '
  + 'Writes go through CometScout\'s own validation; settings_set is a dry run unless dry_run is false, so show the user the diff first. '
  + 'Never ask the user to paste a token, password or cookie into the chat: secrets_form gives them a one-time link to type it on their own computer.';

// JSON-RPC and MCP error codes
export const ERR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, unsupportedVersion: -32022 };
class RpcError extends Error { constructor(code, message, data) { super(message); this.code = code; this.data = data; } }

/** The scope this server runs with: the lower of --scope (default operate) and settings mcp.scope. */
export function resolveScope(flag, setting = SETTINGS.mcp?.scope) {
  const want = flag ?? 'operate';
  if (!SCOPES.includes(want)) throw new Error(`--scope must be read, operate or admin, got "${want}"`);
  if (setting == null) return want;
  if (!SCOPES.includes(setting)) return 'read';   // a typo in settings never widens the scope
  return SCOPES[Math.min(SCOPES.indexOf(want), SCOPES.indexOf(setting))];
}
const allows = (scope, need) => SCOPES.indexOf(scope) >= SCOPES.indexOf(need);

/**
 * The server: handle(message) resolves to the response object, or null for a notification. `scope` limits the tools
 * listed and callable; `ctx` is passed to every tool (tests inject fetch there).
 */
export function createServer({ scope = 'operate', ctx = toolContext() } = {}) {
  let legacy = null;   // the protocol version an initialize agreed on, for clients of the handshake era
  ctx.scope = scope;
  const tools = TOOLS.filter(t => allows(scope, t.scope));
  const capabilities = { tools: {}, resources: {}, prompts: {} };

  const toolView = t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: { title: t.title, ...t.annotations } });
  async function callTool(params) {
    const name = params?.name, tool = tools.find(t => t.name === name);
    if (typeof name !== 'string' || !tool) throw new RpcError(ERR.invalidParams, `Unknown tool: ${String(name)}${TOOLS.some(t => t.name === name) ? ` (it needs the ${TOOLS.find(t => t.name === name).scope} scope; this server runs with ${scope})` : ''}`);
    const args = params.arguments ?? {};
    const error = text => ({ content: [{ type: 'text', text }], isError: true });
    const problems = validate(tool.inputSchema, args, 'arguments');
    let out;
    if (problems.length) out = { error: `Invalid arguments: ${problems.join('; ')}` };
    else {
      try { out = { data: await tool.run(args, ctx) }; } catch (e) {
        if (e instanceof ToolError) out = { error: e.message, data: e.data };
        else { process.stderr.write(`cometscout mcp: ${name} failed: ${e.stack || e.message}\n`); out = { error: `${name} failed: ${e.message}` }; }
      }
    }
    if (tool.scope !== 'read') audit(tool, args, out, ctx);
    if (out.error) return error(out.error);
    return { content: [{ type: 'text', text: JSON.stringify(out.data) }], structuredContent: out.data, isError: false };
  }
  function readResource(params) {
    const r = RESOURCES.find(x => x.uri === params?.uri);
    if (!r) throw new RpcError(ERR.invalidParams, 'Resource not found', { uri: params?.uri ?? null });
    return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.read(ctx) }] };
  }
  function getPrompt(params) {
    const p = PROMPTS.find(x => x.name === params?.name);
    if (!p) throw new RpcError(ERR.invalidParams, `Unknown prompt: ${String(params?.name)}`);
    const args = params.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcError(ERR.invalidParams, 'arguments must be an object of strings');
    const missing = (p.arguments || []).filter(a => a.required && !args[a.name]).map(a => a.name);
    if (missing.length) throw new RpcError(ERR.invalidParams, `Missing argument(s): ${missing.join(', ')}`);
    return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(args, { scope }) } }] };
  }

  const LIST_TTL = 60000;
  const METHODS = {
    ping: () => ({}),
    'tools/list': () => ({ tools: tools.map(toolView), cache: LIST_TTL }),
    'tools/call': callTool,
    'resources/list': () => ({ resources: RESOURCES.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })), cache: LIST_TTL }),
    'resources/templates/list': () => ({ resourceTemplates: [], cache: LIST_TTL }),
    'resources/read': p => ({ ...readResource(p), cache: 0 }),
    'prompts/list': () => ({ prompts: PROMPTS.map(({ name, title, description, arguments: a }) => ({ name, title, description, arguments: a || [] })), cache: LIST_TTL }),
    'prompts/get': getPrompt,
  };

  async function dispatch(msg) {
    const { method } = msg, params = msg.params;
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) throw new RpcError(ERR.invalidParams, 'params must be an object');
    const meta = params?._meta && typeof params._meta === 'object' ? params._meta : {};
    const version = meta[`${M}protocolVersion`];
    if (method === 'initialize') {
      // the handshake era: answer with the requested version when it is one we serve, else our newest legacy one
      const asked = params?.protocolVersion;
      if (typeof asked !== 'string') throw new RpcError(ERR.invalidParams, 'initialize needs protocolVersion', { supported: [...MODERN, ...LEGACY] });
      legacy = LEGACY.includes(asked) ? asked : LEGACY[0];
      return { modern: false, result: { protocolVersion: legacy, capabilities, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } };
    }
    if (version !== undefined) {
      // the per-request era (2026-07-28): version and client capabilities on every request
      if (typeof version !== 'string' || !MODERN.includes(version)) throw new RpcError(ERR.unsupportedVersion, 'Unsupported protocol version', { supported: [...MODERN, ...LEGACY], requested: version });
      const caps = meta[`${M}clientCapabilities`];
      if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw new RpcError(ERR.invalidParams, `Missing _meta["${M}clientCapabilities"]`);
      if (method === 'server/discover') return { modern: true, result: { supportedVersions: [...MODERN, ...LEGACY], capabilities, instructions: INSTRUCTIONS, cache: 3600000 } };
    } else if (!legacy && method !== 'ping') {
      throw new RpcError(ERR.invalidParams, `Name the protocol version in params._meta["${M}protocolVersion"], or send initialize first`, { supported: [...MODERN, ...LEGACY] });
    }
    const fn = METHODS[method];
    if (!fn) throw new RpcError(ERR.methodNotFound, `Method not found: ${method}`);
    return { modern: version !== undefined, result: await fn(params) };
  }

  /** One incoming message (already parsed) -> the response object, or null when none is due. */
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return reply(null, { error: new RpcError(ERR.invalidRequest, Array.isArray(msg) ? 'Batches are not supported; send one message per line' : 'Invalid request') });
    const hasId = 'id' in msg, id = msg.id;
    if (msg.jsonrpc !== '2.0' || (hasId && !(typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))))) return reply(hasId && (typeof id === 'string' || typeof id === 'number') ? id : null, { error: new RpcError(ERR.invalidRequest, 'Invalid request: jsonrpc must be "2.0" and id a string or a number') });
    if (typeof msg.method !== 'string') return hasId && ('result' in msg || 'error' in msg) ? null : reply(hasId ? id : null, { error: new RpcError(ERR.invalidRequest, 'Invalid request: no method') });
    if (!hasId) return null;   // a notification (initialized, cancelled): nothing to answer
    try { return reply(id, await dispatch(msg)); } catch (e) {
      if (!(e instanceof RpcError)) process.stderr.write(`cometscout mcp: ${msg.method} failed: ${e.stack || e.message}\n`);
      return reply(id, { error: e instanceof RpcError ? e : new RpcError(ERR.internal, `Internal error: ${e.message}`) });
    }
  }
  function reply(id, { result, modern, error }) {
    if (error) return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } };
    const { cache, ...rest } = result;
    if (!modern) return { jsonrpc: '2.0', id, result: rest };
    return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...rest, ...(cache !== undefined ? { ttlMs: cache, cacheScope: 'private' } : {}), _meta: { ...(rest._meta || {}), [`${M}serverInfo`]: SERVER_INFO } } };
  }
  return { handle, scope, tools };
}

const MAX_LINE = 4 * 1024 * 1024;
/** Read messages from `input` line by line, answer each on `output` in order; resolves when input ends. */
export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise(resolve => {
    let buf = '', chain = Promise.resolve(), dropping = false;
    const send = obj => { if (obj) output.write(`${JSON.stringify(obj)}\n`); };
    const line = raw => {
      const text = raw.replace(/\r$/, '');
      if (!text.trim()) return;
      let msg; try { msg = JSON.parse(text); } catch { send({ jsonrpc: '2.0', id: null, error: { code: ERR.parse, message: 'Parse error: each line must be one JSON-RPC message' } }); return; }
      chain = chain.then(() => server.handle(msg)).then(send, e => process.stderr.write(`cometscout mcp: ${e.stack || e.message}\n`));
    };
    input.setEncoding('utf8');
    input.on('data', chunk => {
      if (dropping) {
        // the rest of an over-long line: nothing is kept until its newline, then reading goes on with the next line
        const nl = chunk.indexOf('\n');
        if (nl < 0) return;
        dropping = false; chunk = chunk.slice(nl + 1);
      }
      buf += chunk;
      for (let i; (i = buf.indexOf('\n')) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
      if (buf.length > MAX_LINE) {   // a message too large to hold: answered once, the rest of its line skipped
        buf = ''; dropping = true;
        send({ jsonrpc: '2.0', id: null, error: { code: ERR.parse, message: `Parse error: a message over ${MAX_LINE} characters` } });
      }
    });
    input.on('end', () => { if (buf) line(buf); chain.then(resolve); });
  });
}

/** node cli.mjs mcp [--scope read|operate|admin]: serve until stdin closes. */
export async function mcpCommand(rest = []) {
  // stdout is the protocol channel: everything that prints, here or in a module, goes to stderr instead
  for (const k of ['log', 'info', 'debug']) console[k] = (...a) => console.error(...a);
  const i = rest.indexOf('--scope');
  const flag = i >= 0 ? rest[i + 1] : undefined;
  let scope;
  try {
    if (i >= 0 && (!flag || flag.startsWith('--'))) throw new Error('--scope needs read, operate or admin');
    scope = resolveScope(flag);
  } catch (e) { process.stderr.write(`cometscout mcp: ${e.message}\n`); return 2; }
  const server = createServer({ scope });
  process.stderr.write(`cometscout mcp: serving ${server.tools.length} tools with the ${scope} scope on stdio (MCP ${SPEC}; also ${LEGACY.join(', ')})\n`);
  await serveStdio(server);
  return 0;
}

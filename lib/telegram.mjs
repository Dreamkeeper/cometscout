// Telegram delivery (optional). Text is split at line boundaries into messages under Telegram's 4096-character limit.
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, secret } from './config.mjs';
import { secretEnvOf } from './env-names.mjs';

const cfg = () => SETTINGS.delivery.telegram;
// the checked variable names (lib/env-names.mjs): '' when settings.json names a refused variable or another feature's secret
const tokenOf = () => secret(secretEnvOf(SETTINGS, 'delivery.telegram.token_env'));
const chatOf = () => secret(secretEnvOf(SETTINGS, 'delivery.telegram.chat_id_env'));
export const telegramOn = () => cfg().enabled && tokenOf() && chatOf();

async function api(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${tokenOf()}/${method}`, { method: 'POST', body, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(`Telegram ${method} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
}
export async function sendText(text, max = 3900) {
  if (!telegramOn()) return false;
  const parts = []; let cur = '';
  // A line longer than one message (a long answer or letter paragraph) is split at spaces, never cut off.
  const lines = String(text).split('\n').flatMap(line => { const out = []; let s = line; while (s.length > max - 50) { let at = s.lastIndexOf(' ', max - 50); if (at < max / 2) at = max - 50; out.push(s.slice(0, at)); s = s.slice(at).trimStart(); } out.push(s); return out; });
  for (const l of lines) { if (cur && cur.length + l.length + 1 > max) { parts.push(cur); cur = l; } else cur = cur ? `${cur}\n${l}` : l; }
  if (cur) parts.push(cur);
  for (const p of parts) { const fd = new FormData(); fd.append('chat_id', chatOf()); fd.append('text', p); fd.append('disable_web_page_preview', 'true'); await api('sendMessage', fd); }
  return true;
}
export async function sendFile(file, caption) {
  if (!telegramOn()) return false;
  const fd = new FormData(); fd.append('chat_id', chatOf());
  fd.append('document', new Blob([fs.readFileSync(file)], { type: file.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' }), path.basename(file));
  if (caption) fd.append('caption', caption.slice(0, 1000));
  await api('sendDocument', fd); return true;
}

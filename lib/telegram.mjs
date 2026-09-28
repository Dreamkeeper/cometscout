// Telegram delivery (optional). Text is split at line boundaries into messages under Telegram's 4096-character limit.
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, secret } from './config.mjs';

const cfg = () => SETTINGS.delivery.telegram;
export const telegramOn = () => cfg().enabled && secret(cfg().token_env) && secret(cfg().chat_id_env);

async function api(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${secret(cfg().token_env)}/${method}`, { method: 'POST', body, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.ok) throw new Error(`Telegram ${method} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
}
export async function sendText(text, max = 3900) {
  if (!telegramOn()) return false;
  const parts = []; let cur = '';
  for (const line of String(text).split('\n')) { const l = line.slice(0, max - 50); if (cur && cur.length + l.length + 1 > max) { parts.push(cur); cur = l; } else cur = cur ? `${cur}\n${l}` : l; }
  if (cur) parts.push(cur);
  for (const p of parts) { const fd = new FormData(); fd.append('chat_id', secret(cfg().chat_id_env)); fd.append('text', p); fd.append('disable_web_page_preview', 'true'); await api('sendMessage', fd); }
  return true;
}
export async function sendFile(file, caption) {
  if (!telegramOn()) return false;
  const fd = new FormData(); fd.append('chat_id', secret(cfg().chat_id_env));
  fd.append('document', new Blob([fs.readFileSync(file)], { type: file.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' }), path.basename(file));
  if (caption) fd.append('caption', caption.slice(0, 1000));
  await api('sendDocument', fd); return true;
}

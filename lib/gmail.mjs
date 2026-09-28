// Minimal read-only Gmail REST client (OAuth refresh-token flow, no dependencies).
// Credentials come from .env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (tools/gmail-auth.mjs sets them up).
import { secret } from './config.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class Gmail {
  constructor() {
    this.id = secret('GMAIL_CLIENT_ID'); this.secret = secret('GMAIL_CLIENT_SECRET'); this.refresh = secret('GMAIL_REFRESH_TOKEN');
    if (!this.id || !this.secret || !this.refresh) throw new Error('Gmail is not set up: run `node tools/gmail-auth.mjs` (it writes GMAIL_* to .env)');
    this.access = null; this.expires = 0;
  }
  async token() {
    if (this.access && Date.now() < this.expires - 60000) return this.access;
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.id, client_secret: this.secret, refresh_token: this.refresh, grant_type: 'refresh_token' }) });
    if (!r.ok) throw new Error(`Gmail token refresh failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const d = await r.json(); this.access = d.access_token; this.expires = Date.now() + (Number(d.expires_in) || 3600) * 1000;
    return this.access;
  }
  async api(p, query = {}) {
    const url = new URL(API + p); for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return r.json();
      const detail = (await r.text()).replace(/\s+/g, ' ').slice(0, 300);
      const limited = r.status === 429 || r.status >= 500 || (r.status === 403 && /rate|quota|limit/i.test(detail));
      if (!limited || attempt >= 4) throw new Error(`Gmail GET ${p} failed: ${r.status} ${detail}`);
      await new Promise(res => setTimeout(res, 1000 * 2 ** attempt + Math.random() * 500));
    }
  }
  async list(q, max = 100) {
    const out = []; let pageToken;
    do { const d = await this.api('/messages', { q, maxResults: 100, pageToken }); out.push(...(d.messages || [])); pageToken = d.nextPageToken; } while (pageToken && out.length < max);
    return out.slice(0, max);
  }
  get(id) { return this.api(`/messages/${id}`, { format: 'full' }); }
}

const decode = data => Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
/** Plain text of a message: text/plain parts, else HTML with tags stripped. */
export function messageText(payload) {
  const plain = [], html = [];
  (function walk(p) {
    if (!p) return; const mime = String(p.mimeType || '').toLowerCase().split(';')[0];
    if (p.body?.data) (mime === 'text/plain' ? plain : mime === 'text/html' ? html : []).push(decode(p.body.data));
    for (const c of p.parts || []) walk(c);
  })(payload);
  const t = plain.length ? plain.join('\n') : html.join('\n').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return t.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

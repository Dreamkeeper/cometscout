#!/usr/bin/env node
// One-time Gmail read-only authorization. You sign in with Google in your own browser; the resulting refresh
// token is written straight into .env (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN) and never printed.
//
// Before running: in Google Cloud Console create a project, enable the Gmail API, configure the OAuth consent
// screen (External, add yourself as a test user), then create an OAuth client of type "Desktop app".
// Put its id and secret in .env as GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET, then run:
//   node tools/gmail-auth.mjs
// On a VPS without a browser, forward the port first from your computer:  ssh -L 8765:127.0.0.1:8765 <your-vps>
// and open the printed link in your local browser.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ROOT, secret } from '../lib/config.mjs';

const PORT = 8765, REDIRECT = `http://127.0.0.1:${PORT}/callback`, SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const id = secret('GMAIL_CLIENT_ID'), sec = secret('GMAIL_CLIENT_SECRET');
if (!id || !sec) { console.error('Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to .env first (see the comment at the top of this file).'); process.exit(2); }

function setEnv(key, value) {
  const f = path.join(ROOT, '.env'); const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/) : [];
  const i = lines.findIndex(l => l.startsWith(`${key}=`)); if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  fs.writeFileSync(f, lines.filter((l, n) => l || n < lines.length - 1).join('\n') + '\n', { mode: 0o600 });
}

const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent' })}`;
console.log(`Open this link, sign in and allow read-only Gmail access:\n\n${url}\n\nWaiting on ${REDIRECT} ...`);
http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) { res.end(); return; }
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) { res.end('No code in the redirect. Close this tab and run the script again.'); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: sec, redirect_uri: REDIRECT, grant_type: 'authorization_code' }) });
  const d = await r.json();
  if (!d.refresh_token) { res.end('Google returned no refresh token. Remove the app at myaccount.google.com/permissions and try again.'); console.error('No refresh token returned.'); process.exit(1); }
  setEnv('GMAIL_REFRESH_TOKEN', d.refresh_token);
  res.end('Done. Gmail read-only access is set up; you can close this tab.');
  console.log('Saved GMAIL_REFRESH_TOKEN to .env. Test it with: node sources/linkedin-alerts.mjs --dry-run');
  setTimeout(() => process.exit(0), 200);
}).listen(PORT, '127.0.0.1');

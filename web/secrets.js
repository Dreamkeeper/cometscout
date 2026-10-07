// The one-time secrets page (/secrets?t=<token>, served by lib/server.mjs). No framework: the server renders the form
// with its labels; this script sends the values once, as JSON with the X-CometScout header, then drops the token from
// the address bar. The values go to this server only and are never kept in the page after saving.
const form = document.getElementById('secrets-form');
const status = document.getElementById('secrets-status');
const token = new URLSearchParams(location.search).get('t') || '';
const say = text => { status.textContent = text; };

if (form) {
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const values = {};
    for (const input of form.querySelectorAll('input[name]')) if (input.value.trim()) values[input.name] = input.value;
    if (!Object.keys(values).length) { say(form.dataset.empty); return; }
    const button = form.querySelector('button');
    button.disabled = true; say(form.dataset.saving);
    try {
      const r = await fetch('/api/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CometScout': '1' }, body: JSON.stringify({ t: token, values }), cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.ok) {
        form.reset(); form.hidden = true;
        history.replaceState(null, '', '/secrets');
        say(form.dataset.saved.replace('{keys}', (body.saved || []).join(', ')));
      } else {
        if (r.status === 410) { form.hidden = true; history.replaceState(null, '', '/secrets'); }
        say(r.status === 410 ? form.dataset.gone : form.dataset.failed.replace('{error}', body.error || r.status));
        button.disabled = false;
      }
    } catch (e) {
      say(form.dataset.failed.replace('{error}', e.message)); button.disabled = false;
    }
  });
}

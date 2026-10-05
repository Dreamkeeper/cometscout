// What is new: the release notes since the version before the last update (GET /api/whats-new), shown once.
// Action needed items open the settings dialog at their setting; changed defaults offer keep or accept.
// "Got it" marks the notes seen (POST /api/whats-new).
import { useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { showValue, hasNotes, fieldFor, acceptPatch } from '../lib/updates.js';
import { Modal } from './Actions.js';

const List = ({ title, items }) => (items?.length ? html`<h3>${title}</h3><ul>${items.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul>` : null);

export function WhatsNewDialog({ t, data, api, onOpenSetting, onDone }) {
  const [decided, setDecided] = useState({});   // "version:setting" -> "keep" | "accept"
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const done = async () => {
    setBusy(true);
    try { await api.whatsNewSeen(data.current); onDone(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const accept = async (r, d) => {
    const patch = acceptPatch(d); if (!patch) return;
    setBusy(true); setError(null);
    try { await api.saveSettings(patch); setDecided(x => ({ ...x, [`${r.version}:${d.setting}`]: 'accept' })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return html`
    <${Modal} title=${t('ws.whatsnew.title')} onClose=${done}>
      <div class="whats-new">
        ${data.releases.filter(hasNotes).map(r => html`
          <section key=${r.version}>
            <h2>${t('ws.whatsnew.version', { version: r.version })} <span class="muted small">${r.date}</span></h2>
            ${r.behaviour_changes && html`<p class="note-warn">${t('ws.whatsnew.behaviour')}</p>`}
            ${r.highlights.length > 0 && html`<ul class="highlights">${r.highlights.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul>`}
            ${r.media.map(m => html`<img key=${m.url} class="media" src=${m.url} alt=${m.alt} />`)}
            <${List} title=${t('ws.whatsnew.new')} items=${r.new} />
            <${List} title=${t('ws.whatsnew.changed')} items=${r.changed} />
            ${(r.action_needed.length > 0 || r.changed_defaults.length > 0) && html`
              <h3>${t('ws.whatsnew.action')}</h3>
              <ul>
                ${r.action_needed.map((a, i) => html`<li key=${`a${i}`}>${a.text}
                  ${fieldFor(a.key) && html` <button type="button" class="btn btn-small" onClick=${() => onOpenSetting(a.key)}>${t('ws.whatsnew.open_setting')}</button>`}</li>`)}
                ${r.changed_defaults.map(d => {
                  const k = `${r.version}:${d.setting}`;
                  return html`<li key=${k}>${d.text} ${t('ws.whatsnew.default', { value: showValue(d.default), yours: showValue(d.yours) })}
                    ${!decided[k] && html`<span class="choices-row">
                      <button type="button" class="btn btn-small" onClick=${() => setDecided(x => ({ ...x, [k]: 'keep' }))}>${t('ws.whatsnew.keep')}</button>
                      ${acceptPatch(d) && html`<button type="button" class="btn btn-small" disabled=${busy} onClick=${() => accept(r, d)}>${t('ws.whatsnew.accept')}</button>`}
                    </span>`}</li>`;
                })}
              </ul>`}
          </section>`)}
      </div>
      ${error && html`<p class="inline-error">${error}</p>`}
      <p class="choices-row"><button type="button" class="btn btn-primary" disabled=${busy} onClick=${done}>${t('ws.whatsnew.done')}</button></p>
    <//>`;
}

// The settings dialog: digest days, digest time and the interview prep window. Saved through POST /api/settings
// (lib/settings-writer.mjs, the same writer as the Telegram bot); the server says when the timer moved. focus names
// the field to open at (days, time or prep_days: What is new opens the dialog there for an Action needed item).
import { useState, useEffect } from 'preact/hooks';
import { html } from '../lib/html.js';
import { weekdayNames, toggleDay, settingsProblem } from '../lib/logic.js';
import { fieldFor } from '../lib/updates.js';
import { Modal } from './Actions.js';

export function SettingsDialog({ t, locale, api, onSaved, onClose, focus = null }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.settings().then(setS).catch(e => setError(e.message)); }, []);
  // once loaded, the named field gets the focus and a highlight
  useEffect(() => { const id = fieldFor(focus); if (!s || !id) return; const el = document.getElementById(id); el?.classList.add('focus'); (el?.querySelector('input') || el)?.focus?.(); }, [!!s, focus]);
  const names = weekdayNames(locale);
  const problem = s ? settingsProblem(s) : null;
  const save = async () => {
    if (!s || problem || busy) return;
    setBusy(true); setError(null);
    try { const r = await api.saveSettings({ days: s.days, time: s.time, prep_days: s.prep_days }); onSaved(r.message); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return html`
    <${Modal} title=${t('ws.settings.title')} onClose=${onClose}>
      ${!s && !error && html`<p class="loading">${t('ws.loading')}</p>`}
      ${s && html`
        <fieldset class="days" id="setting-days">
          <legend>${t('ws.settings.days')}</legend>
          ${names.map((n, i) => html`<label key=${i} class=${`day${s.days.includes(i + 1) ? ' on' : ''}`}><input type="checkbox" checked=${s.days.includes(i + 1)} disabled=${!s.writable}
            onChange=${() => setS({ ...s, days: toggleDay(s.days, i + 1) })} /> ${n}</label>`)}
        </fieldset>
        <p class="muted small">${t('ws.settings.note')}</p>
        <label class="field" id="setting-time">${t('ws.settings.time', { tz: s.timezone })}
          <input type="time" value=${s.time} disabled=${!s.writable} onInput=${e => setS({ ...s, time: e.currentTarget.value })} /></label>
        <label class="field" id="setting-prep_days">${t('ws.settings.prep')}
          <input type="number" min="0" max="7" step="1" value=${s.prep_days} disabled=${!s.writable} onInput=${e => setS({ ...s, prep_days: Number(e.currentTarget.value) })} /></label>
        ${!s.writable && html`<p class="inline-error">${t('ws.settings.no_file')}</p>`}
        ${s.problems?.length > 0 && html`<p class="inline-error">${s.problems.join(' ')}</p>`}`}
      ${error && html`<p class="inline-error">${error}</p>`}
      <p class="choices-row">
        <button type="button" class="btn btn-primary" disabled=${!s || !s.writable || !!problem || busy} onClick=${save}>${t('ws.settings.save')}</button>
        <button type="button" class="btn" onClick=${onClose}>${t('ws.act.cancel')}</button>
      </p>
    <//>`;
}

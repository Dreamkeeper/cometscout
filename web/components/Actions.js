// The action bar (Applied, Skip, Later, Open job link) and its dialogs, the booked-interview dialog, plus the keyboard help.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { SKIP_REASONS, LATER_CHOICES } from '../lib/logic.js';
import { KEY_HELP, trapTab } from '../lib/keys.js';

// The longest note a skip can carry: the 500-character limit (lib/applications.mjs) less the longest reason prefix.
const NOTE_ROOM = 500 - Math.max(...SKIP_REASONS.map(r => r.note.length + 2));
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ActionBar({ t, item, busy, onApplied, onSkip, onLater, onOpen }) {
  const off = !item || busy;
  return html`
    <div class="actions" role="toolbar" aria-label=${t('ws.title')}>
      <button type="button" class="btn btn-primary" disabled=${off} onClick=${onApplied} title="a">${t('ws.act.applied')}</button>
      <button type="button" class="btn" disabled=${off} onClick=${onSkip} title="s">${t('ws.act.skip')}</button>
      <button type="button" class="btn" disabled=${off} onClick=${onLater} title="l">${t('ws.act.later')}</button>
      <button type="button" class="btn" disabled=${!item?.url} onClick=${onOpen} title="o">${t('ws.act.open')}</button>
    </div>`;
}

// A dialog takes focus when it opens, keeps Tab and Shift+Tab inside, and gives focus back when it closes.
// Escape closes it (the screen's keyboard handler, web/app.js).
export function Modal({ title, onClose, children }) {
  const ref = useRef(null);
  const focusable = () => (ref.current ? [...ref.current.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled) : []);
  useEffect(() => {
    const before = document.activeElement;
    focusable()[0]?.focus();
    return () => { if (before && document.contains(before) && before.focus) before.focus(); };
  }, []);
  const onKeyDown = e => {
    if (e.key !== 'Tab') return;
    const list = focusable(); e.preventDefault();
    list[trapTab(list.length, list.indexOf(document.activeElement), e.shiftKey)]?.focus();
  };
  return html`
    <div class="overlay" onClick=${e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" role="dialog" aria-modal="true" aria-label=${title} ref=${ref} onKeyDown=${onKeyDown}>
        <h3>${title}</h3>
        ${children}
      </div>
    </div>`;
}

export function SkipDialog({ t, onPick, onClose }) {
  const [note, setNote] = useState('');
  return html`
    <${Modal} title=${t('ws.skip.title')} onClose=${onClose}>
      <ol class="choices">
        ${SKIP_REASONS.map((r, i) => html`<li key=${r.id}><button type="button" class="btn choice" onClick=${() => onPick(r.id, note)}><kbd>${i + 1}</kbd> ${t(`ws.skip.${r.id}`)}</button></li>`)}
      </ol>
      <label class="note">${t('ws.skip.note')}<textarea rows="2" maxlength=${NOTE_ROOM} value=${note} onInput=${e => setNote(e.currentTarget.value)}></textarea></label>
      <p><button type="button" class="btn" onClick=${onClose}>${t('ws.act.cancel')}</button></p>
    <//>`;
}

export function LaterDialog({ t, onPick, onClose }) {
  return html`
    <${Modal} title=${t('ws.later.title')} onClose=${onClose}>
      <p class="choices-row">${LATER_CHOICES.map(d => html`<button key=${d} type="button" class="btn choice" onClick=${() => onPick(d)}><kbd>${d}</kbd> ${t(`ws.later.${d}`)}</button> `)}</p>
      <p><button type="button" class="btn" onClick=${onClose}>${t('ws.act.cancel')}</button></p>
    <//>`;
}

/** A booked interview for the selected job: date, time (optional, in settings.timezone) and round (optional). */
export function InterviewDialog({ t, today, onSave, onClose }) {
  const [date, setDate] = useState(today || '');
  const [time, setTime] = useState('');
  const [round, setRound] = useState('');
  return html`
    <${Modal} title=${t('ws.interview.title')} onClose=${onClose}>
      <label class="field">${t('ws.interview.date')}<input type="date" value=${date} min=${today} onInput=${e => setDate(e.currentTarget.value)} /></label>
      <label class="field">${t('ws.interview.time')}<input type="time" value=${time} onInput=${e => setTime(e.currentTarget.value)} /></label>
      <label class="field">${t('ws.interview.round')}<input type="text" maxlength="120" value=${round} onInput=${e => setRound(e.currentTarget.value)} /></label>
      <p class="choices-row">
        <button type="button" class="btn btn-primary" disabled=${!date} onClick=${() => onSave(date, time, round.trim())}>${t('ws.interview.save')}</button>
        <button type="button" class="btn" onClick=${onClose}>${t('ws.act.cancel')}</button>
      </p>
    <//>`;
}

export function HelpDialog({ t, onClose }) {
  return html`
    <${Modal} title=${t('ws.help.title')} onClose=${onClose}>
      <dl class="keys">${KEY_HELP.map(([k, label]) => html`<div key=${k}><dt><kbd>${k}</kbd></dt><dd>${t(label)}</dd></div>`)}</dl>
      <p><button type="button" class="btn" onClick=${onClose}>${t('ws.act.cancel')}</button></p>
    <//>`;
}

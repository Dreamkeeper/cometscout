// The transcription dialog: upload a recording (POST /api/transcribe/upload, streamed to the server's disk) and the
// queue (GET /api/transcribe): waiting, running, failed, and the latest transcripts with their files. While anything
// waits or runs it asks again every 5 seconds. A transcript with separated speakers has a small form to name them
// (POST /api/transcribe/rename), which writes its md and srt again.
import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { ACCEPT, uploadProblem, length, busyQueue, mb, renames } from '../lib/transcribe.js';
import { Modal } from './Actions.js';

/** The names of one transcript's speakers: an input per speaker, saved together. */
function SpeakerNames({ t, api, item, onSaved, onError }) {
  const [names, setNames] = useState(() => Object.fromEntries(item.speakers.map(x => [x.label, x.name])));
  const [busy, setBusy] = useState(false);
  const changed = renames(item.speakers, names);
  const save = async () => {
    if (busy || !Object.keys(changed).length) return;
    setBusy(true);
    try { const r = await api.renameSpeakers(item.dir, changed); onSaved(r); } catch (e) { onError(e.message); } finally { setBusy(false); }
  };
  return html`
    <details class="tr-speakers"><summary class="small">${t('ws.tr.speakers')}: ${item.speakers.map(x => x.name).join(', ')}</summary>
      <div class="choices-row">
        ${item.speakers.map(x => html`<label key=${x.label} class="small">${x.label}${x.me ? ` (${t('ws.tr.me_hint')})` : ''}
          <input type="text" maxlength="40" value=${names[x.label] ?? ''} disabled=${busy} onInput=${e => setNames({ ...names, [x.label]: e.currentTarget.value })} /></label>`)}
        <button type="button" class="btn" disabled=${busy || !Object.keys(changed).length} onClick=${save}>${t('ws.tr.rename')}</button>
      </div>
    </details>`;
}

export function TranscribeDialog({ t, api, onClose }) {
  const [status, setStatus] = useState(null);
  const [file, setFile] = useState(null);
  const [note, setNote] = useState(null);       // { text, error }
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const load = () => api.transcribe().then(setStatus).catch(e => setNote({ text: e.message, error: true }));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!busyQueue(status)) return undefined; const id = setTimeout(load, 5000); return () => clearTimeout(id); }, [status]);
  const problem = uploadProblem(file, status);
  const upload = async () => {
    if (!file || problem || busy) return;
    setBusy(true); setNote({ text: t('ws.tr.uploading', { name: file.name }) });
    try {
      const r = await api.uploadAudio(file);
      setNote({ text: t('ws.tr.uploaded', { name: r.name }) }); setStatus(r.status); setFile(null);
      if (input.current) input.current.value = '';
    } catch (e) { setNote({ text: e.message, error: true }); } finally { setBusy(false); }
  };
  const time = iso => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  return html`
    <${Modal} title=${t('ws.tr.title')} onClose=${onClose}>
      ${status && html`<p class="muted small">${t('ws.tr.note', { mb: status.max_upload_mb })}${status.speakers ? '' : ` ${t('ws.tr.speakers_off')}`}</p>`}
      ${status && !status.installed && html`<p class="inline-error">${t('ws.tr.not_installed')}</p>`}
      <p class="choices-row">
        <input type="file" ref=${input} accept=${ACCEPT} disabled=${busy} onChange=${e => { setFile(e.currentTarget.files?.[0] || null); setNote(null); }} />
        <button type="button" class="btn btn-primary" disabled=${!file || !!problem || busy || !status} onClick=${upload}>${t('ws.tr.upload')}</button>
      </p>
      ${problem && html`<p class="inline-error">${t(problem.key, problem.vars)}</p>`}
      ${note && html`<p class=${note.error ? 'inline-error' : 'muted'} role="status">${note.text}</p>`}
      ${status && html`
        <div class="tr-queue">
          ${status.running && html`<p><strong>${t('ws.tr.running')}:</strong> ${status.running.name} <span class="muted small">${t('ws.tr.since', { time: time(status.running.started) })}</span></p>`}
          ${status.waiting.length > 0 && html`<h4>${t('ws.tr.waiting', { n: status.waiting.length })}</h4>
            <ul>${status.waiting.map(w => html`<li key=${w.name}>${w.name} <span class="muted small">${mb(w.size)} MB</span></li>`)}</ul>`}
          ${status.failed.length > 0 && html`<h4>${t('ws.tr.failed', { n: status.failed.length })}</h4>
            <ul>${status.failed.map(f => html`<li key=${f.name}>${f.name} <span class="inline-error small">${f.error}</span></li>`)}</ul>`}
          ${status.done.length > 0 && html`<h4>${t('ws.tr.done')}</h4>
            <ul>${status.done.map(d => html`<li key=${d.dir}>${d.name} <span class="muted small">${[length(d.duration), d.language, d.at].filter(Boolean).join(', ')}</span>
              ${d.files.map(f => html` <a key=${f.name} href=${f.url} target="_blank" rel="noopener">${f.name.replace(/^transcript\./, '')}</a>`)}
              ${d.speakers && d.speakers.length > 0 && html`<${SpeakerNames} key=${`${d.dir}:${d.speakers.map(x => x.name).join('|')}`} t=${t} api=${api} item=${d}
                onSaved=${r => { setStatus(r.status); setNote({ text: t('ws.tr.renamed', { dir: r.dir }) }); }} onError=${text => setNote({ text, error: true })} />`}</li>`)}</ul>`}
          ${!status.running && !status.waiting.length && !status.failed.length && !status.done.length && html`<p class="muted">${t('ws.tr.empty')}</p>`}
        </div>`}
      <p><button type="button" class="btn" onClick=${onClose}>${t('ws.tr.close')}</button></p>
    <//>`;
}

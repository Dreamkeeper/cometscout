// The labelling screen (/label?set=<name>): one sampled job at a time, as the decoder saw it, with no verdict, gate or
// decoder note anywhere on the page. Yes / No / Unsure, a one-line reason (needed for Unsure), keys Y N U, Enter, arrows.
// Each save appends a line on the server (evals/sets.mjs); the screen opens at the first job without a label.
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { makeT } from '../lib/labels.js';
import { labelKey, canSave, afterSave, progress, step, rubricBlocks, SURFACES } from '../lib/label.js';

const RUBRIC_KEY = 'cometscout.label.rubric';
const load = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not remembered */ } };
const EMPTY = { surface: null, reason: '', failure_mode: '' };
const fmName = (id, t) => { const k = id === 'missing_info' ? 'ws.label.fm.missing_info' : `ws.skip.${id}`; const s = t(k); return s === k ? id : s; };

function SetList({ t, sets }) {
  return html`
    <main class="label-main">
      <h2 class="label-h">${t('ws.label.sets')}</h2>
      ${sets.length ? html`<ul class="label-sets">${sets.map(s => html`<li key=${s.name}><a href=${`/label?set=${encodeURIComponent(s.name)}`}>${t('ws.label.set_line', { name: s.name, n: s.labelled, total: s.total })}</a></li>`)}</ul>`
        : html`<p class="muted">${t('ws.label.no_sets')}</p>`}
    </main>`;
}

export function LabelApp({ api, set }) {
  const [labels, setLabels] = useState({ locale: 'en', labels: {} });
  const t = useMemo(() => makeT(labels.labels), [labels]);
  const [data, setData] = useState(null);       // GET /api/label
  const [index, setIndex] = useState(0);
  const [jobs, setJobs] = useState({});         // file -> job | { error }
  const [draft, setDraft] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [rubricOpen, setRubricOpen] = useState(() => load(RUBRIC_KEY) ?? matchMedia('(min-width: 761px)').matches);   // closed by default on a phone, where it sits below the job
  const reasonRef = useRef(null);

  useEffect(() => {
    Promise.all([api.labels(), api.labelSet(set)]).then(([l, d]) => {
      setLabels(l); setData(d); if (d.files) setIndex(d.resume || 0);
      document.title = `CometScout: ${makeT(l.labels)('ws.label.title')}${set ? ` · ${set}` : ''}`;
    }).catch(e => setError(e.message));
  }, []);

  const file = data?.files?.[index] || null, job = file ? jobs[file] : null;
  // the shown job loads once; its saved label, if any, fills the form
  useEffect(() => {
    if (!file) return;
    const l = data.labels[file]; setDraft(l ? { surface: l.surface, reason: l.reason || '', failure_mode: l.failure_mode || '' } : EMPTY);
    if (!jobs[file]) api.labelJob(set, file).then(j => setJobs(c => ({ ...c, [file]: j }))).catch(e => setJobs(c => ({ ...c, [file]: { error: e.message } })));
    window.scrollTo(0, 0);
  }, [file]);

  const p = data?.files ? progress(data.files, data.labels) : null;
  const ok = canSave(draft.surface, draft.reason);
  const move = by => setIndex(i => step(data.files, i, by));
  const submit = async () => {
    if (!file || busy) return;
    if (!ok) { if (draft.surface === 'unsure') reasonRef.current?.focus(); return; }
    setBusy(true);
    try {
      const r = await api.saveLabel(set, file, draft.surface, draft.reason, draft.surface === 'no' ? draft.failure_mode : '');
      const next = { ...data.labels, [file]: { surface: r.label.surface, reason: r.label.reason, failure_mode: r.label.failure_mode || null, labelled_at: r.label.labelled_at } };
      setData({ ...data, labels: next, labelled: r.labelled });
      setIndex(afterSave(data.files, next, index));
      if (document.activeElement?.tagName === 'INPUT') document.activeElement.blur();   // so Y, N and U choose again on the next job
      setToast(t('ws.label.saved', { surface: t(`ws.label.${r.label.surface}`) })); setTimeout(() => setToast(null), 1500);
      setError(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // keyboard: the handler reads the latest state through a ref
  const keys = useRef(null);
  keys.current = e => {
    if (!file) return;
    const r = labelKey({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, tag: e.target?.tagName, role: e.target?.getAttribute?.('role') });
    if (!r) return;
    if (r.action === 'blur') { e.target?.blur?.(); return; }
    e.preventDefault();
    if (r.action === 'choose') { setDraft(d => ({ ...d, surface: r.surface })); if (r.surface === 'unsure') setTimeout(() => reasonRef.current?.focus(), 0); return; }
    if (r.action === 'save') return submit();
    if (r.action === 'next' || r.action === 'prev') move(r.action === 'next' ? 1 : -1);
  };
  useEffect(() => { const h = e => keys.current(e); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);

  const toggleRubric = e => { const open = e.currentTarget.open; setRubricOpen(open); save(RUBRIC_KEY, open); };
  const current = file && data.labels[file];
  return html`
    <div class="app label-app">
      <header class="top">
        <span class="brand">CometScout</span>
        <span class="title">${t('ws.label.title')}${set ? ` · ${set}` : ''}${p ? ` · ${t('ws.label.progress', { n: Math.min(index + 1, p.total), total: p.total })}` : ''}</span>
        ${p && html`<span class="muted small">${t('ws.label.labelled', { n: p.done })}</span>`}
        <a class="btn btn-small" href="/">${t('ws.label.today')}</a>
      </header>
      ${error && html`<div class="banner" role="alert">${t('ws.error', { error })}</div>`}
      ${!data && !error && html`<p class="loading center">${t('ws.loading')}</p>`}
      ${data?.sets && html`<${SetList} t=${t} sets=${data.sets} />`}
      ${data?.files && html`
        <main class="label-main">
          <p class="label-note">${t('ws.label.focus')}</p>
          ${p.done === p.total && html`<p class="notice">${t('ws.label.done', { set })}</p>`}
          <div class="label-grid">
            <article class="label-job pane">
              ${!job && html`<p class="loading">${t('ws.loading')}</p>`}
              ${job?.error && html`<p class="inline-error">${t('ws.error', { error: job.error })}</p>`}
              ${job && !job.error && html`
                <header class="job-head">
                  <h2><span class="company">${job.company}</span></h2>
                  <p class="job-role">${job.role}</p>
                  <p class="job-meta">${[job.location, job.salary].filter(Boolean).join(' · ')}</p>
                  ${job.url && /^https?:/i.test(job.url) && html`<p><a href=${job.url} target="_blank" rel="noopener noreferrer">${t('ws.label.open')}</a></p>`}
                </header>
                <div class="text">${job.text}</div>`}
            </article>
            <aside class="label-side">
              <details class="block rubric" open=${rubricOpen} onToggle=${toggleRubric}>
                <summary>${t('ws.label.rubric')}</summary>
                ${data.rubric ? html`<div class="rubric-text">${rubricBlocks(data.rubric).map((b, i) => (b.kind === 'h' ? html`<h5 key=${i}>${b.text}</h5>` : b.kind === 'li' ? html`<p key=${i} class="li">${b.text}</p>` : html`<p key=${i}>${b.text}</p>`))}</div>`
                  : html`<p class="muted small">${t('ws.label.no_rubric')}</p>`}
              </details>
            </aside>
          </div>
          <section class="label-bar" aria-label=${t('ws.label.question')}>
            <p class="label-q">${t('ws.label.question')}${current ? html` <span class="chip tone-info">${t('ws.label.current', { surface: t(`ws.label.${current.surface}`) })}</span>` : ''}</p>
            <div class="label-choices" role="radiogroup">
              ${SURFACES.map(s => html`<button key=${s} type="button" role="radio" aria-checked=${draft.surface === s} class=${`btn label-${s}${draft.surface === s ? ' on' : ''}`}
                onClick=${() => { setDraft(d => ({ ...d, surface: s })); if (s === 'unsure') setTimeout(() => reasonRef.current?.focus(), 0); }} title=${s[0].toUpperCase()}>${t(`ws.label.${s}`)}</button>`)}
            </div>
            <div class="label-fields">
              <input ref=${reasonRef} class="search" type="text" maxlength="500" value=${draft.reason} placeholder=${t(draft.surface === 'unsure' ? 'ws.label.reason_unsure' : 'ws.label.reason')}
                aria-label=${t(draft.surface === 'unsure' ? 'ws.label.reason_unsure' : 'ws.label.reason')} onInput=${e => setDraft({ ...draft, reason: e.currentTarget.value })} />
              ${draft.surface === 'no' && html`<select value=${draft.failure_mode} aria-label=${t('ws.label.failure')} onChange=${e => setDraft({ ...draft, failure_mode: e.currentTarget.value })}>
                <option value="">${t('ws.label.failure')}</option>
                ${(data.failure_modes || []).map(id => html`<option key=${id} value=${id}>${fmName(id, t)}</option>`)}
              </select>`}
            </div>
            <div class="label-nav">
              <button type="button" class="btn" disabled=${index === 0} onClick=${() => move(-1)}>‹ ${t('ws.label.prev')}</button>
              <button type="button" class="btn" disabled=${index >= p.total - 1} onClick=${() => move(1)}>${t('ws.label.skip')} ›</button>
              <button type="button" class="btn btn-primary" disabled=${!ok || busy} onClick=${submit}>${t('ws.label.save')}</button>
            </div>
            <p class="muted small label-keys">${t('ws.label.keys')}</p>
          </section>
        </main>`}
      ${toast && html`<div class="toast" role="status">${toast}</div>`}
    </div>`;
}

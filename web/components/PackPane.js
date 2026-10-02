// Right pane: the application pack. What to check before sending (flags and lint) first, then the form answers to
// copy, the cover letter, the CV preview (half the pane, larger on demand), the files and the apply link.
import { useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { formatDate, packView } from '../lib/logic.js';

/** Copy to the clipboard; falls back to a hidden textarea where the Clipboard API is missing. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'offscreen';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
export function CopyButton({ t, text }) {
  const [copied, setCopied] = useState(false);
  const click = async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } };
  return html`<button type="button" class="btn btn-small" onClick=${click}>${copied ? t('ws.pack.copied') : t('ws.pack.copy')}</button>`;
}

export function PackPane({ t, locale, item, job, pack, error, showPdf = true }) {
  const [big, setBig] = useState(false);
  if (!item) return null;
  const url = item.url || job?.fm?.url || '';
  const apply = url && html`<p class="apply"><a class="btn btn-primary" href=${url} target="_blank" rel="noopener noreferrer">${t('ws.pack.apply')}</a> <span class="muted url">${url}</span></p>`;
  if (error) return html`<div class="pack"><p class="inline-error">${t('ws.error', { error })}</p></div>`;
  if (pack === undefined) return html`<div class="pack"><p class="loading">${t('ws.loading')}</p></div>`;
  const v = packView(pack);
  if (!v) return html`<div class="pack"><p class="pane-empty">${t('ws.pack.none')}</p>${apply}</div>`;
  const where = h => (h.kind === 'cv' ? t('ws.pack.cv') : h.kind === 'cover_letter' ? t('ws.pack.cover_letter') : h.field);
  const cl = pack.cover_letter || {};
  const clFiles = pack.files.filter(f => / CL - /.test(f.name));
  const warn = (v.flags && v.flags.length) || (v.hits && v.hits.length);
  return html`
    <div class="pack">
      ${v.fromMd && html`<p class="notice">${t('ws.pack.from_md')}</p>`}
      <section class=${`block ${warn ? 'warn' : ''}`}>
        <h4>${t('ws.pack.check')}</h4>
        ${v.flags == null ? html`<p class="muted">${t('ws.pack.check_unknown')}</p>`
          : v.flags.length ? html`<ul class="bullets">${v.flags.map((f, i) => html`<li key=${i}>${f}</li>`)}</ul>` : html`<p class="muted">${t('ws.pack.nothing_flagged')}</p>`}
        <h5>${t('ws.pack.lint')}</h5>
        ${v.hits == null ? html`<p class="muted">${t('ws.pack.lint_unknown')}</p>`
          : v.hits.length ? html`<ul class="bullets lint">${v.hits.map((h, i) => html`<li key=${i} class=${`lint-${h.level}`}><code>${h.id}</code> ${where(h)}: "${h.match}"${h.why ? ` (${h.why})` : ''}</li>`)}</ul>`
          : html`<p class="muted">${t('ws.pack.lint_clean')}</p>`}
      </section>
      <section class="block">
        <h4>${t('ws.pack.answers')}</h4>
        ${v.answers == null ? null : v.answers.length ? v.answers.map((a, i) => html`
          <div key=${i} class="answer">
            <div class="answer-head">${a.field && html`<strong>${a.field}</strong>`}${a.own_words && html` <span class="tag tag-later">${t('ws.pack.own_words')}</span>`} <${CopyButton} t=${t} text=${a.answer} /></div>
            <p class="answer-text">${a.answer}</p>
            ${a.note && html`<p class="muted small">${a.note}</p>`}
          </div>`) : html`<p class="muted">${t('ws.pack.no_answers')}</p>`}
        ${v.fromMd && html`<details class="raw" open=${v.answers == null}><summary>${t('ws.pack.raw')}</summary><div class="text">${pack.answers}</div></details>`}
      </section>
      <section class="block">
        <h4>${t('ws.pack.cover_letter')} ${cl.text && html`<${CopyButton} t=${t} text=${cl.text} />`}</h4>
        ${cl.text ? html`<p class="answer-text">${cl.text}</p>`
          : clFiles.length ? html`<p>${clFiles.map(f => html`<a key=${f.name} href=${f.url} target="_blank" rel="noopener">${f.name}</a> `)}</p>`
          : html`<p class="muted">${cl.mode && cl.mode !== 'no' ? t('ws.pack.cl_file') : t('ws.pack.cl_none')}</p>`}
      </section>
      <section class="block cv">
        <h4>${t('ws.pack.cv')} <span class="muted">${v.built ? t('ws.pack.built', { date: formatDate(v.built.slice(0, 10), locale) }) : ''}</span>
          ${pack.cv_pdf && showPdf && html`<button type="button" class="btn btn-small" aria-pressed=${big} onClick=${() => setBig(!big)}>${big ? t('ws.pack.shrink') : t('ws.pack.expand')}</button>`}</h4>
        ${v.positioning && html`<p><strong>${t('ws.pack.leads_with')}:</strong> ${v.positioning}</p>`}
        ${pack.cv_pdf && showPdf && html`<iframe class=${`pdf${big ? ' pdf-big' : ''}`} src=${`${pack.cv_pdf}#navpanes=0&view=FitH`} title=${t('ws.pack.cv')}></iframe>`}
        ${pack.cv_pdf && html`<p><a href=${pack.cv_pdf} target="_blank" rel="noopener">${t('ws.pack.open_pdf')}</a></p>`}
      </section>
      <section class="block">
        <h4>${t('ws.pack.files')}</h4>
        <ul class="files">${pack.files.map(f => html`<li key=${f.name}><a href=${f.url} target="_blank" rel="noopener">${f.name}</a></li>`)}</ul>
      </section>
      ${apply}
    </div>`;
}

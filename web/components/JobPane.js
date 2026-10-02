// Middle pane: the job as the decoder judged it, then its history and its text.
import { html } from '../lib/html.js';
import { verdictName, verdictTone, statusName, formatDate, isLater, bodyText } from '../lib/logic.js';

const Section = ({ title, children, cls = '' }) => html`<section class=${`block ${cls}`}><h4>${title}</h4>${children}</section>`;
const Bullets = ({ items }) => html`<ul class="bullets">${items.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul>`;

export function JobHeader({ t, locale, item, date }) {
  if (!item) return null;
  const meta = [item.location, item.source && t('picks.via', { source: item.source }), item.band != null && t('ws.band', { n: item.band }),
    item.decoded_on && t('ws.decoded_on', { date: formatDate(item.decoded_on, locale) }), item.shown ? t('ws.shown', { n: item.shown }) : null].filter(Boolean);
  return html`
    <header class="job-head">
      <h2><span class="company">${item.company}</span></h2>
      <p class="job-role">${item.role}</p>
      <p class="job-meta">${meta.join(' · ')}</p>
      <p class="chips">
        ${item.verdict && html`<span class=${`chip tone-${verdictTone(item.verdict)}`}>${verdictName(item.verdict, t)}</span>`}
        ${item.apply_priority != null && html`<span class="chip">${t('ws.priority', { n: item.apply_priority })}</span>`}
        ${item.application?.status && html`<span class="chip tone-info">${t('ws.recorded', { status: statusName(item.application.status, t), date: formatDate(item.application.updated, locale) })}</span>`}
        ${isLater(item, date) && html`<span class="chip tone-warn">${t('ws.later_until', { date: formatDate(item.later_until, locale) })}</span>`}
      </p>
    </header>`;
}

export function JobPane({ t, locale, item, date, job, error, textOpen, setTextOpen, showHeader = true }) {
  if (!item) return html`<div class="pane-empty">${t('ws.select')}</div>`;
  const d = job?.decode;
  return html`
    <article class="job">
      ${showHeader && html`<${JobHeader} t=${t} locale=${locale} item=${item} date=${date} />`}
      ${error && html`<p class="inline-error">${t('ws.error', { error })}</p>`}
      ${!job && !error && html`<p class="loading">${t('ws.loading')}</p>`}
      ${d && html`
        ${d.action && html`<p class="action-line"><strong>${t('ws.action')}:</strong> ${d.action}</p>`}
        ${d.rationale && html`<${Section} title=${t('ws.rationale')}><p>${d.rationale}</p><//>`}
        ${d.fit_signals?.length > 0 && html`<${Section} title=${t('ws.fit_signals')} cls="good"><${Bullets} items=${d.fit_signals} /><//>`}
        ${d.gaps?.length > 0 && html`<${Section} title=${t('ws.gaps')} cls="warn"><${Bullets} items=${d.gaps} /><//>`}
        ${d.hold_reason && html`<${Section} title=${t('ws.hold_reason')}><p>${d.hold_reason}</p><//>`}
        ${d.fact_flags?.length > 0 && html`<${Section} title=${t('ws.fact_flags')} cls="bad"><${Bullets} items=${d.fact_flags.map(f => (f.why ? `${f.why} (${f.id})` : f.id))} /><//>`}
        <${Section} title=${t('ws.history')}>
          ${job.history.length ? html`<${Bullets} items=${job.history} />` : html`<p class="muted">${t('ws.no_history')}</p>`}
        <//>
        <details class="block job-text" open=${textOpen} onToggle=${e => setTextOpen(e.currentTarget.open)}>
          <summary>${t('ws.job_text')}</summary>
          <div class="text">${bodyText(job.text)}</div>
        </details>`}
    </article>`;
}

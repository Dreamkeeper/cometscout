// Left pane: search, filters, today's picks, then the pool grouped by verdict.
import { useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { verdictName, verdictTone, statusName, formatDate, isLater, optionsOf } from '../lib/logic.js';

function Filters({ t, today, filters, setFilters, searchRef }) {
  const set = patch => setFilters({ ...filters, ...patch });
  const sources = optionsOf(today, 'source'), verdicts = optionsOf(today, 'verdict');
  return html`
    <div class="filters">
      <input ref=${searchRef} type="search" class="search" placeholder=${t('ws.search')} aria-label=${t('ws.search')}
        value=${filters.q} onInput=${e => set({ q: e.currentTarget.value })} />
      <div class="filter-row">
        <select aria-label=${t('ws.filter.source')} value=${filters.source} onChange=${e => set({ source: e.currentTarget.value })}>
          <option value="">${t('ws.filter.source')}: ${t('ws.filter.all')}</option>
          ${sources.map(s => html`<option key=${s} value=${s}>${s}</option>`)}
        </select>
        <select aria-label=${t('ws.filter.verdict')} value=${filters.verdict} onChange=${e => set({ verdict: e.currentTarget.value })}>
          <option value="">${t('ws.filter.verdict')}: ${t('ws.filter.all')}</option>
          ${verdicts.map(v => html`<option key=${v} value=${v}>${verdictName(v, t)}</option>`)}
        </select>
      </div>
      <div class="filter-row checks">
        <label><input type="checkbox" checked=${filters.hasPack} onChange=${e => set({ hasPack: e.currentTarget.checked })} /> ${t('ws.filter.has_pack')}</label>
        <label><input type="checkbox" checked=${filters.hideLater} onChange=${e => set({ hideLater: e.currentTarget.checked })} /> ${t('ws.filter.hide_later')}</label>
      </div>
    </div>`;
}

function Item({ t, locale, item, date, selected, onSelect }) {
  const ref = useRef(null);
  useEffect(() => { if (selected && ref.current?.scrollIntoView) ref.current.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const done = item.application?.status;
  return html`
    <li>
      <button ref=${ref} type="button" class=${`item${selected ? ' selected' : ''}${done ? ' done' : ''}`} aria-current=${selected ? 'true' : undefined} onClick=${() => onSelect(item.file)}>
        <span class="item-top">
          <span class="company">${item.company}</span>
          ${item.apply_priority != null && html`<span class="prio" title=${t('ws.priority', { n: item.apply_priority })}>p${item.apply_priority}</span>`}
        </span>
        <span class="role">${item.role}</span>
        <span class="item-meta">
          <span class=${`dot tone-${verdictTone(item.verdict)}`} aria-hidden="true"></span>
          <span class="loc">${item.location || item.source}</span>
          ${item.pack && html`<span class="tag">${t('ws.tab.pack')}</span>`}
          ${done && html`<span class="tag tag-status">${statusName(done, t)}</span>`}
          ${isLater(item, date) && html`<span class="tag tag-later">${t('ws.later_until', { date: formatDate(item.later_until, locale) })}</span>`}
        </span>
      </button>
    </li>`;
}

export function List({ t, locale, today, groups, selected, onSelect, filters, setFilters, searchRef }) {
  const date = today?.date || '';
  const total = (today?.picks?.length || 0) + (today?.pool?.length || 0);
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  return html`
    <nav class="list" aria-label=${t('ws.title')}>
      <${Filters} t=${t} today=${today} filters=${filters} setFilters=${setFilters} searchRef=${searchRef} />
      ${today && !today.picks.length && total > 0 && html`<p class="notice">${t('ws.empty', { open: today.pool.length })}</p>`}
      ${today && total === 0 && html`<p class="empty">${t('ws.empty_all')}</p>`}
      ${today && total > 0 && shown === 0 && html`<p class="empty">${t('ws.no_match')}</p>`}
      ${groups.map(g => html`
        <section key=${g.key} class="group">
          <h3 class="group-title">${g.kind === 'picks' ? t('ws.picks', { n: g.items.length }) : `${verdictName(g.verdict, t)} (${g.items.length})`}</h3>
          <ul>
            ${g.items.map(i => html`<${Item} key=${i.file} t=${t} locale=${locale} item=${i} date=${date} selected=${i.file === selected} onSelect=${onSelect} />`)}
          </ul>
        </section>`)}
    </nav>`;
}

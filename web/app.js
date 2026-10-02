// The Today screen. Desktop (>= 1100 px): list, job and pack side by side. Narrower: the list, then one job with
// tabs Job / Pack and a fixed action bar. State lives here; the panes are in components/, the logic in lib/.
import { render } from 'preact';
import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks';
import { html } from './lib/html.js';
import { createApi } from './lib/api.js';
import { makeT } from './lib/labels.js';
import { keyAction } from './lib/keys.js';
import { DEFAULT_FILTERS, groupItems, order, stepFile, nextAfterAction, findItem, skipNote, statusName, formatDate, SKIP_REASONS } from './lib/logic.js';
import { List } from './components/List.js';
import { JobPane, JobHeader } from './components/JobPane.js';
import { PackPane } from './components/PackPane.js';
import { ActionBar, SkipDialog, LaterDialog, HelpDialog } from './components/Actions.js';

const api = createApi();
const FILTERS_KEY = 'jobpilot.workspace.filters';
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? { ...d, ...v } : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: not remembered */ } };

function useLayout() {
  const get = () => (matchMedia('(min-width: 1100px)').matches ? 'wide' : matchMedia('(min-width: 720px)').matches ? 'medium' : 'narrow');
  const [layout, setLayout] = useState(get);
  useEffect(() => {
    const qs = ['(min-width: 1100px)', '(min-width: 720px)'].map(q => matchMedia(q));
    const on = () => setLayout(get());
    qs.forEach(q => q.addEventListener('change', on));
    return () => qs.forEach(q => q.removeEventListener('change', on));
  }, []);
  return layout;
}

function App() {
  const layout = useLayout();
  const [labels, setLabels] = useState({ locale: 'en', labels: {} });
  const t = useMemo(() => makeT(labels.labels), [labels]);
  const locale = labels.locale;
  const [today, setToday] = useState(null);
  const [error, setError] = useState(null);
  const [filters, setFiltersState] = useState(() => load(FILTERS_KEY, DEFAULT_FILTERS));
  const setFilters = f => { setFiltersState(f); save(FILTERS_KEY, f); };
  const [selected, setSelected] = useState(null);
  const [jobs, setJobs] = useState({});      // file -> { data } | { error }
  const [packs, setPacks] = useState({});    // file -> { data: pack | null } | { error }
  const [dialog, setDialog] = useState(null);
  const [tab, setTab] = useState('job');
  const [detail, setDetail] = useState(false);  // narrow screens: the job is open instead of the list
  const [textOpen, setTextOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const searchRef = useRef(null);

  const groups = useMemo(() => groupItems(today, filters), [today, filters]);
  const files = useMemo(() => order(groups), [groups]);
  const item = findItem(today, selected);

  const refresh = useCallback(async () => {
    try {
      const [l, d] = await Promise.all([api.labels(), api.today()]);
      setLabels(l); setToday(d); setError(null); document.title = `jobpilot: ${makeT(l.labels)('ws.title')}`;
      return d;
    } catch (e) { setError(e.message); return null; }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // The first job opens by itself where there is room for it.
  useEffect(() => { if (layout !== 'narrow' && !selected && files.length) setSelected(files[0]); }, [layout, files, selected]);

  // Load the selected job's decode and pack once; an action clears them so they load fresh.
  useEffect(() => {
    if (!selected) return;
    if (!jobs[selected]) api.job(selected).then(d => setJobs(j => ({ ...j, [selected]: { data: d } }))).catch(e => setJobs(j => ({ ...j, [selected]: { error: e.message } })));
    if (!packs[selected]) api.pack(selected).then(d => setPacks(p => ({ ...p, [selected]: { data: d } }))).catch(e => setPacks(p => ({ ...p, [selected]: { error: e.message } })));
  }, [selected]);

  const select = file => { setSelected(file); setTab('job'); if (layout === 'narrow') { setDetail(true); window.scrollTo(0, 0); } };

  const act = async (kind, arg) => {
    if (!item || busy) return;
    const file = item.file, before = files;
    setBusy(true); setDialog(null);
    try {
      let what;
      if (kind === 'applied') { await api.status(file, 'applied'); what = statusName('applied', t); }
      else if (kind === 'skip') { await api.status(file, 'skipped', arg); what = statusName('skipped', t); }
      else { const r = await api.later(file, arg); what = t('ws.later_until', { date: formatDate(r.later_until, locale) }); }
      setJobs(j => { const n = { ...j }; delete n[file]; return n; });
      const fresh = await api.today();
      if (fresh) {
        setToday(fresh);
        const next = nextAfterAction(before, file, order(groupItems(fresh, filters)));
        setSelected(next); setTab('job');
        if (layout === 'narrow' && !next) setDetail(false);
      }
      setToast(`${item.company}: ${what}`); setTimeout(() => setToast(null), 2500);
      setError(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const openLink = () => { if (item?.url) window.open(item.url, '_blank', 'noopener,noreferrer'); };

  // Keyboard (desktop): the handler reads the latest state through a ref.
  const keys = useRef(null);
  keys.current = e => {
    const r = keyAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, tag: e.target?.tagName, editable: e.target?.isContentEditable }, dialog || 'main', { reasons: SKIP_REASONS.length });
    if (!r) return;
    if (r.action === 'close') { if (dialog) setDialog(null); else if (e.target?.blur) e.target.blur(); return; }
    e.preventDefault();
    if (r.action === 'skip-reason') return act('skip', skipNote(SKIP_REASONS[r.index].id));
    if (r.action === 'later-days') return act('later', r.days);
    if (r.action === 'next' || r.action === 'prev') { const f = stepFile(files, selected, r.action === 'next' ? 1 : -1); if (f) select(f); return; }
    if (r.action === 'search') { if (layout === 'narrow') setDetail(false); setTimeout(() => searchRef.current?.focus(), 0); return; }
    if (r.action === 'help') return setDialog('help');
    if (!item) return;
    if (r.action === 'applied') return act('applied');
    if (r.action === 'skip') return setDialog('skip');
    if (r.action === 'later') return setDialog('later');
    if (r.action === 'open') return openLink();
  };
  useEffect(() => { const h = e => keys.current(e); document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);

  const job = jobs[selected], pack = packs[selected];
  const jobPane = (header = true) => html`<${JobPane} t=${t} locale=${locale} item=${item} date=${today?.date} job=${job?.data} error=${job?.error} textOpen=${textOpen} setTextOpen=${setTextOpen} showHeader=${header} />`;
  const packPane = (pdf = true) => html`<${PackPane} t=${t} locale=${locale} item=${item} job=${job?.data} pack=${pack ? pack.data : undefined} error=${pack?.error} showPdf=${pdf} />`;
  const bar = html`<${ActionBar} t=${t} item=${item} busy=${busy} onApplied=${() => act('applied')} onSkip=${() => setDialog('skip')} onLater=${() => setDialog('later')} onOpen=${openLink} />`;
  const list = html`<${List} t=${t} locale=${locale} today=${today} groups=${groups} selected=${selected} onSelect=${select} filters=${filters} setFilters=${setFilters} searchRef=${searchRef} />`;
  const tabs = html`
    <div class="tabs" role="tablist">
      ${layout === 'narrow' && html`<button type="button" class="tab back" onClick=${() => setDetail(false)}>‹ ${t('ws.back')}</button>`}
      ${['job', 'pack'].map(k => html`<button key=${k} type="button" role="tab" aria-selected=${tab === k} class=${`tab${tab === k ? ' active' : ''}`} onClick=${() => setTab(k)}>${t(`ws.tab.${k}`)}</button>`)}
    </div>`;
  const tabbed = html`
    <section class="pane detail">
      ${item ? html`
        ${tabs}
        <${JobHeader} t=${t} locale=${locale} item=${item} date=${today?.date} />
        ${tab === 'job' ? jobPane(false) : packPane(layout !== 'narrow')}
        <div class="bar-fixed">${bar}</div>` : html`<div class="pane-empty">${t('ws.select')}</div>`}
    </section>`;

  return html`
    <div class=${`app layout-${layout}${layout === 'narrow' ? (detail ? ' show-detail' : ' show-list') : ''}`}>
      <header class="top">
        <span class="brand">jobpilot</span>
        <span class="title">${t('ws.title')}${today?.date ? ` · ${formatDate(today.date, locale)}` : ''}</span>
        <button type="button" class="btn btn-small help-btn" onClick=${() => setDialog('help')} title="?">?</button>
      </header>
      ${error && html`<div class="banner" role="alert">${t('ws.error', { error })} <button type="button" class="btn btn-small" onClick=${refresh}>${t('ws.retry')}</button></div>`}
      ${!today && !error && html`<p class="loading center">${t('ws.loading')}</p>`}
      ${today && html`
        <main class="panes">
          <aside class="pane list-pane">${list}</aside>
          ${layout === 'wide' ? html`
            <section class="pane job-pane">${item && html`<div class="bar-top">${bar}</div>`}${jobPane(true)}</section>
            <section class="pane pack-pane">${packPane(true)}</section>` : tabbed}
        </main>`}
      ${toast && html`<div class="toast" role="status">${toast}</div>`}
      ${dialog === 'skip' && html`<${SkipDialog} t=${t} onPick=${(id, note) => act('skip', skipNote(id, note))} onClose=${() => setDialog(null)} />`}
      ${dialog === 'later' && html`<${LaterDialog} t=${t} onPick=${d => act('later', d)} onClose=${() => setDialog(null)} />`}
      ${dialog === 'help' && html`<${HelpDialog} t=${t} onClose=${() => setDialog(null)} />`}
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));

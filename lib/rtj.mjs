// The RealtimeJobs search API (rtj.app): paging, and field names in either style. RTJ renames every field to snake_case
// on 2026-10-17 (page_size, next_cursor, available_at, status_code) and rejects unknown request fields, so a request
// in the wrong style fails with 400. searchAll sends snake_case first; a 400 that names the page-size field switches
// to the old camelCase for the rest of the search. Response fields are read in both styles. fetch is injected in tests.
export const RTJ_SEARCH_URL = 'https://rtj.app/api/jobs/search';
export const MAX_PAGE_SIZE = 250;   // the API's documented maximum

/** The request body in one style: 'snake' (page_size) or 'camel' (pageSize). */
export function searchBody({ after, before, pageSize, cursor }, style = 'snake') {
  return { after, before, [style === 'camel' ? 'pageSize' : 'page_size']: pageSize, ...(cursor ? { cursor } : {}) };
}
/** The next page's cursor in either style; null on the last page. */
export const nextCursorOf = page => page?.next_cursor ?? page?.nextCursor ?? null;
/** A 400 that complains about the page-size field: the API wants the other style. */
export const wrongStyle = (status, text) => status === 400 && /page_?size/i.test(String(text || ''));

/**
 * Every page of one search window: { positions, truncated, style, retried }. Stops after maxPages; truncated says more
 * pages were left. Throws "RTJ <status>: ..." on any other error.
 */
export async function searchAll({ token, after, before, pageSize, maxPages, fetch = globalThis.fetch, url = RTJ_SEARCH_URL, timeoutMs = 60000, log = () => {} }) {
  let style = 'snake', retried = false, cursor = null;
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));
  const once = async () => {
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(searchBody({ after, before, pageSize: size, cursor }, style)) });
    return { r, t: await r.text() };
  };
  const positions = [];
  for (let i = 0; i < maxPages; i++) {
    let { r, t } = await once();
    if (!retried && wrongStyle(r.status, t)) {
      retried = true; style = style === 'snake' ? 'camel' : 'snake';
      log(`rtj: the API asked for the other field-name style; using ${style} case`);
      ({ r, t } = await once());
    }
    if (!r.ok) throw new Error(`RTJ ${r.status}: ${t.slice(0, 200)}`);
    const p = JSON.parse(t);
    positions.push(...(p.positions || []));
    cursor = nextCursorOf(p);
    if (!cursor) break;
  }
  return { positions, truncated: Boolean(cursor), style, retried };
}

/** Ids already queued: { seen } is { id: 'YYYY-MM-DD' }; entries older than keepDays are dropped. */
export function pruneSeen(seen, today, keepDays = 90) {
  const cut = new Date(new Date(`${today}T00:00:00Z`).getTime() - keepDays * 86400e3).toISOString().slice(0, 10);
  return Object.fromEntries(Object.entries(seen || {}).filter(([, d]) => typeof d === 'string' && d >= cut));
}

// The API client. fetch is passed in, so node --test can run it against a fake; no DOM.

/** An API failure: message from the server's { error }, status the HTTP status (0 when the server was unreachable). */
export class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }

export function createApi({ fetch = globalThis.fetch, base = '' } = {}) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(base + path, method === 'GET' ? { headers: { Accept: 'application/json' } }
        : { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CometScout': '1' }, body: JSON.stringify(body) });
    } catch (e) { throw new ApiError(e?.message || 'network error', 0); }
    let data = null; try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, res.status);
    return data;
  }
  const q = file => `?file=${encodeURIComponent(file)}`;
  return {
    today: () => call('GET', '/api/today'),
    labels: () => call('GET', '/api/labels'),
    job: file => call('GET', `/api/job${q(file)}`),
    /** The job's pack: { dir: null, pack: null } when it has none; an unknown job is an error (404). */
    pack: file => call('GET', `/api/pack${q(file)}`),
    status: (file, status, note) => call('POST', '/api/status', { file, status, ...(note ? { note } : {}) }),
    later: (file, days) => call('POST', '/api/later', { file, days }),
    /** A booked interview: date YYYY-MM-DD, time HH:MM and round optional. */
    interview: (file, date, time, round) => call('POST', '/api/interview', { file, date, ...(time ? { time } : {}), ...(round ? { round } : {}) }),
    settings: () => call('GET', '/api/settings'),
    /** { days?, time?, prep_days? } */
    saveSettings: patch => call('POST', '/api/settings', patch),
  };
}

// The API client. fetch is passed in, so node --test can run it against a fake; no DOM.

/** An API failure: message from the server's { error }, status the HTTP status (0 when the server was unreachable). */
export class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }

export function createApi({ fetch = globalThis.fetch, base = '' } = {}) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(base + path, method === 'GET' ? { headers: { Accept: 'application/json' } }
        : { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Jobpilot': '1' }, body: JSON.stringify(body) });
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
    /** The job's pack, or null when it has none (404). */
    pack: file => call('GET', `/api/pack${q(file)}`).catch(e => { if (e.status === 404) return null; throw e; }),
    status: (file, status, note) => call('POST', '/api/status', { file, status, ...(note ? { note } : {}) }),
    later: (file, days) => call('POST', '/api/later', { file, days }),
  };
}

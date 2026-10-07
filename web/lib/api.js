// The API client. fetch is passed in, so node --test can run it against a fake; no DOM.

/** An API failure: message from the server's { error }, status the HTTP status (0 when the server was unreachable). */
export class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }

export function createApi({ fetch = globalThis.fetch, base = '' } = {}) {
  // raw: { body, headers } sent as it is (the audio upload); otherwise body goes as JSON
  async function call(method, path, body, raw = null) {
    let res;
    try {
      res = await fetch(base + path, method === 'GET' ? { headers: { Accept: 'application/json' } }
        : raw ? { method, headers: { Accept: 'application/json', 'X-CometScout': '1', ...raw.headers }, body: raw.body }
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
    /** The last update check: { current, latest, available, skipped, pending, behaviour_changes, highlights } */
    update: () => call('GET', '/api/update'),
    /** action: now, tonight or skip */
    updateAction: (action, version) => call('POST', '/api/update', { action, version }),
    whatsNew: () => call('GET', '/api/whats-new'),
    whatsNewSeen: version => call('POST', '/api/whats-new', { seen: version }),
    /** Label sets ({ sets }) without a name; with one, its files, labels, resume index and rubric. */
    labelSet: set => call('GET', `/api/label${set ? `?set=${encodeURIComponent(set)}` : ''}`),
    /** One job as the labeller sees it: no verdict, gate or decoder notes. */
    labelJob: (set, file) => call('GET', `/api/label/job?set=${encodeURIComponent(set)}&file=${encodeURIComponent(file)}`),
    /** surface: yes, no or unsure; reason required for unsure. */
    saveLabel: (set, file, surface, reason, failure_mode) => call('POST', '/api/label', { set, file, surface, reason: reason || '', ...(failure_mode ? { failure_mode } : {}) }),
    /** The transcription queue: { enabled, installed, max_upload_mb, waiting, running, failed, done } */
    transcribe: () => call('GET', '/api/transcribe'),
    /** A File (or Blob with a name) as the body, streamed by the browser; its name percent-encoded in X-File-Name. */
    uploadAudio: file => call('POST', '/api/transcribe/upload', null, { body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) } }),
  };
}

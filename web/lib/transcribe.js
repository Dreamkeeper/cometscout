// Pure logic for the transcription dialog: what may be uploaded, and the queue in rows. No DOM, so node --test covers it.

// The extensions the server takes (lib/transcribe.mjs AUDIO_EXT); the server checks again.
export const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.opus', '.flac', '.aac', '.wma', '.amr', '.3gp', '.webm', '.mp4', '.mkv', '.mov', '.m4v'];
export const ACCEPT = ['audio/*', 'video/*', ...AUDIO_EXTS].join(',');
const ext = name => { const m = String(name || '').toLowerCase().match(/\.[a-z0-9]+$/); return m ? m[0] : ''; };
/** Bytes as MB with one decimal: 1572864 -> "1.5". */
export const mb = bytes => (Math.round((Number(bytes) || 0) / 104857.6) / 10).toFixed(1);

/** Why this file cannot be sent ({ key, vars } for the label table), or null. status is GET /api/transcribe. */
export function uploadProblem(file, status) {
  if (!file) return null;
  if (!AUDIO_EXTS.includes(ext(file.name))) return { key: 'ws.tr.not_audio', vars: { name: file.name } };
  const max = Number(status?.max_upload_mb) || 0;
  if (max && file.size > max * 1048576) return { key: 'ws.tr.too_big', vars: { name: file.name, size: mb(file.size), mb: max } };
  return null;
}

/** "42:10" or "1:02:05" for a length in seconds; "" when unknown. */
export function length(sec) {
  const s = Math.round(Number(sec));
  if (!Number.isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/**
 * The names to send for a transcript's speakers: { label: name } for each one the user changed (names typed, trimmed),
 * compared with what the server shows now. An emptied field sends '' (back to the label).
 */
export function renames(speakers, typed) {
  const out = {};
  for (const x of speakers || []) {
    const v = String(typed?.[x.label] ?? '').trim();
    if (v !== String(x.name ?? '').trim() && !(v === '' && x.name === x.label)) out[x.label] = v;
  }
  return out;
}

/** True while something is waiting or running: the dialog keeps polling. */
export const busyQueue = status => !!(status?.running || status?.waiting?.length);

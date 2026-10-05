// Small edits to a JSON file the user also edits by hand (settings.json): one value is replaced, added, renamed or
// removed, and every other byte stays as it was, so comments in "_comment" keys, key order and line layout survive.
// The text must be valid JSON; a new value is written on one line ({ "a": 1 }, [1, 2]).

/** The value tree with character spans: { type, start, end, members: [{ key, keyStart, value }] } for objects. */
export function parseSpans(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const fail = m => { throw new Error(`${m} at character ${i}`); };
  const str = () => {
    if (text[i] !== '"') fail('expected a string');
    const s = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('unterminated string');
    return JSON.parse(text.slice(s, ++i));
  };
  function value() {
    ws(); const start = i, c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']', members = []; i++; ws();
      if (text[i] === close) { i++; return { type: c === '{' ? 'object' : 'array', start, end: i, members }; }
      for (;;) {
        ws();
        if (c === '{') { const keyStart = i, key = str(); ws(); if (text[i] !== ':') fail('expected ":"'); i++; members.push({ key, keyStart, value: value() }); }
        else value();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === close) { i++; return { type: c === '{' ? 'object' : 'array', start, end: i, members }; }
        fail(`expected "," or "${close}"`);
      }
    }
    if (c === '"') { str(); return { type: 'string', start, end: i }; }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail('unexpected character');
    i += m[0].length; return { type: 'scalar', start, end: i };
  }
  const root = value(); ws();
  if (i < text.length) fail('unexpected text after the JSON');
  return root;
}

/** A value on one line: { "a": 1, "b": [1, 2] }. */
export const inline = v => (Array.isArray(v) ? `[${v.map(inline).join(', ')}]`
  : v && typeof v === 'object' ? (Object.keys(v).length ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}')
    : JSON.stringify(v));

// JSON.parse keeps the last of duplicate keys; so do these edits.
const member = (obj, key) => { for (let j = obj.members.length - 1; j >= 0; j--) if (obj.members[j].key === key) return { m: obj.members[j], j }; return null; };
function walk(text, keys) {
  let node = parseSpans(text);
  for (let k = 0; k < keys.length - 1; k++) {
    if (node.type !== 'object') return { node: null, missingAt: k };
    const hit = member(node, keys[k]); if (!hit) return { node, missingAt: k };
    node = hit.m.value;
  }
  return node.type === 'object' ? { node, missingAt: keys.length - 1 } : { node: null, missingAt: keys.length - 1 };
}
function insert(text, obj, key, value) {
  const line = `${JSON.stringify(key)}: ${inline(value)}`;
  if (!obj.members.length) return `${text.slice(0, obj.start + 1)} ${line} ${text.slice(obj.end - 1)}`;
  const lead = text.slice(obj.start + 1, obj.members[0].keyStart), last = obj.members[obj.members.length - 1];
  const sep = lead.includes('\n') ? `,\n${lead.slice(lead.lastIndexOf('\n') + 1)}` : ', ';
  return text.slice(0, last.value.end) + sep + line + text.slice(last.value.end);
}

/** Set keys (a path) to value; missing objects on the way are created inside their parent. */
export function setPath(text, keys, value) {
  let node = parseSpans(text);
  for (let k = 0; k < keys.length; k++) {
    if (node.type !== 'object') throw new Error(`${keys.slice(0, k).join('.') || 'the file'} is not an object`);
    const hit = member(node, keys[k]);
    if (!hit) return insert(text, node, keys[k], keys.slice(k + 1).reduceRight((v, x) => ({ [x]: v }), value));
    if (k === keys.length - 1) return text.slice(0, hit.m.value.start) + inline(value) + text.slice(hit.m.value.end);
    node = hit.m.value;
  }
  return text;
}
/** Replace the member at keys with newKey: value, in the same place. Unchanged text when it is missing. */
export function replaceMember(text, keys, newKey, value) {
  const { node, missingAt } = walk(text, keys);
  const hit = node && missingAt === keys.length - 1 ? member(node, keys[keys.length - 1]) : null;
  if (!hit) return text;
  return `${text.slice(0, hit.m.keyStart)}${JSON.stringify(newKey)}: ${inline(value)}${text.slice(hit.m.value.end)}`;
}
/** Remove the member at keys, with its comma. Unchanged text when it is missing. */
export function deletePath(text, keys) {
  const { node, missingAt } = walk(text, keys);
  const hit = node && missingAt === keys.length - 1 ? member(node, keys[keys.length - 1]) : null;
  if (!hit) return text;
  const { m, j } = hit, ms = node.members;
  if (ms.length === 1) return text.slice(0, node.start + 1) + text.slice(node.end - 1).replace(/^\s*/, '');
  if (j > 0) return text.slice(0, ms[j - 1].value.end) + text.slice(m.value.end);
  return text.slice(0, m.keyStart) + text.slice(ms[1].keyStart);
}

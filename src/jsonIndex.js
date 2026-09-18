export const DEFAULTS = {
  maxKeys: 3000,
  maxDepth: 12,
  sampleItems: 3,
  sampleChars: 200,
  maxParseBytes: 24 * 1024 * 1024,
  maxNdjsonLines: 200,
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function sampleOf(v, sampleChars) {
  const t = typeOf(v);
  if (t === 'object') return `keys=${Object.keys(v).length}`;
  if (t === 'array') return `len=${v.length}`;
  const s = String(v);
  return s.length > sampleChars ? s.slice(0, sampleChars) + '…' : s;
}

export function flattenJson(value, opts = {}) {
  const { maxKeys, maxDepth, sampleItems, sampleChars } = { ...DEFAULTS, ...opts };
  const keys = [];
  const seen = new Set();
  let maxSeenDepth = 0;
  let truncated = false;

  function walk(node, pathStr, depth) {
    if (keys.length >= maxKeys) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    maxSeenDepth = Math.max(maxSeenDepth, depth);
    const t = typeOf(node);

    if (t === 'array') {
      if (node.length > sampleItems) truncated = true;
      for (const item of node.slice(0, sampleItems)) walk(item, pathStr + '[]', depth + 1);
      if (!node.length && pathStr) {
        const dedupeKey = `${pathStr}[]|empty`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          keys.push({ key_path: `${pathStr}[]`, leaf: '[]', value_type: 'empty', sample: 'len=0' });
        }
      }
      return;
    }
    if (t === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (keys.length >= maxKeys) {
          truncated = true;
          return;
        }
        const p = pathStr ? `${pathStr}.${k}` : k;
        const vt = typeOf(v);
        const dedupeKey = `${p}|${vt}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          keys.push({ key_path: p, leaf: k, value_type: vt, sample: sampleOf(v, sampleChars) });
        }
        if (vt === 'object' || vt === 'array') walk(v, p, depth + 1);
      }
      return;
    }
    if (!pathStr) keys.push({ key_path: '$', leaf: '$', value_type: t, sample: sampleOf(node, sampleChars) });
  }

  walk(value, '', 0);
  return { keys, depth: maxSeenDepth, rootType: typeOf(value), truncated };
}

function tryParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

export function parsePayload(text, contentType = '', opts = {}) {
  const { maxParseBytes, maxNdjsonLines } = { ...DEFAULTS, ...opts };
  if (typeof text !== 'string' || !text.trim()) return null;
  if (text.length > maxParseBytes) return null;
  const ct = String(contentType).toLowerCase();

  if (ct.includes('x-www-form-urlencoded')) {
    const obj = {};
    for (const [k, v] of new URLSearchParams(text)) obj[k] = v;
    return Object.keys(obj).length ? obj : null;
  }

  const trimmed = text.trim();

  if (/^[[{]/.test(trimmed) || ct.includes('json')) {
    const r = tryParse(trimmed);
    if (r.ok) return r.value;
  }

  const guard = trimmed.match(/^\)\]\}'?,?\s*([[{][\s\S]*)$/);
  if (guard) {
    const r = tryParse(guard[1]);
    if (r.ok) return r.value;
  }

  if (/^for\s*\(\s*;;\s*\)\s*;/.test(trimmed)) {
    const r = tryParse(trimmed.replace(/^for\s*\(\s*;;\s*\)\s*;/, '').trim());
    if (r.ok) return r.value;
  }

  const jsonp = trimmed.match(/^[\w$.[\]'"]{1,80}\s*\(\s*([[{][\s\S]*[}\]])\s*\)\s*;?$/);
  if (jsonp) {
    const r = tryParse(jsonp[1]);
    if (r.ok) return r.value;
  }

  if (/^data:/m.test(trimmed)) {
    const joined = trimmed
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (joined) {
      const r = tryParse(joined);
      if (r.ok) return r.value;
    }
  }

  if (trimmed.includes('\n')) {
    const lines = trimmed.split('\n').filter((l) => /^\s*[[{]/.test(l));
    if (lines.length > 1) {
      const parsed = [];
      for (const l of lines.slice(0, maxNdjsonLines)) {
        const r = tryParse(l.trim());
        if (r.ok) parsed.push(r.value);
      }
      if (parsed.length) return parsed;
    }
  }
  return null;
}

export function indexPayload(
  stmts,
  { requestId = null, wsFrameId = null, direction, blobHash, text, contentType, size },
  opts = {}
) {
  const parsed = parsePayload(text, contentType, opts);
  if (parsed === null || parsed === undefined) return null;
  const { keys, depth, rootType, truncated } = flattenJson(parsed, opts);
  const info = stmts.insertJsonPayload.run(
    requestId,
    wsFrameId,
    direction,
    blobHash,
    rootType,
    size ?? text.length,
    keys.length,
    depth,
    truncated ? 1 : 0
  );
  const payloadId = Number(info.lastInsertRowid);
  for (const k of keys) stmts.insertJsonKey.run(payloadId, k.key_path, k.leaf, k.value_type, k.sample);
  return payloadId;
}

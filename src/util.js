const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const NUM = /^\d+$/;
const LONG_OPAQUE = /^[A-Za-z0-9_-]{24,}$/;
const DATEISH = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMPISH = /^\d{10,13}$/;
const BUNDLE_HASH = /^(.*?)([.\-_])([0-9a-f]{8,32}|[A-Za-z0-9_-]{8,12})\.(js|mjs|cjs|css|map)$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

const MULTI_SUFFIX = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'or.jp', 'ne.jp',
  'com.br', 'com.cn', 'com.mx', 'co.in', 'co.nz', 'co.za', 'com.tr', 'com.ar', 'com.sg', 'com.hk',
]);

export function pathTemplate(pathname) {
  if (!pathname) return '/';
  return (
    '/' +
    pathname
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        if (NUM.test(seg)) return TIMESTAMPISH.test(seg) ? '{ts}' : '{num}';
        if (UUID.test(seg)) return '{uuid}';
        if (DATEISH.test(seg)) return '{date}';
        if (HEX.test(seg)) return '{hex}';
        const bundle = BUNDLE_HASH.exec(seg);
        if (bundle) return `${bundle[1]}${bundle[2]}{hash}.${bundle[4]}`;
        if (!seg.includes('.') && LONG_OPAQUE.test(seg) && /\d/.test(seg)) return '{id}';
        return seg;
      })
      .join('/')
  );
}

export function splitUrl(raw) {
  try {
    const u = new URL(raw);
    return {
      scheme: u.protocol.replace(':', ''),
      host: u.host,
      hostname: u.hostname,
      path: u.pathname,
      query: u.search ? u.search.slice(1) : '',
      path_template: pathTemplate(u.pathname),
    };
  } catch {
    return { scheme: '', host: '', hostname: '', path: raw?.slice(0, 200) ?? '', query: '', path_template: '' };
  }
}

export function registrableDomain(host = '') {
  const h = String(host).split(':')[0].toLowerCase();
  if (!h || IPV4.test(h) || h.includes('[') || !h.includes('.')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  return MULTI_SUFFIX.has(last2) ? parts.slice(-3).join('.') : last2;
}

export function sameSite(a, b) {
  if (!a || !b) return false;
  return registrableDomain(a) === registrableDomain(b);
}

const TEXT_MIME =
  /^(text\/|application\/(json|xml|javascript|x-javascript|ecmascript|graphql|ld\+json|manifest\+json|x-ndjson|xhtml\+xml|x-www-form-urlencoded|vnd\.api\+json)|image\/svg)/i;

export function isTextMime(mime = '') {
  return TEXT_MIME.test(mime);
}

const JSON_MIME = /(^application\/(json|ld\+json|x-ndjson|manifest\+json|vnd\.api\+json)|\+json)/i;

export function looksJsonMime(mime = '') {
  return JSON_MIME.test(mime);
}

export function assetKind(mime = '', url = '') {
  const m = mime.toLowerCase();
  const ext = (url.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
  if (m.includes('html') || ext === 'html' || ext === 'htm') return 'html';
  if (m.includes('css') || ext === 'css') return 'css';
  if (m.includes('javascript') || m.includes('ecmascript') || ['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'js';
  if (looksJsonMime(m) || ext === 'json' || ext === 'map') return 'json';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp'].includes(ext)) return 'image';
  if (m.startsWith('font/') || ['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
  if (m.startsWith('video/') || m.startsWith('audio/')) return 'media';
  if (m.includes('xml') || ext === 'xml') return 'xml';
  if (m.includes('wasm') || ext === 'wasm') return 'wasm';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

export function nowIso() {
  return new Date().toISOString();
}

export function headersToObj(h) {
  if (!h) return null;
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

export function headerValue(headers, name) {
  if (!headers) return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return String(v);
  }
  return null;
}

export function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s;
}

export function fmtBytes(n) {
  if (n == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  if (!Number.isFinite(v)) return '-';
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function fmtMs(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  const v = Number(n);
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '-';
  const s = Math.round(Number(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function compileFilter(patterns, { name = 'filter' } = {}) {
  if (!patterns?.length) return null;
  const res = [];
  for (const p of patterns) {
    try {
      res.push(new RegExp(p, 'i'));
    } catch (e) {
      throw new Error(`${name}: invalid regular expression "${p}" (${e.message})`);
    }
  }
  return (url) => res.some((re) => re.test(url));
}

export function parseSetCookie(raw) {
  const lines = Array.isArray(raw) ? raw : String(raw ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    for (const a of attrs) {
      const [k, v = ''] = a.split('=');
      const key = k.trim().toLowerCase();
      if (key === 'path') c.path = v.trim();
      else if (key === 'domain') c.domain = v.trim();
      else if (key === 'expires') c.expires = v.trim();
      else if (key === 'httponly') c.httpOnly = true;
      else if (key === 'secure') c.secure = true;
      else if (key === 'samesite') c.sameSite = v.trim();
    }
    out.push(c);
  }
  return out;
}

export function parseCookieHeader(raw) {
  if (!raw) return [];
  return String(raw)
    .split(';')
    .map((p) => {
      const eq = p.indexOf('=');
      return eq < 0 ? null : { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
    })
    .filter(Boolean);
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assetKind } from './util.js';

const EXT_FOR_KIND = { html: 'html', css: 'css', js: 'js', json: 'json', xml: 'xml', text: 'txt' };
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function sanitize(seg) {
  let clean = seg.replace(/[^A-Za-z0-9._@()\-+,]/g, '_').replace(/^\.+$/, '_');
  if (RESERVED.test(clean.split('.')[0])) clean = `_${clean}`;
  return clean.length > 100 ? `${clean.slice(0, 90)}~${sha1(seg).slice(0, 8)}` : clean;
}

export function mirrorPathFor(rawUrl, kind) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return path.join('site', '_invalid', sha1(String(rawUrl)));
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return null;

  const host = sanitize(u.host || u.protocol.replace(':', ''));
  const segs = u.pathname.split('/').filter(Boolean).map(sanitize);
  let file = segs.pop() || 'index';

  if (!/\.[A-Za-z0-9]{1,6}$/.test(file)) {
    const ext = EXT_FOR_KIND[kind];
    if (ext) file = `${file}.${ext}`;
  }
  if (u.search) {
    const q = sha1(u.search).slice(0, 8);
    const dot = file.lastIndexOf('.');
    file = dot > 0 ? `${file.slice(0, dot)}__q${q}${file.slice(dot)}` : `${file}__q${q}`;
  }
  return path.join('site', host, ...segs, file);
}

function withSuffix(p, suffix) {
  const dot = p.lastIndexOf('.');
  const sep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return dot > sep ? `${p.slice(0, dot)}${suffix}${p.slice(dot)}` : `${p}${suffix}`;
}

export class Mirror {
  constructor(outDir, { link = true } = {}) {
    this.outDir = outDir;
    this.link = link;
    this.written = new Map();
    this.stats = { files: 0, linked: 0, copied: 0, reused: 0, conflicts: 0, errors: 0, bytesSaved: 0 };
  }

  #ensureDir(rel) {
    const abs = path.join(this.outDir, rel);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      return abs;
    } catch {
      return null;
    }
  }

  #materialize(abs, buf, srcAbs) {
    if (this.link && srcAbs) {
      try {
        fs.linkSync(srcAbs, abs);
        this.stats.linked++;
        this.stats.bytesSaved += buf.length;
        return true;
      } catch {}
    }
    try {
      fs.writeFileSync(abs, buf);
      this.stats.copied++;
      return true;
    } catch {
      this.stats.errors++;
      return false;
    }
  }

  write(rawUrl, buf, mime, { srcAbs = null, hash = null } = {}) {
    const kind = assetKind(mime, rawUrl);
    let rel = mirrorPathFor(rawUrl, kind);
    if (!rel) return { rel: null, kind };

    const key = hash ?? sha1(buf.toString('binary').slice(0, 4096) + buf.length);
    const prior = this.written.get(rel);
    if (prior === key) {
      this.stats.reused++;
      return { rel, kind };
    }
    if (prior !== undefined) {
      this.stats.conflicts++;
      rel = withSuffix(rel, `~${key.slice(0, 8)}`);
      if (this.written.get(rel) === key) {
        this.stats.reused++;
        return { rel, kind };
      }
    }

    let abs = this.#ensureDir(rel);
    if (!abs) {
      this.stats.conflicts++;
      rel = path.join('site', '_conflict', key.slice(0, 2), `${key.slice(0, 16)}-${path.basename(rel)}`);
      abs = this.#ensureDir(rel);
      if (!abs) {
        this.stats.errors++;
        return { rel: null, kind };
      }
    }

    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) {
      rel = path.join(rel, `_index.${EXT_FOR_KIND[kind] ?? 'bin'}`);
      abs = this.#ensureDir(rel);
      if (!abs) {
        this.stats.errors++;
        return { rel: null, kind };
      }
      st = null;
    }
    if (st?.isFile()) {
      if (st.size === buf.length) {
        this.written.set(rel, key);
        this.stats.reused++;
        return { rel, kind };
      }
      rel = withSuffix(rel, `~${key.slice(0, 8)}`);
      abs = path.join(this.outDir, rel);
      if (fs.existsSync(abs)) {
        this.written.set(rel, key);
        this.stats.reused++;
        return { rel, kind };
      }
    }

    if (!this.#materialize(abs, buf, srcAbs)) return { rel: null, kind };
    this.written.set(rel, key);
    this.stats.files++;
    return { rel, kind };
  }
}

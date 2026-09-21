import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Limiter } from './limiter.js';
import { isTextMime, nowIso, truncate } from './util.js';

const EXT_BY_MIME = [
  [/html/, 'html'],
  [/css/, 'css'],
  [/javascript|ecmascript/, 'js'],
  [/json/, 'json'],
  [/xml/, 'xml'],
  [/svg/, 'svg'],
  [/png/, 'png'],
  [/jpe?g/, 'jpg'],
  [/gif/, 'gif'],
  [/webp/, 'webp'],
  [/avif/, 'avif'],
  [/x-icon|vnd\.microsoft\.icon/, 'ico'],
  [/wasm/, 'wasm'],
  [/woff2/, 'woff2'],
  [/woff/, 'woff'],
  [/ttf/, 'ttf'],
  [/otf/, 'otf'],
  [/mp4/, 'mp4'],
  [/webm/, 'webm'],
  [/mpeg|mp3/, 'mp3'],
  [/zip/, 'zip'],
  [/pdf/, 'pdf'],
  [/event-stream/, 'sse'],
  [/text\//, 'txt'],
];

const PREVIEW_SOURCE_BYTES = 16 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: false });

export function extFor(mime = '') {
  for (const [re, ext] of EXT_BY_MIME) if (re.test(mime)) return ext;
  return 'bin';
}

function decodeUtf8(buf) {
  try {
    return decoder.decode(buf);
  } catch {
    return null;
  }
}

export function looksUtf8(buf) {
  const n = Math.min(buf.length, 512);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return ctrl / Math.max(n, 1) < 0.05;
}

export class BlobStore {
  constructor(
    outDir,
    stmts,
    { previewChars = 2000, maxTextBytes = 24 * 1024 * 1024, writeConcurrency = 16, seenCap = 200000, log = null } = {}
  ) {
    this.root = path.join(outDir, 'blobs');
    this.outDir = outDir;
    this.stmts = stmts;
    this.log = log;
    this.previewChars = previewChars;
    this.maxTextBytes = maxTextBytes;
    this.seenCap = seenCap;
    this.seen = new Set();
    this.inflight = new Map();
    this.dirs = new Set();
    this.limiter = new Limiter(writeConcurrency);
    this.stats = {
      stored: 0,
      deduped: 0,
      bytesStored: 0,
      bytesDeduped: 0,
      writeErrors: 0,
      writeQueuePeak: 0,
      dbErrors: 0,
    };
    fs.mkdirSync(this.root, { recursive: true });
  }

  relFor(hash, mime) {
    return path.join('blobs', hash.slice(0, 2), `${hash}.${extFor(mime)}`);
  }

  // put() runs inside synchronous CDP event handlers, so a failing statement must be
  // counted rather than thrown: losing a blobs row is survivable, losing the capture is not.
  #db(label, fn) {
    try {
      return fn();
    } catch (e) {
      this.stats.dbErrors++;
      this.log?.debug?.(`blob ${label}: ${e.message}`);
      return null;
    }
  }

  #remember(hash) {
    if (this.seen.size >= this.seenCap) this.seen.clear();
    this.seen.add(hash);
  }

  #enqueueWrite(hash, abs, buf) {
    const existing = this.inflight.get(hash);
    if (existing) return existing;

    const task = this.limiter
      .run(async () => {
        const dir = path.dirname(abs);
        if (!this.dirs.has(dir)) {
          await fsp.mkdir(dir, { recursive: true });
          this.dirs.add(dir);
        }
        await fsp.writeFile(abs, buf);
        return true;
      })
      .catch(() => {
        this.stats.writeErrors++;
        return false;
      })
      .finally(() => {
        this.inflight.delete(hash);
        this.stats.writeQueuePeak = Math.max(this.stats.writeQueuePeak, this.limiter.peak);
      });

    this.inflight.set(hash, task);
    return task;
  }

  put(buf, mime = '') {
    if (!buf || !buf.length) return null;

    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const rel = this.relFor(hash, mime);
    const abs = path.join(this.outDir, rel);
    const textual = isTextMime(mime) || (!mime && looksUtf8(buf));
    const text = textual && buf.length <= this.maxTextBytes ? decodeUtf8(buf) : null;

    if (this.seen.has(hash)) {
      this.stats.deduped++;
      this.stats.bytesDeduped += buf.length;
      return {
        hash,
        size: buf.length,
        isText: Boolean(textual),
        text,
        path: rel,
        abs,
        deduped: true,
        pending: this.inflight.get(hash) ?? null,
      };
    }

    const known = Boolean(this.#db('hasBlob', () => this.stmts.hasBlob.get(hash)));
    const pending = known && fs.existsSync(abs) ? null : this.#enqueueWrite(hash, abs, buf);

    if (known) {
      this.stats.deduped++;
      this.stats.bytesDeduped += buf.length;
    } else {
      const preview = textual
        ? truncate(text ?? decodeUtf8(buf.subarray(0, PREVIEW_SOURCE_BYTES)) ?? '', this.previewChars)
        : null;
      const wrote = this.#db('insertBlob', () =>
        this.stmts.insertBlob.run({
          hash,
          size: buf.length,
          mime: mime || null,
          is_text: textual ? 1 : 0,
          path: rel,
          preview,
          created_at: nowIso(),
        })
      );
      if (wrote) {
        this.stats.stored++;
        this.stats.bytesStored += buf.length;
      }
    }

    this.#remember(hash);
    return { hash, size: buf.length, isText: Boolean(textual), text, path: rel, abs, deduped: known, pending };
  }

  putText(str, mime = 'text/plain') {
    if (typeof str !== 'string' || !str.length) return null;
    return this.put(Buffer.from(str, 'utf8'), mime);
  }

  async drain() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }
}

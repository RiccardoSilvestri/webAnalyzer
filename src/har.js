import fs from 'node:fs';
import path from 'node:path';
import { headerValue, isTextMime, parseCookieHeader, parseSetCookie } from './util.js';

const FLUSH_AT = 1 << 20;
const CACHE_BUDGET = 32 * 1024 * 1024;

class ChunkWriter {
  constructor(dest) {
    this.fd = fs.openSync(dest, 'w');
    this.buf = [];
    this.len = 0;
    this.bytes = 0;
  }
  write(s) {
    this.buf.push(s);
    this.len += s.length;
    if (this.len >= FLUSH_AT) this.flush();
  }
  flush() {
    if (!this.buf.length) return;
    const chunk = Buffer.from(this.buf.join(''), 'utf8');
    fs.writeSync(this.fd, chunk);
    this.bytes += chunk.length;
    this.buf = [];
    this.len = 0;
  }
  close() {
    this.flush();
    fs.closeSync(this.fd);
    return this.bytes;
  }
}

function parseJson(s, fallback = {}) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

function toHarHeaders(obj) {
  return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function queryToPairs(q) {
  if (!q) return [];
  try {
    return [...new URLSearchParams(q)].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function firstPositive(...vals) {
  for (const v of vals) if (typeof v === 'number' && v >= 0) return v;
  return -1;
}

function harTimings(timing, totalMs) {
  if (!timing) {
    return { timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: 0, receive: totalMs > 0 ? totalMs : 0, ssl: -1 }, time: totalMs > 0 ? totalMs : -1 };
  }
  const dns = timing.dnsEnd >= 0 && timing.dnsStart >= 0 ? timing.dnsEnd - timing.dnsStart : -1;
  const connect = timing.connectEnd >= 0 && timing.connectStart >= 0 ? timing.connectEnd - timing.connectStart : -1;
  const ssl = timing.sslEnd >= 0 && timing.sslStart >= 0 ? timing.sslEnd - timing.sslStart : -1;
  const send = timing.sendEnd >= 0 && timing.sendStart >= 0 ? Math.max(0, timing.sendEnd - timing.sendStart) : 0;
  const wait = timing.receiveHeadersEnd >= 0 && timing.sendEnd >= 0 ? Math.max(0, timing.receiveHeadersEnd - timing.sendEnd) : 0;
  const blocked = Math.max(0, firstPositive(timing.dnsStart, timing.connectStart, timing.sendStart));
  const headersDone = timing.receiveHeadersEnd >= 0 ? timing.receiveHeadersEnd : blocked + send + wait;
  const receive = totalMs > headersDone ? totalMs - headersDone : 0;
  const time = totalMs > 0 ? totalMs : blocked + Math.max(dns, 0) + Math.max(connect, 0) + send + wait + receive;
  return {
    timings: {
      blocked: Number(blocked.toFixed(3)),
      dns: dns >= 0 ? Number(dns.toFixed(3)) : -1,
      connect: connect >= 0 ? Number(connect.toFixed(3)) : -1,
      send: Number(send.toFixed(3)),
      wait: Number(wait.toFixed(3)),
      receive: Number(receive.toFixed(3)),
      ssl: ssl >= 0 ? Number(ssl.toFixed(3)) : -1,
    },
    time: Number(time.toFixed(3)),
  };
}

export function exportHar(db, outDir, { bodies = 'text', maxBodyBytes = 2 * 1024 * 1024, log } = {}) {
  const session = db.prepare(`SELECT * FROM session ORDER BY id DESC LIMIT 1`).get() ?? {};
  const blobStmt = db.prepare(`SELECT hash, size, mime, is_text, path FROM blobs WHERE hash = ?`);
  const cache = new Map();
  let cacheBytes = 0;
  const stats = { entries: 0, withBody: 0, skippedBody: 0, missingBody: 0 };

  const readBlob = (hash) => {
    if (!hash || bodies === 'none') return null;
    if (cache.has(hash)) return cache.get(hash);
    const b = blobStmt.get(hash);
    if (!b) {
      stats.missingBody++;
      return null;
    }
    let out;
    if (b.size > maxBodyBytes) {
      stats.skippedBody++;
      out = { size: b.size, mime: b.mime, comment: `body omitted: ${b.size} bytes over the HAR limit` };
    } else if (bodies === 'text' && !b.is_text && !isTextMime(b.mime ?? '')) {
      stats.skippedBody++;
      out = { size: b.size, mime: b.mime, comment: 'binary body omitted (use --har-bodies all to include it)' };
    } else {
      try {
        const buf = fs.readFileSync(path.join(outDir, b.path));
        out = b.is_text ? { size: b.size, mime: b.mime, text: buf.toString('utf8') } : { size: b.size, mime: b.mime, text: buf.toString('base64'), base64: true };
      } catch {
        stats.missingBody++;
        out = { size: b.size, mime: b.mime, comment: 'blob file not readable' };
      }
    }
    if (cacheBytes > CACHE_BUDGET) {
      cache.clear();
      cacheBytes = 0;
    }
    cache.set(hash, out);
    cacheBytes += out.text?.length ?? 0;
    return out;
  };

  const pages = db.prepare(`SELECT * FROM pages ORDER BY id`).all();
  const metrics = db
    .prepare(`SELECT page_id, metric, MAX(value) AS value FROM page_metrics WHERE metric IN ('dom_content_loaded','load_event') GROUP BY page_id, metric`)
    .all();
  const byPage = new Map();
  for (const m of metrics) {
    const e = byPage.get(m.page_id) ?? {};
    e[m.metric] = m.value;
    byPage.set(m.page_id, e);
  }

  const dest = path.join(outDir, 'session.har');
  const w = new ChunkWriter(dest);
  w.write(
    JSON.stringify({
      log: {
        version: '1.2',
        creator: { name: 'webAnalyzer', version: '1.1.0' },
        browser: { name: session.browser ?? 'Chromium', version: '' },
        comment: `bodies=${bodies} maxBodyBytes=${maxBodyBytes}`,
        pages: pages.map((p) => ({
          startedDateTime: p.created_at ?? new Date().toISOString(),
          id: `page_${p.id}`,
          title: p.title ?? p.url ?? '',
          pageTimings: {
            onContentLoad: byPage.get(p.id)?.dom_content_loaded ?? -1,
            onLoad: byPage.get(p.id)?.load_event ?? -1,
          },
        })),
      },
    }).slice(0, -2)
  );
  w.write(',"entries":[');

  const rows = db
    .prepare(
      `SELECT r.*, resp.status, resp.status_text, resp.headers AS resp_headers,
              resp.extra_headers AS resp_extra_headers, resp.mime_type,
              resp.body_hash, resp.body_size, resp.body_error, resp.encoded_size, resp.timing,
              resp.protocol, resp.remote_ip, resp.remote_port, resp.from_disk_cache,
              resp.from_service_worker, resp.finished_at, f.error_text, f.blocked
       FROM requests r
       LEFT JOIN responses resp ON resp.request_id = r.id
       LEFT JOIN failures  f    ON f.request_id    = r.id
       ORDER BY r.id`
    )
    .iterate();

  let first = true;
  for (const r of rows) {
    const reqHeaders = { ...parseJson(r.headers), ...parseJson(r.extra_headers) };
    const respHeaders = { ...parseJson(r.resp_headers), ...parseJson(r.resp_extra_headers) };
    const timing = parseJson(r.timing, null);
    const post = readBlob(r.post_data_hash);
    const body = readBlob(r.body_hash);
    if (body?.text != null) stats.withBody++;

    const totalMs = r.finished_at != null && r.ts != null ? (r.finished_at - r.ts) * 1000 : -1;
    const { timings, time } = harTimings(timing, totalMs);

    const entry = {
      pageref: r.page_id != null ? `page_${r.page_id}` : undefined,
      startedDateTime: r.wall_time ?? new Date().toISOString(),
      time,
      request: {
        method: r.method ?? 'GET',
        url: r.url,
        httpVersion: r.protocol ?? 'HTTP/1.1',
        cookies: parseCookieHeader(headerValue(reqHeaders, 'cookie')),
        headers: toHarHeaders(reqHeaders),
        queryString: queryToPairs(r.query),
        headersSize: -1,
        bodySize: r.post_data_size ?? 0,
        ...(post
          ? {
              postData: {
                mimeType: r.post_content_type ?? 'application/octet-stream',
                text: post.text ?? '',
                ...(post.comment ? { comment: post.comment } : {}),
              },
            }
          : {}),
      },
      response: {
        status: r.status ?? 0,
        statusText: r.status_text ?? r.error_text ?? '',
        httpVersion: r.protocol ?? 'HTTP/1.1',
        cookies: parseSetCookie(headerValue(respHeaders, 'set-cookie')),
        headers: toHarHeaders(respHeaders),
        content: {
          size: r.body_size ?? 0,
          compression: r.encoded_size != null && r.body_size != null ? Math.max(0, r.body_size - r.encoded_size) : undefined,
          mimeType: r.mime_type ?? '',
          ...(body?.text != null ? { text: body.text } : {}),
          ...(body?.base64 ? { encoding: 'base64' } : {}),
          ...(body?.comment || r.body_error ? { comment: body?.comment ?? r.body_error } : {}),
        },
        redirectURL: headerValue(respHeaders, 'location') ?? '',
        headersSize: -1,
        bodySize: r.encoded_size ?? -1,
      },
      cache: r.from_disk_cache ? { afterRequest: null } : {},
      timings,
      serverIPAddress: r.remote_ip ?? '',
      connection: r.remote_port != null ? String(r.remote_port) : undefined,
      _resourceType: r.resource_type ?? '',
      _initiator: r.initiator_type ?? '',
      _requestId: r.id,
      _fromCache: r.from_disk_cache ? 'disk' : r.from_service_worker ? 'serviceworker' : undefined,
      _blockedByClient: r.blocked ? true : undefined,
      _error: r.error_text ?? undefined,
    };

    w.write((first ? '' : ',') + JSON.stringify(entry));
    first = false;
    stats.entries++;
  }

  w.write(']}}');
  const bytes = w.close();
  log?.debug?.(
    `har: ${stats.entries} entries, ${stats.withBody} with body, ${stats.skippedBody} bodies omitted, ${stats.missingBody} blobs absent, ${bytes} bytes`
  );
  return { path: dest, bytes, ...stats };
}

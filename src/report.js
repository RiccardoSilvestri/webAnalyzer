import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA, VIEWS, applyPragmas, ensureSchema } from './db.js';
import { fmtBytes, fmtMs, registrableDomain } from './util.js';

const SENSITIVE_TERMS = [
  'token', 'auth', 'passw', 'secret', 'api_key', 'api-key', 'apikey', 'session', 'jwt', 'bearer',
  'credential', 'signature', 'csrf', 'cookie', 'email', 'phone', 'ssn', 'iban', 'card', 'cvv',
  'otp', 'refresh', 'access', 'private', 'licen', 'pin',
];
const AUTH_QUERY = /(api[_-]?key|apikey|access[_-]?token|token|auth|key|sig|signature|session|password|jwt)/i;

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);
}

function table(headers, rows) {
  if (!rows.length) return '_no data_\n';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}\n`;
}

// Diagnostics are scoped to the database they came from, so generating two reports in the
// same process never mixes their warnings.
const warningsByDb = new WeakMap();

function sink(db) {
  let list = warningsByDb.get(db);
  if (!list) {
    list = [];
    warningsByDb.set(db, list);
  }
  return list;
}

export function warningsFor(db) {
  return [...sink(db)];
}

function note(db, e, sql) {
  sink(db).push(`query failed (${e.message}): ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}…`);
}

function q(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (e) {
    note(db, e, sql);
    return [];
  }
}

function one(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params) ?? {};
  } catch (e) {
    note(db, e, sql);
    return {};
  }
}

export function collect(db) {
  const session = one(db, `SELECT * FROM session ORDER BY id DESC LIMIT 1`);
  const totals = one(
    db,
    `SELECT
       (SELECT COUNT(*) FROM requests)                                   AS requests,
       (SELECT COUNT(DISTINCT host) FROM requests)                       AS hosts,
       (SELECT COUNT(*) FROM responses WHERE body_hash IS NOT NULL)      AS bodies,
       (SELECT COUNT(*) FROM blobs)                                      AS blobs,
       (SELECT COALESCE(SUM(size),0) FROM blobs)                         AS blob_bytes,
       (SELECT COALESCE(SUM(encoded_size),0) FROM responses)             AS wire_bytes,
       (SELECT COUNT(*) FROM json_payloads)                              AS json_payloads,
       (SELECT COUNT(*) FROM json_keys)                                  AS json_keys,
       (SELECT COUNT(*) FROM websockets)                                 AS websockets,
       (SELECT COUNT(*) FROM ws_frames)                                  AS ws_frames,
       (SELECT COUNT(*) FROM failures
          WHERE canceled = 0 AND error_text NOT LIKE '%BLOCKED_BY_CLIENT%')  AS failures,
       (SELECT COUNT(*) FROM failures WHERE canceled = 1)                AS canceled,
       (SELECT COUNT(*) FROM failures
          WHERE error_text LIKE '%BLOCKED_BY_CLIENT%')                   AS blocked,
       (SELECT COUNT(*) FROM console_logs WHERE level='error')           AS console_errors,
       (SELECT COUNT(*) FROM js_errors)                                  AS js_errors,
       (SELECT COUNT(*) FROM assets)                                     AS assets,
       (SELECT COUNT(*) FROM pages)                                      AS pages,
       (SELECT COUNT(*) FROM cookies WHERE phase='end')                  AS cookies,
       (SELECT COUNT(*) FROM storage_items)                              AS storage_items`
  );

  return {
    session,
    totals,
    pages: q(
      db,
      `SELECT p.id, p.title, p.created_at, p.closed_at, p.opener,
              COALESCE(NULLIF(p.url,'about:blank'),
                       (SELECT n.url FROM navigations n
                        WHERE n.page_id = p.id AND n.kind='main' AND n.url <> 'about:blank'
                        ORDER BY n.id DESC LIMIT 1),
                       p.url) AS url
       FROM pages p ORDER BY p.id`
    ),
    blockedTotal: one(db, `SELECT COUNT(*) AS n FROM failures WHERE error_text LIKE '%BLOCKED_BY_CLIENT%'`).n ?? 0,
    blockedHosts: q(
      db,
      `SELECT r.host, COUNT(*) AS n
       FROM failures f JOIN requests r ON r.id = f.request_id
       WHERE f.error_text LIKE '%BLOCKED_BY_CLIENT%'
       GROUP BY r.host ORDER BY n DESC LIMIT 30`
    ),
    blockedByType: q(
      db,
      `SELECT COALESCE(r.resource_type,'?') AS type, COUNT(*) AS n
       FROM failures f JOIN requests r ON r.id = f.request_id
       WHERE f.error_text LIKE '%BLOCKED_BY_CLIENT%'
       GROUP BY type ORDER BY n DESC`
    ),
    navigations: q(db, `SELECT page_id, url, kind, ts FROM navigations WHERE kind='main' ORDER BY id LIMIT 100`),
    hosts: q(
      db,
      `SELECT r.host,
              COUNT(*) AS calls,
              COALESCE(SUM(resp.encoded_size),0) AS bytes,
              COUNT(DISTINCT r.resource_type) AS types,
              SUM(CASE WHEN resp.status >= 400 THEN 1 ELSE 0 END) AS errors
       FROM requests r LEFT JOIN responses resp ON resp.request_id = r.id
       WHERE r.host <> ''
       GROUP BY r.host ORDER BY calls DESC LIMIT 60`
    ),
    byType: q(
      db,
      `SELECT COALESCE(r.resource_type,'?') AS type, COUNT(*) AS n,
              COALESCE(SUM(resp.encoded_size),0) AS bytes
       FROM requests r LEFT JOIN responses resp ON resp.request_id = r.id
       GROUP BY type ORDER BY n DESC`
    ),
    byStatus: q(
      db,
      `SELECT COALESCE(status, 0) AS status, COUNT(*) AS n FROM responses GROUP BY status ORDER BY n DESC`
    ),
    api: q(db, `SELECT * FROM v_api ORDER BY calls DESC LIMIT 80`),
    assets: q(
      db,
      `SELECT kind, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM assets GROUP BY kind ORDER BY bytes DESC`
    ),
    bigAssets: q(
      db,
      `SELECT kind, url, size, saved_path FROM assets WHERE size IS NOT NULL ORDER BY size DESC LIMIT 20`
    ),
    topKeys: q(
      db,
      `SELECT jk.leaf, COUNT(*) AS n, COUNT(DISTINCT jp.request_id) AS endpoints,
              GROUP_CONCAT(DISTINCT jk.value_type) AS types,
              MIN(jk.sample) AS sample
       FROM json_keys jk JOIN json_payloads jp ON jp.id = jk.payload_id
       GROUP BY jk.leaf ORDER BY n DESC LIMIT 60`
    ),
    sensitiveKeys: q(
      db,
      `SELECT DISTINCT jk.key_path, jk.value_type, r.method, r.host, r.path_template, jp.direction
       FROM json_keys jk
       JOIN json_payloads jp ON jp.id = jk.payload_id
       LEFT JOIN requests r ON r.id = jp.request_id
       WHERE ${SENSITIVE_TERMS.map(() => `LOWER(jk.key_path) LIKE ?`).join(' OR ')}
       ORDER BY jk.key_path LIMIT 400`,
      SENSITIVE_TERMS.map((t) => `%${t}%`)
    ),
    authHeaders: q(
      db,
      `SELECT DISTINCT host,
              substr(COALESCE(json_extract(headers,'$.authorization'), json_extract(extra_headers,'$.authorization')), 1, 24) AS auth
       FROM requests
       WHERE auth IS NOT NULL LIMIT 40`
    ),
    apiKeyHeaders: q(
      db,
      `SELECT DISTINCT host, key AS header
       FROM requests, json_each(COALESCE(requests.headers,'{}'))
       WHERE key LIKE '%api%key%' OR key LIKE 'x-%token%' OR key LIKE '%csrf%' OR key LIKE 'x-auth%'
       LIMIT 40`
    ),
    queryParams: q(
      db,
      `SELECT DISTINCT host, path_template, query FROM requests WHERE query <> '' LIMIT 800`
    ),
    websockets: q(
      db,
      `SELECT w.id, w.url,
              (SELECT COUNT(*) FROM ws_frames f WHERE f.ws_id = w.id AND f.direction='sent') AS sent,
              (SELECT COUNT(*) FROM ws_frames f WHERE f.ws_id = w.id AND f.direction='received') AS received,
              (SELECT COUNT(*) FROM ws_frames f WHERE f.ws_id = w.id AND f.is_json=1) AS json_frames
       FROM websockets w ORDER BY w.id`
    ),
    failures: q(
      db,
      `SELECT f.error_text, f.blocked_reason, r.method, r.url, COUNT(*) AS n
       FROM failures f JOIN requests r ON r.id = f.request_id
       WHERE f.canceled = 0 AND f.error_text NOT LIKE '%BLOCKED_BY_CLIENT%'
       GROUP BY f.error_text, r.url ORDER BY n DESC LIMIT 40`
    ),
    consoleErrors: q(
      db,
      `SELECT level, text, url, line, COUNT(*) AS n FROM console_logs
       WHERE level IN ('error','warning') GROUP BY text ORDER BY n DESC LIMIT 40`
    ),
    jsErrors: q(db, `SELECT message, url, COUNT(*) AS n FROM js_errors GROUP BY message ORDER BY n DESC LIMIT 30`),
    cookies: q(
      db,
      `SELECT name, domain, path, http_only, secure, same_site, length(value) AS value_len
       FROM cookies WHERE phase='end' ORDER BY domain, name LIMIT 100`
    ),
    storage: q(
      db,
      `SELECT origin, kind, key, length(value) AS value_len FROM storage_items ORDER BY kind, key LIMIT 120`
    ),
    slowest: q(
      db,
      `SELECT r.method, r.url, resp.status,
              ROUND((resp.finished_at - r.ts) * 1000) AS ms, resp.body_size
       FROM requests r JOIN responses resp ON resp.request_id = r.id
       WHERE resp.finished_at IS NOT NULL AND r.ts IS NOT NULL
       ORDER BY ms DESC LIMIT 20`
    ),
    domSnapshots: q(db, `SELECT page_id, phase, url, size, ts FROM dom_snapshots ORDER BY id`),
    screenshots: q(db, `SELECT page_id, phase, path FROM screenshots ORDER BY id`),
    baseHost: one(db, `SELECT host FROM requests WHERE is_navigation = 1 AND host <> '' ORDER BY id LIMIT 1`).host ?? '',
    bodyErrors: q(
      db,
      `SELECT COALESCE(body_error,'(none)') AS reason, COUNT(*) AS n,
              COALESCE(SUM(encoded_size),0) AS bytes
       FROM responses WHERE body_hash IS NULL
       GROUP BY reason ORDER BY n DESC LIMIT 25`
    ),
    bodyCoverage: one(
      db,
      `SELECT
         (SELECT COUNT(*) FROM responses)                              AS total,
         (SELECT COUNT(*) FROM responses WHERE body_hash IS NOT NULL)  AS captured,
         (SELECT COUNT(*) FROM responses WHERE body_hash IS NULL AND body_error LIKE 'skipped%') AS skipped,
         (SELECT COUNT(*) FROM responses WHERE body_hash IS NULL AND body_error LIKE '%redirect%') AS redirects,
         (SELECT COUNT(*) FROM json_payloads WHERE truncated = 1)      AS json_truncated`
    ),
    vitals: q(db, `SELECT * FROM v_vitals ORDER BY page_id, phase`),
    metricNames: q(
      db,
      `SELECT metric, unit, COUNT(*) AS n, ROUND(MIN(value),2) AS min, ROUND(AVG(value),2) AS avg, ROUND(MAX(value),2) AS max
       FROM page_metrics GROUP BY metric, unit ORDER BY metric`
    ),
    securityHeaders: q(db, `SELECT * FROM v_security`),
    insecureCookies: q(
      db,
      `SELECT name, domain, path, http_only, secure, same_site, length(value) AS value_len
       FROM cookies WHERE phase='end' AND (secure = 0 OR http_only = 0 OR same_site IS NULL OR same_site = 'None')
       ORDER BY domain, name LIMIT 60`
    ),
    thirdParty: q(
      db,
      `SELECT r.host, COUNT(*) AS calls, COALESCE(SUM(resp.encoded_size),0) AS bytes,
              GROUP_CONCAT(DISTINCT r.resource_type) AS types
       FROM requests r LEFT JOIN responses resp ON resp.request_id = r.id
       WHERE r.host <> '' GROUP BY r.host ORDER BY bytes DESC LIMIT 100`
    ),
    mixedContent: q(
      db,
      `SELECT DISTINCT r.scheme, r.host, r.path_template, r.resource_type
       FROM requests r
       WHERE r.scheme = 'http'
         AND EXISTS (SELECT 1 FROM requests d WHERE d.is_navigation = 1 AND d.scheme = 'https')
       LIMIT 60`
    ),
    weakTls: q(
      db,
      `SELECT DISTINCT r.host, resp.protocol, resp.security_state
       FROM requests r JOIN responses resp ON resp.request_id = r.id
       WHERE resp.security_state IS NOT NULL AND resp.security_state NOT IN ('secure','info')
       LIMIT 40`
    ),
    storageSecrets: q(
      db,
      `SELECT origin, kind, key, length(value) AS value_len
       FROM storage_items
       WHERE ${SENSITIVE_TERMS.map(() => `LOWER(key) LIKE ?`).join(' OR ')}
          OR value LIKE 'eyJ%'
       LIMIT 60`,
      SENSITIVE_TERMS.map((t) => `%${t}%`)
    ),
    slowHosts: q(
      db,
      `SELECT r.host, COUNT(*) AS calls,
              CAST(ROUND(AVG((resp.finished_at - r.ts) * 1000)) AS INTEGER) AS avg_ms,
              CAST(ROUND(MAX((resp.finished_at - r.ts) * 1000)) AS INTEGER) AS max_ms
       FROM requests r JOIN responses resp ON resp.request_id = r.id
       WHERE resp.finished_at IS NOT NULL AND r.ts IS NOT NULL AND r.host <> ''
       GROUP BY r.host HAVING calls > 1 ORDER BY avg_ms DESC LIMIT 20`
    ),
    duplicateBodies: q(
      db,
      `SELECT b.mime, b.size, COUNT(*) AS fetches, (COUNT(*) - 1) * b.size AS wasted_bytes,
              MIN(r.url) AS sample_url
       FROM responses resp
       JOIN blobs b   ON b.hash = resp.body_hash
       JOIN requests r ON r.id = resp.request_id
       GROUP BY resp.body_hash HAVING fetches > 1 AND b.size > 4096
       ORDER BY wasted_bytes DESC LIMIT 20`
    ),
  };
}

function endpointDetails(db, limit = 25) {
  const eps = q(
    db,
    `SELECT r.method, r.host, r.path_template, COUNT(*) AS calls
     FROM requests r LEFT JOIN responses resp ON resp.request_id = r.id
     WHERE r.resource_type IN ('XHR','Fetch','EventSource')
        OR resp.mime_type LIKE '%json%'
     GROUP BY r.method, r.host, r.path_template
     ORDER BY calls DESC LIMIT ?`,
    [limit]
  );

  return eps.map((ep) => {
    const sample = one(
      db,
      `SELECT r.id, r.url, r.query, resp.status, resp.mime_type, resp.body_hash, r.post_data_hash
       FROM requests r LEFT JOIN responses resp ON resp.request_id = r.id
       WHERE r.method=? AND r.host=? AND r.path_template=?
       ORDER BY COALESCE(resp.body_size,0) DESC LIMIT 1`,
      [ep.method, ep.host, ep.path_template]
    );
    const keys = q(
      db,
      `SELECT jk.key_path, jk.value_type, MIN(jk.sample) AS sample, jp.direction
       FROM json_keys jk
       JOIN json_payloads jp ON jp.id = jk.payload_id
       JOIN requests r ON r.id = jp.request_id
       WHERE r.method=? AND r.host=? AND r.path_template=?
       GROUP BY jk.key_path, jp.direction
       ORDER BY jp.direction, LENGTH(jk.key_path) LIMIT 40`,
      [ep.method, ep.host, ep.path_template]
    );
    const preview = sample.body_hash
      ? one(db, `SELECT substr(preview, 1, 600) AS p FROM blobs WHERE hash = ?`, [sample.body_hash]).p
      : null;
    return { ...ep, sample, keys, preview };
  });
}

function ublockState(session) {
  let o = {};
  try {
    o = JSON.parse(session.options ?? '{}');
  } catch {
  }
  const st = o.ublockStatus;
  if (!st) return { known: false, active: null, detail: 'not recorded (capture made with an earlier version)' };
  if (st.active) return { known: true, active: true, detail: `${st.rulesets.length} active rulesets: ${st.rulesets.join(', ')}` };
  return { known: true, active: false, detail: st.reason ?? 'not active' };
}

function securityFindings(d) {
  const seen = new Map();
  const add = (sev, area, detail) => {
    const k = `${area}|${detail}`;
    const prev = seen.get(k);
    if (prev) prev[3]++;
    else seen.set(k, [sev, area, detail, 1]);
  };
  const navs = d.securityHeaders ?? [];
  const https = navs.filter((n) => n.scheme === 'https');

  for (const n of navs) {
    const where = n.host || '(unknown host)';
    if (!n.csp) add('high', 'CSP', `${where}: no Content-Security-Policy on the document`);
    else if (/unsafe-inline|unsafe-eval/i.test(n.csp)) add('medium', 'CSP', `${where}: CSP present but allows unsafe-inline/unsafe-eval`);
    if (n.scheme === 'https' && !n.hsts) add('medium', 'HSTS', `${where}: no Strict-Transport-Security`);
    if (!n.x_content_type_options) add('low', 'MIME sniffing', `${where}: no X-Content-Type-Options: nosniff`);
    if (!n.x_frame_options && !/frame-ancestors/i.test(n.csp ?? '')) add('medium', 'Clickjacking', `${where}: neither X-Frame-Options nor CSP frame-ancestors`);
    if (!n.referrer_policy) add('low', 'Referrer', `${where}: no Referrer-Policy`);
    if (n.cors_allow_origin === '*') add('medium', 'CORS', `${where}: Access-Control-Allow-Origin: *`);
    if (n.server && /\d+\.\d+/.test(n.server)) add('low', 'Fingerprinting', `${where}: Server header leaks the version (${n.server})`);
    if (n.scheme === 'http') add('high', 'Transport', `${where}: document served in the clear over http`);
  }
  if (https.length && d.mixedContent?.length) {
    add('high', 'Mixed content', `${d.mixedContent.length} http resources on an https page (e.g. ${d.mixedContent[0].host}${d.mixedContent[0].path_template})`);
  }
  for (const t of d.weakTls ?? []) add('medium', 'TLS', `${t.host}: security_state=${t.security_state} protocol=${t.protocol ?? '?'}`);
  for (const c of d.insecureCookies ?? []) {
    const flaws = [];
    if (!c.secure) flaws.push('no Secure');
    if (!c.http_only) flaws.push('no HttpOnly');
    if (!c.same_site) flaws.push('no SameSite');
    if (c.same_site === 'None' && !c.secure) flaws.push('SameSite=None without Secure');
    if (flaws.length) add(c.secure ? 'low' : 'medium', 'Cookie', `${c.name} (${c.domain}): ${flaws.join(', ')}`);
  }
  for (const s of (d.storageSecrets ?? []).slice(0, 20)) {
    add('medium', 'Storage', `${s.kind}[${s.key}] on ${s.origin} looks like it holds a secret (${s.value_len} bytes)`);
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return [...seen.values()].sort((a, b) => rank[a[0]] - rank[b[0]] || a[1].localeCompare(b[1]));
}

export function buildReport(db, outDir, precollected = null) {
  const d = precollected ?? collect(db);
  const eps = endpointDetails(db);
  const s = d.session;
  const t = d.totals;
  const dur =
    s.started_at && s.ended_at ? Math.round((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000) : null;
  const ubo = ublockState(s);

  let section = 0;
  const h = (title) => `## ${section++}. ${title}`;
  const L = [];
  L.push(`# Capture report — ${s.target_url ?? '?'}`);
  L.push('');
  L.push(`Generated on ${new Date().toISOString()} by webAnalyzer.`);
  L.push('');

  L.push(h('Summary'));
  L.push('');
  const uboLine = ubo.active === true
    ? `**uBlock Origin Lite active** (${ubo.detail}) — ${d.blockedTotal} requests blocked.`
    : ubo.active === false
      ? `**uBlock NOT active** (${ubo.detail}) — ads were not filtered.`
      : `uBlock state ${ubo.detail}; ${d.blockedTotal} requests were blocked by the client anyway.`;
  L.push(`- ${uboLine}`);
  L.push(
    `- ${t.requests} requests to ${t.hosts} hosts in ${dur != null ? `${dur}s` : 'unknown duration'}, ` +
      `${fmtBytes(t.wire_bytes)} on the wire, ${t.bodies} bodies saved.`
  );
  L.push(`- ${t.pages} pages/popups, ${t.json_payloads} JSON payloads, ${t.websockets} websockets.`);
  L.push(
    `- ${t.failures} genuinely failed requests (excluding ${t.blocked} adblock blocks and ${t.canceled} cancellations), ` +
      `${t.console_errors} console errors, ${t.js_errors} JS exceptions.`
  );
  if (!t.cookies && !t.storage_items) {
    L.push(
      '- ⚠️ no cookies and no storage recorded: if you closed the browser window ' +
        'instead of pressing Ctrl+C, the final snapshot of client state may have been lost.'
    );
  } else {
    L.push(`- ${t.cookies} cookies and ${t.storage_items} storage entries at end of session.`);
  }
  L.push('');

  L.push(h('Session'));
  L.push('');
  L.push(
    table(
      ['field', 'value'],
      [
        ['Initial URL', s.target_url],
        ['Start', s.started_at],
        ['End', s.ended_at],
        ['Duration', dur != null ? `${dur}s` : '-'],
        ['Browser', s.browser],
        ['User agent', s.user_agent],
        ['Directory', s.out_dir],
        ['Options', s.options],
      ]
    )
  );

  L.push(h('Key numbers'));
  L.push('');
  L.push(
    table(
      ['metric', 'value'],
      [
        ['HTTP requests', t.requests],
        ['Distinct hosts', t.hosts],
        ['Bodies saved', t.bodies],
        ['Unique blobs', `${t.blobs} (${fmtBytes(t.blob_bytes)})`],
        ['Bytes on the wire', fmtBytes(t.wire_bytes)],
        ['JSON payloads indexed', t.json_payloads],
        ['JSON key paths', t.json_keys],
        ['WebSockets / frames', `${t.websockets} / ${t.ws_frames}`],
        ['Requests blocked by uBlock', t.blocked],
        ['Failed requests (excluding blocks and cancellations)', t.failures],
        ['Cancelled requests', t.canceled],
        ['Console / JS errors', `${t.console_errors} / ${t.js_errors}`],
        ['Assets on disk', t.assets],
        ['Pages', t.pages],
        ['Final cookies', t.cookies],
        ['Storage entries', t.storage_items],
      ]
    )
  );

  L.push(h('Ad and tracking blocking (uBlock Origin Lite)'));
  L.push('');
  L.push(
    table(
      ['field', 'value'],
      [
        ['State at launch', ubo.active === true ? 'ACTIVE' : ubo.active === false ? 'NOT ACTIVE' : 'not recorded'],
        ['Detail', ubo.detail],
        ['Requests blocked', d.blockedTotal],
      ]
    )
  );
  L.push('');
  if (d.blockedTotal) {
    L.push('A block shows up as `net::ERR_BLOCKED_BY_CLIENT` in `failures`: that is uBlock');
    L.push('doing its job, not a site fault. It is not counted among the errors.');
    L.push('');
    L.push('Most blocked hosts:');
    L.push('');
    L.push(table(['host', 'blocked requests'], d.blockedHosts.map((b) => [b.host, b.n])));
    L.push('');
    L.push(table(['resource type', 'blocked'], d.blockedByType.map((b) => [b.type, b.n])));
  } else if (ubo.active) {
    L.push('_uBlock was active but blocked nothing in this session._');
  } else {
    L.push('_no blocks: all ads and tracking ran._');
  }

  L.push('');
  L.push(h('Pages and navigations'));
  L.push('');
  L.push(table(['id', 'url', 'title', 'opened'], d.pages.map((p) => [p.id, p.url, p.title, p.created_at])));
  if (d.navigations.length) {
    L.push('Main-frame navigations:');
    L.push('');
    L.push(table(['page', 'url', 'when'], d.navigations.map((n) => [n.page_id, n.url, n.ts])));
  }

  L.push(h('Hosts contacted'));
  L.push('');
  L.push(
    table(
      ['host', 'calls', 'bytes', 'types', '4xx/5xx errors'],
      d.hosts.map((h) => [h.host, h.calls, fmtBytes(h.bytes), h.types, h.errors])
    )
  );

  L.push(h('Traffic by type and status'));
  L.push('');
  L.push(table(['resource type', 'n', 'bytes'], d.byType.map((r) => [r.type, r.n, fmtBytes(r.bytes)])));
  L.push('');
  L.push(table(['status', 'n'], d.byStatus.map((r) => [r.status || '(no response)', r.n])));

  L.push(h('Observed API surface'));
  L.push('');
  L.push('Endpoints grouped by path template (ids in the path are normalized).');
  L.push('');
  L.push(
    table(
      ['method', 'host', 'path template', 'calls', 'status', 'content-type'],
      d.api.map((a) => [a.method, a.host, a.path_template, a.calls, a.statuses, a.mimes])
    )
  );

  L.push(h('Main endpoints in detail'));
  L.push('');
  if (!eps.length) L.push('_no API calls detected_');
  for (const ep of eps) {
    L.push(`### ${ep.method} ${ep.host}${ep.path_template}`);
    L.push('');
    L.push(`- calls: ${ep.calls}`);
    if (ep.sample?.url) L.push(`- example: \`${ep.sample.url}\``);
    if (ep.sample?.status) L.push(`- status: ${ep.sample.status} · ${ep.sample.mime_type ?? ''}`);
    if (ep.sample?.id) L.push(`- \`requests.id = ${ep.sample.id}\``);
    if (ep.sample?.body_hash) L.push(`- body hash: \`${ep.sample.body_hash}\``);
    L.push('');
    const req = ep.keys.filter((k) => k.direction === 'request');
    const res = ep.keys.filter((k) => k.direction === 'response');
    if (req.length) {
      L.push('Request fields:');
      L.push('');
      L.push(table(['key path', 'type', 'example'], req.map((k) => [k.key_path, k.value_type, k.sample])));
    }
    if (res.length) {
      L.push('Response fields:');
      L.push('');
      L.push(table(['key path', 'type', 'example'], res.map((k) => [k.key_path, k.value_type, k.sample])));
    }
    if (ep.preview) {
      L.push('Response excerpt:');
      L.push('');
      L.push('```');
      L.push(String(ep.preview).slice(0, 600));
      L.push('```');
    }
    L.push('');
  }

  L.push(h('Most recurring JSON fields'));
  L.push('');
  L.push(
    table(
      ['field', 'occurrences', 'endpoints', 'types', 'example'],
      d.topKeys.map((k) => [k.leaf, k.n, k.endpoints, k.types, k.sample])
    )
  );

  L.push(h('Authentication and sensitive data'));
  L.push('');
  if (d.authHeaders.length) {
    L.push('`Authorization` headers observed:');
    L.push('');
    L.push(table(['host', 'prefix'], d.authHeaders.map((a) => [a.host, a.auth])));
  }
  if (d.apiKeyHeaders.length) {
    L.push('Custom authentication headers:');
    L.push('');
    L.push(table(['host', 'header'], d.apiKeyHeaders.map((a) => [a.host, a.header])));
  }
  const suspiciousQuery = [];
  for (const row of d.queryParams) {
    for (const [k] of new URLSearchParams(row.query)) {
      if (AUTH_QUERY.test(k)) suspiciousQuery.push([row.host, row.path_template, k]);
    }
  }
  const uniqQuery = [...new Map(suspiciousQuery.map((r) => [r.join('|'), r])).values()].slice(0, 40);
  if (uniqQuery.length) {
    L.push('Suspicious query parameters (credentials in the URL):');
    L.push('');
    L.push(table(['host', 'path template', 'parameter'], uniqQuery));
  }
  if (d.sensitiveKeys.length) {
    L.push('JSON fields with a sensitive name:');
    L.push('');
    L.push(
      table(
        ['direction', 'method', 'host', 'path template', 'key path', 'type'],
        d.sensitiveKeys.slice(0, 80).map((k) => [k.direction, k.method, k.host, k.path_template, k.key_path, k.value_type])
      )
    );
  }
  if (!d.authHeaders.length && !d.apiKeyHeaders.length && !uniqQuery.length && !d.sensitiveKeys.length) {
    L.push('_no authentication indicator detected_');
  }

  L.push('');
  L.push(h('Saved assets'));
  L.push('');
  L.push(table(['type', 'files', 'bytes'], d.assets.map((a) => [a.kind, a.n, fmtBytes(a.bytes)])));
  L.push('');
  L.push('The heaviest files:');
  L.push('');
  L.push(table(['type', 'bytes', 'path'], d.bigAssets.map((a) => [a.kind, fmtBytes(a.size), a.saved_path ?? a.url])));

  L.push(h('WebSocket'));
  L.push('');
  L.push(
    table(
      ['id', 'url', 'sent', 'received', 'JSON frames'],
      d.websockets.map((w) => [w.id, w.url, w.sent, w.received, w.json_frames])
    )
  );

  L.push(h('Errors'));
  L.push('');
  L.push('Failed requests (cancellations and adblocker blocks excluded: blocks are in section 3):');
  L.push('');
  L.push(
    table(['error', 'block', 'method', 'url', 'n'], d.failures.map((f) => [f.error_text, f.blocked_reason, f.method, f.url, f.n]))
  );
  L.push('');
  L.push('Console:');
  L.push('');
  L.push(table(['level', 'text', 'source', 'n'], d.consoleErrors.map((c) => [c.level, c.text, c.url, c.n])));
  if (d.jsErrors.length) {
    L.push('');
    L.push('JS exceptions:');
    L.push('');
    L.push(table(['message', 'url', 'n'], d.jsErrors.map((e) => [e.message, e.url, e.n])));
  }

  L.push(h('Client state'));
  L.push('');
  L.push('Cookies at end of session:');
  L.push('');
  L.push(
    table(
      ['name', 'domain', 'path', 'httpOnly', 'secure', 'sameSite', 'len'],
      d.cookies.map((c) => [c.name, c.domain, c.path, c.http_only, c.secure, c.same_site, c.value_len])
    )
  );
  L.push('');
  L.push('Storage:');
  L.push('');
  L.push(table(['origin', 'type', 'key', 'len'], d.storage.map((s2) => [s2.origin, s2.kind, s2.key, s2.value_len])));

  L.push(h('Network performance'));
  L.push('');
  L.push('The slowest requests:');
  L.push('');
  L.push(
    table(['method', 'url', 'status', 'duration', 'bytes'], d.slowest.map((r) => [r.method, r.url, r.status, fmtMs(r.ms), fmtBytes(r.body_size)]))
  );
  if (d.slowHosts?.length) {
    L.push('');
    L.push('Average latency per host (only hosts with more than one call):');
    L.push('');
    L.push(table(['host', 'calls', 'average', 'max'], d.slowHosts.map((r) => [r.host, r.calls, fmtMs(r.avg_ms), fmtMs(r.max_ms)])));
  }
  if (d.duplicateBodies?.length) {
    const wasted = d.duplicateBodies.reduce((a, r) => a + (r.wasted_bytes ?? 0), 0);
    L.push('');
    L.push(`Identical bodies downloaded more than once: ${fmtBytes(wasted)} of repeated traffic (caching candidates).`);
    L.push('');
    L.push(
      table(
        ['mime', 'size', 'downloads', 'wasted', 'example'],
        d.duplicateBodies.map((r) => [r.mime, fmtBytes(r.size), r.fetches, fmtBytes(r.wasted_bytes), r.sample_url])
      )
    );
  }

  L.push(h('Perceived performance (Web Vitals)'));
  L.push('');
  if (!d.vitals?.length) {
    L.push('_no page metrics recorded (capture ran with --no-metrics, or with an earlier version of the tool)_');
  } else {
    L.push('Measured in the page with `PerformanceObserver`. LCP and CLS are the values accumulated');
    L.push('up to the snapshot: `load` is the picture at the end of loading, while `periodic` and');
    L.push('`final` also include later interactions.');
    L.push('');
    L.push(
      table(
        ['page', 'phase', 'TTFB', 'FCP', 'LCP', 'CLS', 'INP', 'DCL', 'load', 'blocking', 'DOM nodes'],
        d.vitals.map((v) => [
          v.page_id,
          v.phase,
          fmtMs(v.ttfb_ms),
          fmtMs(v.fcp_ms),
          fmtMs(v.lcp_ms),
          v.cls != null ? Number(v.cls).toFixed(3) : '-',
          fmtMs(v.inp_ms),
          fmtMs(v.dcl_ms),
          fmtMs(v.load_ms),
          fmtMs(v.blocking_ms),
          v.dom_nodes ?? '-',
        ])
      )
    );
    const worst = d.vitals.filter((v) => v.lcp_ms > 2500 || v.cls > 0.1 || v.inp_ms > 200);
    if (worst.length) {
      L.push('');
      L.push('Core Web Vitals thresholds exceeded (LCP > 2.5s, CLS > 0.1, INP > 200ms):');
      L.push('');
      for (const v of worst) {
        const problems = [];
        if (v.lcp_ms > 2500) problems.push(`LCP ${fmtMs(v.lcp_ms)}`);
        if (v.cls > 0.1) problems.push(`CLS ${Number(v.cls).toFixed(3)}`);
        if (v.inp_ms > 200) problems.push(`INP ${fmtMs(v.inp_ms)}`);
        L.push(`- page ${v.page_id} (${v.phase}): ${problems.join(', ')} — ${v.url ?? ''}`);
      }
    }
    if (d.metricNames?.length) {
      L.push('');
      L.push('All collected metrics:');
      L.push('');
      L.push(
        table(
          ['metric', 'unit', 'samples', 'min', 'average', 'max'],
          d.metricNames.map((m) => [m.metric, m.unit, m.n, m.min, m.avg, m.max])
        )
      );
    }
  }

  L.push(h('Security audit'));
  L.push('');
  const findings = securityFindings(d);
  if (!findings.length) {
    L.push('_no findings: security headers present, cookies protected, no mixed content_');
  } else {
    const bySev = { high: 0, medium: 0, low: 0 };
    for (const [sev] of findings) bySev[sev]++;
    L.push(`${findings.length} distinct findings: ${bySev.high} high severity, ${bySev.medium} medium, ${bySev.low} low.`);
    L.push('');
    L.push(table(['severity', 'area', 'finding', 'occurrences'], findings.slice(0, 120)));
  }
  if (d.securityHeaders?.length) {
    L.push('');
    L.push('Security headers on the main documents:');
    L.push('');
    L.push(
      table(
        ['host', 'scheme', 'CSP', 'HSTS', 'X-Frame-Options', 'nosniff', 'Referrer-Policy'],
        d.securityHeaders.map((n) => [
          n.host,
          n.scheme,
          n.csp ? 'yes' : 'NO',
          n.hsts ? 'yes' : 'NO',
          n.x_frame_options ?? 'NO',
          n.x_content_type_options ?? 'NO',
          n.referrer_policy ?? 'NO',
        ])
      )
    );
  }

  L.push(h('First party and third parties'));
  L.push('');
  if (!d.baseHost) {
    L.push('_main domain not identified_');
  } else {
    const base = registrableDomain(d.baseHost);
    const rows = (d.thirdParty ?? []).map((r) => ({ ...r, third: registrableDomain(r.host) !== base }));
    const firstParty = rows.filter((r) => !r.third);
    const third = rows.filter((r) => r.third);
    const sum = (a) => a.reduce((acc, r) => acc + (r.bytes ?? 0), 0);
    const calls = (a) => a.reduce((acc, r) => acc + (r.calls ?? 0), 0);
    L.push(`Main domain: \`${base}\` (from ${d.baseHost}).`);
    L.push('');
    L.push(
      table(
        ['origin', 'hosts', 'calls', 'bytes'],
        [
          ['first party', firstParty.length, calls(firstParty), fmtBytes(sum(firstParty))],
          ['third parties', third.length, calls(third), fmtBytes(sum(third))],
        ]
      )
    );
    if (third.length) {
      L.push('');
      L.push('Third parties contacted:');
      L.push('');
      L.push(table(['host', 'calls', 'bytes', 'types'], third.slice(0, 50).map((r) => [r.host, r.calls, fmtBytes(r.bytes), r.types])));
    }
  }

  L.push(h('Capture completeness'));
  L.push('');
  const bc = d.bodyCoverage ?? {};
  const rate = bc.total ? Math.round((bc.captured / bc.total) * 100) : null;
  L.push(
    `${bc.captured ?? 0} bodies saved out of ${bc.total ?? 0} responses` +
      (rate != null ? ` (${rate}%)` : '') +
      `, of which ${bc.redirects ?? 0} redirects with no body and ${bc.skipped ?? 0} over \`--max-body\`.`
  );
  if (bc.json_truncated) {
    L.push('');
    L.push(
      `⚠️ ${bc.json_truncated} JSON payloads were only partly indexed (key/depth limits): ` +
        'for those read the blob instead of trusting `json_keys`.'
    );
  }
  L.push('');
  L.push('Why a body can be missing:');
  L.push('');
  L.push(table(['reason', 'responses', 'bytes on the wire'], d.bodyErrors.map((r) => [r.reason, r.n, fmtBytes(r.bytes)])));

  L.push(h('Artifacts on disk'));
  L.push('');
  L.push(
    table(
      ['path', 'contents'],
      [
        ['session.db', 'SQLite database with the whole session'],
        ['blobs/', 'bodies deduplicated by sha256'],
        ['site/', 'rebuilt site tree (html, js, css, images, fonts)'],
        ['dom/', 'DOM serialized after JS execution'],
        ['screenshots/', 'screenshots per page and phase'],
        ['downloads/', 'downloaded files'],
        ['session.har', 'standard HAR export'],
        ['REPORT.md', 'this document'],
        ['LLM_GUIDE.md', 'schema and query cookbook for an LLM'],
        ['schema.sql', 'database DDL'],
        ['manifest.json', 'machine-readable summary'],
        ['session.log', 'full capture log, debug level included'],
      ]
    )
  );

  const diagnostics = warningsFor(db);
  if (diagnostics.length) {
    L.push('');
    L.push(h('Report diagnostics'));
    L.push('');
    L.push('These queries did not succeed: the corresponding sections are incomplete.');
    L.push('');
    for (const w of diagnostics) L.push(`- ${w}`);
  }

  return L.join('\n');
}

export function buildLlmGuide(db, outDir, precollected = null) {
  const d = precollected ?? collect(db);
  const t = d.totals;
  const s = d.session ?? one(db, `SELECT * FROM session ORDER BY id DESC LIMIT 1`);
  return `# Guide for an LLM analyzing this capture

This directory holds the complete recording of a browsing session on
\`${s.target_url ?? '?'}\`. Everything is queryable through SQLite.

## Getting started

\`\`\`bash
sqlite3 -header -column "${path.join(outDir, 'session.db')}" "SELECT * FROM v_api ORDER BY calls DESC LIMIT 20;"
\`\`\`

Golden rule: **bodies are not in the database**. The DB holds the sha256 (\`body_hash\`,
\`post_data_hash\`, \`payload_hash\`, \`html_hash\`) and the \`blobs\` table maps that hash
to a file inside \`blobs/\`. To read a body:

\`\`\`sql
SELECT path, size, mime FROM blobs WHERE hash = '<hash>';
\`\`\`

then open the file \`<directory>/<path>\`. For textual bodies \`blobs.preview\` already
holds the first 2000 characters: if that is enough, you do not need to open the file.

## What this capture contains

- ${t.requests} HTTP requests to ${t.hosts} hosts
- ${t.bodies} response bodies saved, ${t.blobs} unique blobs
- ${t.json_payloads} JSON payloads flattened into ${t.json_keys} key paths
- ${t.websockets} websockets with ${t.ws_frames} frames
- ${t.failures} failed requests, ${t.js_errors} JS exceptions

## Views (reach for these first)

| view | what it gives you |
| --- | --- |
| \`v_calls\` | one row per request with status, mime, sizes, body hashes, error |
| \`v_api\` | endpoints grouped by \`method + host + path_template\`, with status and content-type |
| \`v_bodies\` | every body (request and response) already joined to \`blobs\`, with \`preview\` |

## Tables

### session
One row per run: \`target_url\`, \`started_at\`, \`ended_at\`, \`user_agent\`, \`options\` (JSON of the CLI options).

### pages / frames / navigations
\`pages\` one row per tab or popup. \`frames\` the iframes (\`is_oopif = 1\` when cross-origin,
separate process). \`navigations.kind\` is \`main\` or \`subframe\`.

### requests
One row per **single** request on the wire. A redirect produces several rows linked by
\`redirect_from\` (id of the previous request in the chain).

Relevant columns:
- \`url\`, \`scheme\`, \`host\`, \`path\`, \`query\`, \`method\`
- \`path_template\`: the path with identifiers normalized (\`/api/users/{num}/orders\`). **Always group by this column**, not by \`path\`.
- \`resource_type\`: \`Document\`, \`XHR\`, \`Fetch\`, \`Script\`, \`Stylesheet\`, \`Image\`, \`Font\`, \`WebSocket\`, \`EventSource\`, \`Preflight\`, \`Other\`
- \`headers\` / \`extra_headers\`: JSON. \`extra_headers\` are the ones actually sent on the wire (they include cookies); use \`json_extract(headers, '$.authorization')\`.
- \`initiator_type\` (\`parser\`, \`script\`, \`preload\`, \`other\`), \`initiator_url\`, \`initiator_stack\` (JS stack in JSON: it tells you **which line of which bundle** made the call)
- \`post_data_hash\` / \`post_data_size\` / \`post_content_type\`: the body that was sent
- \`ts\` (browser monotonic clock) and \`wall_time\` (ISO, use this one to order over time)

### responses
One row per request that got a response. \`status\`, \`headers\`, \`mime_type\`, \`protocol\`,
\`remote_ip\`, \`from_disk_cache\`, \`from_service_worker\`, \`encoded_size\` (bytes on the wire),
\`body_hash\` + \`body_size\` (decoded body), \`timing\` (JSON with DNS/connect/ssl/TTFB),
\`body_error\` (why the body is missing: redirect, too large, buffer expired).

### failures
Requests that did not complete. It holds three different things, do not conflate them:
- \`canceled = 1\`: normal noise (navigation interrupted), ignore it.
- \`error_text LIKE '%BLOCKED_BY_CLIENT%'\`: **blocked by uBlock Origin Lite**, not a
  fault — that is the adblocker working. These measure how much advertising and
  tracking the site would have loaded.
- everything else: real errors (DNS, TLS, connection, CSP, mixed content).

\`blocked_reason\` gives the browser-side reason for the block, \`cors_error\` the CORS detail.

\`\`\`sql
-- real faults only
SELECT * FROM failures
WHERE canceled = 0 AND error_text NOT LIKE '%BLOCKED_BY_CLIENT%';

-- what the adblocker stopped, per host
SELECT r.host, COUNT(*) n FROM failures f JOIN requests r ON r.id = f.request_id
WHERE f.error_text LIKE '%BLOCKED_BY_CLIENT%' GROUP BY r.host ORDER BY n DESC;
\`\`\`

### json_payloads + json_keys
The heart of API analysis. Every JSON seen (in a request, a response, a websocket frame
or an SSE event) becomes a row in \`json_payloads\`
(\`direction\` = \`request\` | \`response\` | \`ws_sent\` | \`ws_received\` | \`sse\`) and is
flattened into \`json_keys\`:
- \`key_path\`: \`data.items[].user.email\` — \`[]\` marks an array element
- \`leaf\`: the last segment (\`email\`), handy to find a field wherever it appears
- \`value_type\`: \`string\` | \`number\` | \`boolean\` | \`null\` | \`object\` | \`array\`
- \`sample\`: sample value truncated to 200 characters

Limits are deliberate: only the first 3 elements of an array are inspected, at most
3000 key paths and 12 levels of depth per payload. So \`json_keys\` describes **the shape**
of the data, not every value: for those read the blob.

### assets
Static resources also mirrored on disk under \`site/\`. \`kind\` = \`html\` | \`css\` | \`js\` |
\`json\` | \`image\` | \`font\` | \`media\` | \`wasm\` | \`download\` | \`other\`. \`saved_path\` is
relative to this directory.

### websockets / ws_frames / sse_messages
\`ws_frames.direction\` = \`sent\` | \`received\`, \`opcode\` 1 text 2 binary,
\`payload_hash\` points to the blob. \`is_json = 1\` when the frame is JSON (there is then
also a row in \`json_payloads\` with \`ws_frame_id\` set).

### console_logs / js_errors
Browser logs and exceptions, with \`page_id\`, \`url\` and source line.

### cookies / storage_items
\`cookies.phase\` is \`start\` or \`end\`: comparing the two phases shows what the site set.
\`storage_items.kind\` = \`local\` | \`session\` | \`indexeddb\`.

### dom_snapshots / screenshots
\`dom_snapshots\` is the DOM **after** JS execution (different from the source HTML in
\`site/\`): \`phase\` = \`load\` or \`final\`. The HTML is in the \`html_hash\` blob and also in \`dom/\`.

### timeline
The sequence of notable events (\`navigation\`, \`error\`, \`blocked\`, \`websocket\`,
\`snapshot\`, \`download\`, \`popup\`, \`page\`) ordered by \`ts\`: the starting point to
reconstruct the story of the session. \`blocked\` are requests stopped by the adblocker.

### session.options
JSON of the options the capture started with. Inside there is \`ublockStatus\`, which says
whether the adblocker was really active and with which rulesets:

\`\`\`sql
SELECT json_extract(options,'$.ublockStatus.active')   AS ublock_active,
       json_extract(options,'$.ublockStatus.rulesets') AS rulesets
FROM session ORDER BY id DESC LIMIT 1;
\`\`\`

### blobs_fts
FTS5 full-text index over every textual body (HTML, JS, CSS, JSON, websocket frames).
Search for a string anywhere in the site:

\`\`\`sql
SELECT b.mime, b.size, b.path, snippet(blobs_fts, 1, '[', ']', '…', 12) AS ctx
FROM blobs_fts JOIN blobs b ON b.hash = blobs_fts.hash
WHERE blobs_fts MATCH 'apiKey' LIMIT 20;
\`\`\`

## Query cookbook

**Every API call in chronological order**
\`\`\`sql
SELECT at, method, host, path, status, mime, resp_body_size
FROM v_calls WHERE type IN ('XHR','Fetch') ORDER BY at;
\`\`\`

**Which endpoints return a given field**
\`\`\`sql
SELECT DISTINCT r.method, r.host, r.path_template, jk.key_path
FROM json_keys jk
JOIN json_payloads jp ON jp.id = jk.payload_id
JOIN requests r ON r.id = jp.request_id
WHERE jk.leaf = 'email' AND jp.direction = 'response';
\`\`\`

**Response schema of an endpoint**
\`\`\`sql
SELECT jk.key_path, jk.value_type, MIN(jk.sample) AS example
FROM json_keys jk
JOIN json_payloads jp ON jp.id = jk.payload_id
JOIN requests r ON r.id = jp.request_id
WHERE r.path_template = '/api/v1/items' AND jp.direction = 'response'
GROUP BY jk.key_path, jk.value_type ORDER BY LENGTH(jk.key_path);
\`\`\`

**Read the body of a response**
\`\`\`sql
SELECT b.path, b.size, b.preview
FROM responses resp JOIN blobs b ON b.hash = resp.body_hash
WHERE resp.request_id = 42;
\`\`\`

**What was sent to the server (outgoing payloads)**
\`\`\`sql
SELECT r.method, r.url, b.mime, b.preview
FROM requests r JOIN blobs b ON b.hash = r.post_data_hash
ORDER BY r.id;
\`\`\`

**Who originated a call (JS stack)**
\`\`\`sql
SELECT url, initiator_type, initiator_url,
       json_extract(initiator_stack, '$.callFrames[0].functionName') AS fn,
       json_extract(initiator_stack, '$.callFrames[0].url') AS src
FROM requests WHERE resource_type IN ('XHR','Fetch');
\`\`\`

**Third parties relative to the main domain**
\`\`\`sql
SELECT host, COUNT(*) n, SUM(resp_body_size) bytes
FROM v_calls
WHERE host NOT LIKE '%' || (SELECT host FROM requests WHERE is_navigation = 1 ORDER BY id LIMIT 1)
GROUP BY host ORDER BY n DESC;
\`\`\`

**Authenticated calls**
\`\`\`sql
SELECT DISTINCT host, path_template,
       substr(json_extract(headers,'$.authorization'),1,12) AS auth_scheme
FROM requests WHERE json_extract(headers,'$.authorization') IS NOT NULL;
\`\`\`

**Real errors (cancellations excluded)**
\`\`\`sql
SELECT r.method, r.url, f.error_text, f.blocked_reason
FROM failures f JOIN requests r ON r.id = f.request_id WHERE f.canceled = 0;
\`\`\`

**Redirect chain**
\`\`\`sql
WITH RECURSIVE chain(id, url, status, prev) AS (
  SELECT r.id, r.url, resp.status, r.redirect_from
  FROM requests r LEFT JOIN responses resp ON resp.request_id = r.id
  WHERE r.redirect_from IS NULL
  UNION ALL
  SELECT r.id, r.url, resp.status, r.redirect_from
  FROM requests r
  LEFT JOIN responses resp ON resp.request_id = r.id
  JOIN chain c ON r.redirect_from = c.id
)
SELECT * FROM chain WHERE prev IS NOT NULL;
\`\`\`

**Websocket traffic in the clear**
\`\`\`sql
SELECT w.url, f.direction, f.ts, b.preview
FROM ws_frames f JOIN websockets w ON w.id = f.ws_id JOIN blobs b ON b.hash = f.payload_hash
ORDER BY f.ts LIMIT 100;
\`\`\`

**What the site wrote into localStorage**
\`\`\`sql
SELECT origin, kind, key, substr(value,1,200) FROM storage_items ORDER BY kind, key;
\`\`\`

**Cookies set during the session**
\`\`\`sql
SELECT name, domain, http_only, secure, same_site FROM cookies WHERE phase='end'
EXCEPT SELECT name, domain, http_only, secure, same_site FROM cookies WHERE phase='start';
\`\`\`

**Story of the session**
\`\`\`sql
SELECT ts, kind, summary FROM timeline ORDER BY ts;
\`\`\`

**Largest JS bundles (where to look for the logic)**
\`\`\`sql
SELECT url, size, saved_path FROM assets WHERE kind='js' ORDER BY size DESC LIMIT 20;
\`\`\`

**Find a hardcoded endpoint in the code**
\`\`\`sql
SELECT b.path, snippet(blobs_fts, 1, '>>', '<<', '…', 16)
FROM blobs_fts JOIN blobs b ON b.hash = blobs_fts.hash
WHERE blobs_fts MATCH '"/api/' AND b.mime LIKE '%javascript%' LIMIT 20;
\`\`\`

## Traps worth knowing

1. \`responses.body_hash\` can be NULL: read \`body_error\` to tell whether it was a
   redirect, an empty response (204), a body over the limit or an already expired buffer.
2. Requests served from cache (\`from_disk_cache = 1\`) may have no body. The capture runs
   with the cache disabled by default, so there should be few of them.
3. \`Preflight\` requests (CORS OPTIONS) are real requests and should be excluded when you
   count application calls.
4. Requests made by a service worker towards the network do not go through the page's
   Network domain: they show up as responses with \`from_service_worker = 1\` without the
   upstream fetch.
5. The same URL can appear many times: group by \`path_template\`.
6. \`json_keys\` samples arrays: to count elements read the blob.
`;
}

export function generateAll(outDir) {
  const dbPath = path.join(outDir, 'session.db');
  if (!fs.existsSync(dbPath)) throw new Error(`No database in ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  applyPragmas(db);
  ensureSchema(db);

  const d = collect(db);

  fs.writeFileSync(path.join(outDir, 'REPORT.md'), buildReport(db, outDir, d));
  fs.writeFileSync(path.join(outDir, 'LLM_GUIDE.md'), buildLlmGuide(db, outDir, d));
  fs.writeFileSync(path.join(outDir, 'schema.sql'), `${SCHEMA}\n${VIEWS}`);

  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        session: d.session,
        totals: d.totals,
        body_coverage: d.bodyCoverage,
        base_host: d.baseHost,
        hosts: d.hosts,
        api: d.api,
        websockets: d.websockets,
        pages: d.pages,
        vitals: d.vitals,
        security_findings: securityFindings(d).map(([severity, area, detail]) => ({ severity, area, detail })),
        warnings: warningsFor(db),
        artifacts: {
          database: 'session.db',
          blobs: 'blobs/',
          site: 'site/',
          dom: 'dom/',
          screenshots: 'screenshots/',
          har: 'session.har',
          report: 'REPORT.md',
          llm_guide: 'LLM_GUIDE.md',
        },
      },
      null,
      2
    )
  );

  db.close();
  return {
    report: path.join(outDir, 'REPORT.md'),
    guide: path.join(outDir, 'LLM_GUIDE.md'),
    warnings: warningsFor(db),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const dir = path.resolve(process.argv[2] ?? '.');
  if (!fs.existsSync(path.join(dir, 'session.db'))) {
    console.error(`No capture in ${dir}: session.db is missing.`);
    console.error(`Usage: node src/report.js <capture-directory>`);
    process.exit(1);
  }
  const out = generateAll(dir);
  console.log(`REPORT.md    -> ${out.report}`);
  console.log(`LLM_GUIDE.md -> ${out.guide}`);
  for (const w of out.warnings) console.warn(`warning: ${w}`);
}

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -65536;
PRAGMA mmap_size = 268435456;
PRAGMA busy_timeout = 5000;
`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id            INTEGER PRIMARY KEY,
  target_url    TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  browser       TEXT,
  user_agent    TEXT,
  out_dir       TEXT,
  options       TEXT,
  stats         TEXT
);

CREATE TABLE IF NOT EXISTS blobs (
  hash        TEXT PRIMARY KEY,
  size        INTEGER,
  mime        TEXT,
  is_text     INTEGER,
  path        TEXT,
  preview     TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_blobs_mime ON blobs(mime);

CREATE VIRTUAL TABLE IF NOT EXISTS blobs_fts USING fts5(hash UNINDEXED, content);

CREATE TABLE IF NOT EXISTS pages (
  id          INTEGER PRIMARY KEY,
  target_id   TEXT UNIQUE,
  opener      TEXT,
  url         TEXT,
  title       TEXT,
  created_at  TEXT,
  closed_at   TEXT
);

CREATE TABLE IF NOT EXISTS frames (
  id              INTEGER PRIMARY KEY,
  frame_id        TEXT,
  page_id         INTEGER,
  parent_frame_id TEXT,
  url             TEXT,
  name            TEXT,
  is_oopif        INTEGER,
  ts              TEXT,
  UNIQUE(page_id, frame_id)
);
CREATE INDEX IF NOT EXISTS idx_frames_page ON frames(page_id);
CREATE INDEX IF NOT EXISTS idx_frames_fid  ON frames(frame_id);

CREATE TABLE IF NOT EXISTS navigations (
  id       INTEGER PRIMARY KEY,
  page_id  INTEGER,
  frame_id TEXT,
  url      TEXT,
  kind     TEXT,
  ts       TEXT
);
CREATE INDEX IF NOT EXISTS idx_nav_page ON navigations(page_id, kind);

CREATE TABLE IF NOT EXISTS requests (
  id                INTEGER PRIMARY KEY,
  page_id           INTEGER,
  cdp_request_id    TEXT,
  loader_id         TEXT,
  frame_id          TEXT,
  url               TEXT,
  scheme            TEXT,
  host              TEXT,
  path              TEXT,
  path_template     TEXT,
  query             TEXT,
  method            TEXT,
  resource_type     TEXT,
  is_navigation     INTEGER,
  document_url      TEXT,
  initiator_type    TEXT,
  initiator_url     TEXT,
  initiator_stack   TEXT,
  headers           TEXT,
  extra_headers     TEXT,
  post_data_hash    TEXT,
  post_data_size    INTEGER,
  post_content_type TEXT,
  redirect_from     INTEGER,
  served_from_cache INTEGER,
  ts                REAL,
  wall_time         TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_host ON requests(host);
CREATE INDEX IF NOT EXISTS idx_req_tpl  ON requests(method, host, path_template);
CREATE INDEX IF NOT EXISTS idx_req_type ON requests(resource_type);
CREATE INDEX IF NOT EXISTS idx_req_cdp  ON requests(cdp_request_id);
CREATE INDEX IF NOT EXISTS idx_req_wall ON requests(wall_time);
CREATE INDEX IF NOT EXISTS idx_req_page ON requests(page_id);
CREATE INDEX IF NOT EXISTS idx_req_post ON requests(post_data_hash);

CREATE TABLE IF NOT EXISTS responses (
  id                  INTEGER PRIMARY KEY,
  request_id          INTEGER UNIQUE,
  status              INTEGER,
  status_text         TEXT,
  headers             TEXT,
  extra_headers       TEXT,
  mime_type           TEXT,
  remote_ip           TEXT,
  remote_port         INTEGER,
  protocol            TEXT,
  from_disk_cache     INTEGER,
  from_service_worker INTEGER,
  from_prefetch       INTEGER,
  encoded_size        INTEGER,
  body_hash           TEXT,
  body_size           INTEGER,
  body_error          TEXT,
  timing              TEXT,
  security_state      TEXT,
  ts                  REAL,
  finished_at         REAL
);
CREATE INDEX IF NOT EXISTS idx_resp_status ON responses(status);
CREATE INDEX IF NOT EXISTS idx_resp_mime   ON responses(mime_type);
CREATE INDEX IF NOT EXISTS idx_resp_body   ON responses(body_hash);
CREATE INDEX IF NOT EXISTS idx_resp_err    ON responses(body_error);

CREATE TABLE IF NOT EXISTS failures (
  id             INTEGER PRIMARY KEY,
  request_id     INTEGER,
  error_text     TEXT,
  canceled       INTEGER,
  blocked        INTEGER,
  blocked_reason TEXT,
  cors_error     TEXT,
  ts             REAL
);
CREATE INDEX IF NOT EXISTS idx_fail_req ON failures(request_id);
CREATE INDEX IF NOT EXISTS idx_fail_kind ON failures(blocked, canceled);

CREATE TABLE IF NOT EXISTS json_payloads (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER,
  ws_frame_id INTEGER,
  direction   TEXT,
  blob_hash   TEXT,
  root_type   TEXT,
  size        INTEGER,
  n_keys      INTEGER,
  depth       INTEGER,
  truncated   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jp_req  ON json_payloads(request_id);
CREATE INDEX IF NOT EXISTS idx_jp_dir  ON json_payloads(direction);
CREATE INDEX IF NOT EXISTS idx_jp_blob ON json_payloads(blob_hash);

CREATE TABLE IF NOT EXISTS json_keys (
  id         INTEGER PRIMARY KEY,
  payload_id INTEGER,
  key_path   TEXT,
  leaf       TEXT,
  value_type TEXT,
  sample     TEXT
);
CREATE INDEX IF NOT EXISTS idx_jk_path ON json_keys(key_path);
CREATE INDEX IF NOT EXISTS idx_jk_leaf ON json_keys(leaf);
CREATE INDEX IF NOT EXISTS idx_jk_pl   ON json_keys(payload_id);

CREATE TABLE IF NOT EXISTS assets (
  id         INTEGER PRIMARY KEY,
  request_id INTEGER,
  url        TEXT,
  kind       TEXT,
  saved_path TEXT,
  body_hash  TEXT,
  size       INTEGER,
  mime       TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind);
CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(body_hash);

CREATE TABLE IF NOT EXISTS websockets (
  id                 INTEGER PRIMARY KEY,
  page_id            INTEGER,
  cdp_request_id     TEXT,
  url                TEXT,
  created_at         REAL,
  closed_at          REAL,
  handshake_request  TEXT,
  handshake_response TEXT,
  error              TEXT
);

CREATE TABLE IF NOT EXISTS ws_frames (
  id           INTEGER PRIMARY KEY,
  ws_id        INTEGER,
  direction    TEXT,
  opcode       INTEGER,
  payload_hash TEXT,
  size         INTEGER,
  is_json      INTEGER,
  ts           REAL
);
CREATE INDEX IF NOT EXISTS idx_wsf_ws ON ws_frames(ws_id);

CREATE TABLE IF NOT EXISTS sse_messages (
  id         INTEGER PRIMARY KEY,
  request_id INTEGER,
  event_name TEXT,
  event_id   TEXT,
  data_hash  TEXT,
  size       INTEGER,
  ts         REAL
);
CREATE INDEX IF NOT EXISTS idx_sse_req ON sse_messages(request_id);

CREATE TABLE IF NOT EXISTS console_logs (
  id      INTEGER PRIMARY KEY,
  page_id INTEGER,
  level   TEXT,
  text    TEXT,
  url     TEXT,
  line    INTEGER,
  col     INTEGER,
  stack   TEXT,
  ts      TEXT
);
CREATE INDEX IF NOT EXISTS idx_console_level ON console_logs(level);

CREATE TABLE IF NOT EXISTS js_errors (
  id      INTEGER PRIMARY KEY,
  page_id INTEGER,
  message TEXT,
  stack   TEXT,
  url     TEXT,
  ts      TEXT
);

CREATE TABLE IF NOT EXISTS cookies (
  id          INTEGER PRIMARY KEY,
  phase       TEXT,
  name        TEXT,
  value       TEXT,
  domain      TEXT,
  path        TEXT,
  expires     REAL,
  http_only   INTEGER,
  secure      INTEGER,
  same_site   TEXT,
  captured_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cookies_phase ON cookies(phase);

CREATE TABLE IF NOT EXISTS storage_items (
  id          INTEGER PRIMARY KEY,
  page_id     INTEGER,
  origin      TEXT,
  kind        TEXT,
  key         TEXT,
  value       TEXT,
  captured_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_storage_page ON storage_items(page_id, kind);

CREATE TABLE IF NOT EXISTS dom_snapshots (
  id        INTEGER PRIMARY KEY,
  page_id   INTEGER,
  phase     TEXT,
  url       TEXT,
  html_hash TEXT,
  size      INTEGER,
  ts        TEXT
);

CREATE TABLE IF NOT EXISTS screenshots (
  id      INTEGER PRIMARY KEY,
  page_id INTEGER,
  phase   TEXT,
  path    TEXT,
  ts      TEXT
);

CREATE TABLE IF NOT EXISTS page_metrics (
  id      INTEGER PRIMARY KEY,
  page_id INTEGER,
  phase   TEXT,
  url     TEXT,
  metric  TEXT,
  value   REAL,
  unit    TEXT,
  ts      TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_page ON page_metrics(page_id, metric);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON page_metrics(metric);

CREATE TABLE IF NOT EXISTS timeline (
  id        INTEGER PRIMARY KEY,
  ts        TEXT,
  kind      TEXT,
  page_id   INTEGER,
  ref_table TEXT,
  ref_id    INTEGER,
  summary   TEXT
);
CREATE INDEX IF NOT EXISTS idx_timeline_ts   ON timeline(ts);
CREATE INDEX IF NOT EXISTS idx_timeline_kind ON timeline(kind);
`;

export const VIEWS = `
DROP VIEW IF EXISTS v_calls;
CREATE VIEW v_calls AS
SELECT
  r.id             AS request_id,
  r.wall_time      AS at,
  r.method         AS method,
  r.host           AS host,
  r.path           AS path,
  r.path_template  AS path_template,
  r.query          AS query,
  r.url            AS url,
  r.resource_type  AS type,
  resp.status      AS status,
  resp.mime_type   AS mime,
  r.post_data_size AS req_body_size,
  resp.body_size   AS resp_body_size,
  resp.encoded_size AS wire_size,
  r.post_data_hash AS req_body_hash,
  resp.body_hash   AS resp_body_hash,
  resp.body_error  AS body_error,
  CAST(ROUND((resp.finished_at - r.ts) * 1000) AS INTEGER) AS duration_ms,
  r.initiator_type AS initiator,
  f.error_text     AS error,
  f.blocked        AS blocked,
  r.page_id        AS page_id
FROM requests r
LEFT JOIN responses resp ON resp.request_id = r.id
LEFT JOIN failures  f    ON f.request_id    = r.id;

DROP VIEW IF EXISTS v_api;
CREATE VIEW v_api AS
SELECT
  r.method,
  r.host,
  r.path_template,
  COUNT(*)                              AS calls,
  GROUP_CONCAT(DISTINCT resp.status)    AS statuses,
  GROUP_CONCAT(DISTINCT resp.mime_type) AS mimes,
  CAST(ROUND(AVG((resp.finished_at - r.ts) * 1000)) AS INTEGER) AS avg_ms,
  CAST(ROUND(MAX((resp.finished_at - r.ts) * 1000)) AS INTEGER) AS max_ms,
  MIN(r.wall_time)                      AS first_seen,
  MAX(r.wall_time)                      AS last_seen
FROM requests r
LEFT JOIN responses resp ON resp.request_id = r.id
WHERE r.resource_type IN ('XHR','Fetch','EventSource','WebSocket')
   OR resp.mime_type LIKE '%json%'
GROUP BY r.method, r.host, r.path_template;

DROP VIEW IF EXISTS v_bodies;
CREATE VIEW v_bodies AS
SELECT
  r.id       AS request_id,
  r.method,
  r.url,
  'response' AS direction,
  b.hash,
  b.mime,
  b.size,
  b.path,
  b.preview
FROM requests r
JOIN responses resp ON resp.request_id = r.id
JOIN blobs b        ON b.hash = resp.body_hash
UNION ALL
SELECT
  r.id      AS request_id,
  r.method,
  r.url,
  'request' AS direction,
  b.hash,
  b.mime,
  b.size,
  b.path,
  b.preview
FROM requests r
JOIN blobs b ON b.hash = r.post_data_hash;

DROP VIEW IF EXISTS v_vitals;
CREATE VIEW v_vitals AS
SELECT
  p.id   AS page_id,
  p.url  AS url,
  m.phase,
  MAX(CASE WHEN m.metric = 'ttfb'                THEN m.value END) AS ttfb_ms,
  MAX(CASE WHEN m.metric = 'first_contentful_paint' THEN m.value END) AS fcp_ms,
  MAX(CASE WHEN m.metric = 'largest_contentful_paint' THEN m.value END) AS lcp_ms,
  MAX(CASE WHEN m.metric = 'cumulative_layout_shift' THEN m.value END) AS cls,
  MAX(CASE WHEN m.metric = 'interaction_next_paint' THEN m.value END) AS inp_ms,
  MAX(CASE WHEN m.metric = 'dom_content_loaded'   THEN m.value END) AS dcl_ms,
  MAX(CASE WHEN m.metric = 'load_event'           THEN m.value END) AS load_ms,
  MAX(CASE WHEN m.metric = 'long_task_total'      THEN m.value END) AS blocking_ms,
  MAX(CASE WHEN m.metric = 'dom_nodes'            THEN m.value END) AS dom_nodes,
  MAX(CASE WHEN m.metric = 'js_heap_used'         THEN m.value END) AS js_heap
FROM page_metrics m
JOIN pages p ON p.id = m.page_id
GROUP BY p.id, m.phase;

DROP VIEW IF EXISTS v_security;
CREATE VIEW v_security AS
SELECT DISTINCT
  r.host,
  r.scheme,
  resp.protocol,
  resp.security_state,
  json_extract(resp.headers, '$.content-security-policy')   AS csp,
  json_extract(resp.headers, '$.strict-transport-security') AS hsts,
  json_extract(resp.headers, '$.x-frame-options')           AS x_frame_options,
  json_extract(resp.headers, '$.x-content-type-options')    AS x_content_type_options,
  json_extract(resp.headers, '$.referrer-policy')           AS referrer_policy,
  json_extract(resp.headers, '$.permissions-policy')        AS permissions_policy,
  json_extract(resp.headers, '$.access-control-allow-origin') AS cors_allow_origin,
  json_extract(resp.headers, '$.server')                    AS server
FROM requests r
JOIN responses resp ON resp.request_id = r.id
WHERE r.is_navigation = 1;
`;

export function applyPragmas(db) {
  for (const line of PRAGMAS.split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      db.exec(line);
    } catch {
      continue;
    }
  }
}

const ADDED_COLUMNS = [
  ['session', 'stats', 'TEXT'],
  ['requests', 'served_from_cache', 'INTEGER'],
  ['failures', 'blocked', 'INTEGER'],
  ['json_payloads', 'truncated', 'INTEGER'],
];

export function migrate(db) {
  const applied = [];
  for (const [tableName, column, type] of ADDED_COLUMNS) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
      if (!cols.length || cols.some((c) => c.name === column)) continue;
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column} ${type}`);
      applied.push(`${tableName}.${column}`);
    } catch {
      continue;
    }
  }
  return applied;
}

export function ensureSchema(db) {
  migrate(db);
  db.exec(SCHEMA);
  migrate(db);
  db.exec(VIEWS);
}

export function openDb(outDir) {
  const db = new DatabaseSync(path.join(outDir, 'session.db'));
  applyPragmas(db);
  ensureSchema(db);
  return db;
}

export function walCheckpoint(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return true;
  } catch {
    return false;
  }
}

export function optimize(db) {
  try {
    db.exec('PRAGMA analysis_limit = 400');
    db.exec('PRAGMA optimize');
    return true;
  } catch {
    return false;
  }
}

export function buildFts(db, outDir, { maxBytes = 2 * 1024 * 1024, onProgress } = {}) {
  const result = { indexed: 0, skipped: 0, missing: 0, bytes: 0 };

  const rows = db
    .prepare(`SELECT hash, path, size FROM blobs WHERE is_text = 1 AND size > 0 AND size <= ? ORDER BY size`)
    .all(maxBytes);
  if (!rows.length) return result;

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM blobs_fts');
    const insert = db.prepare(`INSERT INTO blobs_fts (hash, content) VALUES (?, ?)`);
    for (const row of rows) {
      if (!row.path) {
        result.skipped++;
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(path.join(outDir, row.path), 'utf8');
      } catch {
        result.missing++;
        continue;
      }
      insert.run(row.hash, text);
      result.indexed++;
      result.bytes += row.size ?? 0;
      if (onProgress && result.indexed % 500 === 0) onProgress(result.indexed, rows.length);
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* niente da annullare */
    }
    throw e;
  }

  return result;
}

export class WriteBatch {
  constructor(db, { maxOps = 1000, maxMs = 400, onError } = {}) {
    this.db = db;
    this.maxOps = maxOps;
    this.maxMs = maxMs;
    this.onError = onError;
    this.open = false;
    this.locked = false;
    this.ops = 0;
    this.since = 0;
    this.commits = 0;
    this.total = 0;
    this.savepoints = 0;
    this.rollbacks = 0;
  }

  enter() {
    const now = Date.now();
    if (this.open && !this.locked && (this.ops >= this.maxOps || now - this.since >= this.maxMs)) this.flush();
    if (!this.open) {
      try {
        this.db.exec('BEGIN');
        this.open = true;
        this.ops = 0;
        this.since = now;
      } catch (e) {
        this.onError?.(e);
        return;
      }
    }
    this.ops++;
    this.total++;
  }

  flush() {
    if (!this.open || this.locked) return false;
    this.open = false;
    try {
      this.db.exec('COMMIT');
      this.commits++;
      return true;
    } catch (e) {
      this.onError?.(e);
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* niente da annullare */
      }
      return false;
    }
  }

  atomic(fn) {
    this.enter();
    if (!this.open) return fn();

    const name = `wa_sp${++this.savepoints}`;
    try {
      this.db.exec(`SAVEPOINT ${name}`);
    } catch (e) {
      this.onError?.(e);
      return fn();
    }

    const wasLocked = this.locked;
    this.locked = true;
    try {
      const result = fn();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      this.rollbacks++;
      this.onError?.(e);
      try {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
      } catch (e2) {
        this.onError?.(e2);
      }
      return null;
    } finally {
      this.locked = wasLocked;
    }
  }
}

function wrap(stmt, batch) {
  if (!batch) return stmt;
  return {
    run: (...args) => {
      batch.enter();
      return stmt.run(...args);
    },
    get: (...args) => stmt.get(...args),
    all: (...args) => stmt.all(...args),
  };
}

export function prepare(db, batch = null) {
  const p = (sql) => wrap(db.prepare(sql), batch);
  return {
    insertSession: p(
      `INSERT INTO session (target_url, started_at, browser, user_agent, out_dir, options)
       VALUES (@target_url, @started_at, @browser, @user_agent, @out_dir, @options)`
    ),
    endSession: p(`UPDATE session SET ended_at = ?, stats = ? WHERE id = ?`),

    insertBlob: p(
      `INSERT OR IGNORE INTO blobs (hash, size, mime, is_text, path, preview, created_at)
       VALUES (@hash, @size, @mime, @is_text, @path, @preview, @created_at)`
    ),
    hasBlob: p(`SELECT 1 FROM blobs WHERE hash = ?`),

    insertPage: p(`INSERT OR IGNORE INTO pages (target_id, opener, url, created_at) VALUES (?,?,?,?)`),
    pageIdByTarget: p(`SELECT id FROM pages WHERE target_id = ?`),
    updatePage: p(`UPDATE pages SET url = ?, title = ? WHERE id = ?`),
    setPageUrl: p(`UPDATE pages SET url = ? WHERE id = ?`),
    closePage: p(`UPDATE pages SET closed_at = ? WHERE id = ?`),

    upsertFrame: p(
      `INSERT INTO frames (frame_id, page_id, parent_frame_id, url, name, is_oopif, ts)
       VALUES (@frame_id,@page_id,@parent_frame_id,@url,@name,@is_oopif,@ts)
       ON CONFLICT(page_id, frame_id) DO UPDATE SET
         parent_frame_id = COALESCE(excluded.parent_frame_id, frames.parent_frame_id),
         url             = COALESCE(excluded.url, frames.url),
         name            = COALESCE(excluded.name, frames.name),
         is_oopif        = MAX(COALESCE(excluded.is_oopif, 0), COALESCE(frames.is_oopif, 0)),
         ts              = excluded.ts`
    ),
    insertNavigation: p(`INSERT INTO navigations (page_id, frame_id, url, kind, ts) VALUES (?,?,?,?,?)`),

    insertRequest: p(
      `INSERT INTO requests (page_id, cdp_request_id, loader_id, frame_id, url, scheme, host, path,
        path_template, query, method, resource_type, is_navigation, document_url, initiator_type,
        initiator_url, initiator_stack, headers, post_data_hash, post_data_size, post_content_type,
        redirect_from, ts, wall_time)
       VALUES (@page_id,@cdp_request_id,@loader_id,@frame_id,@url,@scheme,@host,@path,
        @path_template,@query,@method,@resource_type,@is_navigation,@document_url,@initiator_type,
        @initiator_url,@initiator_stack,@headers,@post_data_hash,@post_data_size,@post_content_type,
        @redirect_from,@ts,@wall_time)`
    ),
    setRequestExtraHeaders: p(`UPDATE requests SET extra_headers = ? WHERE id = ?`),
    setPostData: p(`UPDATE requests SET post_data_hash = ?, post_data_size = ? WHERE id = ?`),
    setServedFromCache: p(`UPDATE requests SET served_from_cache = 1 WHERE id = ?`),

    insertResponse: p(
      `INSERT INTO responses (request_id, status, status_text, headers, mime_type,
        remote_ip, remote_port, protocol, from_disk_cache, from_service_worker, from_prefetch,
        encoded_size, timing, security_state, ts)
       VALUES (@request_id,@status,@status_text,@headers,@mime_type,@remote_ip,@remote_port,
        @protocol,@from_disk_cache,@from_service_worker,@from_prefetch,@encoded_size,@timing,
        @security_state,@ts)
       ON CONFLICT(request_id) DO UPDATE SET
         status              = excluded.status,
         status_text         = excluded.status_text,
         headers             = COALESCE(excluded.headers, responses.headers),
         mime_type           = COALESCE(excluded.mime_type, responses.mime_type),
         remote_ip           = COALESCE(excluded.remote_ip, responses.remote_ip),
         remote_port         = COALESCE(excluded.remote_port, responses.remote_port),
         protocol            = COALESCE(excluded.protocol, responses.protocol),
         from_disk_cache     = excluded.from_disk_cache,
         from_service_worker = excluded.from_service_worker,
         from_prefetch       = excluded.from_prefetch,
         encoded_size        = COALESCE(NULLIF(excluded.encoded_size, 0), responses.encoded_size),
         timing              = COALESCE(excluded.timing, responses.timing),
         security_state      = COALESCE(excluded.security_state, responses.security_state),
         ts                  = COALESCE(responses.ts, excluded.ts)`
    ),
    setResponseBody: p(
      `INSERT INTO responses (request_id, body_hash, body_size, body_error, encoded_size, finished_at)
       VALUES (@request_id,@body_hash,@body_size,@body_error,@encoded_size,@finished_at)
       ON CONFLICT(request_id) DO UPDATE SET
         body_hash    = excluded.body_hash,
         body_size    = excluded.body_size,
         body_error   = excluded.body_error,
         encoded_size = COALESCE(NULLIF(excluded.encoded_size, 0), responses.encoded_size),
         finished_at  = COALESCE(excluded.finished_at, responses.finished_at)`
    ),
    setResponseExtraHeaders: p(
      `INSERT INTO responses (request_id, extra_headers) VALUES (?, ?)
       ON CONFLICT(request_id) DO UPDATE SET extra_headers = excluded.extra_headers`
    ),

    insertFailure: p(
      `INSERT INTO failures (request_id, error_text, canceled, blocked, blocked_reason, cors_error, ts)
       VALUES (?,?,?,?,?,?,?)`
    ),

    insertJsonPayload: p(
      `INSERT INTO json_payloads (request_id, ws_frame_id, direction, blob_hash, root_type, size, n_keys, depth, truncated)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ),
    insertJsonKey: p(`INSERT INTO json_keys (payload_id, key_path, leaf, value_type, sample) VALUES (?,?,?,?,?)`),

    insertAsset: p(`INSERT INTO assets (request_id, url, kind, saved_path, body_hash, size, mime) VALUES (?,?,?,?,?,?,?)`),

    insertWebsocket: p(`INSERT INTO websockets (page_id, cdp_request_id, url, created_at) VALUES (?,?,?,?)`),
    setWsHandshake: p(
      `UPDATE websockets SET handshake_request = COALESCE(?, handshake_request),
        handshake_response = COALESCE(?, handshake_response) WHERE id = ?`
    ),
    closeWebsocket: p(`UPDATE websockets SET closed_at = ?, error = COALESCE(?, error) WHERE id = ?`),
    insertWsFrame: p(
      `INSERT INTO ws_frames (ws_id, direction, opcode, payload_hash, size, is_json, ts) VALUES (?,?,?,?,?,?,?)`
    ),

    insertSse: p(`INSERT INTO sse_messages (request_id, event_name, event_id, data_hash, size, ts) VALUES (?,?,?,?,?,?)`),

    insertConsole: p(
      `INSERT INTO console_logs (page_id, level, text, url, line, col, stack, ts) VALUES (?,?,?,?,?,?,?,?)`
    ),
    insertJsError: p(`INSERT INTO js_errors (page_id, message, stack, url, ts) VALUES (?,?,?,?,?)`),
    insertCookie: p(
      `INSERT INTO cookies (phase, name, value, domain, path, expires, http_only, secure, same_site, captured_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ),
    insertStorage: p(`INSERT INTO storage_items (page_id, origin, kind, key, value, captured_at) VALUES (?,?,?,?,?,?)`),
    clearCookies: p(`DELETE FROM cookies WHERE phase = ?`),
    clearStorage: p(`DELETE FROM storage_items WHERE page_id = ?`),
    insertDom: p(`INSERT INTO dom_snapshots (page_id, phase, url, html_hash, size, ts) VALUES (?,?,?,?,?,?)`),
    insertScreenshot: p(`INSERT INTO screenshots (page_id, phase, path, ts) VALUES (?,?,?,?)`),
    clearMetrics: p(`DELETE FROM page_metrics WHERE page_id = ? AND phase = ?`),
    insertMetric: p(`INSERT INTO page_metrics (page_id, phase, url, metric, value, unit, ts) VALUES (?,?,?,?,?,?,?)`),
    insertTimeline: p(`INSERT INTO timeline (ts, kind, page_id, ref_table, ref_id, summary) VALUES (?,?,?,?,?,?)`),
  };
}

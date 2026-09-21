import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { ensureSchema, openDb } from '../src/db.js';
import { buildLlmGuide, buildReport, collect, generateAll, warningsFor } from '../src/report.js';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-report-'));
}

// A capture just large enough to exercise every section of the report: two hosts, a JSON
// API with a sensitive key, a blocked request, a failure and a websocket.
function seed(db) {
  db.exec(`
    INSERT INTO session (id, target_url, started_at, ended_at, browser, user_agent, out_dir)
    VALUES (1, 'https://example.com/', '2026-09-18T10:00:00.000Z', '2026-09-18T10:05:00.000Z',
            'Chromium/140', 'UA', '/tmp/out');

    INSERT INTO pages (id, target_id, url, title, created_at)
    VALUES (1, 'page-1', 'https://example.com/', 'Example', '2026-09-18T10:00:00.000Z');

    INSERT INTO navigations (page_id, url, kind, ts)
    VALUES (1, 'https://example.com/', 'main', '2026-09-18T10:00:01.000Z');

    INSERT INTO blobs (hash, size, mime, is_text, path, preview, created_at) VALUES
      ('a1', 120, 'text/html', 1, 'blobs/a1/a1.html', '<html>', '2026-09-18T10:00:01.000Z'),
      ('b2', 340, 'application/json', 1, 'blobs/b2/b2.json', '{"email":"x"}', '2026-09-18T10:00:02.000Z');

    INSERT INTO requests
      (id, page_id, url, scheme, host, path, path_template, query, method, resource_type,
       is_navigation, headers, wall_time)
    VALUES
      (1, 1, 'https://example.com/', 'https', 'example.com', '/', '/', '', 'GET', 'Document', 1,
       '{"accept":"text/html"}', '2026-09-18T10:00:01.000Z'),
      (2, 1, 'https://api.example.com/v1/users/42', 'https', 'api.example.com', '/v1/users/42',
       '/v1/users/{num}', '', 'GET', 'XHR', 0, '{"authorization":"Bearer abc123"}',
       '2026-09-18T10:00:02.000Z'),
      (3, 1, 'https://ads.tracker.test/pixel.gif', 'https', 'ads.tracker.test', '/pixel.gif',
       '/pixel.gif', '', 'GET', 'Image', 0, '{}', '2026-09-18T10:00:03.000Z'),
      (4, 1, 'https://api.example.com/v1/missing', 'https', 'api.example.com', '/v1/missing',
       '/v1/missing', '', 'GET', 'XHR', 0, '{}', '2026-09-18T10:00:04.000Z');

    INSERT INTO responses (request_id, status, mime_type, body_hash, body_size, encoded_size, headers)
    VALUES
      (1, 200, 'text/html', 'a1', 120, 150, '{"content-type":"text/html"}'),
      (2, 200, 'application/json', 'b2', 340, 200, '{"content-type":"application/json"}'),
      (4, 404, 'text/plain', NULL, NULL, 40, '{}');

    INSERT INTO failures (request_id, error_text, canceled, blocked)
    VALUES (3, 'net::ERR_BLOCKED_BY_CLIENT', 0, 1);

    INSERT INTO json_payloads (id, request_id, direction, blob_hash, root_type, size, n_keys, depth)
    VALUES (1, 2, 'response', 'b2', 'object', 340, 2, 2);

    INSERT INTO json_keys (payload_id, key_path, leaf, value_type, sample)
    VALUES (1, 'user.email', 'email', 'string', 'a@b.c'),
           (1, 'user.id', 'id', 'number', '42');

    INSERT INTO websockets (id, page_id, cdp_request_id, url, created_at)
    VALUES (1, 1, 'ws-1', 'wss://api.example.com/live', 1758189600.0);

    INSERT INTO ws_frames (ws_id, direction, opcode, payload_hash, size, is_json)
    VALUES (1, 'sent', 1, 'b2', 340, 1);

    INSERT INTO console_logs (page_id, level, text, ts)
    VALUES (1, 'error', 'Uncaught TypeError', '2026-09-18T10:00:05.000Z');

    INSERT INTO assets (request_id, url, kind, saved_path, body_hash, size, mime)
    VALUES (1, 'https://example.com/', 'html', 'site/example.com/index.html', 'a1', 120, 'text/html');
  `);
}

function seededCapture() {
  const dir = makeDir();
  const db = openDb(dir);
  seed(db);
  db.close();
  return dir;
}

describe('collect', () => {
  it('counts what the capture actually holds', () => {
    const dir = seededCapture();
    const db = new DatabaseSync(path.join(dir, 'session.db'));

    const d = collect(db);

    assert.equal(d.totals.requests, 4);
    assert.equal(d.totals.hosts, 3);
    assert.equal(d.totals.bodies, 2);
    assert.equal(d.totals.blocked, 1);
    assert.equal(d.totals.websockets, 1);
    assert.equal(d.totals.console_errors, 1);
    assert.equal(d.session.target_url, 'https://example.com/');
    assert.deepEqual(warningsFor(db), []);
    db.close();
  });

  it('reads through on an empty but valid capture', () => {
    const dir = makeDir();
    const db = openDb(dir);

    const d = collect(db);

    assert.equal(d.totals.requests, 0);
    assert.deepEqual(d.hosts, []);
    assert.deepEqual(warningsFor(db), []);
    db.close();
  });

  it('records a warning instead of throwing when a table is missing', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);
    db.exec('DROP TABLE websockets');

    const d = collect(db);

    assert.ok(d, 'collect should still return a result');
    const warnings = warningsFor(db);
    assert.ok(warnings.length > 0, 'the failed query should be reported');
    assert.ok(
      warnings.some((w) => /websockets/.test(w)),
      `expected a websockets warning, got ${JSON.stringify(warnings)}`
    );
    db.close();
  });
});

describe('warning isolation', () => {
  it('does not leak one capture’s warnings into another', () => {
    const broken = new DatabaseSync(':memory:');
    ensureSchema(broken);
    broken.exec('DROP TABLE websockets');
    collect(broken);
    assert.ok(warningsFor(broken).length > 0);

    const healthy = new DatabaseSync(':memory:');
    ensureSchema(healthy);
    collect(healthy);

    assert.deepEqual(warningsFor(healthy), [], 'a healthy capture must report nothing');
    broken.close();
    healthy.close();
  });
});

describe('buildReport', () => {
  it('renders the sections a reader needs', () => {
    const dir = seededCapture();
    const db = new DatabaseSync(path.join(dir, 'session.db'));

    const md = buildReport(db, dir);

    assert.match(md, /example\.com/);
    assert.match(md, /api\.example\.com/);
    assert.match(md, /\/v1\/users\/\{num\}/, 'endpoints should be grouped by path template');
    assert.doesNotMatch(md, /Report diagnostics/, 'a healthy capture has no diagnostics');
    db.close();
  });

  it('emits well-formed tables even when the data contains pipes', () => {
    const dir = makeDir();
    const db = openDb(dir);
    seed(db);
    // A host and a mirrored path that both carry the markdown cell separator.
    db.exec(
      `INSERT INTO requests (id, page_id, url, scheme, host, path, path_template, query, method,
         resource_type, is_navigation, headers, wall_time)
       VALUES (9, 1, 'https://evil.test/a|b', 'https', 'evil|test', '/a|b', '/a|b', '', 'GET',
               'XHR', 0, '{}', '2026-09-18T10:00:09.000Z');
       INSERT INTO assets (request_id, url, kind, saved_path, body_hash, size, mime)
       VALUES (9, 'https://evil.test/a|b', 'css', 'site/evil|test/a_b.css', 'b2', 999, 'text/css')`
    );

    const md = buildReport(db, dir);

    // Cells are separated by unescaped pipes, so splitting on those must give every row in
    // a table the same width as its header. An unescaped pipe in the data breaks this.
    const cells = (row) => row.replace(/\\\|/g, '').split('|').length;
    const lines = md.split('\n');
    let header = null;
    let checked = 0;
    for (const line of lines) {
      if (!line.startsWith('|')) {
        header = null;
        continue;
      }
      if (header === null) {
        header = cells(line);
        continue;
      }
      if (/^\|[\s|:-]+\|$/.test(line)) continue; // the --- separator row
      assert.equal(cells(line), header, `ragged table row: ${line}`);
      checked++;
    }
    assert.ok(checked > 5, `expected to check several rows, checked ${checked}`);
    db.close();
  });

  it('surfaces a diagnostics section when queries failed', () => {
    const dir = makeDir();
    const db = openDb(dir);
    db.exec('DROP TABLE websockets');

    const md = buildReport(db, dir);

    assert.match(md, /Report diagnostics/);
    db.close();
  });
});

describe('buildLlmGuide', () => {
  it('documents the views an LLM is told to query', () => {
    const dir = seededCapture();
    const db = new DatabaseSync(path.join(dir, 'session.db'));

    const md = buildLlmGuide(db, dir);

    for (const view of ['v_calls', 'v_api', 'v_bodies']) {
      assert.match(md, new RegExp(view), `${view} should be documented`);
    }
    db.close();
  });
});

describe('generateAll', () => {
  it('writes every artifact and a manifest that parses', () => {
    const dir = seededCapture();

    const out = generateAll(dir);

    for (const f of ['REPORT.md', 'LLM_GUIDE.md', 'schema.sql', 'manifest.json']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${f} should exist`);
    }
    assert.equal(out.report, path.join(dir, 'REPORT.md'));
    assert.deepEqual(out.warnings, []);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.totals.requests, 4);
    assert.equal(manifest.base_host, 'example.com');
    assert.ok(Array.isArray(manifest.security_findings));
    assert.equal(manifest.artifacts.database, 'session.db');
  });

  it('is repeatable: regenerating does not accumulate warnings', () => {
    const dir = seededCapture();

    const first = generateAll(dir);
    const second = generateAll(dir);

    assert.deepEqual(second.warnings, first.warnings);
    assert.equal(
      fs.readFileSync(path.join(dir, 'LLM_GUIDE.md'), 'utf8').includes('v_api'),
      true
    );
  });

  it('refuses a directory that holds no capture', () => {
    const dir = makeDir();
    assert.throws(() => generateAll(dir), /No database/);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../src/db.js';
import { exportHar } from '../src/har.js';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-har-'));
}

// Writes a capture with one HTML navigation (body on disk), one POST carrying JSON, and one
// request blocked by the adblocker, which has no response at all.
function capture({ htmlBody = '<h1>hi</h1>' } = {}) {
  const dir = makeDir();
  const db = openDb(dir);

  const blob = (hash, rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    db.prepare(
      `INSERT INTO blobs (hash, size, mime, is_text, path, created_at)
       VALUES (?, ?, ?, 1, ?, '2026-09-18T10:00:00.000Z')`
    ).run(hash, Buffer.byteLength(content), 'text/html', rel);
  };

  blob('h1', 'blobs/h1/h1.html', htmlBody);
  blob('p1', 'blobs/p1/p1.json', '{"user":"me"}');

  db.exec(`
    INSERT INTO session (id, target_url, started_at) VALUES (1, 'https://example.com/', '2026-09-18T10:00:00.000Z');
    INSERT INTO pages (id, target_id, url, title, created_at)
    VALUES (1, 'page-1', 'https://example.com/', 'Example', '2026-09-18T10:00:00.000Z');

    INSERT INTO requests
      (id, page_id, url, scheme, host, path, path_template, query, method, resource_type,
       is_navigation, headers, post_data_hash, post_data_size, post_content_type, ts, wall_time)
    VALUES
      (1, 1, 'https://example.com/?a=1&b=2', 'https', 'example.com', '/', '/', 'a=1&b=2', 'GET',
       'Document', 1, '{"accept":"text/html","cookie":"sid=abc; t=1"}', NULL, NULL, NULL,
       100.0, '2026-09-18T10:00:01.000Z'),
      (2, 1, 'https://api.example.com/login', 'https', 'api.example.com', '/login', '/login', '',
       'POST', 'XHR', 0, '{}', 'p1', 13, 'application/json', 101.0, '2026-09-18T10:00:02.000Z'),
      (3, 1, 'https://ads.test/px.gif', 'https', 'ads.test', '/px.gif', '/px.gif', '', 'GET',
       'Image', 0, '{}', NULL, NULL, NULL, 102.0, '2026-09-18T10:00:03.000Z');

    INSERT INTO responses (request_id, status, status_text, mime_type, headers, body_hash,
                           body_size, encoded_size, remote_ip, remote_port, protocol, ts, finished_at)
    VALUES
      (1, 200, 'OK', 'text/html',
       '{"content-type":"text/html","set-cookie":"sid=abc; Path=/; HttpOnly","location":""}',
       'h1', ${Buffer.byteLength('<h1>hi</h1>')}, 90, '93.184.216.34', 443, 'h2', 100.1, 100.4),
      (2, 201, 'Created', 'application/json', '{"content-type":"application/json"}', NULL, NULL,
       20, '93.184.216.35', 443, 'h2', 101.1, 101.2);

    INSERT INTO failures (request_id, error_text, canceled, blocked)
    VALUES (3, 'net::ERR_BLOCKED_BY_CLIENT', 0, 1);
  `);
  db.close();
  return dir;
}

function readHar(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'session.har'), 'utf8'));
}

describe('exportHar', () => {
  it('produces a HAR 1.2 log with one entry per request', () => {
    const dir = capture();

    const out = exportHar(openDb(dir), dir);
    const har = readHar(dir);

    assert.equal(out.entries, 3);
    assert.equal(har.log.version, '1.2');
    assert.equal(har.log.entries.length, 3);
    assert.equal(har.log.pages.length, 1);
    assert.ok(out.bytes > 0);
  });

  it('is valid JSON even though it is streamed in chunks', () => {
    const dir = capture({ htmlBody: 'x'.repeat(3 * 1024 * 1024) });

    exportHar(openDb(dir), dir, { maxBodyBytes: 8 * 1024 * 1024 });

    assert.doesNotThrow(() => readHar(dir), 'the streamed HAR must parse');
  });

  it('carries the request side: query, cookies and post data', () => {
    const dir = capture();

    exportHar(openDb(dir), dir);
    const [nav, post] = readHar(dir).log.entries;

    assert.deepEqual(nav.request.queryString, [
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
    assert.deepEqual(
      nav.request.cookies.map((c) => c.name),
      ['sid', 't']
    );
    assert.equal(post.request.method, 'POST');
    assert.equal(post.request.postData.mimeType, 'application/json');
    assert.equal(post.request.postData.text, '{"user":"me"}');
  });

  it('inlines a response body it can read from blobs/', () => {
    const dir = capture();

    const out = exportHar(openDb(dir), dir);
    const [nav] = readHar(dir).log.entries;

    assert.equal(nav.response.content.text, '<h1>hi</h1>');
    assert.equal(nav.response.status, 200);
    assert.equal(out.withBody, 1);
  });

  it('parses set-cookie into HAR cookie objects', () => {
    const dir = capture();

    exportHar(openDb(dir), dir);
    const [nav] = readHar(dir).log.entries;

    const sid = nav.response.cookies.find((c) => c.name === 'sid');
    assert.ok(sid, 'set-cookie should be parsed');
    assert.equal(sid.value, 'abc');
    assert.equal(sid.httpOnly, true);
  });

  it('keeps a blocked request as an entry and marks why it failed', () => {
    const dir = capture();

    exportHar(openDb(dir), dir);
    const blocked = readHar(dir).log.entries.find((e) => e.request.url.includes('ads.test'));

    assert.ok(blocked, 'a blocked request is still part of the session');
    assert.equal(blocked.response.status, 0);
    assert.equal(blocked._blockedByClient, true);
    assert.match(blocked._error, /BLOCKED_BY_CLIENT/);
  });

  it('omits bodies over the limit without dropping the entry', () => {
    const dir = capture();

    const out = exportHar(openDb(dir), dir, { maxBodyBytes: 4 });
    const [nav] = readHar(dir).log.entries;

    assert.equal(out.entries, 3, 'entries stay');
    assert.equal(nav.response.content.text, undefined, 'the oversized body is gone');
    assert.ok(out.skippedBody >= 1);
  });

  it('drops every body when asked for none', () => {
    const dir = capture();

    exportHar(openDb(dir), dir, { bodies: 'none' });

    for (const e of readHar(dir).log.entries) {
      assert.equal(e.response.content.text, undefined);
    }
  });

  it('reports timings that add up to the entry time', () => {
    const dir = capture();

    exportHar(openDb(dir), dir);
    const [nav] = readHar(dir).log.entries;

    assert.ok(nav.time >= 0, 'time should be measured');
    for (const [k, v] of Object.entries(nav.timings)) {
      assert.ok(v === -1 || v >= 0, `timing ${k} must be -1 or non-negative, got ${v}`);
    }
  });
});

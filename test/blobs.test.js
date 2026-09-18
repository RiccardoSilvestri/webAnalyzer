import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BlobStore, extFor, looksUtf8 } from '../src/blobs.js';
import { mirrorPathFor } from '../src/mirror.js';

const dirs = [];
function makeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-blob-'));
  dirs.push(d);
  return d;
}

after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function fakeStmts() {
  const rows = new Map();
  return {
    rows,
    hasBlob: { get: (h) => (rows.has(h) ? 1 : undefined) },
    insertBlob: { run: (r) => rows.set(r.hash, r) },
  };
}

describe('extFor', () => {
  it('maps common mimes', () => {
    assert.equal(extFor('text/html'), 'html');
    assert.equal(extFor('application/javascript'), 'js');
    assert.equal(extFor('image/webp'), 'webp');
  });

  it('prefers woff2 over woff', () => {
    assert.equal(extFor('font/woff2'), 'woff2');
  });

  it('falls back to bin', () => {
    assert.equal(extFor('application/octet-stream'), 'bin');
    assert.equal(extFor(''), 'bin');
  });
});

describe('looksUtf8', () => {
  it('accepts plain text', () => {
    assert.equal(looksUtf8(Buffer.from('hello world')), true);
  });

  it('rejects buffers containing NUL', () => {
    assert.equal(looksUtf8(Buffer.from([0x61, 0x00, 0x62])), false);
  });

  it('rejects control-heavy binary', () => {
    assert.equal(looksUtf8(Buffer.from(Array.from({ length: 64 }, () => 0x01))), false);
  });
});

describe('BlobStore', () => {
  it('writes the file asynchronously and reports the pending write', async () => {
    const outDir = makeDir();
    const store = new BlobStore(outDir, fakeStmts());

    const blob = store.putText('plain text body', 'text/plain');
    assert.ok(blob.pending);
    await blob.pending;

    assert.equal(fs.readFileSync(path.join(outDir, blob.path), 'utf8'), 'plain text body');
    assert.equal(store.stats.stored, 1);
  });

  it('addresses content by sha256 so identical bodies share one file', async () => {
    const outDir = makeDir();
    const store = new BlobStore(outDir, fakeStmts());

    const a = store.putText('same', 'text/plain');
    const b = store.putText('same', 'text/plain');
    await store.drain();

    assert.equal(a.hash, b.hash);
    assert.equal(b.deduped, true);
    assert.equal(store.stats.stored, 1);
    assert.equal(store.stats.deduped, 1);
  });

  it('exposes decoded text for textual bodies only', () => {
    const outDir = makeDir();
    const store = new BlobStore(outDir, fakeStmts());

    assert.equal(store.putText('{"a":1}', 'application/json').text, '{"a":1}');
    assert.equal(store.put(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), 'image/png').text, null);
  });

  it('still previews a body too large to decode whole', () => {
    const outDir = makeDir();
    const stmts = fakeStmts();
    const store = new BlobStore(outDir, stmts, { maxTextBytes: 16, previewChars: 10 });

    const blob = store.putText('x'.repeat(5000), 'text/plain');

    assert.equal(blob.text, null);
    assert.match(stmts.rows.get(blob.hash).preview, /^x{10}…/);
  });

  it('ignores empty payloads', () => {
    const store = new BlobStore(makeDir(), fakeStmts());
    assert.equal(store.put(Buffer.alloc(0), 'text/plain'), null);
    assert.equal(store.putText('', 'text/plain'), null);
  });

  it('drain settles every queued write', async () => {
    const outDir = makeDir();
    const store = new BlobStore(outDir, fakeStmts());

    for (let i = 0; i < 40; i++) store.putText(`body ${i}`, 'text/plain');
    await store.drain();

    assert.equal(store.inflight.size, 0);
    assert.equal(store.stats.writeErrors, 0);
  });

  it('bounds the dedup cache without losing correctness', async () => {
    const outDir = makeDir();
    const stmts = fakeStmts();
    const store = new BlobStore(outDir, stmts, { seenCap: 4 });

    for (let i = 0; i < 12; i++) store.putText(`unico ${i}`, 'text/plain');
    await store.drain();

    assert.ok(store.seen.size <= 4);
    assert.equal(stmts.rows.size, 12);
  });
});

describe('mirrorPathFor', () => {
  it('rebuilds the site tree under the host', () => {
    assert.equal(
      mirrorPathFor('https://example.com/en/city/page', 'html'),
      path.join('site', 'example.com', 'en', 'city', 'page.html')
    );
  });

  it('names a bare directory request index', () => {
    assert.equal(mirrorPathFor('https://example.org/', 'html'), path.join('site', 'example.org', 'index.html'));
  });

  it('separates different query strings', () => {
    const a = mirrorPathFor('https://example.org/api?a=1', 'json');
    const b = mirrorPathFor('https://example.org/api?a=2', 'json');
    assert.notEqual(a, b);
    assert.match(a, /__q[0-9a-f]{8}\.json$/);
  });

  it('escapes windows reserved names', () => {
    assert.match(mirrorPathFor('https://example.org/con.txt', 'text'), /_con\.txt$/);
  });

  it('refuses non-network schemes', () => {
    assert.equal(mirrorPathFor('data:text/plain,hi', 'text'), null);
    assert.equal(mirrorPathFor('about:blank', 'html'), null);
  });

  it('keeps invalid urls out of the tree', () => {
    assert.match(mirrorPathFor('::nope::', 'html'), /_invalid/);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { WriteBatch, buildFts, ensureSchema, prepare } from '../src/db.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  ensureSchema(db);
  return db;
}

function countCookies(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM cookies').get().n;
}

function insertCookie(stmts, name) {
  return stmts.insertCookie.run('start', name, 'v', 'example.com', '/', null, 0, 1, 'Lax', '2026-09-18T00:00:00.000Z');
}

describe('WriteBatch', () => {
  it('commits buffered work on flush', () => {
    const db = freshDb();
    const batch = new WriteBatch(db);
    const stmts = prepare(db, batch);

    insertCookie(stmts, 'a');
    insertCookie(stmts, 'b');
    batch.flush();

    assert.equal(countCookies(db), 2);
    assert.equal(batch.commits, 1);
    assert.equal(batch.total, 2);
    db.close();
  });

  it('rolls back only the failed atomic group', () => {
    const db = freshDb();
    const batch = new WriteBatch(db);
    const stmts = prepare(db, batch);

    insertCookie(stmts, 'keep');
    batch.atomic(() => {
      insertCookie(stmts, 'discard');
      throw new Error('boom');
    });
    batch.flush();

    const names = db.prepare('SELECT name FROM cookies').all().map((r) => r.name);
    assert.deepEqual(names, ['keep']);
    assert.equal(batch.rollbacks, 1);
    db.close();
  });

  it('keeps an atomic group whole when it succeeds', () => {
    const db = freshDb();
    const batch = new WriteBatch(db);
    const stmts = prepare(db, batch);

    batch.atomic(() => {
      insertCookie(stmts, 'a');
      insertCookie(stmts, 'b');
    });
    batch.flush();

    assert.equal(countCookies(db), 2);
    assert.equal(batch.rollbacks, 0);
    db.close();
  });

  it('never commits midway through an atomic group', () => {
    const db = freshDb();
    const batch = new WriteBatch(db, { maxOps: 2 });
    const stmts = prepare(db, batch);

    batch.atomic(() => {
      for (let i = 0; i < 10; i++) insertCookie(stmts, `c${i}`);
      assert.equal(countCookies(db), 10);
      throw new Error('boom');
    });
    batch.flush();

    assert.equal(countCookies(db), 0);
    db.close();
  });

  it('reports transaction failures through onError', () => {
    const db = freshDb();
    const seen = [];
    const batch = new WriteBatch(db, { onError: (e) => seen.push(e.message) });
    const stmts = prepare(db, batch);

    batch.atomic(() => {
      insertCookie(stmts, 'x');
      throw new Error('deliberate');
    });

    assert.ok(seen.some((m) => /deliberate/.test(m)));
    db.close();
  });
});

describe('buildFts', () => {
  const dirs = [];
  const makeDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fts-'));
    dirs.push(d);
    return d;
  };

  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  const addBlob = (db, outDir, hash, text, { isText = 1, write = true } = {}) => {
    const rel = path.join('blobs', hash.slice(0, 2), `${hash}.txt`);
    if (write) {
      fs.mkdirSync(path.join(outDir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(outDir, rel), text);
    }
    db.prepare(
      `INSERT INTO blobs (hash, size, mime, is_text, path, preview, created_at) VALUES (?,?,?,?,?,?,?)`
    ).run(hash, Buffer.byteLength(text), 'text/plain', isText, rel, text.slice(0, 20), '2026-09-18T00:00:00.000Z');
  };

  it('indexes text blobs and makes them searchable', () => {
    const outDir = makeDir();
    const db = freshDb();
    addBlob(db, outDir, 'aa'.repeat(32), 'indexable text content');

    const res = buildFts(db, outDir);
    assert.equal(res.indexed, 1);

    const hit = db.prepare(`SELECT hash FROM blobs_fts WHERE blobs_fts MATCH ?`).get('indexable');
    assert.equal(hit.hash, 'aa'.repeat(32));
    db.close();
  });

  it('skips binary blobs', () => {
    const outDir = makeDir();
    const db = freshDb();
    addBlob(db, outDir, 'bb'.repeat(32), 'binary payload', { isText: 0 });

    assert.equal(buildFts(db, outDir).indexed, 0);
    db.close();
  });

  it('counts blobs whose file disappeared instead of failing', () => {
    const outDir = makeDir();
    const db = freshDb();
    addBlob(db, outDir, 'cc'.repeat(32), 'gone', { write: false });

    const res = buildFts(db, outDir);
    assert.equal(res.indexed, 0);
    assert.equal(res.missing, 1);
    db.close();
  });

  it('honours the size budget', () => {
    const outDir = makeDir();
    const db = freshDb();
    addBlob(db, outDir, 'dd'.repeat(32), 'x'.repeat(5000));

    assert.equal(buildFts(db, outDir, { maxBytes: 100 }).indexed, 0);
    assert.equal(buildFts(db, outDir, { maxBytes: 10000 }).indexed, 1);
    db.close();
  });

  it('is idempotent across repeated runs', () => {
    const outDir = makeDir();
    const db = freshDb();
    addBlob(db, outDir, 'ee'.repeat(32), 'indexable');

    buildFts(db, outDir);
    buildFts(db, outDir);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blobs_fts').get().n, 1);
    db.close();
  });
});

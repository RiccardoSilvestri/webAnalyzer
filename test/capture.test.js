import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Recorder } from '../src/capture.js';
import { Limiter } from '../src/limiter.js';
import { Store } from '../src/store.js';

function makeRecorder(opts = {}) {
  return new Recorder({
    db: null,
    stmts: {},
    blobs: { stats: {} },
    batch: null,
    outDir: '.',
    opts,
    log: null,
  });
}

function fill(map, n) {
  for (let i = 0; i < n; i++) map.set(`k${i}`, i);
}

describe('Recorder.sweep', () => {
  it('trims down to the requested target, not to an unrelated constant', () => {
    const rec = makeRecorder();
    fill(rec.records, 20100);

    rec.sweep(rec.records, 15000);

    assert.equal(rec.records.size, 15000);
    assert.equal(rec.counts.dropped, 5100);
  });

  it('leaves the map untouched when it is within budget', () => {
    const rec = makeRecorder();
    fill(rec.records, 100);

    assert.equal(rec.sweep(rec.records, 15000), 0);
    assert.equal(rec.records.size, 100);
    assert.equal(rec.counts.dropped, 0);
  });

  it('evicts the oldest entries first', () => {
    const rec = makeRecorder();
    fill(rec.records, 10);

    rec.sweep(rec.records, 4);

    assert.deepEqual([...rec.records.keys()], ['k6', 'k7', 'k8', 'k9']);
  });

  it('accounts every dropped record exactly once', () => {
    const rec = makeRecorder();
    fill(rec.records, 30);

    rec.sweep(rec.records, 20);
    rec.sweep(rec.records, 10);

    assert.equal(rec.counts.dropped, 20);
    assert.equal(rec.records.size, 10);
  });
});

describe('Recorder.accepts', () => {
  it('always keeps top level documents', () => {
    const rec = makeRecorder({ excludeFilter: () => true });
    assert.equal(rec.accepts('https://example.com/page', 'Document'), true);
  });

  it('applies exclude before include', () => {
    const rec = makeRecorder({ excludeFilter: (u) => u.includes('ads'), includeFilter: () => true });
    assert.equal(rec.accepts('https://example.com/ads.js', 'Script'), false);
  });

  it('drops anything outside include when include is set', () => {
    const rec = makeRecorder({ includeFilter: (u) => u.includes('example.com') });
    assert.equal(rec.accepts('https://example.com/a.js', 'Script'), true);
    assert.equal(rec.accepts('https://other.example.net/a.js', 'Script'), false);
  });

  it('keeps everything when no filter is configured', () => {
    const rec = makeRecorder();
    assert.equal(rec.accepts('https://example.com/a.js', 'Script'), true);
  });
});

describe('Recorder.stats', () => {
  it('reports null capture rate before any body is attempted', () => {
    assert.equal(makeRecorder().stats.body_capture_rate, null);
  });

  it('derives the capture rate from attempted bodies', () => {
    const rec = makeRecorder();
    rec.counts.bodies = 3;
    rec.counts.bodiesMissing = 1;
    assert.equal(rec.stats.body_capture_rate, 0.75);
  });
});

describe('Store', () => {
  it('returns the statement result when it succeeds', () => {
    const store = new Store({ stmts: {} });
    assert.equal(store.run('x', () => 42), 42);
    assert.equal(store.errors, 0);
  });

  it('swallows the failure but records it', () => {
    const store = new Store({ stmts: {} });
    const out = store.run('insertRequest', () => {
      throw new Error('constraint failed');
    });

    assert.equal(out, null);
    assert.equal(store.errors, 1);
    assert.equal(store.byLabel.get('insertRequest'), 1);
  });

  it('aggregates failures per statement', () => {
    const store = new Store({ stmts: {} });
    for (let i = 0; i < 3; i++) {
      store.run('insertBlob', () => {
        throw new Error('disk full');
      });
    }

    assert.deepEqual(store.stats, { errors: 3, by_statement: { insertBlob: 3 } });
  });

  it('forwards the message to the debug log', () => {
    const lines = [];
    const store = new Store({ stmts: {}, log: { debug: (m) => lines.push(m) } });
    store.run('insertAsset', () => {
      throw new Error('nope');
    });

    assert.match(lines[0], /insertAsset: nope/);
  });
});

describe('Limiter', () => {
  it('never exceeds the configured concurrency', async () => {
    const limiter = new Limiter(3);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.run(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
        })
      )
    );

    assert.ok(maxActive <= 3, `observed concurrency ${maxActive}`);
    assert.equal(limiter.idle, true);
  });

  it('propagates rejections without stalling the queue', async () => {
    const limiter = new Limiter(1);

    await assert.rejects(limiter.run(async () => {
      throw new Error('boom');
    }));
    assert.equal(await limiter.run(async () => 'ok'), 'ok');
    assert.equal(limiter.idle, true);
  });

  it('records the queue peak', async () => {
    const limiter = new Limiter(1);
    await Promise.all(Array.from({ length: 5 }, () => limiter.run(async () => {})));
    assert.ok(limiter.peak >= 4);
  });
});

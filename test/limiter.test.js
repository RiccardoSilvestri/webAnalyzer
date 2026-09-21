import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Limiter } from '../src/limiter.js';

const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Limiter', () => {
  it('never runs more than n tasks at once', async () => {
    const limiter = new Limiter(3);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.run(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await tick();
          active--;
        })
      )
    );

    assert.equal(maxActive, 3);
    assert.equal(active, 0);
  });

  it('treats a non-positive limit as one', async () => {
    const limiter = new Limiter(0);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.run(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await tick();
          active--;
        })
      )
    );

    assert.equal(maxActive, 1);
  });

  it('gives back each task’s own result', async () => {
    const limiter = new Limiter(2);

    const results = await Promise.all([1, 2, 3, 4].map((n) => limiter.run(async () => n * 10)));

    assert.deepEqual(results, [10, 20, 30, 40]);
  });

  it('rejects the failing task without disturbing the others', async () => {
    const limiter = new Limiter(2);

    const settled = await Promise.allSettled([
      limiter.run(async () => 'ok'),
      limiter.run(async () => {
        throw new Error('boom');
      }),
      limiter.run(async () => 'also ok'),
    ]);

    assert.deepEqual(
      settled.map((s) => s.status),
      ['fulfilled', 'rejected', 'fulfilled']
    );
    assert.equal(settled[1].reason.message, 'boom');
  });

  it('keeps draining after a task throws', async () => {
    const limiter = new Limiter(1);

    await limiter.run(async () => {
      throw new Error('boom');
    }).catch(() => {});
    const after = await limiter.run(async () => 'still working');

    assert.equal(after, 'still working');
    assert.ok(limiter.idle);
  });

  it('catches a synchronous throw as a rejection', async () => {
    const limiter = new Limiter(1);

    await assert.rejects(
      limiter.run(() => {
        throw new Error('sync boom');
      }),
      /sync boom/
    );
    assert.ok(limiter.idle);
  });

  it('reports the queue depth it had to hold', async () => {
    const limiter = new Limiter(1);
    const gate = deferred();

    const tasks = [
      limiter.run(() => gate.promise),
      limiter.run(async () => 'b'),
      limiter.run(async () => 'c'),
    ];
    await tick();
    assert.ok(limiter.queued >= 2, `expected a backlog, got ${limiter.queued}`);

    gate.resolve('a');
    await Promise.all(tasks);

    assert.ok(limiter.peak >= 2, `peak should record the backlog, got ${limiter.peak}`);
    assert.ok(limiter.idle);
    assert.equal(limiter.queued, 0);
  });

  it('is idle before anything is submitted', () => {
    assert.ok(new Limiter(4).idle);
  });
});

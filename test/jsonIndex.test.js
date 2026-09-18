import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flattenJson, parsePayload } from '../src/jsonIndex.js';

describe('parsePayload', () => {
  it('parses plain json', () => {
    assert.deepEqual(parsePayload('{"a":1}', 'application/json'), { a: 1 });
  });

  it('strips the anti-hijacking guard prefix', () => {
    assert.deepEqual(parsePayload(')]}\'\n{"a":1}', 'application/json'), { a: 1 });
  });

  it('strips the infinite-loop guard prefix', () => {
    assert.deepEqual(parsePayload('for(;;);{"a":1}', 'application/json'), { a: 1 });
  });

  it('unwraps jsonp', () => {
    assert.deepEqual(parsePayload('cb({"a":1});', 'text/javascript'), { a: 1 });
  });

  it('reassembles sse data lines', () => {
    assert.deepEqual(parsePayload('data: {"a":\ndata: 1}', 'text/event-stream'), { a: 1 });
  });

  it('collects ndjson into an array', () => {
    const out = parsePayload('{"a":1}\n{"a":2}', 'application/x-ndjson');
    assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
  });

  it('decodes form encoded bodies', () => {
    assert.deepEqual(parsePayload('a=1&b=x', 'application/x-www-form-urlencoded'), { a: '1', b: 'x' });
  });

  it('returns null for non-json text', () => {
    assert.equal(parsePayload('hello world', 'text/plain'), null);
    assert.equal(parsePayload('', 'application/json'), null);
  });

  it('refuses payloads beyond the parse budget', () => {
    assert.equal(parsePayload('{"a":1}', 'application/json', { maxParseBytes: 2 }), null);
  });
});

describe('flattenJson', () => {
  it('emits a dotted path per field', () => {
    const { keys } = flattenJson({ user: { email: 'a@b.c' } });
    assert.ok(keys.some((k) => k.key_path === 'user.email' && k.leaf === 'email'));
  });

  it('marks array hops with brackets', () => {
    const { keys } = flattenJson({ items: [{ id: 1 }] });
    assert.ok(keys.some((k) => k.key_path === 'items[].id'));
  });

  it('samples only the first items and flags truncation', () => {
    const { truncated } = flattenJson({ a: [1, 2, 3, 4, 5] }, { sampleItems: 2 });
    assert.equal(truncated, true);
  });

  it('stops at the key budget', () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const { keys, truncated } = flattenJson(big, { maxKeys: 10 });
    assert.equal(keys.length, 10);
    assert.equal(truncated, true);
  });

  it('stops at the depth budget', () => {
    const { truncated } = flattenJson({ a: { b: { c: { d: 1 } } } }, { maxDepth: 2 });
    assert.equal(truncated, true);
  });

  it('deduplicates identical path and type pairs', () => {
    const { keys } = flattenJson({ rows: [{ id: 1 }, { id: 2 }] });
    assert.equal(keys.filter((k) => k.key_path === 'rows[].id').length, 1);
  });

  it('reports the root type', () => {
    assert.equal(flattenJson([1, 2]).rootType, 'array');
    assert.equal(flattenJson({}).rootType, 'object');
  });

  it('records empty arrays as a leaf', () => {
    const { keys } = flattenJson({ tags: [] });
    assert.ok(keys.some((k) => k.key_path === 'tags[]' && k.value_type === 'empty'));
  });
});

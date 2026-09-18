import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assetKind,
  compileFilter,
  fmtBytes,
  fmtDuration,
  headerValue,
  headersToObj,
  isTextMime,
  looksJsonMime,
  parseCookieHeader,
  parseSetCookie,
  pathTemplate,
  registrableDomain,
  sameSite,
  splitUrl,
  truncate,
} from '../src/util.js';

describe('pathTemplate', () => {
  it('collapses numeric ids', () => {
    assert.equal(pathTemplate('/api/users/42/posts'), '/api/users/{num}/posts');
  });

  it('distinguishes timestamps from plain numbers', () => {
    assert.equal(pathTemplate('/t/1716393600000'), '/t/{ts}');
    assert.equal(pathTemplate('/t/999'), '/t/{num}');
  });

  it('collapses uuids, dates and hex blobs', () => {
    assert.equal(pathTemplate('/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301'), '/x/{uuid}');
    assert.equal(pathTemplate('/logs/2026-09-18'), '/logs/{date}');
    assert.equal(pathTemplate('/o/deadbeefdeadbeef'), '/o/{hex}');
  });

  it('keeps the bundle name and collapses only its hash', () => {
    assert.equal(pathTemplate('/static/main.4f3a2b1c.js'), '/static/main.{hash}.js');
    assert.equal(pathTemplate('/static/vendor-a1b2c3d4.css'), '/static/vendor-{hash}.css');
  });

  it('leaves readable segments alone', () => {
    assert.equal(pathTemplate('/en/city/page'), '/en/city/page');
  });

  it('normalises empty input', () => {
    assert.equal(pathTemplate(''), '/');
    assert.equal(pathTemplate('/'), '/');
  });
});

describe('splitUrl', () => {
  it('decomposes a full url', () => {
    const u = splitUrl('https://example.com/en/city/page?x=1');
    assert.equal(u.scheme, 'https');
    assert.equal(u.host, 'example.com');
    assert.equal(u.path, '/en/city/page');
    assert.equal(u.query, 'x=1');
  });

  it('degrades without throwing on garbage', () => {
    const u = splitUrl('not a url');
    assert.equal(u.host, '');
    assert.equal(u.scheme, '');
  });
});

describe('registrableDomain', () => {
  it('reduces to the registrable part', () => {
    assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  });

  it('honours multi-label public suffixes', () => {
    assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  });

  it('passes through ip literals', () => {
    assert.equal(registrableDomain('192.168.1.10'), '192.168.1.10');
  });

  it('drops the port', () => {
    assert.equal(registrableDomain('example.com:8443'), 'example.com');
  });
});

describe('sameSite', () => {
  it('matches across subdomains', () => {
    assert.equal(sameSite('cdn.example.com', 'www.example.com'), true);
  });

  it('separates distinct registrable domains', () => {
    assert.equal(sameSite('example.com', 'example.org'), false);
  });

  it('is false when either side is missing', () => {
    assert.equal(sameSite('', 'example.com'), false);
  });
});

describe('mime helpers', () => {
  it('classifies text mimes', () => {
    assert.equal(isTextMime('application/json'), true);
    assert.equal(isTextMime('image/svg+xml'), true);
    assert.equal(isTextMime('image/png'), false);
  });

  it('recognises json suffixes', () => {
    assert.equal(looksJsonMime('application/vnd.api+json'), true);
    assert.equal(looksJsonMime('text/html'), false);
  });

  it('derives asset kind from mime or extension', () => {
    assert.equal(assetKind('application/javascript', ''), 'js');
    assert.equal(assetKind('', 'https://example.com/app.woff2'), 'font');
    assert.equal(assetKind('', 'https://example.com/a.png?v=2'), 'image');
    assert.equal(assetKind('application/octet-stream', 'https://example.com/blob'), 'other');
  });
});

describe('headers', () => {
  it('lowercases keys', () => {
    assert.deepEqual(headersToObj({ 'Content-Type': 'text/html' }), { 'content-type': 'text/html' });
  });

  it('returns null for missing input', () => {
    assert.equal(headersToObj(null), null);
  });

  it('looks up case-insensitively', () => {
    assert.equal(headerValue({ 'content-type': 'a/b' }, 'Content-Type'), 'a/b');
    assert.equal(headerValue({}, 'x'), null);
  });
});

describe('formatting', () => {
  it('formats bytes', () => {
    assert.equal(fmtBytes(0), '0 B');
    assert.equal(fmtBytes(1536), '1.5 KB');
    assert.equal(fmtBytes(null), '-');
  });

  it('formats durations', () => {
    assert.equal(fmtDuration(45), '45s');
    assert.equal(fmtDuration(90), '1m 30s');
    assert.equal(fmtDuration(3700), '1h 1m');
  });

  it('marks truncation with the dropped length', () => {
    assert.equal(truncate('abcdef', 3), 'abc…[+3 chars]');
    assert.equal(truncate('ab', 5), 'ab');
  });
});

describe('compileFilter', () => {
  it('returns null without patterns', () => {
    assert.equal(compileFilter([]), null);
  });

  it('matches if any pattern matches', () => {
    const f = compileFilter(['\\.js$', 'api']);
    assert.equal(f('https://example.com/app.js'), true);
    assert.equal(f('https://example.com/api/v1'), true);
    assert.equal(f('https://example.com/a.png'), false);
  });

  it('reports the offending pattern', () => {
    assert.throws(() => compileFilter(['('], { name: '--include' }), /--include/);
  });
});

describe('cookie parsing', () => {
  it('reads attributes from set-cookie', () => {
    const [c] = parseSetCookie('sid=abc; Path=/; HttpOnly; SameSite=Lax');
    assert.equal(c.name, 'sid');
    assert.equal(c.value, 'abc');
    assert.equal(c.httpOnly, true);
    assert.equal(c.sameSite, 'Lax');
  });

  it('keeps values containing equals signs', () => {
    const [c] = parseSetCookie('t=a=b=c; Secure');
    assert.equal(c.value, 'a=b=c');
    assert.equal(c.secure, true);
  });

  it('splits a cookie request header', () => {
    assert.deepEqual(parseCookieHeader('a=1; b=2'), [
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
    assert.deepEqual(parseCookieHeader(''), []);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Mirror, mirrorPathFor } from '../src/mirror.js';

const p = (...segs) => path.join(...segs);

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mirror-'));
}

describe('mirrorPathFor', () => {
  it('maps host and path segments into site/', () => {
    assert.equal(mirrorPathFor('https://example.com/a/b/app.js', 'js'), p('site', 'example.com', 'a', 'b', 'app.js'));
  });

  it('names the root document index', () => {
    assert.equal(mirrorPathFor('https://example.com/', 'html'), p('site', 'example.com', 'index.html'));
  });

  it('adds an extension when the last segment has none', () => {
    assert.equal(mirrorPathFor('https://example.com/api/users', 'json'), p('site', 'example.com', 'api', 'users.json'));
  });

  it('leaves an existing extension alone', () => {
    assert.equal(mirrorPathFor('https://example.com/x.png', 'image'), p('site', 'example.com', 'x.png'));
  });

  it('keeps the port, which cannot appear in a filename', () => {
    assert.equal(mirrorPathFor('https://example.com:8443/x.png', 'image'), p('site', 'example.com_8443', 'x.png'));
  });

  it('distinguishes two query strings on the same path', () => {
    const a = mirrorPathFor('https://example.com/search?q=one', 'html');
    const b = mirrorPathFor('https://example.com/search?q=two', 'html');
    assert.notEqual(a, b);
    assert.match(path.basename(a), /^search__q[0-9a-f]{8}\.html$/);
  });

  it('is stable: the same url always maps to the same path', () => {
    const u = 'https://example.com/a/b?c=d';
    assert.equal(mirrorPathFor(u, 'html'), mirrorPathFor(u, 'html'));
  });

  it('escapes reserved Windows device names', () => {
    assert.equal(mirrorPathFor('https://example.com/CON.txt', 'text'), p('site', 'example.com', '_CON.txt'));
    assert.equal(mirrorPathFor('https://example.com/lpt1', 'text'), p('site', 'example.com', '_lpt1.txt'));
  });

  it('strips characters that are illegal in filenames', () => {
    const rel = mirrorPathFor('https://example.com/a b/c:d*e.css', 'css');
    assert.doesNotMatch(path.basename(rel), /[:*?"<>|]/);
  });

  it('refuses to escape the site directory', () => {
    for (const u of [
      'https://example.com/../../etc/passwd',
      'https://example.com/..%2f..%2fetc%2fpasswd',
      'https://example.com/./.././x',
    ]) {
      const rel = mirrorPathFor(u, 'text');
      const resolved = path.resolve('/root', rel);
      assert.ok(
        resolved.startsWith(path.resolve('/root', 'site') + path.sep),
        `${u} escaped to ${rel}`
      );
      assert.ok(!rel.split(path.sep).includes('..'), `${u} kept a .. segment`);
    }
  });

  it('shortens very long segments, keeping them unique and still openable', () => {
    const long = 'x'.repeat(400);
    const a = mirrorPathFor(`https://example.com/${long}a.css`, 'css');
    const b = mirrorPathFor(`https://example.com/${long}b.css`, 'css');
    const base = path.basename(a);

    // Well under the 255-byte limit every common filesystem imposes.
    assert.ok(base.length < 128, `basename was ${base.length} chars`);
    // The hash suffix lands before the extension, so the mirror stays browsable.
    assert.match(base, /~[0-9a-f]{8}\.css$/);
    assert.notEqual(a, b);
  });

  it('has nowhere to put pseudo-schemes', () => {
    assert.equal(mirrorPathFor('data:text/html,hello', 'html'), null);
    assert.equal(mirrorPathFor('blob:https://example.com/abc', 'html'), null);
    assert.equal(mirrorPathFor('about:blank', 'html'), null);
  });

  it('parks unparseable urls under _invalid instead of throwing', () => {
    const rel = mirrorPathFor('not a url at all', 'html');
    assert.equal(path.dirname(rel), p('site', '_invalid'));
    assert.match(path.basename(rel), /^[0-9a-f]{40}$/);
  });
});

describe('Mirror.write', () => {
  const html = (s) => Buffer.from(s, 'utf8');

  it('writes the body and reports where it landed', () => {
    const dir = makeDir();
    const m = new Mirror(dir, { link: false });

    const { rel, kind } = m.write('https://example.com/a.html', html('<p>hi</p>'), 'text/html');

    assert.equal(kind, 'html');
    assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), '<p>hi</p>');
    assert.equal(m.stats.files, 1);
    assert.equal(m.stats.copied, 1);
  });

  it('does not rewrite the same body fetched twice', () => {
    const dir = makeDir();
    const m = new Mirror(dir, { link: false });
    const buf = html('same');

    const first = m.write('https://example.com/a.html', buf, 'text/html', { hash: 'h1' });
    const second = m.write('https://example.com/a.html', buf, 'text/html', { hash: 'h1' });

    assert.equal(first.rel, second.rel);
    assert.equal(m.stats.files, 1);
    assert.equal(m.stats.reused, 1);
  });

  it('keeps both versions when one url serves different bodies', () => {
    const dir = makeDir();
    const m = new Mirror(dir, { link: false });

    const first = m.write('https://example.com/a.html', html('one'), 'text/html', { hash: 'h1' });
    const second = m.write('https://example.com/a.html', html('two!!'), 'text/html', { hash: 'h2' });

    assert.notEqual(first.rel, second.rel);
    assert.equal(m.stats.conflicts, 1);
    assert.equal(fs.readFileSync(path.join(dir, first.rel), 'utf8'), 'one');
    assert.equal(fs.readFileSync(path.join(dir, second.rel), 'utf8'), 'two!!');
  });

  it('hardlinks to the blob instead of copying when asked', () => {
    const dir = makeDir();
    const srcAbs = path.join(dir, 'blob.bin');
    fs.writeFileSync(srcAbs, 'shared');
    const m = new Mirror(dir, { link: true });

    const { rel } = m.write('https://example.com/a.html', html('shared'), 'text/html', { srcAbs, hash: 'h1' });

    assert.equal(m.stats.linked, 1);
    assert.equal(m.stats.copied, 0);
    assert.equal(m.stats.bytesSaved, 6);
    assert.equal(fs.statSync(path.join(dir, rel)).ino, fs.statSync(srcAbs).ino);
  });

  it('falls back to copying when the link cannot be made', () => {
    const dir = makeDir();
    const m = new Mirror(dir, { link: true });

    const { rel } = m.write('https://example.com/a.html', html('x'), 'text/html', {
      srcAbs: path.join(dir, 'does-not-exist'),
      hash: 'h1',
    });

    assert.equal(m.stats.linked, 0);
    assert.equal(m.stats.copied, 1);
    assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), 'x');
  });

  it('survives a path that is already a directory', () => {
    const dir = makeDir();
    const m = new Mirror(dir, { link: false });

    m.write('https://example.com/a/b.html', html('child'), 'text/html', { hash: 'h1' });
    const { rel } = m.write('https://example.com/a', html('parent'), 'text/html', { hash: 'h2' });

    assert.ok(rel, 'the parent path should still be written somewhere');
    assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), 'parent');
    assert.equal(m.stats.errors, 0);
  });

  it('reports no path for bodies that have nowhere to go', () => {
    const dir = makeDir();
    const m = new Mirror(dir, { link: false });

    const { rel } = m.write('data:text/html,x', html('x'), 'text/html');

    assert.equal(rel, null);
    assert.equal(m.stats.files, 0);
  });
});

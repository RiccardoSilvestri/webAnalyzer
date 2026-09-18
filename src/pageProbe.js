import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso, safe } from './util.js';

const SCREENSHOT_MIN_GAP_MS = 1500;
const STORAGE_VALUE_CAP = 200000;
const IDB_TIMEOUT_MS = 3000;

const METRIC_UNITS = {
  cumulative_layout_shift: 'score',
  dom_nodes: 'count',
  long_task_count: 'count',
  resources_count: 'count',
  js_heap_used: 'bytes',
  js_heap_limit: 'bytes',
  transfer_size: 'bytes',
  encoded_body_size: 'bytes',
  decoded_body_size: 'bytes',
};

function readVitals() {
  const nav = performance.getEntriesByType('navigation')[0] ?? {};
  const paint = {};
  for (const p of performance.getEntriesByType('paint')) paint[p.name] = p.startTime;
  const v = window.__waVitals ?? {};
  const mem = performance.memory ?? null;
  return {
    ttfb: nav.responseStart ?? null,
    dom_interactive: nav.domInteractive ?? null,
    dom_content_loaded: nav.domContentLoadedEventEnd ?? null,
    load_event: nav.loadEventEnd ?? null,
    response_end: nav.responseEnd ?? null,
    transfer_size: nav.transferSize ?? null,
    encoded_body_size: nav.encodedBodySize ?? null,
    decoded_body_size: nav.decodedBodySize ?? null,
    first_paint: paint['first-paint'] ?? null,
    first_contentful_paint: paint['first-contentful-paint'] ?? null,
    largest_contentful_paint: v.lcp ?? null,
    cumulative_layout_shift: v.cls ?? null,
    interaction_next_paint: v.inp ?? null,
    long_task_total: v.longTaskMs ?? null,
    long_task_count: v.longTasks ?? null,
    resources_count: performance.getEntriesByType('resource').length,
    dom_nodes: document.getElementsByTagName('*').length,
    js_heap_used: mem?.usedJSHeapSize ?? null,
    js_heap_limit: mem?.jsHeapSizeLimit ?? null,
  };
}

function readStorage({ cap, idbTimeout }) {
  const out = { origin: location.origin, local: [], session: [], idb: [] };

  const drain = (store, target) => {
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        target.push([k, String(store.getItem(k)).slice(0, cap)]);
      }
    } catch {}
  };
  drain(localStorage, out.local);
  drain(sessionStorage, out.session);

  if (!indexedDB.databases) return Promise.resolve(out);

  return indexedDB
    .databases()
    .then(async (dbs) => {
      for (const meta of dbs.slice(0, 10)) {
        const rows = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve([]), idbTimeout);
          const req = indexedDB.open(meta.name);
          req.onerror = () => {
            clearTimeout(timer);
            resolve([]);
          };
          req.onsuccess = () => {
            const db = req.result;
            const names = [...db.objectStoreNames];
            if (!names.length) {
              clearTimeout(timer);
              return resolve([]);
            }
            const acc = [];
            let left = names.length;
            const done = () => {
              if (--left === 0) {
                clearTimeout(timer);
                resolve(acc);
              }
            };
            const tx = db.transaction(names, 'readonly');
            for (const n of names) {
              const g = tx.objectStore(n).getAll(undefined, 200);
              g.onsuccess = () => {
                acc.push([n, JSON.stringify(g.result).slice(0, cap)]);
                done();
              };
              g.onerror = done;
            }
          };
        });
        for (const [store, json] of rows) out.idb.push([`${meta.name}/${store}`, json]);
      }
      return out;
    })
    .catch(() => out);
}

export class PageProbe {
  constructor({ store, stmts, blobs, batch, outDir, opts, log, counts }) {
    this.store = store;
    this.stmts = stmts;
    this.blobs = blobs;
    this.batch = batch;
    this.outDir = outDir;
    this.opts = opts;
    this.log = log;
    this.counts = counts;
    this.lastShot = new Map();
    this.stopped = false;
  }

  async killPopup(page, openerPageId) {
    this.counts.popupsKilled++;
    const url = await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 800 }).then(() => safe(() => page.url(), '')),
      new Promise((r) => setTimeout(() => r(safe(() => page.url(), '')), 800)),
    ]).catch(() => safe(() => page.url(), ''));
    this.store.timeline('popup', openerPageId, null, null, `popup closed automatically: ${url || '(about:blank)'}`);
    await page.close().catch(() => {});
  }

  async saveDownload(dl, pageId) {
    try {
      const dir = path.join(this.outDir, 'downloads');
      await fsp.mkdir(dir, { recursive: true });
      const name = (dl.suggestedFilename() || `download-${Date.now()}`).replace(/[^A-Za-z0-9._@()\-+,]/g, '_');
      const dest = path.join(dir, name);
      await dl.saveAs(dest);
      const buf = await fsp.readFile(dest);
      const blob = this.blobs.put(buf, '');
      this.store.run('insertAsset', () =>
        this.stmts.insertAsset.run(null, dl.url(), 'download', path.relative(this.outDir, dest), blob?.hash ?? null, buf.length, null)
      );
      this.store.timeline('download', pageId, 'assets', null, dl.url());
      this.log?.event?.('download', `${name} (${buf.length} byte)`);
    } catch (e) {
      this.log?.debug?.(`download not saved: ${e.message}`);
    }
  }

  async snapshot(page, pageId, phase) {
    if (this.stopped && phase !== 'final') return;
    if (phase === 'load') {
      await page.waitForLoadState('networkidle', { timeout: this.opts.settleMs ?? 3000 }).catch(() => {});
    }
    if (page.isClosed()) return;

    try {
      const html = await page.content();
      const blob = this.blobs.putText(html, 'text/html');
      this.store.run('insertDom', () =>
        this.stmts.insertDom.run(pageId, phase, page.url(), blob?.hash ?? null, blob?.size ?? 0, nowIso())
      );
      const rel = path.join('dom', `page${pageId}-${phase}.html`);
      await fsp.mkdir(path.join(this.outDir, 'dom'), { recursive: true });
      await fsp.writeFile(path.join(this.outDir, rel), html);
    } catch {}

    try {
      const url = page.url();
      const title = await page.title();
      this.store.run('updatePage', () => this.stmts.updatePage.run(url, title, pageId));
    } catch {
      this.store.run('setPageUrl', () => this.stmts.setPageUrl.run(safe(() => page.url(), null), pageId));
    }

    if (this.opts.metrics !== false) await this.captureMetrics(page, pageId, phase);
    if (this.opts.screenshots) await this.screenshot(page, pageId, phase);
    this.store.timeline('snapshot', pageId, 'dom_snapshots', null, `${phase}: ${safe(() => page.url(), '')}`);
  }

  async screenshot(page, pageId, phase) {
    const gapKey = `${pageId}:${phase}`;
    const last = this.lastShot.get(gapKey) ?? 0;
    if (phase !== 'final' && Date.now() - last < SCREENSHOT_MIN_GAP_MS) return;
    this.lastShot.set(gapKey, Date.now());
    try {
      const dir = path.join(this.outDir, 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const rel = path.join('screenshots', `page${pageId}-${phase}-${Date.now()}.png`);
      await page.screenshot({ path: path.join(this.outDir, rel), fullPage: this.opts.fullPageShots, timeout: 15000 });
      this.store.run('insertScreenshot', () => this.stmts.insertScreenshot.run(pageId, phase, rel, nowIso()));
      this.counts.screenshots++;
    } catch {}
  }

  async captureMetrics(page, pageId, phase) {
    let metrics;
    try {
      metrics = await page.evaluate(readVitals);
    } catch {
      return;
    }
    const url = safe(() => page.url(), null);
    const at = nowIso();
    this.batch.atomic(() => {
      this.stmts.clearMetrics.run(pageId, phase);
      for (const [metric, raw] of Object.entries(metrics)) {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) continue;
        this.stmts.insertMetric.run(pageId, phase, url, metric, value, METRIC_UNITS[metric] ?? 'ms', at);
        this.counts.metrics++;
      }
    });
  }

  async captureStorage(page, pageId) {
    if (page.isClosed()) return;
    let data;
    try {
      data = await page.evaluate(readStorage, { cap: STORAGE_VALUE_CAP, idbTimeout: IDB_TIMEOUT_MS });
    } catch {
      return;
    }
    const at = nowIso();
    this.batch.atomic(() => {
      this.stmts.clearStorage.run(pageId);
      for (const [kind, rows] of [
        ['local', data.local],
        ['session', data.session],
        ['indexeddb', data.idb],
      ]) {
        for (const [k, v] of rows) this.stmts.insertStorage.run(pageId, data.origin, kind, k, v, at);
      }
    });
  }

  async captureCookies(context, phase) {
    let cookies;
    try {
      cookies = await context.cookies();
    } catch (e) {
      this.log?.debug?.(`cookies (${phase}) not collected: ${e.message}`);
      return;
    }
    const at = nowIso();
    this.batch.atomic(() => {
      this.stmts.clearCookies.run(phase);
      for (const c of cookies) {
        this.stmts.insertCookie.run(
          phase,
          c.name,
          c.value,
          c.domain,
          c.path,
          c.expires ?? null,
          c.httpOnly ? 1 : 0,
          c.secure ? 1 : 0,
          c.sameSite ?? null,
          at
        );
      }
    });
    this.log?.debug?.(`cookies (${phase}): ${cookies.length}`);
  }

  async captureClientState(context) {
    const pages = context.pages().filter((p) => !p.isClosed() && p.__waPageId != null);
    for (const p of pages) {
      await this.captureStorage(p, p.__waPageId).catch(() => {});
      if (this.opts.metrics !== false) await this.captureMetrics(p, p.__waPageId, 'periodic').catch(() => {});
    }
    await this.captureCookies(context, 'end');
  }
}

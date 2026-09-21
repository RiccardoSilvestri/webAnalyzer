import { indexPayload } from './jsonIndex.js';
import { Limiter } from './limiter.js';
import { Mirror } from './mirror.js';
import { PageProbe } from './pageProbe.js';
import { Store } from './store.js';
import { assetKind, headerValue, headersToObj, looksJsonMime, nowIso, safe, splitUrl } from './util.js';

const MAX_TRACKED_RECORDS = 20000;
const TRACKED_RECORDS_KEEP = 15000;
const MAX_PENDING_EXTRA = 5000;
const PENDING_EXTRA_KEEP = 4000;

function mimeOnly(ct) {
  return (ct || '').split(';')[0].trim().toLowerCase();
}

export class Recorder {
  constructor({ db, stmts, blobs, batch, outDir, opts, log }) {
    this.db = db;
    this.stmts = stmts;
    this.blobs = blobs;
    this.batch = batch ?? { commits: 0, total: 0, enter() {}, flush: () => false, atomic: (fn) => fn() };
    this.outDir = outDir;
    this.opts = opts;
    this.log = log;
    this.store = new Store({ stmts, log });
    this.mirror = new Mirror(outDir, { link: opts.linkAssets !== false });
    this.records = new Map();
    this.reqExtra = new Map();
    this.respExtra = new Map();
    this.sockets = new Map();
    this.pageSeq = 0;
    this.sessionSeq = 0;
    this.pending = new Set();
    this.limiter = new Limiter(opts.bodyConcurrency ?? 24);
    this.attachedFrames = new WeakSet();
    this.jsonOpts = {
      maxKeys: opts.maxJsonKeys ?? undefined,
      maxDepth: opts.maxJsonDepth ?? undefined,
    };
    this.counts = {
      requests: 0,
      filtered: 0,
      bodies: 0,
      bodiesMissing: 0,
      bodiesSkipped: 0,
      json: 0,
      ws: 0,
      wsFrames: 0,
      sse: 0,
      errors: 0,
      blocked: 0,
      canceled: 0,
      popupsKilled: 0,
      assets: 0,
      screenshots: 0,
      metrics: 0,
      dropped: 0,
      headersDropped: 0,
    };
    this.probe = new PageProbe({
      store: this.store,
      stmts,
      blobs,
      batch: this.batch,
      outDir,
      opts,
      log,
      counts: this.counts,
    });
    this.stopped = false;
  }

  set stopped(v) {
    this._stopped = v;
    if (this.probe) this.probe.stopped = v;
  }

  get stopped() {
    return this._stopped;
  }

  get stats() {
    const attempted = this.counts.bodies + this.counts.bodiesMissing;
    return {
      ...this.counts,
      blobs: this.blobs.stats,
      mirror: this.mirror.stats,
      db: this.store.stats,
      body_capture_rate: attempted ? Number((this.counts.bodies / attempted).toFixed(4)) : null,
      body_queue_peak: this.limiter.peak,
      db_commits: this.batch?.commits ?? null,
      db_statements: this.batch?.total ?? null,
    };
  }

  accepts(url, resourceType) {
    if (!url) return true;
    if (resourceType === 'Document') return true;
    if (this.opts.excludeFilter?.(url)) return false;
    if (this.opts.includeFilter && !this.opts.includeFilter(url)) return false;
    return true;
  }

  track(promise) {
    const p = Promise.resolve(promise).catch((e) => this.log?.debug?.(`task: ${e?.message ?? e}`));
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
    return p;
  }

  async settle(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size && Date.now() < deadline) {
      const snapshot = [...this.pending];
      let timer = null;
      await Promise.race([
        Promise.allSettled(snapshot),
        new Promise((r) => {
          timer = setTimeout(r, Math.max(50, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
      await new Promise((r) => setImmediate(r));
    }
    if (this.pending.size) {
      this.log?.warn?.(`${this.pending.size} operations still pending after ${timeoutMs / 1000}s: giving up.`);
    }
    await this.blobs.drain();
  }

  sweep(map, keep, counter = 'dropped') {
    if (map.size <= keep) return 0;
    const excess = map.size - keep;
    let left = excess;
    for (const k of map.keys()) {
      map.delete(k);
      if (--left <= 0) break;
    }
    this.counts[counter] += excess;
    return excess;
  }

  registerPage(page, targetId, openerUrl) {
    this.store.run('insertPage', () =>
      this.stmts.insertPage.run(targetId, openerUrl ?? null, safe(() => page.url(), null), nowIso())
    );
    const row = this.store.run('pageIdByTarget', () => this.stmts.pageIdByTarget.get(targetId));
    return row?.id ?? null;
  }

  async attachPage(page, { opener = null } = {}) {
    const targetId = `page-${++this.pageSeq}`;
    const pageId = this.registerPage(page, targetId, opener);
    page.__waPageId = pageId;
    this.store.timeline('page', pageId, 'pages', pageId, `page opened: ${safe(() => page.url(), '')}`);
    this.log?.event?.('page', `opened page ${pageId}${opener ? ` (popup from ${opener})` : ''}`);

    let session;
    try {
      session = await page.context().newCDPSession(page);
    } catch (e) {
      this.log?.warn?.(`CDP unavailable for the page: ${e.message}`);
      return pageId;
    }
    await this.wireSession(session, pageId);
    this.track(this.seedFrameTree(session, pageId));
    this.wirePageEvents(page, pageId);
    return pageId;
  }

  wirePageEvents(page, pageId) {
    page.on('console', (msg) => {
      const loc = safe(() => msg.location(), {}) ?? {};
      const type = safe(() => msg.type(), 'log');
      const text = safe(() => msg.text(), '');
      this.store.run('insertConsole', () =>
        this.stmts.insertConsole.run(pageId, type, text, loc.url ?? null, loc.lineNumber ?? null, loc.columnNumber ?? null, null, nowIso())
      );
      if (type === 'error') {
        this.counts.errors++;
        this.store.timeline('error', pageId, 'console_logs', null, text.slice(0, 300));
      }
    });

    page.on('pageerror', (err) => {
      this.counts.errors++;
      this.store.run('insertJsError', () =>
        this.stmts.insertJsError.run(pageId, err.message, err.stack ?? null, safe(() => page.url(), null), nowIso())
      );
      this.store.timeline('error', pageId, 'js_errors', null, String(err.message).slice(0, 300));
    });

    page.on('framenavigated', (frame) => {
      const url = safe(() => frame.url(), '') ?? '';
      const isMain = frame === page.mainFrame();
      this.store.run('insertNavigation', () =>
        this.stmts.insertNavigation.run(pageId, null, url, isMain ? 'main' : 'subframe', nowIso())
      );
      if (isMain) {
        this.store.run('setPageUrl', () => this.stmts.setPageUrl.run(url, pageId));
        this.store.timeline('navigation', pageId, 'navigations', null, url);
        this.log?.event?.('nav', `page ${pageId} → ${url}`);
      }
      this.track(this.maybeAttachOopif(page, frame, pageId));
    });

    page.on('load', () => this.track(this.probe.snapshot(page, pageId, 'load')));
    page.on('close', () => this.store.run('closePage', () => this.stmts.closePage.run(nowIso(), pageId)));
    page.on('download', (dl) => this.track(this.probe.saveDownload(dl, pageId)));
    page.on('popup', (p) => {
      if (this.opts.killPopups) this.track(this.probe.killPopup(p, pageId));
      else this.track(this.attachPage(p, { opener: safe(() => page.url(), null) }));
    });
  }

  async seedFrameTree(session, pageId) {
    const tree = await session.send('Page.getFrameTree').catch(() => null);
    if (!tree?.frameTree) return;
    const walk = (node, parentId) => {
      const f = node.frame;
      if (!f?.id) return;
      this.upsertFrame({
        frame_id: f.id,
        page_id: pageId,
        parent_frame_id: f.parentId ?? parentId ?? null,
        url: f.url ?? null,
        name: f.name ?? null,
        is_oopif: 0,
      });
      for (const child of node.childFrames ?? []) walk(child, f.id);
    };
    walk(tree.frameTree, null);
  }

  upsertFrame(frame) {
    this.store.run('upsertFrame', () => this.stmts.upsertFrame.run({ ...frame, ts: nowIso() }));
  }

  async maybeAttachOopif(page, frame, pageId) {
    if (frame === page.mainFrame() || this.attachedFrames.has(frame)) return;
    const url = safe(() => frame.url(), '');
    if (!url || url === 'about:blank') return;
    const mainHost = splitUrl(safe(() => page.url(), '')).host;
    if (splitUrl(url).host === mainHost) return;
    this.attachedFrames.add(frame);
    try {
      const s = await page.context().newCDPSession(frame);
      await this.wireSession(s, pageId);
      const tree = await s.send('Page.getFrameTree').catch(() => null);
      const fid = tree?.frameTree?.frame?.id ?? null;
      if (fid) {
        this.upsertFrame({
          frame_id: fid,
          page_id: pageId,
          parent_frame_id: tree.frameTree.frame.parentId ?? null,
          url,
          name: safe(() => frame.name(), null),
          is_oopif: 1,
        });
      }
    } catch {}
  }

  async wireSession(session, pageId) {
    const sid = `s${++this.sessionSeq}`;
    const key = (id) => `${sid}:${id}`;

    session.on('Network.requestWillBeSent', (e) => this.onRequest(session, key(e.requestId), e, pageId));
    session.on('Network.requestWillBeSentExtraInfo', (e) => this.onRequestExtra(key(e.requestId), e));
    session.on('Network.responseReceived', (e) => this.onResponse(key(e.requestId), e));
    session.on('Network.responseReceivedExtraInfo', (e) => this.onResponseExtra(key(e.requestId), e));
    session.on('Network.requestServedFromCache', (e) => {
      const rec = this.records.get(key(e.requestId));
      if (rec) this.store.run('setServedFromCache', () => this.stmts.setServedFromCache.run(rec.dbId));
    });
    session.on('Network.dataReceived', (e) => {
      const rec = this.records.get(key(e.requestId));
      if (rec) rec.encoded = (rec.encoded ?? 0) + (e.encodedDataLength ?? 0);
    });
    session.on('Network.loadingFinished', (e) => this.track(this.onFinished(session, key(e.requestId), e)));
    session.on('Network.loadingFailed', (e) => this.onFailed(key(e.requestId), e));
    session.on('Network.eventSourceMessageReceived', (e) => this.onSse(key(e.requestId), e));

    session.on('Network.webSocketCreated', (e) => this.onWsCreated(key(e.requestId), e, pageId));
    session.on('Network.webSocketWillSendHandshakeRequest', (e) => {
      const ws = this.sockets.get(key(e.requestId));
      if (ws) {
        this.store.run('setWsHandshake', () =>
          this.stmts.setWsHandshake.run(JSON.stringify(headersToObj(e.request?.headers)), null, ws.dbId)
        );
      }
    });
    session.on('Network.webSocketHandshakeResponseReceived', (e) => {
      const ws = this.sockets.get(key(e.requestId));
      if (ws) {
        this.store.run('setWsHandshake', () =>
          this.stmts.setWsHandshake.run(null, JSON.stringify(headersToObj(e.response?.headers)), ws.dbId)
        );
      }
    });
    session.on('Network.webSocketFrameSent', (e) => this.onWsFrame(key(e.requestId), e, 'sent'));
    session.on('Network.webSocketFrameReceived', (e) => this.onWsFrame(key(e.requestId), e, 'received'));
    session.on('Network.webSocketFrameError', (e) => {
      const ws = this.sockets.get(key(e.requestId));
      if (ws) this.store.run('closeWebsocket', () => this.stmts.closeWebsocket.run(null, e.errorMessage ?? null, ws.dbId));
    });
    session.on('Network.webSocketClosed', (e) => {
      const k = key(e.requestId);
      const ws = this.sockets.get(k);
      if (ws) {
        this.store.run('closeWebsocket', () => this.stmts.closeWebsocket.run(e.timestamp ?? null, null, ws.dbId));
        this.sockets.delete(k);
      }
    });

    const onFrame = (frameId, parentId, url, name) =>
      this.upsertFrame({ frame_id: frameId, page_id: pageId, parent_frame_id: parentId ?? null, url: url ?? null, name: name ?? null, is_oopif: 0 });

    session.on('Page.frameAttached', (e) => onFrame(e.frameId, e.parentFrameId, null, null));
    session.on('Page.frameNavigated', (e) => onFrame(e.frame?.id, e.frame?.parentId, e.frame?.url, e.frame?.name));

    try {
      await session.send('Network.enable', {
        maxTotalBufferSize: this.opts.networkBuffer ?? 512 * 1024 * 1024,
        maxResourceBufferSize: this.opts.resourceBuffer ?? 128 * 1024 * 1024,
        maxPostDataSize: 16 * 1024 * 1024,
      });
      if (this.opts.disableCache) await session.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (this.opts.insecureTls) {
        await session.send('Security.setIgnoreCertificateErrors', { ignore: true }).catch(() => {});
      }
      await session.send('Page.enable').catch(() => {});
      await session.send('Runtime.enable').catch(() => {});
    } catch (e) {
      const gone = /has been closed|Target closed|Session closed|detached/i.test(e.message ?? '');
      if (gone) this.log?.debug?.(`Network.enable on an already closed target: ${e.message}`);
      else this.log?.warn?.(`Network.enable failed: ${e.message}`);
    }
    return session;
  }

  onRequest(session, k, e, pageId) {
    const prev = this.records.get(k);
    if (e.redirectResponse && prev) {
      this.writeResponseRow(prev.dbId, e.redirectResponse, e.timestamp);
      this.store.run('setResponseBody', () =>
        this.stmts.setResponseBody.run({
          request_id: prev.dbId,
          body_hash: null,
          body_size: null,
          body_error: 'redirect (no body)',
          encoded_size: null,
          finished_at: e.timestamp ?? null,
        })
      );
    }

    if (!this.accepts(e.request?.url, e.type)) {
      this.counts.filtered++;
      this.records.delete(k);
      return;
    }

    if (this.records.size > MAX_TRACKED_RECORDS) this.sweep(this.records, TRACKED_RECORDS_KEEP);

    const u = splitUrl(e.request.url);
    const headers = headersToObj(e.request.headers);
    const ct = headerValue(headers, 'content-type') ?? '';
    const postBlob =
      typeof e.request.postData === 'string' && e.request.postData.length
        ? this.blobs.putText(e.request.postData, mimeOnly(ct) || 'text/plain')
        : null;

    const info = this.store.run('insertRequest', () =>
      this.stmts.insertRequest.run({
        page_id: pageId,
        cdp_request_id: e.requestId,
        loader_id: e.loaderId ?? null,
        frame_id: e.frameId ?? null,
        url: e.request.url,
        scheme: u.scheme,
        host: u.host,
        path: u.path,
        path_template: u.path_template,
        query: u.query,
        method: e.request.method,
        resource_type: e.type ?? null,
        is_navigation: e.type === 'Document' ? 1 : 0,
        document_url: e.documentURL ?? null,
        initiator_type: e.initiator?.type ?? null,
        initiator_url: e.initiator?.url ?? null,
        initiator_stack: e.initiator?.stack ? JSON.stringify(e.initiator.stack) : null,
        headers: headers ? JSON.stringify(headers) : null,
        post_data_hash: postBlob?.hash ?? null,
        post_data_size: postBlob?.size ?? null,
        post_content_type: mimeOnly(ct) || null,
        redirect_from: e.redirectResponse && prev ? prev.dbId : null,
        ts: e.timestamp ?? null,
        wall_time: e.wallTime ? new Date(e.wallTime * 1000).toISOString() : nowIso(),
      })
    );
    if (!info) return;
    const dbId = Number(info.lastInsertRowid);

    this.counts.requests++;
    const rec = {
      dbId,
      cdpId: e.requestId,
      url: e.request.url,
      method: e.request.method,
      type: e.type,
      mime: null,
      pageId,
      encoded: 0,
      postHash: postBlob?.hash ?? null,
      contentType: mimeOnly(ct),
    };
    this.records.set(k, rec);

    if (postBlob && this.opts.indexJson) {
      this.indexJson({
        requestId: dbId,
        direction: 'request',
        blobHash: postBlob.hash,
        text: e.request.postData,
        contentType: ct,
        size: postBlob.size,
      });
    } else if (e.request.hasPostData && !postBlob) {
      this.track(this.fetchPostData(session, e.requestId, rec, ct));
    }

    const pendingReq = this.reqExtra.get(k);
    if (pendingReq) {
      this.store.run('setRequestExtraHeaders', () => this.stmts.setRequestExtraHeaders.run(JSON.stringify(pendingReq), dbId));
      this.reqExtra.delete(k);
    }
    const pendingResp = this.respExtra.get(k);
    if (pendingResp) {
      this.store.run('setResponseExtraHeaders', () => this.stmts.setResponseExtraHeaders.run(dbId, JSON.stringify(pendingResp)));
      this.respExtra.delete(k);
    }
  }

  indexJson(payload) {
    const id = this.store.run('indexPayload', () => indexPayload(this.stmts, payload, this.jsonOpts));
    if (id) this.counts.json++;
    return id;
  }

  async fetchPostData(session, cdpId, rec, ct) {
    try {
      const { postData } = await session.send('Network.getRequestPostData', { requestId: cdpId });
      if (!postData) return;
      const blob = this.blobs.putText(postData, mimeOnly(ct) || 'text/plain');
      if (!blob) return;
      this.store.run('setPostData', () => this.stmts.setPostData.run(blob.hash, blob.size, rec.dbId));
      rec.postHash = blob.hash;
      if (this.opts.indexJson) {
        this.indexJson({
          requestId: rec.dbId,
          direction: 'request',
          blobHash: blob.hash,
          text: postData,
          contentType: ct,
          size: blob.size,
        });
      }
    } catch {}
  }

  onRequestExtra(k, e) {
    const headers = headersToObj(e.headers);
    const rec = this.records.get(k);
    if (rec) {
      this.store.run('setRequestExtraHeaders', () => this.stmts.setRequestExtraHeaders.run(JSON.stringify(headers), rec.dbId));
      return;
    }
    this.reqExtra.set(k, headers);
    if (this.reqExtra.size > MAX_PENDING_EXTRA) this.sweep(this.reqExtra, PENDING_EXTRA_KEEP, 'headersDropped');
  }

  writeResponseRow(dbId, r, ts) {
    this.store.run('insertResponse', () =>
      this.stmts.insertResponse.run({
        request_id: dbId,
        status: r.status ?? null,
        status_text: r.statusText ?? null,
        headers: r.headers ? JSON.stringify(headersToObj(r.headers)) : null,
        mime_type: r.mimeType ?? null,
        remote_ip: r.remoteIPAddress ?? null,
        remote_port: r.remotePort ?? null,
        protocol: r.protocol ?? null,
        from_disk_cache: r.fromDiskCache ? 1 : 0,
        from_service_worker: r.fromServiceWorker ? 1 : 0,
        from_prefetch: r.fromPrefetchCache ? 1 : 0,
        encoded_size: r.encodedDataLength ?? null,
        timing: r.timing ? JSON.stringify(r.timing) : null,
        security_state: r.securityState ?? null,
        ts: ts ?? null,
      })
    );
  }

  onResponse(k, e) {
    const rec = this.records.get(k);
    if (!rec) return;
    const headers = headersToObj(e.response?.headers);
    rec.mime = e.response?.mimeType ?? null;
    rec.status = e.response?.status ?? null;
    rec.respContentType = headerValue(headers, 'content-type') || rec.mime;
    this.writeResponseRow(rec.dbId, e.response ?? {}, e.timestamp);

    const pendingExtra = this.respExtra.get(k);
    if (pendingExtra) {
      this.store.run('setResponseExtraHeaders', () => this.stmts.setResponseExtraHeaders.run(rec.dbId, JSON.stringify(pendingExtra)));
      this.respExtra.delete(k);
    }
  }

  onResponseExtra(k, e) {
    const headers = headersToObj(e.headers);
    const rec = this.records.get(k);
    if (rec) {
      this.store.run('setResponseExtraHeaders', () => this.stmts.setResponseExtraHeaders.run(rec.dbId, JSON.stringify(headers)));
      return;
    }
    this.respExtra.set(k, headers);
    if (this.respExtra.size > MAX_PENDING_EXTRA) this.sweep(this.respExtra, PENDING_EXTRA_KEEP, 'headersDropped');
  }

  async onFinished(session, k, e) {
    const rec = this.records.get(k);
    if (!rec) return;
    this.records.delete(k);
    const encoded = e.encodedDataLength || rec.encoded || 0;

    const finish = (body_hash, body_size, body_error) =>
      this.store.run('setResponseBody', () =>
        this.stmts.setResponseBody.run({
          request_id: rec.dbId,
          body_hash,
          body_size,
          body_error,
          encoded_size: encoded || null,
          finished_at: e.timestamp ?? null,
        })
      );

    if (this.opts.maxBody > 0 && encoded > this.opts.maxBody) {
      this.counts.bodiesSkipped++;
      finish(null, null, `skipped: ${encoded} bytes over --max-body`);
      return;
    }

    let body = null;
    let base64 = false;
    let err = null;
    try {
      const res = await this.limiter.run(() => session.send('Network.getResponseBody', { requestId: rec.cdpId }));
      body = res.body;
      base64 = res.base64Encoded;
    } catch (e2) {
      err = e2?.message ?? String(e2);
    }

    if (body == null) {
      this.counts.bodiesMissing++;
      finish(null, null, err ?? 'body no longer available');
      return;
    }

    const buf = base64 ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
    if (!buf.length) {
      finish(null, 0, null);
      return;
    }

    const mime = mimeOnly(rec.respContentType || rec.mime || '');
    const blob = this.blobs.put(buf, mime);
    if (!blob) {
      this.counts.bodiesMissing++;
      finish(null, 0, 'blob not writable');
      return;
    }
    this.counts.bodies++;
    finish(blob.hash, blob.size, null);

    if (this.opts.saveAssets && (rec.status ?? 200) < 400) {
      if (blob.pending) await blob.pending;
      const { rel, kind } = this.mirror.write(rec.url, buf, mime, { srcAbs: blob.abs, hash: blob.hash });
      if (rel) this.counts.assets++;
      this.store.run('insertAsset', () =>
        this.stmts.insertAsset.run(rec.dbId, rec.url, kind, rel, blob.hash, blob.size, mime || null)
      );
    }

    if (this.opts.indexJson && blob.isText && blob.text) {
      const head = blob.text.trimStart().slice(0, 2);
      const isJsonish = looksJsonMime(mime) || assetKind(mime, rec.url) === 'json' || /^[[{]/.test(head);
      if (isJsonish) {
        this.indexJson({
          requestId: rec.dbId,
          direction: 'response',
          blobHash: blob.hash,
          text: blob.text,
          contentType: rec.respContentType || mime,
          size: blob.size,
        });
      }
    }
  }

  onFailed(k, e) {
    const rec = this.records.get(k);
    if (!rec) return;
    this.records.delete(k);
    const isBlocked = /ERR_BLOCKED_BY_CLIENT/.test(e.errorText ?? '');
    if (isBlocked) this.counts.blocked++;
    else if (e.canceled) this.counts.canceled++;
    else this.counts.errors++;

    this.store.run('insertFailure', () =>
      this.stmts.insertFailure.run(
        rec.dbId,
        e.errorText ?? null,
        e.canceled ? 1 : 0,
        isBlocked ? 1 : 0,
        e.blockedReason ?? null,
        e.corsErrorStatus ? JSON.stringify(e.corsErrorStatus) : null,
        e.timestamp ?? null
      )
    );
    if (isBlocked) {
      this.store.timeline('blocked', rec.pageId, 'failures', rec.dbId, `blocked by uBlock: ${rec.url}`);
      this.log?.debug?.(`blocked: ${rec.url}`);
    } else if (!e.canceled) {
      this.store.timeline('error', rec.pageId, 'failures', rec.dbId, `${rec.method} ${rec.url} -> ${e.errorText}`);
    }
  }

  onSse(k, e) {
    const rec = this.records.get(k);
    const blob = this.blobs.putText(e.data ?? '', 'text/event-stream');
    if (!blob) return;
    this.counts.sse++;
    this.store.run('insertSse', () =>
      this.stmts.insertSse.run(rec?.dbId ?? null, e.eventName ?? null, e.eventId ?? null, blob.hash, blob.size, e.timestamp ?? null)
    );
    if (this.opts.indexJson && blob.text) {
      this.indexJson({
        requestId: rec?.dbId ?? null,
        direction: 'sse',
        blobHash: blob.hash,
        text: blob.text,
        contentType: 'application/json',
        size: blob.size,
      });
    }
  }

  onWsCreated(k, e, pageId) {
    if (!this.accepts(e.url, 'WebSocket')) {
      this.counts.filtered++;
      return;
    }
    const info = this.store.run('insertWebsocket', () =>
      this.stmts.insertWebsocket.run(pageId, e.requestId, e.url, Date.now() / 1000)
    );
    if (!info) return;
    const dbId = Number(info.lastInsertRowid);
    this.sockets.set(k, { dbId, url: e.url });
    this.counts.ws++;
    this.store.timeline('websocket', pageId, 'websockets', dbId, `ws open: ${e.url}`);
  }

  onWsFrame(k, e, direction) {
    const ws = this.sockets.get(k);
    if (!ws) return;
    const payload = e.response?.payloadData ?? '';
    const opcode = e.response?.opcode ?? 1;
    const blob =
      opcode === 2
        ? this.blobs.put(Buffer.from(payload, 'base64'), 'application/octet-stream')
        : this.blobs.putText(payload, 'text/plain');
    if (!blob) return;
    this.counts.wsFrames++;
    const trimmed = typeof blob.text === 'string' ? blob.text.trimStart() : '';
    const isJson = /^[[{]/.test(trimmed.slice(0, 2));
    const info = this.store.run('insertWsFrame', () =>
      this.stmts.insertWsFrame.run(ws.dbId, direction, opcode, blob.hash, blob.size, isJson ? 1 : 0, e.timestamp ?? null)
    );
    if (isJson && this.opts.indexJson && info) {
      this.indexJson({
        wsFrameId: Number(info.lastInsertRowid),
        direction: direction === 'sent' ? 'ws_sent' : 'ws_received',
        blobHash: blob.hash,
        text: blob.text,
        contentType: 'application/json',
        size: blob.size,
      });
    }
  }
}

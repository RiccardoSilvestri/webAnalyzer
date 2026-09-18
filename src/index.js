#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BlobStore } from './blobs.js';
import { Recorder } from './capture.js';
import { WriteBatch, buildFts, openDb, optimize, prepare, walCheckpoint } from './db.js';
import { exportHar } from './har.js';
import { Logger } from './logger.js';
import { askUrl, askYesNo } from './prompt.js';
import { generateAll } from './report.js';
import * as ublock from './ublock.js';
import { compileFilter, fmtBytes, fmtDuration, nowIso, splitUrl } from './util.js';

const VITALS_INIT = `(() => {
  if (window.__waVitals) return;
  const v = { lcp: 0, cls: 0, inp: 0, longTasks: 0, longTaskMs: 0 };
  Object.defineProperty(window, '__waVitals', { value: v, configurable: false, enumerable: false });
  const obs = (type, fn, extra) => {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) fn(e); })
        .observe({ type, buffered: true, ...extra });
    } catch {}
  };
  obs('largest-contentful-paint', (e) => { v.lcp = Math.max(v.lcp, e.startTime); });
  obs('layout-shift', (e) => { if (!e.hadRecentInput) v.cls += e.value; });
  obs('longtask', (e) => { v.longTasks++; v.longTaskMs += e.duration; });
  obs('event', (e) => { v.inp = Math.max(v.inp, e.duration); }, { durationThreshold: 40 });
})();`;

const HELP = `
webAnalyzer — launches an instrumented Chromium and records everything the site does.

  node src/index.js [url] [options]    without a url it asks for one in a dialog window
  node src/report.js <directory>       regenerate only the reports from an existing capture

Options
  --out <dir>        output directory (default: captures/<host>-<timestamp>)
  --append           add to an existing capture instead of refusing to overwrite it
  --profile <dir>    persistent Chrome profile (default: inside --out, use a fixed one to stay logged in)
  --tmp-profile      keep the profile in a temporary directory, not inside --out (lighter capture)
  --headless         no window (WARNING: uBlock does not start in headless, no adblock)
  --timeout <sec>    close automatically after N seconds (default: 0 = until Ctrl+C)
  --max-body <MB>    do not save bodies above this size (default: 25, 0 = no limit)
  --keep-cache       leave the HTTP cache on (default: off, so every body stays capturable)
  --include <regex>  capture only matching urls (repeatable; documents always pass)
  --exclude <regex>  discard matching urls (repeatable; takes precedence over --include)
  --no-assets        do not rebuild the site tree in site/
  --copy-assets      copy files into site/ instead of hardlinking them to blobs/ (doubles disk use)
  --no-json          do not index JSON payloads
  --no-fts           do not build the full-text index (faster close, much smaller DB)
  --no-metrics       do not measure page performance (Web Vitals)
  --no-screenshots   no screenshots
  --full-page        full-page screenshots
  --no-har           do not generate session.har
  --har-bodies <m>   bodies in the HAR: text (default) | all | none
  --har-max-body <MB> per-body limit for what goes into the HAR (default: 2)
  --ublock           force uBlock Origin Lite (downloads it if missing, without asking)
  --no-ublock        do not load uBlock Origin Lite
  --proxy <host:port> HTTP proxy used only to download uBlock (default: HTTPS_PROXY)
  --kill-popups      immediately close popup/popunder windows (useful on ad-heavy sites)
  --strict-tls       restore certificate validation (default: self-signed, expired or
                     wrong-hostname certificates are accepted without an interstitial,
                     so internal https appliances work)
  --real-chrome      use real Chrome instead of the bundled Chromium (WARNING: real Chrome
                     refuses extensions loaded from the command line, this disables uBlock)
  --viewport <WxH>   initial window size (default: 1440x900). With a real window the page
                     follows resizing; passing --viewport pins it to that size (useful for
                     reproducible screenshots)
  --device-scale <n> device pixel ratio (default: 1)
  --ua <string>      custom user agent
  --quiet            less terminal output (session.log stays complete either way)
  --verbose          also log fine-grained events

If you do not pass a url, webAnalyzer asks for one in a system dialog window and then
asks whether you want ad blocking (falling back to the terminal when there is no
graphical interface). A bare IP works too: 192.168.1.10:8080 becomes
http://192.168.1.10:8080. If you answer yes and uBlock is missing, it is downloaded.

During the capture you can browse, click and log in by hand: everything is recorded.
Press Ctrl+C to stop and generate the reports (twice to quit immediately).
`;

function parseArgs(argv) {
  const o = {
    url: null,
    out: null,
    append: false,
    profile: null,
    tmpProfile: false,
    headless: false,
    timeout: 0,
    maxBody: 25 * 1024 * 1024,
    disableCache: true,
    include: [],
    exclude: [],
    saveAssets: true,
    linkAssets: true,
    indexJson: true,
    fts: true,
    metrics: true,
    screenshots: true,
    fullPageShots: false,
    har: true,
    harBodies: 'text',
    harMaxBody: 2 * 1024 * 1024,
    ublock: true,
    ublockExplicit: false,
    proxy: null,
    killPopups: false,
    insecureTls: true,
    realChrome: false,
    bodyConcurrency: 24,
    viewport: { width: 1440, height: 900 },
    viewportExplicit: false,
    deviceScale: 1,
    ua: null,
    quiet: false,
    verbose: false,
  };
  const rest = [];
  const fail = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail(`Option ${a} requires a value.`);
      return v;
    };
    const numArg = (min, max) => {
      const raw = next();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min || (max != null && n > max)) fail(`Invalid value for ${a}: ${raw}`);
      return n;
    };
    switch (a) {
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      case '--out': o.out = next(); break;
      case '--append': o.append = true; break;
      case '--profile': o.profile = next(); break;
      case '--tmp-profile': o.tmpProfile = true; break;
      case '--headless': o.headless = true; break;
      case '--timeout': o.timeout = numArg(0); break;
      case '--max-body': o.maxBody = Math.round(numArg(0) * 1024 * 1024); break;
      case '--keep-cache': o.disableCache = false; break;
      case '--include': o.include.push(next()); break;
      case '--exclude': o.exclude.push(next()); break;
      case '--no-assets': o.saveAssets = false; break;
      case '--copy-assets': o.linkAssets = false; break;
      case '--no-json': o.indexJson = false; break;
      case '--no-fts': o.fts = false; break;
      case '--no-metrics': o.metrics = false; break;
      case '--no-screenshots': o.screenshots = false; break;
      case '--full-page': o.fullPageShots = true; break;
      case '--no-har': o.har = false; break;
      case '--har-bodies': {
        const v = next();
        if (!['text', 'all', 'none'].includes(v)) fail(`--har-bodies accepts text, all or none (given: ${v})`);
        o.harBodies = v;
        break;
      }
      case '--har-max-body': o.harMaxBody = Math.round(numArg(0) * 1024 * 1024); break;
      case '--body-concurrency': o.bodyConcurrency = numArg(1, 256); break;
      case '--no-ublock': o.ublock = false; o.ublockExplicit = true; break;
      case '--ublock': o.ublock = true; o.ublockExplicit = true; break;
      case '--proxy': o.proxy = next(); break;
      case '--kill-popups': o.killPopups = true; break;
      case '--strict-tls': o.insecureTls = false; break;
      case '--insecure':
      case '--ignore-cert-errors': o.insecureTls = true; break;
      case '--real-chrome': o.realChrome = true; break;
      case '--device-scale': o.deviceScale = numArg(0.1, 5); break;
      case '--ua': o.ua = next(); break;
      case '--quiet': o.quiet = true; break;
      case '--verbose': o.verbose = true; break;
      case '--viewport': {
        const raw = next();
        const [w, h] = String(raw).split('x').map(Number);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < 100 || h < 100) fail(`--viewport expects the WIDTHxHEIGHT format (given: ${raw})`);
        o.viewport = { width: w, height: h };
        o.viewportExplicit = true;
        break;
      }
      default:
        if (a.startsWith('-')) fail(`Unknown option: ${a}\nUse --help for the full list.`);
        rest.push(a);
    }
  }
  if (rest.length > 1) fail(`Troppi indirizzi: ${rest.join(' ')}`);
  o.url = rest[0] ?? null;
  try {
    o.includeFilter = compileFilter(o.include, { name: '--include' });
    o.excludeFilter = compileFilter(o.exclude, { name: '--exclude' });
  } catch (e) {
    fail(e.message);
  }
  return o;
}

const BARE_IPV4 = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/;
const BARE_IPV6 = /^\[[0-9a-f:]+\](:\d+)?(\/.*)?$/i;

function normalizeUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|chrome|data|file):/i.test(s)) return s;
  const local = BARE_IPV4.test(s) || BARE_IPV6.test(s) || /^localhost(:\d+)?(\/|$)/i.test(s);
  return local ? `http://${s}` : `https://${s}`;
}

function validUrl(u) {
  try {
    return Boolean(new URL(u));
  } catch {
    return false;
  }
}

function pinExtensionInProfile(profileDir, extensionId) {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  let prefs = {};
  if (fs.existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    } catch {
      prefs = {};
    }
  }
  prefs.extensions ??= {};
  const pinned = new Set(prefs.extensions.pinned_extensions ?? []);
  pinned.add(extensionId);
  prefs.extensions.pinned_extensions = [...pinned];
  try {
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch {
  }
}

async function probeExtensionWorker(worker, expectedId) {
  const url = worker.url();
  if (!url.startsWith('chrome-extension://')) return null;
  const id = url.slice('chrome-extension://'.length).split('/')[0];
  const info = await worker
    .evaluate(async () => {
      const m = chrome.runtime?.getManifest?.() ?? {};
      let rulesets = null;
      try {
        rulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
      } catch {
        rulesets = null;
      }
      let name = m.name ?? '';
      if (/^__MSG_/.test(name)) name = chrome.i18n?.getMessage?.(name.slice(6, -2)) || m.short_name || '';
      return { name, version: m.version ?? '', id: chrome.runtime?.id ?? '', rulesets };
    })
    .catch(() => null);
  if (!info) return null;
  const looksLikeUbo = /ublock/i.test(info.name) || id === expectedId || Array.isArray(info.rulesets);
  return looksLikeUbo ? { ...info, id: info.id || id } : null;
}

async function checkUblock(context, log, expectedId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let found = null;

  for (const w of context.serviceWorkers()) {
    found = await probeExtensionWorker(w, expectedId);
    if (found) break;
  }

  while (!found && Date.now() < deadline) {
    const w = await context
      .waitForEvent('serviceworker', { timeout: Math.max(500, deadline - Date.now()) })
      .catch(() => null);
    if (!w) break;
    found = await probeExtensionWorker(w, expectedId);
  }

  if (!found) {
    log.warn('  uBlock: no extension service worker detected — ads are NOT being filtered.');
    return { active: false, reason: 'service worker did not start', expectedId };
  }

  const label = `${found.name || 'estensione'} ${found.version}`.trim();
  if (!found.rulesets?.length) {
    log.warn(`  uBlock: ${label} active but no ruleset enabled — filters are not applied.`);
    return { active: false, reason: 'no ruleset enabled', extensionId: found.id, name: found.name };
  }
  log.info(`  ublock  ATTIVO — ${label}, ${found.rulesets.length} ruleset: ${found.rulesets.join(', ')}`);
  return { active: true, extensionId: found.id, name: found.name, version: found.version, rulesets: found.rulesets };
}

async function bypassCertInterstitial(page, url, log) {
  const isInterstitial = () =>
    page
      .evaluate(() => {
        const t = document.body?.innerText ?? '';
        return Boolean(
          document.querySelector('#proceed-link, #main-frame-error, .interstitial-wrapper') &&
            /ERR_CERT|ERR_SSL|certificat|privata|private|NET::/i.test(t)
        );
      })
      .catch(() => false);

  if (!(await isInterstitial())) return false;
  log.warn('certificate interstitial detected: trying to get past it…');

  const proceed = await page.$('#proceed-link');
  if (proceed) {
    await page.click('#details-button').catch(() => {});
    await proceed.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    if (!(await isInterstitial())) {
      log.info('interstitial cleared via "Advanced → Proceed".');
      return true;
    }
  }

  await page.keyboard.type('thisisunsafe', { delay: 30 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  if (await isInterstitial()) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  const still = await isInterstitial();
  if (still) log.warn('interstitial still present: the site may require a client certificate.');
  else log.info('interstitial cleared with "thisisunsafe".');
  return !still;
}

function defaultOutDir(url) {
  const host = splitUrl(url).host.replace(/[^A-Za-z0-9.-]/g, '_') || 'capture';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.resolve('captures', `${host}-${stamp}`);
}

function countSessions(dbPath) {
  try {
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    const row = probe.prepare(`SELECT COUNT(*) AS n FROM session`).get();
    probe.close();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function dirSize(dir, { skip = [] } = {}) {
  const skipSet = new Set(skip);
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (skipSet.has(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
            }
      }
    }
  };
  walk(dir);
  return total;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.url) {
    const answer = await askUrl({ placeholder: 'https://' });
    if (answer == null) {
      console.error('No address entered: cancelled.');
      process.exit(1);
    }
    opts.url = answer;
    opts.askedInteractively = true;

    if (!opts.ublockExplicit && !opts.realChrome) {
      const want = await askYesNo({
        message: 'Block ads and tracking with uBlock Origin Lite?',
        defaultYes: true,
      });
      if (want == null) {
        console.error('Cancelled.');
        process.exit(1);
      }
      opts.ublock = want;
    }
  }

  opts.url = normalizeUrl(opts.url);
  if (!opts.url || !validUrl(opts.url)) {
    console.error(`Invalid address: ${opts.url ?? '(empty)'}`);
    process.exit(1);
  }

  const outDir = path.resolve(opts.out ?? defaultOutDir(opts.url));
  fs.mkdirSync(outDir, { recursive: true });

  const existingDb = path.join(outDir, 'session.db');
  if (!opts.append && fs.existsSync(existingDb)) {
    const prior = countSessions(existingDb);
    if (prior > 0) {
      console.error(`${outDir} already holds a capture (${prior} session${prior > 1 ? 's' : ''} recorded).`);
      console.error('Continuing would merge them into one database and the report would mix the data.');
      console.error('Pick a different --out, or use --append if you really mean to add to this one.');
      process.exit(1);
    }
  }
  const profileDir = path.resolve(
    opts.profile ?? (opts.tmpProfile ? fs.mkdtempSync(path.join(os.tmpdir(), 'webanalyzer-')) : path.join(outDir, 'profile'))
  );
  fs.mkdirSync(profileDir, { recursive: true });

  const log = new Logger({ outDir, quiet: opts.quiet, level: opts.verbose ? 'debug' : 'info' });

  const db = openDb(outDir);
  const batch = new WriteBatch(db, { onError: (e) => log.debug(`transaction: ${e.message}`) });
  const stmts = prepare(db, batch);
  const blobs = new BlobStore(outDir, stmts);

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const ublockDir = path.resolve(moduleDir, '..', 'extensions', 'ublock-origin-lite');
  let ublockFilesPresent = ublock.isInstalled(ublockDir);

  log.info(`webAnalyzer`);
  log.info(`  target  ${opts.url}`);
  log.info(`  output  ${outDir}`);
  log.info(`  profilo ${profileDir}`);
  log.info(`  browser ${opts.realChrome ? 'Chrome vero' : 'Chromium interno'}`);
  log.info(
    `  tls     ${opts.insecureTls ? 'invalid certificates accepted (self-signed, expired, wrong hostname)' : 'standard validation (--strict-tls)'}`
  );
  if (opts.include.length) log.info(`  include ${opts.include.join(' , ')}`);
  if (opts.exclude.length) log.info(`  exclude ${opts.exclude.join(' , ')}`);

  if (!opts.ublock) {
    log.info('  ublock  disabled on request');
  } else if (opts.realChrome) {
    log.warn('  ublock  disabled: with --real-chrome command-line extensions do not load.');
  } else if (!ublockFilesPresent) {
    const proxy = ublock.resolveProxy(opts.proxy);
    log.info(`  ublock  missing, downloading${proxy ? ` via proxy ${proxy.href}` : ''}…`);
    try {
      const r = await ublock.install({ dir: ublockDir, proxy, log });
      log.info(`  ublock  installed: ${r.name} ${r.version} (${r.files} files, ${r.rulesets} rulesets declared)`);
      ublockFilesPresent = true;
    } catch (e) {
      log.warn(`  ublock  download failed: ${e.message}`);
      log.warn('  ublock  continuing without adblock; to install it by hand: npm run fetch-ublock');
    }
  } else {
    const info = ublock.describeInstalled(ublockDir);
    log.info(`  ublock  ${info ? `${info.name} ${info.version} present` : 'present'}, will verify after startup`);
  }

  const ublockAvailable = opts.ublock && !opts.realChrome && ublockFilesPresent;
  const ublockExpectedId = ublock.extensionIdForPath(ublockDir);
  if (ublockAvailable) pinExtensionInProfile(profileDir, ublockExpectedId);
  opts.ublockRequested = ublockAvailable;

  if (ublockAvailable && opts.headless) {
    log.warn('  warning: in --headless the uBlock service worker does not start, no real adblock.');
  }

  const disabledFeatures = ['IsolateOrigins', 'site-per-process', 'Translate'];
  if (opts.insecureTls) {
    disabledFeatures.push('HttpsUpgrades', 'HttpsFirstBalancedModeAutoEnable', 'HttpsFirstModeV2');
  }

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    `--disable-features=${disabledFeatures.join(',')}`,
    '--no-default-browser-check',
    '--no-first-run',
    '--password-store=basic',
  ];

  if (opts.insecureTls) {
    launchArgs.push(
      '--ignore-certificate-errors',
      '--ignore-urlfetcher-cert-requests',
      '--allow-insecure-localhost',
      '--allow-running-insecure-content',
      '--test-type'
    );
  }

  if (ublockAvailable) {
    launchArgs.push(`--disable-extensions-except=${ublockDir}`, `--load-extension=${ublockDir}`);
  }

  const pinViewport = opts.headless || opts.viewportExplicit || opts.deviceScale !== 1;
  if (!opts.headless) launchArgs.push(`--window-size=${opts.viewport.width},${opts.viewport.height}`);

  const launchOpts = {
    headless: opts.headless,
    viewport: pinViewport ? opts.viewport : null,
    deviceScaleFactor: pinViewport ? opts.deviceScale : undefined,
    userAgent: opts.ua ?? undefined,
    acceptDownloads: true,
    ignoreHTTPSErrors: opts.insecureTls,
    args: launchArgs,
    ignoreDefaultArgs: ['--enable-automation'],
  };

  let context;
  if (opts.realChrome) {
    try {
      context = await chromium.launchPersistentContext(profileDir, { ...launchOpts, channel: 'chrome' });
    } catch (e) {
      log.warn(`Real Chrome unavailable (${e.message}), falling back to the bundled Chromium.`);
      context = await chromium.launchPersistentContext(profileDir, launchOpts);
    }
  } else {
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  }

  if (opts.metrics) await context.addInitScript(VITALS_INIT).catch((e) => log.debug(`vitals init script: ${e.message}`));

  const browserVersion = context.browser()?.version?.() ?? 'chromium';
  const rec = new Recorder({ db, stmts, blobs, batch, outDir, opts, log });

  if (ublockAvailable) {
    opts.ublockStatus = await checkUblock(context, log, ublockExpectedId);
  } else {
    opts.ublockStatus = { active: false, reason: opts.ublock ? 'not loadable' : 'disabled by --no-ublock' };
  }

  const page = context.pages()[0] ?? (await context.newPage());
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);

  const startedAt = nowIso();
  const sessionInfo = stmts.insertSession.run({
    target_url: opts.url,
    started_at: startedAt,
    browser: browserVersion,
    user_agent: userAgent,
    out_dir: outDir,
    options: JSON.stringify(opts, (k, v) => (k.endsWith('Filter') ? undefined : v)),
  });
  const sessionId = Number(sessionInfo.lastInsertRowid);

  await rec.probe.captureCookies(context, 'start');
  await rec.attachPage(page);

  context.on('page', (p) => {
    if (p !== page && !p.__waPageId) rec.track(rec.attachPage(p));
  });

  let stopping = false;
  let browserAlive = true;
  let sigints = 0;
  const stopped = new Promise((resolve) => {
    const finish = (why) => {
      if (stopping) return;
      stopping = true;
      log.endStatus();
      log.info(`closing capture (${why})…`);
      resolve();
    };
    process.on('SIGINT', () => {
      if (++sigints > 1) {
        log.warn('second Ctrl+C: quitting now, reports will not be generated.');
        batch.flush();
        walCheckpoint(db);
        process.exit(130);
      }
      finish('Ctrl+C');
    });
    process.on('SIGTERM', () => finish('SIGTERM'));
    context.on('close', () => {
      browserAlive = false;
      finish('browser chiuso');
    });
    if (opts.timeout > 0) setTimeout(() => finish(`timeout ${opts.timeout}s`), opts.timeout * 1000);
  });

  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    log.warn(`navigation: ${e.message}`);
  }

  if (opts.insecureTls) {
    await bypassCertInterstitial(page, opts.url, log).catch((e) => log.debug(`certificate bypass: ${e.message}`));
  }

  const ticker = setInterval(() => {
    if (stopping) return;
    batch.flush();
    const c = rec.counts;
    const popups = opts.killPopups ? ` · ${c.popupsKilled} popups closed` : '';
    const filtered = c.filtered ? ` · ${c.filtered} filtered` : '';
    log.status(
      `  ${c.requests} requests · ${c.bodies} bodies · ${c.json} json · ${c.ws} ws · ` +
        `${c.blocked} blocked by uBlock · ${c.errors} errors${filtered}${popups}`
    );
  }, 1000);

  const snapshotter = setInterval(() => {
    if (stopping || !browserAlive) return;
    rec.track(rec.probe.captureClientState(context));
  }, 15000);

  log.info('');
  log.info('go ahead and browse in the window: everything is recorded. Ctrl+C to stop.');
  await stopped;
  clearInterval(ticker);
  clearInterval(snapshotter);
  log.endStatus();
  rec.stopped = true;

  if (browserAlive) {
    const openPages = context.pages().filter((p) => !p.isClosed());
    for (const p of openPages) {
      const pid = p.__waPageId ?? null;
      if (pid == null) continue;
      await rec.probe.snapshot(p, pid, 'final');
      await rec.probe.captureStorage(p, pid);
    }
    await rec.probe.captureCookies(context, 'end');
  } else {
    log.warn(
      'browser closed by the user: no final snapshot, the cookies and storage from the ' +
        'last periodic sweep apply (at most 15s before closing).'
    );
  }

  log.info('waiting for pending operations…');
  await rec.settle();

  const stats = rec.stats;
  stmts.endSession.run(nowIso(), JSON.stringify(stats), sessionId);
  batch.flush();

  try {
    await context.close();
  } catch {
  }
  batch.flush();

  if (opts.fts) {
    log.info('building the full-text index…');
    try {
      const fts = buildFts(db, outDir);
      log.info(`  blobs_fts ${fts.indexed} documents (${fmtBytes(fts.bytes)})${fts.missing ? `, ${fts.missing} blobs missing` : ''}`);
    } catch (e) {
      log.warn(`full-text index not built: ${e.message}`);
    }
  }

  if (opts.har) {
    log.info('generating session.har…');
    const har = exportHar(db, outDir, { bodies: opts.harBodies, maxBodyBytes: opts.harMaxBody, log });
    log.info(`  session.har ${fmtBytes(har.bytes)} (${har.entries} entries, bodies: ${opts.harBodies})`);
  }

  optimize(db);
  walCheckpoint(db);
  db.close();

  log.info('generating the reports…');
  const { warnings } = generateAll(outDir);
  for (const w of warnings) log.warn(`report: ${w}`);

  const profileBytes = dirSize(profileDir);
  const size = dirSize(outDir, { skip: [profileDir] });
  const durSec = (Date.parse(nowIso()) - Date.parse(startedAt)) / 1000;
  const c = rec.counts;
  const rate = stats.body_capture_rate != null ? `${Math.round(stats.body_capture_rate * 100)}%` : 'n/d';

  log.info('');
  log.info(`capture completed in ${fmtDuration(durSec)}`);
  log.info(`  ${c.requests} requests, ${c.bodies} bodies saved (coverage ${rate}), ${c.blocked} blocked by uBlock`);
  if (c.bodiesMissing || c.bodiesSkipped) {
    log.info(`  ${c.bodiesMissing} bodies no longer available, ${c.bodiesSkipped} over --max-body (see the Completeness section)`);
  }
  log.info(`  ${c.json} JSON payloads, ${c.wsFrames} websocket frames, ${c.metrics} page metrics`);
  log.info(`  ${fmtBytes(size)} of artifacts${profileBytes ? ` (+ ${fmtBytes(profileBytes)} of browser profile)` : ''}`);
  if (blobs.stats.bytesDeduped) log.info(`  ${fmtBytes(blobs.stats.bytesDeduped)} saved by body deduplication`);
  if (rec.mirror.stats.bytesSaved) log.info(`  ${fmtBytes(rec.mirror.stats.bytesSaved)} saved by hardlinking site/ to blobs/`);
  log.info(`  ${batch.commits} transactions for ${batch.total} writes`);
  if (rec.store.errors) {
    const worst = [...rec.store.byLabel].sort((a, b) => b[1] - a[1]).slice(0, 3);
    log.warn(`  ${rec.store.errors} failed writes: ${worst.map(([k, n]) => `${k} x${n}`).join(', ')}`);
  }
  if (c.dropped) log.warn(`  ${c.dropped} requests dropped because the in-memory buffers filled up`);
  log.info('');
  log.info(`  ${path.join(outDir, 'REPORT.md')}`);
  log.info(`  ${path.join(outDir, 'LLM_GUIDE.md')}`);
  log.info(`  ${path.join(outDir, 'session.db')}`);
  log.info(`  ${path.join(outDir, 'session.log')}`);
  await log.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

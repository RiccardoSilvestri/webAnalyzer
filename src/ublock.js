import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';

export const WEBSTORE_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const CHROME_VERSION = '131.0.0.0';
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export function crxUrl(id = WEBSTORE_ID) {
  const u = new URL('https://clients2.google.com/service/update2/crx');
  u.searchParams.set('response', 'redirect');
  u.searchParams.set('acceptformat', 'crx3');
  u.searchParams.set('prodversion', CHROME_VERSION);
  u.searchParams.set('x', `id=${id}&installsource=ondemand&uc`);
  return u.href;
}

export function resolveProxy(explicit) {
  const raw =
    explicit ??
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    null;
  if (!raw) return null;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const port = Number(u.port || 8080);
  return {
    hostname: u.hostname,
    port,
    auth: u.username
      ? Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
      : null,
    href: `${u.protocol}//${u.hostname}:${port}`,
  };
}

function connectTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}`, 'User-Agent': UA };
    if (proxy.auth) headers['Proxy-Authorization'] = `Basic ${proxy.auth}`;
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      timeout: 30000,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`the proxy refused the tunnel to ${host}:${port}: HTTP ${res.statusCode}`));
      }
      resolve(socket);
    });
    req.once('timeout', () => {
      req.destroy();
      reject(new Error(`timed out contacting the proxy ${proxy.href}`));
    });
    req.once('error', reject);
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.once('end', () => resolve(Buffer.concat(chunks)));
    res.once('error', reject);
  });
}

async function requestOnce(url, proxy) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const port = Number(target.port || (secure ? 443 : 80));
  const headers = { Host: target.host, 'User-Agent': UA, Accept: '*/*', Connection: 'close' };

  let options;
  if (!proxy) {
    options = { host: target.hostname, port, path: target.pathname + target.search, headers, timeout: 30000 };
  } else if (secure) {
    const socket = await connectTunnel(proxy, target.hostname, port);
    options = {
      socket,
      agent: false,
      servername: target.hostname,
      host: target.hostname,
      port,
      path: target.pathname + target.search,
      headers,
      timeout: 30000,
    };
  } else {
    if (proxy.auth) headers['Proxy-Authorization'] = `Basic ${proxy.auth}`;
    options = { host: proxy.hostname, port: proxy.port, path: url, headers, timeout: 30000 };
  }

  const lib = secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => resolve(res));
    req.once('timeout', () => {
      req.destroy();
      reject(new Error(`timeout su ${url}`));
    });
    req.once('error', reject);
    req.end();
  });
}

export async function download(url, proxy, hops = 0) {
  if (hops > 6) throw new Error('troppi redirect');
  const res = await requestOnce(url, proxy);
  const { statusCode: status, headers } = res;
  if (status >= 300 && status < 400 && headers.location) {
    res.resume();
    return download(new URL(headers.location, url).href, proxy, hops + 1);
  }
  if (status !== 200) {
    res.resume();
    throw new Error(`download failed: HTTP ${status}`);
  }
  return readBody(res);
}

export function stripCrxHeader(buf) {
  if (buf.length < 16) throw new Error('file too small to be a CRX');
  const magic = buf.subarray(0, 4).toString('latin1');
  if (magic !== 'Cr24') {
    if (buf.subarray(0, 2).toString('latin1') === 'PK') return buf;
    throw new Error(`unexpected format: magic "${magic}" instead of "Cr24"`);
  }
  const version = buf.readUInt32LE(4);
  if (version === 3) return buf.subarray(12 + buf.readUInt32LE(8));
  if (version === 2) return buf.subarray(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  throw new Error(`unsupported CRX version: ${version}`);
}

function findEocd(zip) {
  const min = Math.max(0, zip.length - 66560);
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('invalid ZIP archive: End Of Central Directory not found');
}

function readEntries(zip) {
  const eocd = findEocd(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== CEN_SIG) throw new Error(`entry ${i} is corrupt in the central directory`);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function safeJoin(root, name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const dest = path.resolve(root, normalized);
  const rel = path.relative(root, dest);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dest;
}

export function extractZip(zip, root) {
  const entries = readEntries(zip);
  let files = 0;
  let skipped = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const dest = safeJoin(root, e.name);
    if (!dest) {
      skipped++;
      continue;
    }
    if (zip.readUInt32LE(e.localOffset) !== LOC_SIG) throw new Error(`corrupt local header for ${e.name}`);
    const nameLen = zip.readUInt16LE(e.localOffset + 26);
    const extraLen = zip.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = zip.subarray(start, start + e.compressedSize);

    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`compression method ${e.method} is not supported for ${e.name}`);

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    files++;
  }
  return { files, skipped };
}

export function resolveLocalizedName(manifest, root) {
  const raw = manifest.name ?? '';
  const m = /^__MSG_(.+)__$/.exec(raw);
  if (!m) return raw;
  for (const loc of [manifest.default_locale, 'en', 'en_US'].filter(Boolean)) {
    const p = path.join(root, '_locales', loc, 'messages.json');
    if (!fs.existsSync(p)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(p, 'utf8'))[m[1]]?.message;
      if (value) return value;
    } catch {
      continue;
    }
  }
  return manifest.short_name ?? raw;
}

export function extensionIdForPath(absPath) {
  const input = process.platform === 'win32' ? Buffer.from(absPath, 'utf16le') : Buffer.from(absPath, 'utf8');
  const hash = crypto.createHash('sha256').update(input).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

export function isInstalled(dir) {
  return fs.existsSync(path.join(dir, 'manifest.json'));
}

export function describeInstalled(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return {
      name: resolveLocalizedName(manifest, dir),
      version: manifest.version,
      rulesets: manifest.declarative_net_request?.rule_resources?.length ?? 0,
    };
  } catch {
    return null;
  }
}

export async function install({ dir, proxy = null, source = null, log } = {}) {
  let crx;
  if (source) {
    const src = path.resolve(source);
    if (!fs.existsSync(src)) throw new Error(`file not found: ${src}`);
    crx = fs.readFileSync(src);
  } else {
    try {
      crx = await download(crxUrl(), proxy);
    } catch (e) {
      const detail = `${e.message} ${e.cause?.message ?? ''}`;
      if (/timeout|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|certificate|tunnel|socket/i.test(detail)) {
        throw new Error(
          `network unreachable (${e.message}).\n` +
            (proxy ? '' : 'If you are behind a proxy, pass it with --proxy host:port or set HTTPS_PROXY.\n') +
            `Otherwise download the file from:\n  ${crxUrl()}\n` +
            `and install it with:  npm run fetch-ublock -- --file <path>`
        );
      }
      throw e;
    }
  }
  log?.debug?.(`ublock: ${crx.length} byte da elaborare`);

  const zip = stripCrxHeader(crx);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { files, skipped } = extractZip(zip, dir);
  if (!isInstalled(dir)) throw new Error('estrazione incompleta: manifest.json assente');

  const info = describeInstalled(dir);
  return { files, skipped, bytes: crx.length, expectedId: extensionIdForPath(dir), ...info };
}

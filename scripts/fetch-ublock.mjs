#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEBSTORE_ID, crxUrl, install, resolveProxy } from '../src/ublock.js';

const targetDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extensions', 'ublock-origin-lite');

const HELP = `
fetch-ublock — downloads uBlock Origin Lite and unpacks it into extensions/ublock-origin-lite/

  node scripts/fetch-ublock.mjs                      download from the Chrome Web Store
  node scripts/fetch-ublock.mjs --proxy host:8080    through an HTTP proxy
  node scripts/fetch-ublock.mjs --file ubo.crx       use an already downloaded CRX (or ZIP)
  node scripts/fetch-ublock.mjs --no-proxy           ignore HTTPS_PROXY/HTTP_PROXY

Without --proxy the HTTPS_PROXY or HTTP_PROXY environment variables are used, when
set. https connections go through the proxy over a CONNECT tunnel.

If there is no way out to the network, download the file by hand from here and pass it
with --file:

  ${crxUrl()}
`;

function parseArgs(argv) {
  const o = { file: null, proxy: null, noProxy: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') o.file = argv[++i];
    else if (a === '--proxy') o.proxy = argv[++i];
    else if (a === '--no-proxy') o.noProxy = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (o.file === undefined) throw new Error('--file requires a path');
  if (o.proxy === undefined) throw new Error('--proxy requires an address');
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const proxy = opts.noProxy ? null : resolveProxy(opts.proxy);
  if (opts.file) console.log(`Using the local file ${path.resolve(opts.file)}…`);
  else {
    console.log(`Downloading uBlock Origin Lite from the Chrome Web Store (id ${WEBSTORE_ID})…`);
    console.log(`  proxy: ${proxy ? proxy.href : 'none (direct connection)'}`);
  }

  const r = await install({ dir: targetDir, proxy, source: opts.file });

  console.log(`  ${(r.bytes / 1024).toFixed(0)} KB processed, ${r.files} files extracted${r.skipped ? ` (${r.skipped} unsafe paths discarded)` : ''}`);
  console.log(`  ${r.name} version ${r.version}`);
  if (!r.rulesets) console.warn('  warning: the manifest declares no ruleset, the adblocker may filter nothing.');
  else console.log(`  ${r.rulesets} rulesets declared in the manifest`);
  console.log(`  directory: ${targetDir}`);
  console.log(`  expected id once loaded: ${r.expectedId}`);
  console.log('');
  console.log('Ready: on the next run webAnalyzer will load uBlock and verify the active rulesets.');
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});

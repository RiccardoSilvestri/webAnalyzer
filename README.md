<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo.svg" alt="webAnalyzer" width="360">
  </picture>
</p>

Opens a real Chromium window, lets you browse normally, and records everything the site
does behind the glass — every request, every response body, every JSON payload,
WebSocket frame, cookie, console error and performance metric.

When you close it, you get a SQLite database you can query, the site's files on disk,
and two reports: one for you, one for an LLM.

```bash
npm install
node src/index.js https://example.com
```

Browse, click, log in by hand. Press `Ctrl+C` when you are done.

## Why

Browser DevTools shows you all of this too — but only while the tab is open, and only
one panel at a time. webAnalyzer keeps it: after the session you can ask questions like
*which endpoint returns a field called `email`*, or *which script made this call*, with
a SQL query instead of scrolling through a Network tab.

## What you get

```
captures/example.com-2026-09-18T10-30-00/
  session.db      everything, queryable with sqlite3
  blobs/          response bodies, stored once per unique content
  site/           the site rebuilt as a browsable file tree
  session.har     standard HAR, opens in Chrome DevTools
  REPORT.md       readable summary: hosts, APIs, errors, Web Vitals, security audit
  LLM_GUIDE.md    the schema plus ready-made queries, for handing to an LLM
```

Bodies live in `blobs/` rather than inside the database, addressed by their sha256, so
the same file downloaded ten times is stored once. `site/` hardlinks to those blobs, so
the browsable tree costs no extra disk.

## Asking questions

```bash
sqlite3 -header -column captures/example.com-*/session.db \
  "SELECT method, host, path_template, calls FROM v_api ORDER BY calls DESC LIMIT 10;"
```

Three views cover most needs: `v_calls` (one row per request), `v_api` (endpoints grouped
by path template) and `v_bodies` (bodies joined to their metadata). Every textual body is
also in a full-text index, so you can grep the whole site from SQL:

```sql
SELECT b.path FROM blobs_fts JOIN blobs b ON b.hash = blobs_fts.hash
WHERE blobs_fts MATCH 'apiKey';
```

`LLM_GUIDE.md` in each capture explains the rest.

## Ad blocking

The browser loads uBlock Origin Lite, which is not in this repository:

```bash
npm run fetch-ublock                          # add --proxy host:8080 if you need one
```

Blocked requests are recorded too — they are how you measure what the site *would*
have loaded. They are kept separate from real errors.

## Useful options

| option | what it does |
| --- | --- |
| `--timeout <sec>` | stop on its own after N seconds |
| `--profile <dir>` | reuse a fixed Chrome profile to stay logged in between runs |
| `--include` / `--exclude <regex>` | narrow what gets captured |
| `--tmp-profile` | keep the browser profile out of the capture directory |
| `--headless` | no window (note: uBlock does not run in headless) |

`node src/index.js --help` lists them all.

Re-generate the reports from an existing capture without re-recording:

```bash
node src/report.js captures/example.com-2026-09-18T10-30-00
```

## Requirements

Node 23.4 or newer — it uses the built-in `node:sqlite`, so there is nothing to compile.
Playwright is the only dependency.

## Tests

```bash
npm test
```

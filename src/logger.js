import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor({ outDir, quiet = false, level = 'info' } = {}) {
    this.min = LEVELS[level] ?? LEVELS.info;
    this.quiet = quiet;
    this.statusText = '';
    this.statusShown = false;
    this.tty = Boolean(process.stdout.isTTY);
    this.stream = null;
    if (outDir) {
      try {
        fs.mkdirSync(outDir, { recursive: true });
        this.stream = fs.createWriteStream(path.join(outDir, 'session.log'), { flags: 'a' });
      } catch {}
    }
  }

  #clearStatus() {
    if (!this.statusShown || !this.tty) return;
    process.stdout.write(`\r${' '.repeat(process.stdout.columns ?? 80)}\r`);
    this.statusShown = false;
  }

  #drawStatus() {
    if (!this.statusText || !this.tty || this.quiet) return;
    const max = (process.stdout.columns ?? 80) - 1;
    process.stdout.write(`\r${this.statusText.slice(0, max)}`);
    this.statusShown = true;
  }

  #write(level, msg) {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    this.stream?.write(`${line}\n`);
    if (LEVELS[level] < this.min) return;
    if (this.quiet && LEVELS[level] < LEVELS.warn) return;
    this.#clearStatus();
    (level === 'warn' || level === 'error' ? console.error : console.log)(msg);
    this.#drawStatus();
  }

  debug(...a) { this.#write('debug', a.join(' ')); }
  info(...a) { this.#write('info', a.join(' ')); }
  warn(...a) { this.#write('warn', a.join(' ')); }
  error(...a) { this.#write('error', a.join(' ')); }

  event(kind, msg) { this.#write('info', `[${kind}] ${msg}`); }

  status(text) {
    this.statusText = text;
    this.#drawStatus();
  }

  endStatus() {
    this.#clearStatus();
    this.statusText = '';
  }

  async close() {
    this.endStatus();
    if (!this.stream) return;
    await new Promise((r) => this.stream.end(r));
    this.stream = null;
  }
}

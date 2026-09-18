import { nowIso } from './util.js';

export class Store {
  constructor({ stmts, log } = {}) {
    this.stmts = stmts;
    this.log = log;
    this.errors = 0;
    this.byLabel = new Map();
  }

  run(label, fn) {
    try {
      return fn();
    } catch (e) {
      this.errors++;
      this.byLabel.set(label, (this.byLabel.get(label) ?? 0) + 1);
      this.log?.debug?.(`db ${label}: ${e.message}`);
      return null;
    }
  }

  timeline(kind, pageId, refTable, refId, summary) {
    return this.run('timeline', () =>
      this.stmts.insertTimeline.run(nowIso(), kind, pageId, refTable, refId, summary)
    );
  }

  get stats() {
    if (!this.errors) return { errors: 0 };
    return { errors: this.errors, by_statement: Object.fromEntries(this.byLabel) };
  }
}

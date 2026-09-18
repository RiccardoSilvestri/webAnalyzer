export class Limiter {
  constructor(n) {
    this.n = Math.max(1, n);
    this.queue = [];
    this.active = 0;
    this.peak = 0;
  }

  get queued() {
    return this.queue.length;
  }

  get idle() {
    return this.active === 0 && this.queue.length === 0;
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.peak = Math.max(this.peak, this.queue.length);
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.n && this.queue.length) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active++;
      const settle = (cb) => (value) => {
        this.active--;
        this.#drain();
        cb(value);
      };
      Promise.resolve().then(fn).then(settle(resolve), settle(reject));
    }
  }
}

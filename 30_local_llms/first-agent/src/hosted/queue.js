/**
 * **The hosted server's request queue (Day 30).**
 *
 * One model on one laptop: at most `concurrency` requests reach it at once
 * (default 1), up to `max` more wait in FIFO order, and anything past that is
 * refused straight away with a `Retry-After` estimate. Admission is
 * synchronous — `enqueue` either returns a ticket or throws a `QueueError` —
 * so a caller knows before it answers whether the request got in.
 *
 * - **Leaving the queue.** A waiting request whose `signal` aborts (the client
 *   disconnected) is removed at once and never runs; the ones behind it move up.
 *   A running one keeps going unless it was enqueued with `cancelRunning`.
 * - **Timeout.** `timeoutMs` counts from the moment a request starts running
 *   (the time it waited is not the model's fault). When it fires, the job's
 *   signal is aborted, the request fails with a `QueueError` (504), and its
 *   slot is freed for the next one.
 * - **One per key.** `has(key)` says whether a request with that key is waiting
 *   or running; the routes use `user:conversation` keys to refuse a second
 *   message in the same chat.
 * - **Draining.** `drain()` refuses everything new, rejects the waiting
 *   requests (503) and resolves once the running ones have finished.
 */

export class QueueError extends Error {
  /**
   * @param {string} message - written to be shown to a person
   * @param {{ status: number, code: string, retryAfterS?: number }} o
   */
  constructor(message, { status, code, retryAfterS } = {}) {
    super(message);
    this.name = "QueueError";
    this.status = status;
    this.code = code;
    if (retryAfterS != null) this.retryAfterS = retryAfterS;
  }
}

/** How many recent run times the Retry-After estimate averages. */
const RECENT_RUNS = 10;
/** The estimate before anything has run: about one RAG answer on qwen3.5:9b on the Air (Day 29). */
const DEFAULT_RUN_MS = 30_000;

let nextId = 1;

export class RequestQueue {
  #waiting = [];
  #running = new Set();
  #recentMs = [];
  #idle = [];
  #now;

  /**
   * @param {object} [o]
   * @param {number} [o.concurrency] - requests at the model at once
   * @param {number} [o.max] - requests waiting behind them
   * @param {number} [o.timeoutMs] - per request, from the moment it starts running
   * @param {() => number} [o.now]
   */
  constructor({ concurrency = 1, max = 5, timeoutMs = 180_000, now = Date.now } = {}) {
    this.concurrency = concurrency;
    this.max = max;
    this.timeoutMs = timeoutMs;
    this.draining = false;
    this.#now = now;
  }

  get depth() {
    return this.#waiting.length;
  }

  get running() {
    return this.#running.size;
  }

  has(key) {
    return this.#waiting.some((e) => e.key === key) || [...this.#running].some((e) => e.key === key);
  }

  /** Seconds until a refused request is likely to get in: the work ahead of it, at the recent pace. */
  retryAfterS() {
    const avg = this.#recentMs.length ? this.#recentMs.reduce((a, b) => a + b, 0) / this.#recentMs.length : DEFAULT_RUN_MS;
    const ahead = this.#waiting.length + this.#running.size;
    return Math.min(600, Math.max(5, Math.ceil((ahead * avg) / this.concurrency / 1000)));
  }

  /**
   * Admit a request, or throw a `QueueError` (503 draining, 429 busy).
   *
   * @template T
   * @param {(signal: AbortSignal) => Promise<T>} job - started when a slot is free; `signal` aborts on timeout (or on disconnect with `cancelRunning`)
   * @param {object} [o]
   * @param {string} [o.key]
   * @param {AbortSignal} [o.signal] - aborts when the client is gone
   * @param {boolean} [o.cancelRunning] - also abort the job if the client leaves while it runs
   * @param {number} [o.timeoutMs] - this request's own deadline, never longer than the queue's
   * @param {(update: { type: "queued", position: number } | { type: "started", waitedMs: number }) => void} [o.onUpdate]
   * @returns {{ id: number, position: number, promise: Promise<{ value: T, waitedMs: number, runMs: number }> }} `position`: 0 when it started at once
   */
  enqueue(job, { key = null, signal, cancelRunning = false, timeoutMs, onUpdate = () => {} } = {}) {
    if (this.draining) throw new QueueError("The server is shutting down. Try again in a minute.", { status: 503, code: "shutting_down" });
    const hasRoom = this.#running.size < this.concurrency || this.#waiting.length < this.max;
    if (!hasRoom) {
      const retryAfterS = this.retryAfterS();
      throw new QueueError(
        `The server is busy: ${this.#running.size} request${this.#running.size === 1 ? "" : "s"} running and ${this.#waiting.length} waiting, the most it holds. Try again in about ${humanSeconds(retryAfterS)}.`,
        { status: 429, code: "busy", retryAfterS },
      );
    }
    const entry = {
      id: nextId++,
      key,
      job,
      cancelRunning,
      timeoutMs: Math.min(timeoutMs ?? this.timeoutMs, this.timeoutMs),
      onUpdate,
      enqueuedAt: this.#now(),
      controller: new AbortController(),
      settled: false,
    };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    if (signal) {
      if (signal.aborted) throw new QueueError("The client went away.", { status: 499, code: "cancelled" });
      const onGone = () => this.#leave(entry);
      signal.addEventListener("abort", onGone, { once: true });
      entry.unlisten = () => signal.removeEventListener("abort", onGone);
    }
    this.#waiting.push(entry);
    this.#pump();
    const position = this.#waiting.indexOf(entry) + 1;
    if (position) onUpdate({ type: "queued", position });
    return { id: entry.id, position, promise: entry.promise };
  }

  /** Refuse new requests, reject the waiting ones (503), and resolve when nothing is running. */
  drain() {
    this.draining = true;
    for (const entry of this.#waiting.splice(0)) {
      this.#settle(entry, new QueueError("The server is shutting down, so this request was not run. Try again in a minute.", { status: 503, code: "shutting_down" }));
    }
    return this.#running.size ? new Promise((resolve) => this.#idle.push(resolve)) : Promise.resolve();
  }

  #leave(entry) {
    const at = this.#waiting.indexOf(entry);
    if (at >= 0) {
      this.#waiting.splice(at, 1);
      this.#settle(entry, new QueueError("The client went away before this request ran.", { status: 499, code: "cancelled" }));
      this.#positions(at);
      return;
    }
    if (this.#running.has(entry) && entry.cancelRunning) {
      entry.controller.abort(new QueueError("The client went away while this request ran.", { status: 499, code: "cancelled" }));
      this.#settle(entry, entry.controller.signal.reason);
      this.#release(entry);
    }
  }

  #pump() {
    while (this.#running.size < this.concurrency && this.#waiting.length) {
      const entry = this.#waiting.shift();
      this.#start(entry);
      this.#positions(0);
    }
  }

  /** Tell everyone from index `from` on where they now stand. */
  #positions(from) {
    for (let i = from; i < this.#waiting.length; i++) this.#waiting[i].onUpdate({ type: "queued", position: i + 1 });
  }

  #start(entry) {
    this.#running.add(entry);
    entry.startedAt = this.#now();
    entry.onUpdate({ type: "started", waitedMs: entry.startedAt - entry.enqueuedAt });
    entry.timer = setTimeout(() => {
      const err = new QueueError(
        `The model didn't finish within ${humanSeconds(Math.round(entry.timeoutMs / 1000))}, so this request was stopped and the next one started. Try again, or ask a shorter question.`,
        { status: 504, code: "timeout" },
      );
      entry.controller.abort(err);
      this.#settle(entry, err);
      this.#release(entry);
    }, entry.timeoutMs);
    entry.timer.unref?.();
    let run;
    try {
      run = Promise.resolve(entry.job(entry.controller.signal));
    } catch (err) {
      run = Promise.reject(err);
    }
    run.then(
      (value) => {
        this.#settle(entry, null, value);
        this.#release(entry);
      },
      (err) => {
        this.#settle(entry, err);
        this.#release(entry);
      },
    );
  }

  #settle(entry, err, value) {
    if (entry.settled) return;
    entry.settled = true;
    entry.unlisten?.();
    const startedAt = entry.startedAt ?? this.#now();
    if (err) entry.reject(err);
    else entry.resolve({ value, waitedMs: startedAt - entry.enqueuedAt, runMs: this.#now() - startedAt });
  }

  #release(entry) {
    if (!this.#running.delete(entry)) return;
    clearTimeout(entry.timer);
    this.#recentMs.push(this.#now() - entry.startedAt);
    if (this.#recentMs.length > RECENT_RUNS) this.#recentMs.shift();
    this.#pump();
    if (!this.#running.size) for (const resolve of this.#idle.splice(0)) resolve();
  }
}

/** 45 → "45 s", 150 → "3 min". */
export function humanSeconds(s) {
  return s < 90 ? `${s} s` : `${Math.ceil(s / 60)} min`;
}

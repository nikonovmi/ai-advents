import { humanSeconds } from "./queue.js";

/**
 * **Messages per user per window (Day 30)** — a sliding window: a user may
 * have sent at most `limit` messages in the last `windowMs`. `check` only
 * looks; `record` counts one. The routes count a message once the queue has
 * admitted it, so a request refused for any other reason (too long, server
 * busy) costs nothing, and one that was admitted counts even if the client
 * leaves before it runs.
 */
export class RateLimiter {
  #sent = new Map();
  #now;

  /**
   * @param {{ limit?: number, windowMs?: number, now?: () => number }} [o]
   */
  constructor({ limit = 10, windowMs = 600_000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.#now = now;
  }

  /** @returns {{ ok: true, remaining: number } | { ok: false, retryAfterS: number, message: string }} */
  check(user) {
    const times = this.#recent(user);
    if (times.length < this.limit) return { ok: true, remaining: this.limit - times.length };
    const retryAfterS = Math.max(1, Math.ceil((times[0] + this.windowMs - this.#now()) / 1000));
    return {
      ok: false,
      retryAfterS,
      message: `You've sent ${this.limit} messages in the last ${humanSeconds(Math.round(this.windowMs / 1000))}, the most this server takes from one person. Try again in ${humanSeconds(retryAfterS)}.`,
    };
  }

  record(user) {
    const times = this.#recent(user);
    times.push(this.#now());
    this.#sent.set(user, times);
  }

  #recent(user) {
    const since = this.#now() - this.windowMs;
    const times = (this.#sent.get(user) ?? []).filter((t) => t > since);
    if (times.length) this.#sent.set(user, times);
    else this.#sent.delete(user);
    return times;
  }
}

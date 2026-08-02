/**
 * redis-rate-limit-store.js
 *
 * Remediation Pass 3 / SEC-004 (Docs/reports/remediation-pass-3-redis-report.md):
 * a shared, Redis-backed `express-rate-limit` Store, so rate limiting stays
 * effective once the backend is deployed across more than one instance
 * (an in-memory store, as used everywhere before this pass, only tracks
 * hits seen by that one process).
 *
 * Product decision 1: built on `@upstash/redis` (already a project
 * dependency — used elsewhere for LangChain vector-store work, unrelated
 * to this pass) rather than adding a second, different Redis client
 * library, via a small custom Store adapter implementing the interface
 * `express-rate-limit` v7 expects (see `node_modules/express-rate-limit
 * /dist/index.d.ts`'s `Store` type: `init`, `get`, `increment`,
 * `decrement`, `resetKey`, optionally `resetAll`/`shutdown`).
 *
 * Product decision 2 (mandatory): automatic fallback to the existing
 * in-memory store when `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`
 * are absent — no code path requires real Redis credentials to run tests
 * or develop locally. `createRateLimitStore()` below is the single place
 * this decision is enforced: every call site in `rate-limiter.middleware
 * .js` and every route file goes through this factory instead of ever
 * constructing `MemoryStore`/`RedisRateLimitStore` directly, so the
 * fallback can never be accidentally bypassed by a future route.
 *
 * Fallback path returns express-rate-limit's own, unmodified `MemoryStore`
 * — the exact same class every limiter in this codebase already used
 * before this pass — so `store.resetAll()` (the mechanism every existing
 * integration test relies on to reset rate-limit state between test
 * cases/suites) continues to work with zero changes to any test file.
 * This is deliberate: it's what makes "zero behavior change for local
 * development or CI" (the spec's own deliverable line) actually true,
 * rather than just asserted.
 */

const { Redis } = require('@upstash/redis');
const { MemoryStore } = require('express-rate-limit');
const env = require('../../config/env.config');

// The Redis key prefix every store instance's keys live under, so this
// feature's keys are trivially greppable/flushable in a shared Upstash
// database that may hold keys from other, unrelated uses of the same
// instance in the future.
const REDIS_KEY_ROOT = 'sakanify:ratelimit:';

let sharedRedisClient = null;
let hasLoggedModeOnce = false;

/**
 * One shared `@upstash/redis` REST client for every Redis-backed limiter,
 * rather than one HTTP client per limiter — Upstash's client is a thin,
 * stateless REST wrapper (no persistent socket to worry about pooling),
 * so sharing it is purely to avoid constructing N identical clients for
 * no benefit, not a correctness requirement.
 */
function getSharedRedisClient() {
  if (!sharedRedisClient) {
    sharedRedisClient = new Redis({ url: env.redis.url, token: env.redis.token });
  }
  return sharedRedisClient;
}

/**
 * Logs which mode is active exactly once at boot (the first time any
 * limiter is constructed), not per-request — implementation step 2's
 * explicit requirement ("visible in server logs without being noisy").
 */
function logModeOnce() {
  if (hasLoggedModeOnce) return;
  hasLoggedModeOnce = true;

  if (env.redis.isConfigured) {
    // eslint-disable-next-line no-console
    console.log('[rate-limiter] Redis-backed store active (Upstash) — rate limits are shared across all server instances.');
  } else {
    // eslint-disable-next-line no-console
    console.log('[rate-limiter] UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set — using the in-memory rate-limit store (single-instance only, as before this pass).');
  }
}

/**
 * Custom `express-rate-limit` v7 Store backed by `@upstash/redis`.
 *
 * Windowing strategy: a fixed window per key, implemented with Redis'
 * `INCR` + `EXPIRE` (set only on the first hit of a window, i.e. when
 * `INCR` returns 1) — the same fixed-window algorithm `MemoryStore`
 * itself implements, so switching stores does not change a limiter's
 * observable behavior (max N per windowMs), only where the count lives.
 */
class RedisRateLimitStore {
  /**
   * @param {object} options
   * @param {string} options.prefix - Namespaces this limiter's keys within
   *   the shared Redis database (e.g. `'otp:'`) so unrelated limiters never
   *   collide on the same counter, per implementation step 3.
   */
  constructor({ prefix }) {
    this.prefix = prefix;
    this.client = getSharedRedisClient();

    // Per the Store interface's doc comment: "Typically false if a
    // database is used, true for MemoryStore." Redis is a shared external
    // store, so this must be `false` — it tells express-rate-limit that
    // hits recorded by one process ARE visible to every other process
    // using the same store, which is the entire point of this pass.
    this.localKeys = false;
  }

  /**
   * @param {import('express-rate-limit').Options} options
   */
  init(options) {
    this.windowMs = options.windowMs;
  }

  _redisKey(key) {
    return `${REDIS_KEY_ROOT}${this.prefix}${key}`;
  }

  async get(key) {
    const redisKey = this._redisKey(key);
    const [totalHits, ttlSeconds] = await Promise.all([
      this.client.get(redisKey),
      this.client.ttl(redisKey),
    ]);

    if (totalHits === null || totalHits === undefined) {
      return undefined;
    }

    return {
      totalHits: Number(totalHits),
      resetTime: ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : undefined,
    };
  }

  async increment(key) {
    const redisKey = this._redisKey(key);
    const totalHits = await this.client.incr(redisKey);

    // Only set the TTL on the FIRST hit of a new window (INCR returning 1
    // means the key didn't exist a moment ago) — resetting the TTL on
    // every hit would make the window "roll" indefinitely for an active
    // client instead of expiring on a fixed schedule, which is not how
    // MemoryStore's fixed-window behavior works and would make this store
    // stricter than the one it replaces.
    if (totalHits === 1) {
      await this.client.expire(redisKey, Math.max(1, Math.ceil(this.windowMs / 1000)));
    }

    const ttlSeconds = await this.client.ttl(redisKey);
    const resetTime = ttlSeconds > 0
      ? new Date(Date.now() + ttlSeconds * 1000)
      : new Date(Date.now() + this.windowMs);

    return { totalHits, resetTime };
  }

  async decrement(key) {
    const redisKey = this._redisKey(key);
    // Guard against decrementing below zero (express-rate-limit calls
    // decrement() when a request should not count against the limit
    // after all, e.g. `skipFailedRequests`/`skipSuccessfulRequests`) —
    // @upstash/redis's DECR would happily go negative, which MemoryStore
    // never allows (it clamps at 0), so this mirrors that behavior rather
    // than introducing a store-specific quirk.
    const current = await this.client.get(redisKey);
    if (current !== null && current !== undefined && Number(current) > 0) {
      await this.client.decr(redisKey);
    }
  }

  async resetKey(key) {
    await this.client.del(this._redisKey(key));
  }

  // Deliberately NOT implementing resetAll()/shutdown() for the Redis
  // path: `resetAll` would require a SCAN across every key under this
  // limiter's prefix, which is expensive and unsafe to run in production
  // (SCAN over a live, shared database) purely to support a test-only
  // convenience. Per the spec (implementation step 6 / decision 2), no
  // test in this codebase is expected to exercise the real Redis path —
  // every test runs with the env vars absent and therefore gets the
  // MemoryStore fallback below, which already implements resetAll(). If
  // this method is ever called against a live RedisRateLimitStore
  // instance, express-rate-limit itself simply skips it (per its own
  // `Store` type, `resetAll` is optional) — no error, just a no-op.
}

/**
 * The single factory every rate limiter in this codebase must go through
 * (implementation step 2/3) — decides Redis-vs-in-memory once per limiter,
 * based purely on whether both Upstash env vars are present, with zero
 * other configuration required by the caller beyond a unique `prefix`.
 *
 * @param {string} prefix - A short, unique namespace for this limiter's
 *   keys (e.g. `'otp:'`, `'login:'`, `'public-browse:'`). Only meaningful
 *   for the Redis path (see `RedisRateLimitStore`'s doc comment) — the
 *   in-memory fallback is already isolated per-instance and doesn't need
 *   it, but every call site still passes one for consistency and so
 *   switching a given limiter to Redis later never requires touching its
 *   call site again.
 * @returns {import('express-rate-limit').Store} Either a `RedisRateLimitStore`
 *   or a plain `MemoryStore`, both of which satisfy the same `Store`
 *   interface, so callers never need to branch on which one they got.
 */
function createRateLimitStore(prefix) {
  logModeOnce();

  if (env.redis.isConfigured) {
    return new RedisRateLimitStore({ prefix });
  }

  return new MemoryStore();
}

module.exports = {
  createRateLimitStore,
  RedisRateLimitStore,
};

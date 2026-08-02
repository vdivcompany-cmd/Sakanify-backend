/**
 * redis-rate-limit-store.test.js
 *
 * Remediation Pass 3 / SEC-004 (Docs/reports/remediation-pass-3-redis-report.md).
 * Pure unit tests for the shared rate-limit store factory
 * (src/shared/utils/redis-rate-limit-store.js) — deliberately no database
 * or mongoose-touching module is required anywhere in this file (unlike
 * tests/unit/mfa.service.test.js), so this suite is not expected to hit
 * the slow-mounted-drive-plus-jest-overhead constraint documented in
 * Docs/reports/remediation-pass-2-mfa-report.md — see the phase report's
 * "Test Evidence" section for whether that held true in practice.
 *
 * Covers, per implementation step 5:
 *   - The Redis-backed store's increment/decrement/resetKey/get logic
 *     against a MOCKED `@upstash/redis` client (no real network access,
 *     per the spec's explicit instruction not to add a live-Redis test).
 *   - TTL is only set on the first hit of a window (fixed-window
 *     behavior, matching MemoryStore's own semantics), not reset on every
 *     hit.
 *   - Key namespacing: different `prefix` values never collide on the
 *     same underlying Redis key for the same rate-limit key.
 *   - The fallback path: with the Upstash env vars absent (the only
 *     configuration this sandbox and CI can actually exercise — see
 *     product decision 2), `createRateLimitStore()` returns a real,
 *     unmodified `express-rate-limit` `MemoryStore` instance — the exact
 *     class every limiter used before this pass — confirming
 *     `store.resetAll()` keeps working for every existing integration
 *     test with zero changes to those test files.
 *   - The partial-configuration case (only one of the two env vars set)
 *     also falls back to in-memory, matching env.config.js's own guard.
 */

// Mock functions are declared with a `mock` prefix so Jest allows them to
// be referenced inside the `jest.mock()` factory below (its out-of-scope
// variable restriction has an explicit exception for names starting with
// `mock`).
const mockIncr = jest.fn();
const mockExpire = jest.fn();
const mockTtl = jest.fn();
const mockGet = jest.fn();
const mockDecr = jest.fn();
const mockDel = jest.fn();

jest.mock('@upstash/redis', () => ({
  Redis: jest.fn().mockImplementation(() => ({
    incr: mockIncr,
    expire: mockExpire,
    ttl: mockTtl,
    get: mockGet,
    decr: mockDecr,
    del: mockDel,
  })),
}));

const REQUIRED_ENV = {
  MONGODB_URI: 'mongodb://localhost:27017/sakanify_unit_test_placeholder',
  JWT_ACCESS_SECRET: 'unit-test-access-secret',
  JWT_REFRESH_SECRET: 'unit-test-refresh-secret',
  MFA_ENCRYPTION_KEY: '0'.repeat(64),
};

function setRequiredEnv() {
  Object.entries(REQUIRED_ENV).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

/**
 * env.config.js reads process.env once, at require-time, and every
 * downstream module (including redis-rate-limit-store.js) imports that
 * same singleton — so switching between "Redis configured" and "Redis
 * absent" scenarios across tests requires `jest.resetModules()` plus a
 * fresh `require()` of both, in that order, every time.
 */
function loadStoreModule() {
  jest.resetModules();
  setRequiredEnv();
  // eslint-disable-next-line global-require
  return require('../../src/shared/utils/redis-rate-limit-store');
}

describe('redis-rate-limit-store — Redis-backed path (mocked @upstash/redis client)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash-instance.example.com';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('createRateLimitStore returns a RedisRateLimitStore instance when both env vars are set', () => {
    const { createRateLimitStore, RedisRateLimitStore } = loadStoreModule();
    const store = createRateLimitStore('otp:');
    expect(store).toBeInstanceOf(RedisRateLimitStore);
    expect(store.localKeys).toBe(false);
  });

  it('increment(): first hit of a window sets the TTL exactly once, using windowMs converted to seconds', async () => {
    const { createRateLimitStore } = loadStoreModule();
    const store = createRateLimitStore('login:');
    store.init({ windowMs: 15 * 60 * 1000 }); // 15 minutes

    mockIncr.mockResolvedValueOnce(1);
    mockTtl.mockResolvedValueOnce(900);

    const result = await store.increment('1.2.3.4');

    expect(mockIncr).toHaveBeenCalledWith('sakanify:ratelimit:login:1.2.3.4');
    expect(mockExpire).toHaveBeenCalledWith('sakanify:ratelimit:login:1.2.3.4', 900);
    expect(result.totalHits).toBe(1);
    expect(result.resetTime).toBeInstanceOf(Date);
  });

  it('increment(): subsequent hits within the same window do NOT reset the TTL', async () => {
    const { createRateLimitStore } = loadStoreModule();
    const store = createRateLimitStore('login:');
    store.init({ windowMs: 15 * 60 * 1000 });

    mockIncr.mockResolvedValueOnce(2); // not the first hit
    mockTtl.mockResolvedValueOnce(600); // TTL already counting down from the first hit

    const result = await store.increment('1.2.3.4');

    expect(mockExpire).not.toHaveBeenCalled();
    expect(result.totalHits).toBe(2);
  });

  it('decrement(): calls DECR only when the current count is above zero', async () => {
    const { createRateLimitStore } = loadStoreModule();
    const store = createRateLimitStore('otp:');

    mockGet.mockResolvedValueOnce('3');
    await store.decrement('1.2.3.4');
    expect(mockDecr).toHaveBeenCalledWith('sakanify:ratelimit:otp:1.2.3.4');

    mockDecr.mockClear();
    mockGet.mockResolvedValueOnce('0');
    await store.decrement('1.2.3.4');
    expect(mockDecr).not.toHaveBeenCalled();

    mockDecr.mockClear();
    mockGet.mockResolvedValueOnce(null);
    await store.decrement('1.2.3.4');
    expect(mockDecr).not.toHaveBeenCalled();
  });

  it('resetKey(): deletes the correctly-namespaced key', async () => {
    const { createRateLimitStore } = loadStoreModule();
    const store = createRateLimitStore('password-reset:');

    await store.resetKey('owner@example.com');
    expect(mockDel).toHaveBeenCalledWith('sakanify:ratelimit:password-reset:owner@example.com');
  });

  it('get(): returns undefined for a key with no recorded hits', async () => {
    const { createRateLimitStore } = loadStoreModule();
    const store = createRateLimitStore('otp:');

    mockGet.mockResolvedValueOnce(null);
    mockTtl.mockResolvedValueOnce(-2); // Redis TTL convention: -2 = key does not exist

    const result = await store.get('1.2.3.4');
    expect(result).toBeUndefined();
  });

  it('get(): returns totalHits + resetTime for a key with recorded hits', async () => {
    const { createRateLimitStore } = loadStoreModule();
    const store = createRateLimitStore('otp:');

    mockGet.mockResolvedValueOnce('2');
    mockTtl.mockResolvedValueOnce(120);

    const result = await store.get('1.2.3.4');
    expect(result.totalHits).toBe(2);
    expect(result.resetTime).toBeInstanceOf(Date);
  });

  it('namespacing: two limiters with different prefixes never collide on the same underlying Redis key', async () => {
    const { createRateLimitStore } = loadStoreModule();
    const otpStore = createRateLimitStore('otp:');
    const loginStore = createRateLimitStore('login:');
    otpStore.init({ windowMs: 60000 });
    loginStore.init({ windowMs: 60000 });

    mockIncr.mockResolvedValueOnce(1);
    mockTtl.mockResolvedValueOnce(60);
    await otpStore.increment('1.2.3.4');

    mockIncr.mockResolvedValueOnce(1);
    mockTtl.mockResolvedValueOnce(60);
    await loginStore.increment('1.2.3.4');

    const calledKeys = mockIncr.mock.calls.map((call) => call[0]);
    expect(calledKeys).toEqual([
      'sakanify:ratelimit:otp:1.2.3.4',
      'sakanify:ratelimit:login:1.2.3.4',
    ]);
    expect(new Set(calledKeys).size).toBe(2); // no collision
  });
});

describe('redis-rate-limit-store — automatic in-memory fallback (product decision 2)', () => {
  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('falls back to a real MemoryStore when both Upstash env vars are absent', () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const { createRateLimitStore, RedisRateLimitStore } = loadStoreModule();
    // eslint-disable-next-line global-require
    const { MemoryStore } = require('express-rate-limit');

    const store = createRateLimitStore('otp:');
    expect(store).toBeInstanceOf(MemoryStore);
    expect(store).not.toBeInstanceOf(RedisRateLimitStore);
    expect(typeof store.resetAll).toBe('function');
  });

  it('falls back to in-memory when only UPSTASH_REDIS_REST_URL is set (partial config)', () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash-instance.example.com';
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const { createRateLimitStore, RedisRateLimitStore } = loadStoreModule();
    // eslint-disable-next-line global-require
    const { MemoryStore } = require('express-rate-limit');

    const store = createRateLimitStore('login:');
    expect(store).toBeInstanceOf(MemoryStore);
    expect(store).not.toBeInstanceOf(RedisRateLimitStore);
  });

  it('falls back to in-memory when only UPSTASH_REDIS_REST_TOKEN is set (partial config)', () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

    const { createRateLimitStore, RedisRateLimitStore } = loadStoreModule();
    // eslint-disable-next-line global-require
    const { MemoryStore } = require('express-rate-limit');

    const store = createRateLimitStore('password-reset:');
    expect(store).toBeInstanceOf(MemoryStore);
    expect(store).not.toBeInstanceOf(RedisRateLimitStore);
  });

  it('a fallback MemoryStore actually works end-to-end (increment, then resetAll clears it)', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const { createRateLimitStore } = loadStoreModule();
    const store = createRateLimitStore('otp:');
    store.init({ windowMs: 60000 });

    const first = await store.increment('9.9.9.9');
    expect(first.totalHits).toBe(1);
    const second = await store.increment('9.9.9.9');
    expect(second.totalHits).toBe(2);

    await store.resetAll();

    const afterReset = await store.increment('9.9.9.9');
    expect(afterReset.totalHits).toBe(1); // back to a fresh count, exactly like every existing integration test relies on
  });
});

/**
 * rate-limiter.middleware.js
 *
 * Basic abuse protection applied globally in app.entry.js. Per-route,
 * stricter limiters (e.g. login/OTP endpoints in Phase 1) can be built on
 * top of express-rate-limit separately when those routes are added.
 */

const rateLimit = require('express-rate-limit');
const { error } = require('../shared/utils/response.util');
const { createRateLimitStore } = require('../shared/utils/redis-rate-limit-store');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 min
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX) || 100;

const rateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  // Remediation Pass 3 / SEC-004: previously had no explicit `store`,
  // meaning express-rate-limit silently constructed its own internal
  // MemoryStore. Now goes through the same shared factory as every other
  // limiter, for consistency (and so this global limiter also becomes
  // Redis-backed once Upstash is configured, not just the per-route ones).
  store: createRateLimitStore('global:'),
  // Regression fix (post-hardening-pass): this global limiter's scope/
  // mounting order in app.entry.js never changed — it was already applied
  // to every route, before and after the hardening pass. What changed is
  // that the integration suite grew (new subscription-capacity tests in
  // buildings-apartments-beds.test.js), and that one file already fires
  // 100+ HTTP requests against a single shared app/limiter instance
  // (Jest's per-file module registry — the same reason auth.routes.js's
  // OTP/login limiters needed an explicit resetAll() mechanism for
  // cross-`it()`-block isolation within one file, documented there).
  // Unlike those route-specific limiters, nothing in the test suite
  // asserts on *this* global limiter's 429 behavior (confirmed: every
  // existing 429 test targets otpLimiter/loginLimiter/browsingLimiter/
  // leadLimiter specifically), so skipping it in NODE_ENV=test removes a
  // latent test-suite-size ceiling with zero loss of real coverage.
  // Production/development behavior is completely unchanged.
  skip: () => process.env.NODE_ENV === 'test',
  handler: (req, res) => {
    error(res, {
      statusCode: 429,
      message: 'Too many requests. Please try again later.',
    });
  },
});

module.exports = rateLimiter;

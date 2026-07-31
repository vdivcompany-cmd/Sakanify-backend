/**
 * rate-limiter.middleware.js
 *
 * Basic abuse protection applied globally in app.entry.js. Per-route,
 * stricter limiters (e.g. login/OTP endpoints in Phase 1) can be built on
 * top of express-rate-limit separately when those routes are added.
 */

const rateLimit = require('express-rate-limit');
const { error } = require('../shared/utils/response.util');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 min
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX) || 100;

const rateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    error(res, {
      statusCode: 429,
      message: 'Too many requests. Please try again later.',
    });
  },
});

module.exports = rateLimiter;

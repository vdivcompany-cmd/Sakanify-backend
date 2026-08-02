/**
 * mfa.routes.js
 *
 * Remediation Pass 2 / SEC-002. Mounted under /api/auth/mfa (see
 * app.entry.js). Every route here is auth'd by one of the two scoped-token
 * middlewares in auth.middleware.js — never the normal verifyToken(),
 * since none of these tokens are a real session (see mfa.controller.js's
 * doc comments on each handler for exactly which token each route needs).
 *
 * Rate limiting (implementation step 7): "Rate-limit verify-login and
 * verify-setup aggressively — this is now a brute-forceable 6-digit code
 * path, same risk profile as the student OTP flow." setup() itself is
 * rate-limited too (a more generous limit) for consistency with CLAUDE.md
 * 3.7's blanket "rate-limit all authentication endpoints," even though its
 * abuse potential is much lower (it requires already having a valid
 * setup/access token, which itself required a correct password).
 *
 * Each limiter gets its own explicit MemoryStore, same reasoning/pattern
 * as auth.routes.js and public.routes.js: tests need to call
 * store.resetAll() between suites/cases without one test's requests
 * exhausting every later test's quota, without changing real
 * max/windowMs behavior.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createRateLimitStore } = require('../../shared/utils/redis-rate-limit-store');
const mfaController = require('./mfa.controller');
const { verifyMfaSetupAccess, verifyMfaPendingAccess } = require('../../middleware/auth.middleware');

const router = express.Router();

// Remediation Pass 3 / SEC-004: stores now come from the shared
// Redis-backed factory (falls back to the same MemoryStore as before when
// Upstash isn't configured — see redis-rate-limit-store.js's header
// comment). `store.resetAll()` below continues to work unchanged in tests,
// since the fallback path returns a real MemoryStore.
const setupStore = createRateLimitStore('mfa-setup:');
const verifySetupStore = createRateLimitStore('mfa-verify-setup:');
const verifyLoginStore = createRateLimitStore('mfa-verify-login:');

// Generous — requires a valid setup/access token already (i.e. a correct
// password was already required upstream); not a brute-forceable code path
// on its own.
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many MFA setup requests. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: setupStore,
});

// Aggressive — a 6-digit TOTP code (1,000,000 possibilities) confirming a
// brand-new enrollment. Same class of protection as otpLimiter in
// auth.routes.js.
const verifySetupLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: 'Too many MFA verification attempts. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: verifySetupStore,
});

// Aggressive — same reasoning as verifySetupLimiter, but this is also the
// path that accepts backup codes, which is exactly why decision 6 sizes
// the backup-code space at 40 bits: even under this limiter, that space is
// not the weak point, but the limiter still applies uniformly to both
// paths through this one endpoint.
const verifyLoginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: 'Too many login verification attempts. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: verifyLoginStore,
});

/**
 * POST /api/auth/mfa/setup
 * Auth: full Super-Admin session OR a bare/enriched mfa_setup token.
 */
router.post('/setup', setupLimiter, verifyMfaSetupAccess, mfaController.setup);

/**
 * POST /api/auth/mfa/verify-setup
 * Auth: an mfa_setup token carrying pending_secret_encrypted (i.e. one
 * returned by /setup above).
 * Body: { code: "123456" }
 */
router.post('/verify-setup', verifySetupLimiter, verifyMfaSetupAccess, mfaController.verifySetup);

/**
 * POST /api/auth/mfa/verify-login
 * Auth: an mfa_pending token (issued by POST /api/auth/login-owner when
 * mfa_enabled is already true).
 * Body: { code: "123456" } OR { backup_code: "A1B2C3D4E5" }
 */
router.post('/verify-login', verifyLoginLimiter, verifyMfaPendingAccess, mfaController.verifyLogin);

// --- Test-only escape hatch, same pattern as auth.routes.js ---
router.rateLimitStores = {
  setup: setupStore,
  verifySetup: verifySetupStore,
  verifyLogin: verifyLoginStore,
};

module.exports = router;

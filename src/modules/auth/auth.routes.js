/**
 * auth.routes.js
 *
 * Authentication endpoints: student login (OTP-based), owner/admin login (email/password),
 * token management, password reset, and admin owner-invitation.
 *
 * Rate limiting is applied more strictly to auth endpoints to prevent
 * brute-force attacks and OTP spam.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createRateLimitStore } = require('../../shared/utils/redis-rate-limit-store');
const authController = require('./auth.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

// --- Stricter rate limiting for auth endpoints ---
//
// Remediation Pass 3 / SEC-004: every store below now comes from the
// shared Redis-backed factory (redis-rate-limit-store.js) instead of
// constructing its own MemoryStore directly — this is what makes rate
// limiting stay effective across more than one server instance once
// Upstash credentials are configured. When they're not (local dev, CI,
// or any environment before Upstash is provisioned), the factory
// transparently falls back to the exact same MemoryStore class every
// limiter used before this pass, so `store.resetAll()` (see below) keeps
// working with zero changes to any test file.
//
// NOTE: The rate-limit key is the client IP by default. In a real deployment
// with many distinct users behind different IPs, that's fine. But every
// request made by supertest in a test run originates from the same
// simulated IP, so without a way to reset between test groups, the very
// first 3 OTP requests in an entire test run would exhaust the limiter for
// every test after it — that was the root cause of the CI failures we saw.

const otpStore = createRateLimitStore('otp:');
const loginStore = createRateLimitStore('login:');
const passwordResetStore = createRateLimitStore('password-reset:');
const refreshTokenStore = createRateLimitStore('refresh-token:');

// OTP requests: max 3 per 5 minutes to prevent spam
const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3,
  message: 'Too many OTP requests. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: otpStore,
});

// Login attempts: max 5 per 15 minutes to prevent brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: loginStore,
});

// Password reset: max 3 per 60 minutes
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 60 minutes
  max: 3,
  message: 'Too many password reset requests. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: passwordResetStore,
});

// Remediation Pass 1 / SEC-006 (Docs/reports/remediation-pass-1-report.md):
// refresh-token was the one auth endpoint with no rate limiter at all,
// inconsistent with CLAUDE.md 3.7's "rate-limit all authentication
// endpoints." Low practical exploitability (refresh tokens are unguessable
// 256-bit-class JWTs, not a brute-forceable secret), so this is a generous
// defense-in-depth limit, not a tight anti-brute-force one — legitimate
// clients refresh their access token roughly every 15-30 minutes
// (env.jwt.accessExpiry), so even a client refreshing unusually often
// stays well under this well before it'd ever affect real usage.
const refreshTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: 'Too many token refresh requests. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: refreshTokenStore,
});

// --- Public endpoints (no authentication required) ---

/**
 * POST /api/auth/register-student
 * Register a new student account (phone-based)
 */
router.post('/register-student', otpLimiter, authController.registerStudent);

/**
 * POST /api/auth/request-otp
 * Request OTP code for student login
 * Body: { phone: "+201234567890" }
 */
router.post('/request-otp', otpLimiter, authController.requestOtp);

/**
 * POST /api/auth/verify-otp
 * Verify OTP code and log in student
 * Body: { phone: "+201234567890", code: "123456" }
 */
router.post('/verify-otp', otpLimiter, authController.verifyOtp);

/**
 * POST /api/auth/login-owner
 * Log in as owner or super-admin
 * Body: { email: "owner@example.com", password: "..." }
 */
router.post('/login-owner', loginLimiter, authController.loginOwner);

/**
 * POST /api/auth/refresh-token
 * Refresh access token using refresh token
 * Body: { refreshToken: "..." }
 */
router.post('/refresh-token', refreshTokenLimiter, authController.refreshToken);

/**
 * POST /api/auth/password-reset/initiate
 * Initiate password reset (email-based)
 * Body: { email: "owner@example.com" }
 */
router.post(
  '/password-reset/initiate',
  passwordResetLimiter,
  authController.initiatePasswordReset,
);

// --- Protected endpoints (authentication required) ---

/**
 * POST /api/auth/logout
 * Logout current user
 * Headers: { Authorization: "Bearer <accessToken>" }
 */
router.post('/logout', verifyToken, authController.logout);

/**
 * POST /api/auth/password-reset/complete
 * Complete password reset with new password
 * Headers: { Authorization: "Bearer <accessToken>" }
 * Body: { newPassword: "..." }
 */
router.post(
  '/password-reset/complete',
  verifyToken,
  authController.completePasswordReset,
);

// --- Admin-only endpoints ---

/**
 * POST /api/auth/invite-owner
 * Invite a new owner account (super-admin only)
 * Headers: { Authorization: "Bearer <superAdminToken>" }
 * Body: { email: "owner@example.com", temporaryPassword: "..." }
 */
router.post(
  '/invite-owner',
  verifyToken,
  requireRole(ROLES.SUPER_ADMIN),
  authController.inviteOwner,
);

// --- Test-only escape hatch ---
// Exposes the rate-limit stores so integration tests can call
// resetAll() between test suites (see tests/integration/*.test.js).
// This does not affect production: the router itself is unchanged,
// this is just an extra property attached to the exported function.
router.rateLimitStores = {
  otp: otpStore,
  login: loginStore,
  passwordReset: passwordResetStore,
  refreshToken: refreshTokenStore,
};

module.exports = router;
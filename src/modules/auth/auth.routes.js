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
const authController = require('./auth.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

// --- Stricter rate limiting for auth endpoints ---
// OTP requests: max 3 per 5 minutes to prevent spam
const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3,
  message: 'Too many OTP requests. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
});

// Login attempts: max 5 per 15 minutes to prevent brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
});

// Password reset: max 3 per 60 minutes
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 60 minutes
  max: 3,
  message: 'Too many password reset requests. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
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
router.post('/refresh-token', authController.refreshToken);

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

module.exports = router;
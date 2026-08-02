/**
 * auth.controller.js
 *
 * Handles incoming auth requests: registration, login, token refresh, logout,
 * password reset. Delegates business logic to auth.service.
 */

const { success, error } = require('../../shared/utils/response.util');
const authService = require('./auth.service');
const otpService = require('./otp.service');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

// Security-hardening-pass addition (hardening-audit Category 5 / CLAUDE.md
// Section 7.3a): every catch block in this controller used to do
// `error(res, { statusCode: <hardcoded 400/401>, message: err.message })`
// directly — never classifying the error and never redacting an
// unexpected/internal error's message in production. Routed through
// normalizeError() now, same pattern already used by every other
// controller in this codebase (payment/rental/request/admin/etc) — see
// error-handler.middleware.js's normalizeError doc comment for why the
// prod-message redaction has to live there rather than only in the
// (effectively unreachable, since nothing here calls next(err))
// central errorHandler.
function handleControllerError(res, err, context, defaultStatusCode = 400) {
  if (!(err instanceof AppError)) {
    console.error(`[auth.controller:${context}]`, err);
  }

  // auth.service.js/otp.service.js throw plain `Error` objects with
  // deliberately client-safe messages (their own established convention —
  // e.g. "Invalid or expired OTP", "Invalid email or password") rather
  // than AppError instances or statusCode-tagged errors, so
  // normalizeError()'s fallback branch would misclassify every one of them
  // as an unexpected 500 and (correctly, but wrongly here) redact the
  // message in production. Recognized/classified error shapes (AppError,
  // Mongoose errors, JWT errors, anything with an explicit .statusCode)
  // still go through normalizeError() for correct status mapping and, for
  // a genuine 5xx, production redaction; anything else keeps this
  // controller's original per-endpoint default status code with the
  // service's own message — unchanged behavior from before this
  // hardening pass, now with the missing console.error logging added.
  const isRecognizedShape = err instanceof AppError
    || err.statusCode
    || err.name === 'ValidationError'
    || err.name === 'CastError'
    || err.code === 11000
    || err.name === 'JsonWebTokenError'
    || err.name === 'TokenExpiredError';

  if (isRecognizedShape) {
    const { statusCode, message, errors } = normalizeError(err);
    return error(res, { statusCode, message, errors });
  }

  return error(res, { statusCode: defaultStatusCode, message: err.message || 'Request failed' });
}

/**
 * POST /api/auth/register-student
 * Public endpoint for student registration
 */
async function registerStudent(req, res) {
  try {
    const { phone } = req.body;

    if (!phone) {
      return error(res, {
        statusCode: 400,
        message: 'Phone number is required',
      });
    }

    const result = await authService.registerStudent(phone);
    return success(res, {
      statusCode: 201,
      message: 'Student registered',
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'registerStudent', 400);
  }
}

/**
 * POST /api/auth/request-otp
 * Public endpoint for requesting OTP (student login)
 */
async function requestOtp(req, res) {
  try {
    const { phone } = req.body;

    if (!phone) {
      return error(res, {
        statusCode: 400,
        message: 'Phone number is required',
      });
    }

    const result = await otpService.requestOtp(phone);
    return success(res, {
      statusCode: 200,
      message: 'OTP sent',
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'requestOtp', 400);
  }
}

/**
 * POST /api/auth/verify-otp
 * Public endpoint for verifying OTP and logging in student
 */
async function verifyOtp(req, res) {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return error(res, {
        statusCode: 400,
        message: 'Phone and OTP code are required',
      });
    }

    const result = await authService.loginStudent(phone, code);
    return success(res, {
      statusCode: 200,
      message: 'Student logged in',
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'verifyOtp', 401);
  }
}

/**
 * POST /api/auth/login-owner
 * Public endpoint for owner/admin login
 */
async function loginOwner(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return error(res, {
        statusCode: 400,
        message: 'Email and password are required',
      });
    }

    const result = await authService.loginOwner(email, password);

    // Remediation Pass 2 / SEC-002: the top-level message must reflect what
    // actually happened — "Logged in successfully" would be misleading for
    // a Super-Admin who does NOT yet have a real session (see
    // authService.loginOwner's mfa_enabled branches). The Owner path
    // (neither flag set) is completely unaffected.
    let message = 'Logged in successfully';
    if (result.mfaSetupRequired) {
      message = 'MFA setup is required before you can access the platform.';
    } else if (result.mfaVerificationRequired) {
      message = 'Enter your authenticator code to complete login.';
    }

    return success(res, {
      statusCode: 200,
      message,
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'loginOwner', 401);
  }
}

/**
 * POST /api/auth/refresh-token
 * Public endpoint for refreshing access token
 */
async function refreshToken(req, res) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return error(res, {
        statusCode: 400,
        message: 'Refresh token is required',
      });
    }

    const result = await authService.refreshAccessToken(refreshToken);
    return success(res, {
      statusCode: 200,
      message: 'Access token refreshed',
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'refreshToken', 401);
  }
}

/**
 * POST /api/auth/logout
 * Protected endpoint (requires valid access token)
 */
async function logout(req, res) {
  try {
    const userId = req.user.userId; // From auth middleware

    const result = await authService.logout(userId);
    return success(res, {
      statusCode: 200,
      message: 'Logged out successfully',
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'logout', 400);
  }
}

/**
 * POST /api/auth/password-reset/initiate
 * Public endpoint to initiate password reset
 */
async function initiatePasswordReset(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return error(res, {
        statusCode: 400,
        message: 'Email is required',
      });
    }

    const result = await authService.initiatePasswordReset(email);
    return success(res, {
      statusCode: 200,
      message: result.message,
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'initiatePasswordReset', 400);
  }
}

/**
 * POST /api/auth/password-reset/complete
 * Protected endpoint (requires valid access token)
 */
async function completePasswordReset(req, res) {
  try {
    const userId = req.user.userId; // From auth middleware
    const { newPassword } = req.body;

    if (!newPassword) {
      return error(res, {
        statusCode: 400,
        message: 'New password is required',
      });
    }

    const result = await authService.completePasswordReset(userId, newPassword);
    return success(res, {
      statusCode: 200,
      message: result.message,
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'completePasswordReset', 400);
  }
}

/**
 * POST /api/auth/invite-owner
 * Admin-only endpoint for inviting owner accounts
 */
async function inviteOwner(req, res) {
  try {
    const { email, temporaryPassword } = req.body;

    if (!email || !temporaryPassword) {
      return error(res, {
        statusCode: 400,
        message: 'Email and temporary password are required',
      });
    }

    const result = await authService.inviteOwner(email, temporaryPassword);
    return success(res, {
      statusCode: 201,
      message: 'Owner invited successfully',
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'inviteOwner', 400);
  }
}

module.exports = {
  registerStudent,
  requestOtp,
  verifyOtp,
  loginOwner,
  refreshToken,
  logout,
  initiatePasswordReset,
  completePasswordReset,
  inviteOwner,
};
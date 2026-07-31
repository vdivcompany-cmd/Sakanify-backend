/**
 * auth.controller.js
 *
 * Handles incoming auth requests: registration, login, token refresh, logout,
 * password reset. Delegates business logic to auth.service.
 */

const { success, error } = require('../../shared/utils/response.util');
const authService = require('./auth.service');
const otpService = require('./otp.service');

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
    return error(res, {
      statusCode: 400,
      message: err.message,
    });
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
    return error(res, {
      statusCode: 400,
      message: err.message,
    });
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
    return error(res, {
      statusCode: 401,
      message: err.message,
    });
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
    return success(res, {
      statusCode: 200,
      message: 'Logged in successfully',
      data: result,
    });
  } catch (err) {
    return error(res, {
      statusCode: 401,
      message: err.message,
    });
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
    return error(res, {
      statusCode: 401,
      message: err.message,
    });
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
    return error(res, {
      statusCode: 400,
      message: err.message,
    });
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
    return error(res, {
      statusCode: 400,
      message: err.message,
    });
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
    return error(res, {
      statusCode: 400,
      message: err.message,
    });
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
    return error(res, {
      statusCode: 400,
      message: err.message,
    });
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
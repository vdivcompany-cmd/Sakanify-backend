/**
 * error-handler.middleware.js
 *
 * Central Express error handler. Every module throws/next()'s errors and
 * they all funnel through here so the API always returns the same error
 * shape (see shared/utils/response.util.js).
 *
 * Must be mounted LAST, after all routers, per Express convention.
 */

const { error } = require('../shared/utils/response.util');

/**
 * AppError lets modules throw an error with an explicit HTTP status code
 * and a client-safe message, e.g.:
 *   throw new AppError('Bed already reserved', 409);
 */
class AppError extends Error {
  constructor(message, statusCode = 400, errors = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;
  }
}

function normalizeError(err) {
  // Explicit, known application errors
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, message: err.message, errors: err.errors };
  }

  // Mongoose validation errors
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors || {}).map((e) => e.message);
    return { statusCode: 422, message: 'Validation failed', errors };
  }

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    return { statusCode: 400, message: `Invalid value for field "${err.path}"`, errors: null };
  }

  // Duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0];
    return { statusCode: 409, message: `Duplicate value for field "${field}"`, errors: null };
  }

  // JWT errors (Phase 1 onward)
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return { statusCode: 401, message: 'Invalid or expired token', errors: null };
  }

  // Fallback: unknown/unexpected error
  return { statusCode: err.statusCode || 500, message: err.message || 'Internal Server Error', errors: null };
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const { statusCode, message, errors } = normalizeError(err);

  if (statusCode >= 500) {
    console.error(`[error-handler] ${req.method} ${req.originalUrl} ->`, err);
  }

  const isProd = process.env.NODE_ENV === 'production';

  return error(res, {
    statusCode,
    message,
    errors: isProd && statusCode >= 500 ? null : errors,
  });
}

module.exports = errorHandler;
module.exports.AppError = AppError;

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
  // Explicit, known application errors. AppError's message is always
  // developer-written to be client-safe by construction (see the class's
  // own doc comment) — never redacted, even at 5xx, in any environment.
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

  // Known-shape client errors that aren't AppError instances (e.g.
  // student.validation.js's zod helper throws a plain Error with an
  // explicit `.statusCode` < 500 and a `.errors` array) — classify by the
  // explicit statusCode and preserve the field-level errors array, same as
  // AppError would. Security-hardening-pass addition (Aug 2026): this
  // branch didn't exist before, so any 4xx error shaped this way used to
  // fall into the fallback below and silently lose its `errors` array.
  if (err.statusCode && Number(err.statusCode) < 500) {
    return { statusCode: err.statusCode, message: err.message || 'Request failed', errors: err.errors || null };
  }

  // Fallback: genuinely unknown/unexpected error (a real bug, a DB
  // connection failure, etc). Security-hardening-pass addition (Aug 2026):
  // CLAUDE.md Section 3.5/hardening-audit Category 5 requires that
  // production error responses never leak raw internals (a Mongoose
  // connection error message, a third-party library's error string, etc)
  // — `err.message` here is NOT developer-written to be client-safe the
  // way AppError's is, so it must be redacted once NODE_ENV=production and
  // the response is a 5xx. Non-production environments keep the real
  // message so local/CI debugging isn't hurt. This redaction now lives
  // here (the single function every controller's error handling funnels
  // through, whether via the central errorHandler below or a per-module
  // handleControllerError) rather than only in errorHandler, because most
  // controllers in this codebase catch their own errors and respond
  // directly — they never call next(err), so the central errorHandler
  // never actually runs for them; normalizeError is the only shared choke
  // point that reaches every code path.
  const statusCode = err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';
  const message = isProd && statusCode >= 500 ? 'Internal Server Error' : (err.message || 'Internal Server Error');
  return { statusCode, message, errors: null };
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const { statusCode, message, errors } = normalizeError(err);

  if (statusCode >= 500) {
    console.error(`[error-handler] ${req.method} ${req.originalUrl} ->`, err);
  }

  // normalizeError() already redacts the message for prod 5xxs; `errors`
  // is only ever populated for classified 4xx cases (never alongside a
  // 5xx), so no additional isProd branching is needed here.
  return error(res, { statusCode, message, errors });
}

module.exports = errorHandler;
module.exports.AppError = AppError;
module.exports.normalizeError = normalizeError;

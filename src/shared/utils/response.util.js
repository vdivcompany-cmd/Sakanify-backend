/**
 * response.util.js
 *
 * Single standardized response shape used by every module in the project.
 * Every controller should respond through success()/error() instead of
 * calling res.json()/res.status() directly, so the API surface is uniform.
 */

function success(res, { statusCode = 200, message = 'OK', data = null, meta = null } = {}) {
  const body = {
    success: true,
    message,
    data,
  };

  if (meta) body.meta = meta;

  return res.status(statusCode).json(body);
}

function error(res, { statusCode = 500, message = 'Internal Server Error', errors = null } = {}) {
  const body = {
    success: false,
    message,
  };

  if (errors) body.errors = errors;

  return res.status(statusCode).json(body);
}

module.exports = {
  success,
  error,
};

/**
 * request-logger.middleware.js
 *
 * Basic operational request/response logging (method, path, status,
 * duration). This is NOT the audit log — audit logging of business state
 * changes (bed/payment/request status) is a separate module built later.
 */

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`;

    if (res.statusCode >= 500) {
      console.error(line);
    } else if (res.statusCode >= 400) {
      console.warn(line);
    } else {
      console.log(line);
    }
  });

  next();
}

module.exports = requestLogger;

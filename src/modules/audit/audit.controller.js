/**
 * audit.controller.js
 *
 * Read-only, super-admin-facing access to the audit log. Nothing in this
 * module ever writes — writes only ever happen through
 * audit.service.writeAuditLog(), called by other modules
 * (bed-history.service, kyc.service, and future Requests/Payments).
 */

const { success, error } = require('../../shared/utils/response.util');
const auditService = require('./audit.service');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

// Security-hardening-pass addition (hardening-audit Category 5 / CLAUDE.md
// Section 7.3a) — same reasoning as every other retrofitted controller in
// this pass: the old `err.statusCode || 400` catch collapsed every error
// into an unclassified, unlogged 400 and never redacted an unexpected
// error's message in production.
function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[audit.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

/**
 * GET /api/audit
 * Super-admin only. Query params: entity_type?, entity_id?, actor?, action?, page?, limit?
 */
async function listAuditLogs(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const filters = {
      entityType: req.query.entity_type || undefined,
      entityId: req.query.entity_id || undefined,
      actor: req.query.actor || undefined,
      action: req.query.action || undefined,
    };

    const { entries, total } = await auditService.listAuditLogs(filters, { skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Audit log retrieved',
      data: entries,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listAuditLogs');
  }
}

/**
 * GET /api/audit/entity/:entityType/:entityId
 * Super-admin only. Full, unpaginated history for a single entity — used
 * for "show me everything that ever happened to this bed/KYC record"
 * views. Bounded by nature (one entity's lifetime of changes is never
 * unbounded the way the whole log is), so pagination is not required here.
 */
async function getEntityHistory(req, res) {
  try {
    const { entityType, entityId } = req.params;
    const entries = await auditService.getEntityHistory(entityType, entityId);

    return success(res, {
      statusCode: 200,
      message: 'Entity audit history retrieved',
      data: entries,
    });
  } catch (err) {
    return handleControllerError(res, err, 'getEntityHistory');
  }
}

module.exports = {
  listAuditLogs,
  getEntityHistory,
};

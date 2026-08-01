/**
 * audit.service.js
 *
 * Generic audit-logging entry point used by every other module.
 * `writeAuditLog` is the one function every module (bed-history.service
 * this phase, kyc.service retrofitted this phase, and Requests/Payments
 * in Phase 4/5) calls to record a state-changing action, per the "Added
 * After Phase 2 Review" section of Docs/phase-3-buildings-apartments-beds.md.
 */

const auditRepository = require('./audit.repository');
const { AppError } = require('../../middleware/error-handler.middleware');

/**
 * Write a single, immutable audit entry.
 *
 * @param {Object} params
 * @param {string|null} [params.actor] - User id of whoever performed the action; null for automated/system actions (e.g. request-expiry.job)
 * @param {string} params.action - e.g. "bed_status_change", "kyc_status_change"
 * @param {string} params.entityType - e.g. "Bed", "Kyc"
 * @param {string} params.entityId - id of the affected document
 * @param {Object|null} [params.beforeState] - relevant fields before the change
 * @param {Object|null} [params.afterState] - relevant fields after the change
 */
async function writeAuditLog({ actor = null, action, entityType, entityId, beforeState = null, afterState = null }) {
  if (!action || !entityType || !entityId) {
    throw new AppError('writeAuditLog requires action, entityType, and entityId', 400);
  }

  return auditRepository.create({
    actor,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_state: beforeState,
    after_state: afterState,
  });
}

/**
 * Full history for a single entity (e.g. every status change a specific
 * bed has ever gone through) — used by bed-history.service.
 */
async function getEntityHistory(entityType, entityId) {
  return auditRepository.findByEntity(entityType, entityId);
}

/**
 * Super-admin-facing, paginated, filterable query over the whole log.
 */
async function listAuditLogs(filters, pagination) {
  const [entries, total] = await Promise.all([
    auditRepository.list(filters, pagination),
    auditRepository.count(filters),
  ]);

  return { entries, total };
}

module.exports = {
  writeAuditLog,
  getEntityHistory,
  listAuditLogs,
};

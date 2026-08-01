/**
 * bed-history.service.js
 *
 * Thin wrapper around audit.service.writeAuditLog() — NOT a separate
 * logging mechanism. Per the "Added After Phase 2 Review" section of
 * Docs/phase-3-buildings-apartments-beds.md: bed status transitions and
 * KYC verification decisions now share one real, already-tested audit
 * mechanism instead of two parallel ones.
 */

const auditService = require('../audit/audit.service');

const ENTITY_TYPE = 'Bed';
const ACTION = 'bed_status_change';

/**
 * Record a single bed status transition. Called by bed.service whenever
 * a bed's `status` field actually changes (never called for updates that
 * don't touch status, e.g. editing room_label).
 */
async function recordStatusChange(bedId, actorUserId, previousStatus, newStatus) {
  return auditService.writeAuditLog({
    actor: actorUserId,
    action: ACTION,
    entityType: ENTITY_TYPE,
    entityId: bedId,
    beforeState: { status: previousStatus },
    afterState: { status: newStatus },
  });
}

/**
 * Full append-only status-change history for one bed — used by owner
 * dashboards and, later, dispute resolution (CLAUDE.md Section 5.3).
 */
async function getHistoryForBed(bedId) {
  return auditService.getEntityHistory(ENTITY_TYPE, bedId);
}

module.exports = {
  recordStatusChange,
  getHistoryForBed,
};

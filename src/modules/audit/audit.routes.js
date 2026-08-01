/**
 * audit.routes.js
 *
 * Super-admin-facing, read-only audit query endpoints. Every other module
 * writes into this collection via audit.service.writeAuditLog() directly
 * (a service call, never an HTTP round-trip) — there is no POST route
 * here on purpose, matching the phase spec: "Query audit records
 * (super-admin facing, read-only)".
 */

const express = require('express');
const auditController = require('./audit.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

/**
 * GET /api/audit
 * Super-admin only, paginated. Optional filters: entity_type, entity_id, actor, action.
 */
router.get('/', verifyToken, requireRole(ROLES.SUPER_ADMIN), auditController.listAuditLogs);

/**
 * GET /api/audit/entity/:entityType/:entityId
 * Super-admin only. Full history for a single entity.
 */
router.get(
  '/entity/:entityType/:entityId',
  verifyToken,
  requireRole(ROLES.SUPER_ADMIN),
  auditController.getEntityHistory,
);

module.exports = router;

/**
 * audit.repository.js
 *
 * Data-access layer for the Audit collection. Deliberately exposes only
 * `create` and read operations — no update/delete function exists here at
 * all, so it is structurally impossible for any service in the codebase
 * to mutate or remove an existing audit entry (CLAUDE.md Section 5.3).
 */

const Audit = require('./audit.model');

function create(data) {
  return Audit.create(data);
}

function findByEntity(entityType, entityId) {
  return Audit.find({ entity_type: entityType, entity_id: entityId }).sort({ created_at: -1 });
}

/**
 * Builds the shared filter object for list()/count() below.
 *
 * `startDate`/`endDate` (Phase 7 addition, Docs/phase-7-admin.md
 * implementation step 6 — "optional date-range filtering" on the
 * platform-wide activity feed) filter on `created_at`. This is an
 * additive, backward-compatible retrofit onto the Phase 3 audit module:
 * every existing caller (bed-history.service, kyc.service,
 * request.service, etc.) keeps working unchanged since it never passes
 * these keys.
 */
function buildQuery(filters = {}) {
  const query = {};
  if (filters.entityType) query.entity_type = filters.entityType;
  if (filters.entityId) query.entity_id = filters.entityId;
  if (filters.actor) query.actor = filters.actor;
  if (filters.action) query.action = filters.action;
  if (filters.startDate || filters.endDate) {
    query.created_at = {};
    if (filters.startDate) query.created_at.$gte = filters.startDate;
    if (filters.endDate) query.created_at.$lte = filters.endDate;
  }

  return query;
}

/**
 * List audit entries with optional filters, paginated.
 * filters: { entityType?, entityId?, actor?, action?, startDate?, endDate? }
 */
function list(filters = {}, { skip = 0, limit = 20 } = {}) {
  return Audit.find(buildQuery(filters)).sort({ created_at: -1 }).skip(skip).limit(limit);
}

function count(filters = {}) {
  return Audit.countDocuments(buildQuery(filters));
}

module.exports = {
  create,
  findByEntity,
  list,
  count,
};

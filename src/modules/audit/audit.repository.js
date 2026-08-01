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
 * List audit entries with optional filters, paginated.
 * filters: { entityType?, entityId?, actor?, action? }
 */
function list(filters = {}, { skip = 0, limit = 20 } = {}) {
  const query = {};
  if (filters.entityType) query.entity_type = filters.entityType;
  if (filters.entityId) query.entity_id = filters.entityId;
  if (filters.actor) query.actor = filters.actor;
  if (filters.action) query.action = filters.action;

  return Audit.find(query).sort({ created_at: -1 }).skip(skip).limit(limit);
}

function count(filters = {}) {
  const query = {};
  if (filters.entityType) query.entity_type = filters.entityType;
  if (filters.entityId) query.entity_id = filters.entityId;
  if (filters.actor) query.actor = filters.actor;
  if (filters.action) query.action = filters.action;

  return Audit.countDocuments(query);
}

module.exports = {
  create,
  findByEntity,
  list,
  count,
};

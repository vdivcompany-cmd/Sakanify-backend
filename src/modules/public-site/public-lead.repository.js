/**
 * public-lead.repository.js
 *
 * Data-access layer for the PublicLead collection. Controllers/services
 * never touch the PublicLead mongoose model directly — everything goes
 * through here, per CLAUDE.md Section 7.2. Not one of the files literally
 * named in Docs/phase-8-public-site.md's folder listing (which lists only
 * public-lead.model/public-lead.service), but added anyway to match the
 * repository-layer convention every other module in this codebase
 * follows — same kind of additive-but-consistent decision flagged in
 * earlier phase reports (e.g. pagination.util.js in Phase 3).
 */

const PublicLead = require('./public-lead.model');

function create(data) {
  return PublicLead.create(data);
}

function findById(leadId) {
  return PublicLead.findById(leadId);
}

// Ownership-scoped find — every owner-facing list query filters by
// owner_id at the query level, per CLAUDE.md Section 3.3.
function findByOwner(ownerId, { skip = 0, limit = 20 } = {}) {
  return PublicLead.find({ owner_id: ownerId }).sort({ submitted_at: -1 }).skip(skip).limit(limit);
}

function countByOwner(ownerId) {
  return PublicLead.countDocuments({ owner_id: ownerId });
}

module.exports = {
  create,
  findById,
  findByOwner,
  countByOwner,
};

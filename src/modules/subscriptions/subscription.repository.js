/**
 * subscription.repository.js
 *
 * Data-access layer for the Subscription collection. Controllers/services
 * never touch the Subscription mongoose model directly — everything goes
 * through here, per CLAUDE.md Section 7.2.
 */

const Subscription = require('./subscription.model');

function create(data) {
  return Subscription.create(data);
}

function findByOwner(ownerId) {
  return Subscription.findOne({ owner_id: ownerId });
}

function findById(subscriptionId) {
  return Subscription.findById(subscriptionId);
}

function updateByOwner(ownerId, updates) {
  return Subscription.findOneAndUpdate({ owner_id: ownerId }, { $set: updates }, { new: true, runValidators: true });
}

/**
 * Appends a new expansion-request sub-document to the owner's
 * subscription in one atomic $push — never a read-modify-write of the
 * whole array (avoids a lost-update race if an owner somehow double-taps
 * "request expansion").
 */
function pushExpansionRequest(ownerId, expansionRequest) {
  return Subscription.findOneAndUpdate(
    { owner_id: ownerId },
    { $push: { expansion_requests: expansionRequest } },
    { new: true, runValidators: true },
  );
}

/**
 * Super-admin-facing (Phase 7) — every subscription across every owner
 * that currently has at least one PENDING expansion request. Not used by
 * this phase's own owner-facing routes, but exposed now so Phase 7's
 * expansion queue has a ready-made, ownership-agnostic query to build on
 * (per the phase spec's "Dependency Note").
 */
function findWithPendingExpansionRequests({ skip = 0, limit = 20 } = {}) {
  return Subscription.find({ 'expansion_requests.status': 'pending' })
    .sort({ updated_at: -1 })
    .skip(skip)
    .limit(limit);
}

module.exports = {
  create,
  findByOwner,
  findById,
  updateByOwner,
  pushExpansionRequest,
  findWithPendingExpansionRequests,
};

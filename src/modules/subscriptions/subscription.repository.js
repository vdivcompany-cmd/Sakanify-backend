/**
 * subscription.repository.js
 *
 * Data-access layer for the Subscription collection. Controllers/services
 * never touch the Subscription mongoose model directly — everything goes
 * through here, per CLAUDE.md Section 7.2.
 */

const Subscription = require('./subscription.model');
const { SUBSCRIPTION_STATUS } = require('../../config/constants.config');

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

function countWithPendingExpansionRequests() {
  return Subscription.countDocuments({ 'expansion_requests.status': 'pending' });
}

/**
 * Platform-wide, unpaginated-by-owner read for Phase 7's admin
 * owners/buildings table. Only the fields the table actually needs —
 * never the full expansion_requests array (that has its own dedicated
 * queue endpoint) — kept lean since this runs once per page of owners,
 * not once per owner (CLAUDE.md Section 4.4).
 */
function findByOwnerIds(ownerIds) {
  return Subscription.find({ owner_id: { $in: ownerIds } }).select(
    'owner_id tier_name total_bed_capacity monthly_price status renewal_date',
  );
}

/**
 * Resolve (approve/reject) a single expansion-request sub-document by its
 * own `_id`, using a positional arrayFilter so this is a single atomic
 * update against the exact matching sub-document — never a read the whole
 * array/mutate in memory/write the whole array back pattern, which would
 * risk clobbering a concurrent expansion request submitted by the same
 * owner in between the read and the write.
 *
 * When `newCapacity` is provided (the approval path — implementation step
 * 5: "approving updates the relevant subscription's capacity"),
 * total_bed_capacity is set in the same atomic update as the status
 * change, so a reader can never observe "approved" with the old capacity
 * still in effect.
 */
function resolveExpansionRequest(subscriptionId, expansionRequestId, { status, resolvedBy, newCapacity } = {}) {
  const setFields = {
    'expansion_requests.$[req].status': status,
    'expansion_requests.$[req].resolved_at': new Date(),
    'expansion_requests.$[req].resolved_by': resolvedBy,
  };
  if (typeof newCapacity === 'number') {
    setFields.total_bed_capacity = newCapacity;
  }

  return Subscription.findOneAndUpdate(
    { _id: subscriptionId, 'expansion_requests._id': expansionRequestId },
    { $set: setFields },
    {
      new: true,
      runValidators: true,
      arrayFilters: [{ 'req._id': expansionRequestId }],
    },
  );
}

/**
 * Phase 8 addition (Docs/phase-8-public-site.md): every owner_id whose
 * subscription is currently ACTIVE — the eligibility gate for the public
 * building directory ("buildings not subscribed must never appear"). A
 * single distinct() query regardless of how many owners exist, not one
 * query per candidate building (CLAUDE.md Section 4.4).
 */
function findActiveOwnerIds() {
  return Subscription.distinct('owner_id', { status: SUBSCRIPTION_STATUS.ACTIVE });
}

module.exports = {
  create,
  findByOwner,
  findById,
  updateByOwner,
  pushExpansionRequest,
  findWithPendingExpansionRequests,
  countWithPendingExpansionRequests,
  findByOwnerIds,
  resolveExpansionRequest,
  findActiveOwnerIds,
};

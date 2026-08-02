/**
 * subscription.service.js
 *
 * Business logic for owner subscription tiers, usage calculation, and
 * bed-capacity expansion requests (Docs/phase-6-subscriptions.md,
 * "Subscriptions (Original Scope)"). Delegates to bed.service for the
 * actual bed count rather than touching the Bed collection directly, per
 * CLAUDE.md Section 7.2.
 */

const subscriptionRepository = require('./subscription.repository');
const bedService = require('../beds/bed.service');
const auditService = require('../audit/audit.service');
const { SUBSCRIPTION_STATUS, EXPANSION_REQUEST_STATUS } = require('../../config/constants.config');
const { AppError } = require('../../middleware/error-handler.middleware');

// Business default, not specified explicitly in the phase spec beyond
// "e.g., 90%+ utilized" (implementation step 3) — flagged as a technical
// decision in the Phase 6 report, same pattern as Phase 5's
// GRACE_PERIOD_DAYS default.
const USAGE_WARNING_THRESHOLD = 0.9;

/**
 * Not exposed via an owner-facing route this phase (the spec's routes
 * list is only "Get current subscription/usage, request expansion") —
 * subscriptions are provisioned out-of-band (e.g. by a future Phase 7
 * Super-Admin assignment flow, or directly in tests/fixtures the same
 * way every other phase's tests create fixture data directly via the
 * model). Exposed here so that provisioning path exists as real,
 * testable service logic rather than only ever being a raw
 * Subscription.create() scattered across callers.
 */
async function createSubscription(ownerId, { tierName, totalBedCapacity, monthlyPrice, renewalDate }) {
  const existing = await subscriptionRepository.findByOwner(ownerId);
  if (existing) {
    throw new AppError('This owner already has a subscription', 409);
  }

  return subscriptionRepository.create({
    owner_id: ownerId,
    tier_name: tierName,
    total_bed_capacity: totalBedCapacity,
    monthly_price: monthlyPrice,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    renewal_date: renewalDate,
  });
}

async function getSubscriptionForOwner(ownerId) {
  const subscription = await subscriptionRepository.findByOwner(ownerId);
  if (!subscription) {
    throw new AppError('No subscription found for this owner', 404);
  }
  return subscription;
}

/**
 * Implementation steps 2-3: actual bed count vs. subscribed capacity,
 * plus the 90%+ utilization warning flag surfaced for a future dashboard
 * alert.
 */
async function getUsageForOwner(ownerId) {
  const subscription = await getSubscriptionForOwner(ownerId);
  const bedsUsed = await bedService.countBedsForOwner(ownerId);
  const percentUsed = subscription.total_bed_capacity > 0 ? bedsUsed / subscription.total_bed_capacity : 0;

  return {
    subscription,
    beds_used: bedsUsed,
    total_bed_capacity: subscription.total_bed_capacity,
    percent_used: Math.round(percentUsed * 1000) / 10, // one decimal place, e.g. 92.3
    warning_threshold_percent: USAGE_WARNING_THRESHOLD * 100,
    is_near_capacity: percentUsed >= USAGE_WARNING_THRESHOLD,
  };
}

/**
 * Implementation step 4: "Request Bed Expansion" — creates a record
 * consumed by the Super-Admin expansion queue (Phase 7). Rejects a
 * request that doesn't actually ask for MORE capacity than the owner
 * already has (an obvious no-op that Phase 7 shouldn't have to filter
 * out of its queue).
 */
async function requestExpansion(ownerId, { requestedCapacity, reason }, actorUserId) {
  const subscription = await getSubscriptionForOwner(ownerId);

  if (typeof requestedCapacity !== 'number' || !Number.isFinite(requestedCapacity) || requestedCapacity <= 0) {
    throw new AppError('requested_capacity must be a positive number', 422);
  }
  if (requestedCapacity <= subscription.total_bed_capacity) {
    throw new AppError(
      `requested_capacity (${requestedCapacity}) must be greater than the current capacity (${subscription.total_bed_capacity})`,
      422,
    );
  }

  const expansionRequest = {
    requested_capacity: requestedCapacity,
    reason: reason || null,
    status: EXPANSION_REQUEST_STATUS.PENDING,
    requested_at: new Date(),
  };

  const updated = await subscriptionRepository.pushExpansionRequest(ownerId, expansionRequest);

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'subscription_expansion_requested',
    entityType: 'Subscription',
    entityId: updated._id,
    beforeState: { total_bed_capacity: subscription.total_bed_capacity },
    afterState: { requested_capacity: requestedCapacity },
  });

  return updated;
}

/**
 * Implementation step 5: subscription status transitions
 * (active/overdue/suspended) and the business rules tied to each.
 * Not routed to an owner-facing endpoint this phase (an owner doesn't
 * self-suspend their own account) — exposed for a future Phase 7
 * Super-Admin action and directly usable by tests.
 */
async function updateStatus(ownerId, newStatus, actorUserId = null) {
  if (!Object.values(SUBSCRIPTION_STATUS).includes(newStatus)) {
    throw new AppError(`status must be one of: ${Object.values(SUBSCRIPTION_STATUS).join(', ')}`, 422);
  }

  const subscription = await getSubscriptionForOwner(ownerId);
  const updated = await subscriptionRepository.updateByOwner(ownerId, { status: newStatus });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'subscription_status_changed',
    entityType: 'Subscription',
    entityId: subscription._id,
    beforeState: { status: subscription.status },
    afterState: { status: newStatus },
  });

  return updated;
}

/**
 * Implementation step 5's business rule: "a suspended owner may be
 * blocked from accepting new requests." Exposed here as a pure query
 * function so a future caller (Phase 7, or a future retrofit of
 * request.service explicitly authorized by the project owner) can wire
 * it in. Deliberately NOT called from request.service in this phase —
 * the project owner's instructions for this phase scoped the required
 * cross-phase retrofits to building.model (Phase 3) and payment.model
 * (Phase 5) only; request.service (Phase 4) was not named as a retrofit
 * target. Wiring a new blocking rule into an already-closed phase's
 * booking flow without that explicit instruction would be exactly the
 * kind of silent scope-creep CLAUDE.md Section 7.5 warns against — this
 * is flagged as an open, deferred decision in the Phase 6 report rather
 * than guessed at.
 */
async function canAcceptNewRequests(ownerId) {
  const subscription = await subscriptionRepository.findByOwner(ownerId);
  if (!subscription) return true; // no subscription provisioned yet — not this function's concern to gate
  return subscription.status !== SUBSCRIPTION_STATUS.SUSPENDED;
}

/**
 * Phase 7 addition (Docs/phase-7-admin.md, "Added After Phase 6 Review"
 * point 3): Super-Admin-only direct capacity adjustment outside the
 * normal request/approval flow. Deliberately does NOT block a new
 * capacity that's below the owner's currently-used bed count — that's an
 * explicit admin action, not a bug — but returns a clear warning string
 * so the caller (admin.controller) can surface it, rather than silently
 * succeeding. Lives here (not in admin.service) because it writes
 * directly to the Subscription collection, which only this module may
 * touch per CLAUDE.md Section 7.2; admin.service calls this function
 * rather than reaching into subscription.repository/model itself.
 */
async function manualCapacityOverride(ownerId, newCapacity, actorUserId) {
  if (typeof newCapacity !== 'number' || !Number.isFinite(newCapacity) || newCapacity <= 0) {
    throw new AppError('new_capacity must be a positive number', 422);
  }

  const subscription = await getSubscriptionForOwner(ownerId);
  const bedsUsed = await bedService.countBedsForOwner(ownerId);
  const beforeCapacity = subscription.total_bed_capacity;

  const updated = await subscriptionRepository.updateByOwner(ownerId, { total_bed_capacity: newCapacity });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'subscription_capacity_manually_overridden',
    entityType: 'Subscription',
    entityId: subscription._id,
    beforeState: { total_bed_capacity: beforeCapacity },
    afterState: { total_bed_capacity: newCapacity },
  });

  const warning = newCapacity < bedsUsed
    ? `Warning: new capacity (${newCapacity}) is below the owner's currently-used bed count (${bedsUsed}). The override was applied as requested — the owner is now over-capacity.`
    : null;

  return { subscription: updated, beds_used: bedsUsed, warning };
}

/**
 * Phase 7's expansion queue (Docs/phase-7-admin.md, implementation step 5)
 * — every subscription across every owner with at least one PENDING
 * expansion request, paginated. Returned as a flat, per-request list
 * (one row per pending expansion request, not one row per subscription
 * with a nested array) since that's what a Super-Admin queue UI actually
 * needs to act on.
 */
async function listPendingExpansionRequests({ skip = 0, limit = 20 } = {}) {
  const [subscriptions, total] = await Promise.all([
    subscriptionRepository.findWithPendingExpansionRequests({ skip, limit }),
    subscriptionRepository.countWithPendingExpansionRequests(),
  ]);

  const rows = [];
  for (const subscription of subscriptions) {
    for (const req of subscription.expansion_requests) {
      if (req.status !== EXPANSION_REQUEST_STATUS.PENDING) continue;
      rows.push({
        subscription_id: subscription._id,
        owner_id: subscription.owner_id,
        expansion_request_id: req._id,
        current_capacity: subscription.total_bed_capacity,
        requested_capacity: req.requested_capacity,
        reason: req.reason,
        requested_at: req.requested_at,
      });
    }
  }

  return { rows, total };
}

async function findSubscriptionExpansionRequest(subscriptionId, expansionRequestId) {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription) {
    throw new AppError('Subscription not found', 404);
  }
  const expansionRequest = subscription.expansion_requests.id(expansionRequestId);
  if (!expansionRequest) {
    throw new AppError('Expansion request not found', 404);
  }
  if (expansionRequest.status !== EXPANSION_REQUEST_STATUS.PENDING) {
    throw new AppError(`Expansion request is not pending (current status: "${expansionRequest.status}")`, 409);
  }
  return { subscription, expansionRequest };
}

/**
 * Approve a pending expansion request: sets it APPROVED and — per
 * implementation step 5 — actually raises total_bed_capacity to the
 * requested value, atomically, in the same update (see
 * subscriptionRepository.resolveExpansionRequest).
 */
async function approveExpansionRequest(subscriptionId, expansionRequestId, actorUserId) {
  const { subscription, expansionRequest } = await findSubscriptionExpansionRequest(subscriptionId, expansionRequestId);

  const updated = await subscriptionRepository.resolveExpansionRequest(subscriptionId, expansionRequestId, {
    status: EXPANSION_REQUEST_STATUS.APPROVED,
    resolvedBy: actorUserId,
    newCapacity: expansionRequest.requested_capacity,
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'subscription_expansion_approved',
    entityType: 'Subscription',
    entityId: subscription._id,
    beforeState: { total_bed_capacity: subscription.total_bed_capacity },
    afterState: { total_bed_capacity: expansionRequest.requested_capacity, expansion_request_id: expansionRequestId },
  });

  return updated;
}

/**
 * Reject a pending expansion request: sets it REJECTED, capacity
 * untouched.
 */
async function rejectExpansionRequest(subscriptionId, expansionRequestId, actorUserId) {
  const { subscription } = await findSubscriptionExpansionRequest(subscriptionId, expansionRequestId);

  const updated = await subscriptionRepository.resolveExpansionRequest(subscriptionId, expansionRequestId, {
    status: EXPANSION_REQUEST_STATUS.REJECTED,
    resolvedBy: actorUserId,
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'subscription_expansion_rejected',
    entityType: 'Subscription',
    entityId: subscription._id,
    beforeState: { total_bed_capacity: subscription.total_bed_capacity },
    afterState: { expansion_request_id: expansionRequestId, status: 'rejected' },
  });

  return updated;
}

/**
 * Phase 7 addition: subscriptions for many owners at once — backs
 * admin.service's platform-wide owners/buildings table (see
 * subscriptionRepository.findByOwnerIds's comment).
 */
async function getSubscriptionsForOwnerIds(ownerIds) {
  return subscriptionRepository.findByOwnerIds(ownerIds);
}

/**
 * Phase 8 addition (Docs/phase-8-public-site.md): which owner_ids are
 * eligible to appear in the public building directory right now
 * (subscription.status === ACTIVE). Consumed by
 * building.service.listPublicBuildings/countPublicBuildings — kept here
 * rather than a direct Subscription query from the public-site module,
 * per CLAUDE.md Section 7.2 (cross-module access goes through the owning
 * module's own service).
 */
async function getActiveOwnerIds() {
  return subscriptionRepository.findActiveOwnerIds();
}

/**
 * Phase 8 addition: is this single owner currently eligible for public
 * listing? Used by building.service.getPublicBuildingDetail (single
 * building lookup) and public-lead.service.createLead (reject a lead
 * submitted against a bed whose owner isn't actively subscribed) without
 * either caller needing to know how "actively subscribed" is defined —
 * that stays a subscriptions-module concern. Deliberately distinct from
 * canAcceptNewRequests() above: that function treats "no subscription
 * provisioned yet" as accepting (true), which is the right default for
 * the booking engine's request-creation guard, but wrong for public
 * listing eligibility — an owner with no subscription at all must never
 * appear in the public directory, so this returns false in that case.
 */
async function isOwnerPubliclyListed(ownerId) {
  const subscription = await subscriptionRepository.findByOwner(ownerId);
  return Boolean(subscription && subscription.status === SUBSCRIPTION_STATUS.ACTIVE);
}

module.exports = {
  createSubscription,
  getSubscriptionForOwner,
  getSubscriptionsForOwnerIds,
  getUsageForOwner,
  requestExpansion,
  updateStatus,
  canAcceptNewRequests,
  manualCapacityOverride,
  listPendingExpansionRequests,
  approveExpansionRequest,
  rejectExpansionRequest,
  getActiveOwnerIds,
  isOwnerPubliclyListed,
  USAGE_WARNING_THRESHOLD,
};

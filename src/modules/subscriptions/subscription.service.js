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

module.exports = {
  createSubscription,
  getSubscriptionForOwner,
  getUsageForOwner,
  requestExpansion,
  updateStatus,
  canAcceptNewRequests,
  USAGE_WARNING_THRESHOLD,
};

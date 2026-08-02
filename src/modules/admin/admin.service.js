/**
 * admin.service.js
 *
 * Business logic for the Super-Admin / V Div Control Center
 * (Docs/phase-7-admin.md). This module is "purely an aggregation layer
 * over Phases 1, 3, 4, 5, and 6" (the phase spec's own words) — every
 * read/write against another module's collection goes through that
 * module's service function, never direct model/repository access, per
 * CLAUDE.md Section 7.2. The only collection this module owns outright is
 * ImpersonationSession (admin.repository.js).
 *
 * Every function here is only ever reachable via requireRole(SUPER_ADMIN)
 * at the route layer (admin.routes.js) — see CLAUDE.md Section 3.11
 * (least privilege by default) and this phase spec's implementation
 * step 8.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const adminRepository = require('./admin.repository');
const authService = require('../auth/auth.service');
const buildingService = require('../buildings/building.service');
const bedService = require('../beds/bed.service');
const subscriptionService = require('../subscriptions/subscription.service');
const requestService = require('../requests/request.service');
const kycService = require('../kyc/kyc.service');
const auditService = require('../audit/audit.service');
const env = require('../../config/env.config');
const { ROLES, SUBSCRIPTION_STATUS } = require('../../config/constants.config');
const { AppError } = require('../../middleware/error-handler.middleware');

const IMPERSONATION_EXPIRY = '30m';
const IMPERSONATION_EXPIRY_MS = 30 * 60 * 1000;

/**
 * Implementation step 1: platform-wide Owners/Buildings table — one row
 * per owner with their building count, actual bed usage, and subscription
 * tier/status.
 *
 * Three extra queries total, each a single batched lookup keyed by the
 * current page's owner_ids (buildings-per-owner, beds-per-owner,
 * subscriptions-per-owner) — never one query per owner, regardless of
 * page size (CLAUDE.md Section 4.4, and implementation point 5's
 * aggregation-pipeline requirement, applied here too even though point 5
 * is written about step 7's metrics specifically — the same scale
 * reasoning applies to this table).
 */
async function listOwnersOverview({ skip, limit }) {
  const { owners, total } = await authService.listOwners({ skip, limit });
  const ownerIds = owners.map((o) => o.owner_id).filter(Boolean);

  const [buildingCounts, bedCounts, subscriptions] = await Promise.all([
    buildingService.countBuildingsByOwnerIds(ownerIds),
    bedService.countBedsForOwnerIds(ownerIds),
    subscriptionService.getSubscriptionsForOwnerIds(ownerIds),
  ]);

  const buildingCountByOwner = new Map(buildingCounts.map((row) => [row._id, row.count]));
  const bedCountByOwner = new Map(bedCounts.map((row) => [row._id, row.count]));
  const subscriptionByOwner = new Map(subscriptions.map((sub) => [sub.owner_id, sub]));

  const rows = owners.map((owner) => {
    const subscription = subscriptionByOwner.get(owner.owner_id) || null;
    return {
      owner_user_id: owner._id,
      owner_id: owner.owner_id,
      email: owner.email,
      status: owner.status,
      created_at: owner.created_at,
      buildings_count: buildingCountByOwner.get(owner.owner_id) || 0,
      beds_used: bedCountByOwner.get(owner.owner_id) || 0,
      subscription: subscription
        ? {
          tier_name: subscription.tier_name,
          total_bed_capacity: subscription.total_bed_capacity,
          status: subscription.status,
          renewal_date: subscription.renewal_date,
        }
        : null,
    };
  });

  return { rows, total };
}

/**
 * Implementation step 2 / "Added After Phase 6 Review" point 3 — thin
 * pass-through to subscriptionService.manualCapacityOverride, which owns
 * the actual write + audit log (CLAUDE.md Section 7.2: this module never
 * touches the Subscription collection itself).
 */
async function manualCapacityOverride(ownerId, newCapacity, actorUserId) {
  return subscriptionService.manualCapacityOverride(ownerId, newCapacity, actorUserId);
}

/**
 * Implementation step 3 / "Added After Phase 6 Review" points 1-2 — THE
 * critical wiring this phase exists for. Two independent effects, both
 * required, neither optional:
 *
 *   1. subscription.status -> 'suspended' via subscriptionService, which
 *      is what activates request.service.createRequest's existing
 *      canAcceptNewRequests() guard clause (wired since Phase 6, dormant
 *      until this function exists to actually flip the switch).
 *   2. The owner's User account status -> 'suspended' (blocks
 *      loginOwner() immediately) AND every currently-issued token for
 *      that account is invalidated via authService's real
 *      tokens_invalidated_at mechanism (see auth.model.js's comment on
 *      why this had to be fixed this phase for "immediately" to be true) —
 *      auth.middleware.verifyToken checks this on every subsequent
 *      request, so an already-in-hand access token stops working on its
 *      very next call, not just after it naturally expires.
 *
 * Both effects are logged to the central audit trail, in addition to
 * subscriptionService.updateStatus's own audit entry, so the activity
 * feed shows the suspension as a distinct, admin-attributed event
 * separate from the subscription-status-change entry.
 */
async function suspendOwner(ownerId, actorUserId) {
  const ownerUser = await authService.getUserByOwnerId(ownerId);
  if (!ownerUser) {
    throw new AppError('Owner not found', 404);
  }

  // subscriptionService.updateStatus throws a 404 ("No subscription found
  // for this owner") if this owner has never been provisioned a
  // subscription. That's surfaced as-is rather than silently suspending
  // only the User record: canAcceptNewRequests() already treats "no
  // subscription" as "always allowed" (see subscription.service.js's
  // comment), so a suspend that can't also flip subscription.status would
  // not actually block new bookings — it would be exactly the cosmetic,
  // partially-working suspend this phase exists to prevent. An owner
  // without a subscription needs one provisioned first (see
  // subscriptionService.createSubscription) before they can be suspended
  // in a way that's actually enforced. Flagged as an edge case in the
  // Phase 7 report rather than silently working around it.
  const subscription = await subscriptionService.updateStatus(ownerId, SUBSCRIPTION_STATUS.SUSPENDED, actorUserId);

  await authService.setUserStatus(ownerUser._id, 'suspended');
  await authService.invalidateAllTokensForUser(ownerUser._id);

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'owner_account_suspended',
    entityType: 'User',
    entityId: ownerUser._id,
    beforeState: { status: ownerUser.status },
    afterState: { status: 'suspended', owner_id: ownerId },
  });

  return { owner_id: ownerId, user_status: 'suspended', subscription };
}

/**
 * Reactivate Account — reverses suspendOwner's steps 1-2 (subscription
 * status back to ACTIVE, User status back to 'active'). Added after the
 * Phase 7 report review, per the project owner's explicit request — the
 * original spec only asked for "Suspend Account" and deliberately did not
 * include a reverse operation, so this was held back pending that
 * confirmation rather than guessed at (CLAUDE.md Section 7.5).
 *
 * Deliberately does NOT reverse token invalidation: there is nothing
 * meaningful to "un-invalidate" — the owner's tokens issued before
 * suspension are still stamped with an `iat` at or before
 * `tokens_invalidated_at`, so they'd still fail auth.middleware
 * .verifyToken's check even after this call (correctly — those specific
 * tokens were live during the suspended window and should never come back
 * to life). The owner simply logs in again; loginOwner's existing
 * `status !== 'active'` check now passes (status is 'active' again), and
 * the fresh token's `iat` is after the invalidation cutoff, so it passes
 * the middleware check normally with no special-casing needed here.
 */
async function reactivateOwner(ownerId, actorUserId) {
  const ownerUser = await authService.getUserByOwnerId(ownerId);
  if (!ownerUser) {
    throw new AppError('Owner not found', 404);
  }

  const subscription = await subscriptionService.updateStatus(ownerId, SUBSCRIPTION_STATUS.ACTIVE, actorUserId);

  await authService.setUserStatus(ownerUser._id, 'active');

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'owner_account_reactivated',
    entityType: 'User',
    entityId: ownerUser._id,
    beforeState: { status: ownerUser.status },
    afterState: { status: 'active', owner_id: ownerId },
  });

  return { owner_id: ownerId, user_status: 'active', subscription };
}

/**
 * Implementation step 4 / "Added After Phase 6 Review" point 4 —
 * short-lived, distinctly-typed impersonation token. Signed with the same
 * accessSecret as a normal access token (so it flows through the existing
 * auth.middleware.verifyToken pipeline and every existing
 * requireOwner/ownershipScoping check downstream needs zero changes to
 * accept it) but carries `type: 'impersonation'` and an
 * `impersonating_admin_id` claim, and is checked against a live
 * ImpersonationSession record on every request (see
 * auth.middleware.verifyToken and admin.repository.findActiveByJti) —
 * NOT just a reissued normal owner token, per point 4's explicit
 * requirement.
 *
 * Deliberately allowed against a suspended owner: a Super-Admin
 * impersonating a suspended account for support/investigation purposes is
 * a legitimate, intentional use of this feature (e.g. to see exactly what
 * a suspended owner would see, or to help them resolve whatever caused
 * the suspension) — auth.middleware.verifyToken does not apply the target
 * owner's own status/tokens_invalidated_at check to impersonation-type
 * tokens for this reason. Flagged as a technical decision in the Phase 7
 * report since the spec doesn't say either way.
 */
async function impersonateOwner(ownerId, adminUserId) {
  const ownerUser = await authService.getUserByOwnerId(ownerId);
  if (!ownerUser) {
    throw new AppError('Owner not found', 404);
  }

  const jti = crypto.randomUUID();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + IMPERSONATION_EXPIRY_MS);

  const token = jwt.sign(
    {
      userId: ownerUser._id,
      role: ROLES.OWNER,
      ownerId,
      type: 'impersonation',
      impersonating_admin_id: adminUserId,
      jti,
    },
    env.jwt.accessSecret,
    { expiresIn: IMPERSONATION_EXPIRY },
  );

  await adminRepository.createSession({
    jti,
    admin: adminUserId,
    owner_id: ownerId,
    target_user: ownerUser._id,
    issued_at: issuedAt,
    expires_at: expiresAt,
  });

  await auditService.writeAuditLog({
    actor: adminUserId,
    action: 'owner_impersonation_started',
    entityType: 'User',
    entityId: ownerUser._id,
    afterState: { owner_id: ownerId, jti, expires_at: expiresAt },
  });

  return { impersonation_token: token, owner_id: ownerId, expires_at: expiresAt };
}

/**
 * "if an 'end impersonation' action exists, log that too" (point 4). Ends
 * the session by jti so the token is rejected on its very next use, and
 * writes the corresponding audit entry — the pairing of these two start/
 * end audit entries is what makes "duration" reconstructable from the
 * audit trail alone.
 */
async function endImpersonation(jti, adminUserId) {
  const session = await adminRepository.endSession(jti, adminUserId);
  if (!session) {
    throw new AppError('Impersonation session not found or already ended', 404);
  }

  await auditService.writeAuditLog({
    actor: adminUserId,
    action: 'owner_impersonation_ended',
    entityType: 'User',
    entityId: session.target_user,
    beforeState: { jti, owner_id: session.owner_id },
    afterState: { ended_at: session.ended_at },
  });

  return session;
}

/**
 * Implementation step 6: platform-wide activity feed, pulled from the
 * shared audit module across every owner/building — pagination is
 * mandatory (CLAUDE.md Section 4.2), date-range filtering is optional per
 * the spec but implemented here since audit.repository already supports
 * it (see audit.repository.buildQuery's Phase 7 addition).
 */
async function getActivityFeed({ skip, limit, startDate, endDate }) {
  const filters = {};
  if (startDate) filters.startDate = new Date(startDate);
  if (endDate) filters.endDate = new Date(endDate);

  const { entries, total } = await auditService.listAuditLogs(filters, { skip, limit });
  return { entries, total };
}

/**
 * Implementation step 7 / point 5: platform-wide metrics, every one of
 * which is computed by its owning module via a MongoDB aggregation
 * pipeline or an indexed countDocuments — never by loading a full
 * collection into application memory, per point 5's explicit requirement
 * (which matters concretely at this project's ~500K-student,
 * ~1000-building target scale, CLAUDE.md Section 2).
 */
async function getPlatformMetrics() {
  const [funnel, totalActiveBuildings, totalVerifiedStudents] = await Promise.all([
    requestService.getRequestFunnelStats(),
    buildingService.countAllBuildings(),
    kycService.countVerifiedStudents(),
  ]);

  return {
    conversion_funnel: funnel,
    total_active_buildings: totalActiveBuildings,
    total_verified_students: totalVerifiedStudents,
  };
}

module.exports = {
  listOwnersOverview,
  manualCapacityOverride,
  suspendOwner,
  reactivateOwner,
  impersonateOwner,
  endImpersonation,
  getActivityFeed,
  getPlatformMetrics,
};

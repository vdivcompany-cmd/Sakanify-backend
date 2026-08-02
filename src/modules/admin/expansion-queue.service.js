/**
 * expansion-queue.service.js
 *
 * Implementation step 5: lists, approves, and rejects pending bed-capacity
 * expansion requests submitted by owners in Phase 6
 * (subscriptionService.requestExpansion). All actual reads/writes against
 * the Subscription collection happen inside subscription.service — this
 * file only orchestrates + is the Super-Admin-facing entry point, per
 * CLAUDE.md Section 7.2 (admin never touches Subscription directly).
 */

const subscriptionService = require('../subscriptions/subscription.service');

async function listPending({ skip, limit }) {
  return subscriptionService.listPendingExpansionRequests({ skip, limit });
}

async function approve(subscriptionId, expansionRequestId, actorUserId) {
  return subscriptionService.approveExpansionRequest(subscriptionId, expansionRequestId, actorUserId);
}

async function reject(subscriptionId, expansionRequestId, actorUserId) {
  return subscriptionService.rejectExpansionRequest(subscriptionId, expansionRequestId, actorUserId);
}

module.exports = {
  listPending,
  approve,
  reject,
};

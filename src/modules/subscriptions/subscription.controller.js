/**
 * subscription.controller.js
 *
 * Owner-facing subscription endpoints: get current subscription + usage,
 * request a capacity expansion (Docs/phase-6-subscriptions.md's folder
 * comment: "Get current subscription/usage, request expansion"). Both
 * endpoints are inherently ownership-scoped — the subscription looked up
 * is always the one belonging to req.user.ownerId (from the verified
 * JWT), never a client-supplied id, so there's no separate resource id
 * for another owner to spoof (CLAUDE.md Section 3.3).
 *
 * Every catch block runs the error through normalizeError() and logs
 * anything that isn't an expected AppError, per CLAUDE.md Section 7.3a.
 */

const { success, error } = require('../../shared/utils/response.util');
const subscriptionService = require('./subscription.service');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[subscription.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

/**
 * GET /api/subscriptions/me
 * Owner only. Current subscription + real-time usage vs. capacity.
 */
async function getMySubscription(req, res) {
  try {
    const usage = await subscriptionService.getUsageForOwner(req.user.ownerId);
    return success(res, { statusCode: 200, message: 'Subscription retrieved', data: usage });
  } catch (err) {
    return handleControllerError(res, err, 'getMySubscription');
  }
}

/**
 * POST /api/subscriptions/expansion-requests
 * Owner only. Body: { requested_capacity: number, reason?: string }
 */
async function requestExpansion(req, res) {
  try {
    const requestedCapacity = req.body ? req.body.requested_capacity : undefined;
    const reason = req.body ? req.body.reason : undefined;

    if (typeof requestedCapacity !== 'number') {
      throw new AppError('requested_capacity is required and must be a number', 422);
    }

    const updated = await subscriptionService.requestExpansion(
      req.user.ownerId,
      { requestedCapacity, reason },
      req.user.userId,
    );
    return success(res, { statusCode: 201, message: 'Expansion request submitted', data: updated });
  } catch (err) {
    return handleControllerError(res, err, 'requestExpansion');
  }
}

module.exports = {
  getMySubscription,
  requestExpansion,
};

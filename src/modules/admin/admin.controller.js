/**
 * admin.controller.js
 *
 * HTTP layer for the Super-Admin / V Div Control Center. Every route this
 * controller serves is mounted behind requireRole(SUPER_ADMIN) in
 * admin.routes.js — nothing here re-checks role, only ownership-agnostic
 * business rules (this module is platform-wide by design, there is no
 * per-request "ownership scoping" concept to apply).
 *
 * Every catch block runs the error through normalizeError() and logs
 * anything that isn't an expected AppError, per CLAUDE.md Section 7.3a —
 * same pattern as subscription.controller.js.
 */

const { success, error } = require('../../shared/utils/response.util');
const adminService = require('./admin.service');
const expansionQueueService = require('./expansion-queue.service');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');

function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[admin.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

/**
 * GET /api/admin/owners
 * Implementation step 1: platform-wide Owners/Buildings table.
 */
async function listOwners(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { rows, total } = await adminService.listOwnersOverview({ skip, limit });
    return success(res, {
      statusCode: 200,
      message: 'Owners retrieved',
      data: rows,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listOwners');
  }
}

/**
 * PATCH /api/admin/owners/:ownerId/capacity-override
 * Body: { new_capacity: number }
 * Implementation step 2 / "Added After Phase 6 Review" point 3.
 */
async function overrideCapacity(req, res) {
  try {
    const { ownerId } = req.params;
    const newCapacity = req.body ? req.body.new_capacity : undefined;

    if (typeof newCapacity !== 'number') {
      throw new AppError('new_capacity is required and must be a number', 422);
    }

    const result = await adminService.manualCapacityOverride(ownerId, newCapacity, req.user.userId);
    return success(res, {
      statusCode: 200,
      message: result.warning || 'Capacity overridden',
      data: result,
    });
  } catch (err) {
    return handleControllerError(res, err, 'overrideCapacity');
  }
}

/**
 * POST /api/admin/owners/:ownerId/suspend
 * Implementation step 3 / points 1-2. THE real-wiring endpoint.
 */
async function suspendOwner(req, res) {
  try {
    const { ownerId } = req.params;
    const result = await adminService.suspendOwner(ownerId, req.user.userId);
    return success(res, { statusCode: 200, message: 'Owner account suspended', data: result });
  } catch (err) {
    return handleControllerError(res, err, 'suspendOwner');
  }
}

/**
 * POST /api/admin/owners/:ownerId/reactivate
 * Reverses suspendOwner's subscription/User status changes.
 */
async function reactivateOwner(req, res) {
  try {
    const { ownerId } = req.params;
    const result = await adminService.reactivateOwner(ownerId, req.user.userId);
    return success(res, { statusCode: 200, message: 'Owner account reactivated', data: result });
  } catch (err) {
    return handleControllerError(res, err, 'reactivateOwner');
  }
}

/**
 * POST /api/admin/owners/:ownerId/impersonate
 * Implementation step 4 / point 4.
 */
async function impersonateOwner(req, res) {
  try {
    const { ownerId } = req.params;
    const result = await adminService.impersonateOwner(ownerId, req.user.userId);
    return success(res, { statusCode: 201, message: 'Impersonation session started', data: result });
  } catch (err) {
    return handleControllerError(res, err, 'impersonateOwner');
  }
}

/**
 * POST /api/admin/impersonate/:jti/end
 */
async function endImpersonation(req, res) {
  try {
    const { jti } = req.params;
    const result = await adminService.endImpersonation(jti, req.user.userId);
    return success(res, { statusCode: 200, message: 'Impersonation session ended', data: result });
  } catch (err) {
    return handleControllerError(res, err, 'endImpersonation');
  }
}

/**
 * GET /api/admin/expansion-requests
 * Implementation step 5.
 */
async function listExpansionRequests(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { rows, total } = await expansionQueueService.listPending({ skip, limit });
    return success(res, {
      statusCode: 200,
      message: 'Pending expansion requests retrieved',
      data: rows,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listExpansionRequests');
  }
}

/**
 * POST /api/admin/expansion-requests/:subscriptionId/:expansionRequestId/approve
 */
async function approveExpansionRequest(req, res) {
  try {
    const { subscriptionId, expansionRequestId } = req.params;
    const updated = await expansionQueueService.approve(subscriptionId, expansionRequestId, req.user.userId);
    return success(res, { statusCode: 200, message: 'Expansion request approved', data: updated });
  } catch (err) {
    return handleControllerError(res, err, 'approveExpansionRequest');
  }
}

/**
 * POST /api/admin/expansion-requests/:subscriptionId/:expansionRequestId/reject
 */
async function rejectExpansionRequest(req, res) {
  try {
    const { subscriptionId, expansionRequestId } = req.params;
    const updated = await expansionQueueService.reject(subscriptionId, expansionRequestId, req.user.userId);
    return success(res, { statusCode: 200, message: 'Expansion request rejected', data: updated });
  } catch (err) {
    return handleControllerError(res, err, 'rejectExpansionRequest');
  }
}

/**
 * GET /api/admin/activity
 * Implementation step 6. Query: page, limit, start_date?, end_date?
 */
async function getActivityFeed(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { entries, total } = await adminService.getActivityFeed({
      skip,
      limit,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
    });
    return success(res, {
      statusCode: 200,
      message: 'Activity feed retrieved',
      data: entries,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'getActivityFeed');
  }
}

/**
 * GET /api/admin/metrics
 * Implementation step 7.
 */
async function getPlatformMetrics(req, res) {
  try {
    const metrics = await adminService.getPlatformMetrics();
    return success(res, { statusCode: 200, message: 'Platform metrics retrieved', data: metrics });
  } catch (err) {
    return handleControllerError(res, err, 'getPlatformMetrics');
  }
}

module.exports = {
  listOwners,
  overrideCapacity,
  suspendOwner,
  reactivateOwner,
  impersonateOwner,
  endImpersonation,
  listExpansionRequests,
  approveExpansionRequest,
  rejectExpansionRequest,
  getActivityFeed,
  getPlatformMetrics,
};

/**
 * request.controller.js
 *
 * Student-facing request creation/self-list, and owner-facing pending
 * queue/confirm/reject. Owner actions always fetch the request first and
 * check ownershipScoping(req.user.ownerId, request.owner_id) before doing
 * anything else — same pattern as every owner-facing controller since
 * Phase 3 (CLAUDE.md Section 3.3).
 *
 * No separate request.validation.js file, matching the convention set by
 * kyc.controller.js/building.controller.js in earlier phases — fields are
 * validated inline here.
 */

const { success, error } = require('../../shared/utils/response.util');
const requestService = require('./request.service');
const studentService = require('../students/student.service');
const { ownershipScoping } = require('../../middleware/auth.middleware');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { REQUEST_REJECTION_REASON } = require('../../config/constants.config');

function parseOptionalDate(value, fieldName, errors) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    errors.push(`${fieldName} must be a valid date`);
    return null;
  }
  return date;
}

/**
 * POST /api/requests
 * Student only. Body: { bed_id, move_in_date?, note? }
 */
async function createRequest(req, res) {
  try {
    const { bed_id: bedId, note } = req.body;

    if (!bedId) {
      return error(res, { statusCode: 422, message: 'bed_id is required' });
    }

    const errors = [];
    const moveInDate = parseOptionalDate(req.body.move_in_date, 'move_in_date', errors);
    if (errors.length > 0) {
      return error(res, { statusCode: 422, message: 'Validation failed', errors });
    }

    const request = await requestService.createRequest(req.user.userId, bedId, {
      moveInDate,
      note: note ? String(note).trim() : null,
    });

    return success(res, { statusCode: 201, message: 'Request created — bed locked pending owner review', data: request });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message, errors: err.errors || null });
  }
}

/**
 * GET /api/requests/me
 * Student only, paginated. The student's own request history.
 */
async function getMyRequests(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { requests, total } = await requestService.getMyRequests(req.user.userId, { skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Your requests retrieved',
      data: requests,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * GET /api/requests/pending
 * Owner only, paginated. Each request comes with its student's
 * profile/KYC summary (implementation step 4), attached via one batched
 * lookup for the whole page — never one query per request
 * (CLAUDE.md Section 4.4; see studentService.getFullProfilesWithKycForIds).
 */
async function listPending(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { requests, total } = await requestService.listPendingForOwner(req.user.ownerId, { skip, limit });

    const studentIds = requests.map((r) => r.student);
    const profileMap = await studentService.getFullProfilesWithKycForIds(studentIds);

    const enriched = requests.map((r) => {
      const profile = profileMap.get(r.student.toString());
      return {
        ...r.toObject(),
        student_summary: profile
          ? {
              student: profile.student,
              kyc_status: profile.kyc ? profile.kyc.verification_status : null,
            }
          : null,
      };
    });

    return success(res, {
      statusCode: 200,
      message: 'Pending requests retrieved',
      data: enriched,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * POST /api/requests/:requestId/confirm
 * Owner only, ownership-scoped.
 */
async function confirmRequest(req, res) {
  try {
    const request = await requestService.getRequestById(req.params.requestId);

    try {
      ownershipScoping(req.user.ownerId, request.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const result = await requestService.confirmRequest(req.params.requestId, req.user.userId);

    return success(res, {
      statusCode: 200,
      message: 'Request confirmed — rental created, bed occupied',
      data: result,
    });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * POST /api/requests/:requestId/reject
 * Owner only, ownership-scoped. Body: { reason, note? }
 */
async function rejectRequest(req, res) {
  try {
    const request = await requestService.getRequestById(req.params.requestId);

    try {
      ownershipScoping(req.user.ownerId, request.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { reason, note } = req.body;
    if (!reason || !Object.values(REQUEST_REJECTION_REASON).includes(reason)) {
      return error(res, {
        statusCode: 422,
        message: `reason is required and must be one of: ${Object.values(REQUEST_REJECTION_REASON).join(', ')}`,
      });
    }

    const updated = await requestService.rejectRequest(req.params.requestId, req.user.userId, {
      reason,
      note: note ? String(note).trim() : null,
    });

    return success(res, { statusCode: 200, message: 'Request rejected — bed released', data: updated });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

module.exports = {
  createRequest,
  getMyRequests,
  listPending,
  confirmRequest,
  rejectRequest,
};

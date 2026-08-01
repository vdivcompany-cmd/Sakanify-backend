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
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

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
 * Every catch block in this controller used to do a shallow
 * `err.statusCode || 400`, which silently collapsed EVERY non-AppError
 * (a Mongoose CastError/ValidationError, a duplicate-key error, a plain
 * bug) into a generic, undiagnosable 400 — no classification, and nothing
 * written to the CI logs, which is exactly what made the original CI
 * failure (27/117 tests, every POST /api/requests returning 400) so hard
 * to diagnose after the fact: request-logger.middleware only logs
 * method/path/status/time, never the body, so the real error message was
 * gone the moment this shallow catch ran.
 *
 * This helper reuses error-handler.middleware's normalizeError (the same
 * classification the global error handler already applies to
 * next(err)-routed errors) so AppError/CastError/ValidationError/
 * duplicate-key errors resolve to their correct status codes here too —
 * and, critically, console.error()s any error that ISN'T an expected
 * AppError, so the next CI run's Jest output actually contains the real
 * stack trace instead of a bare 400.
 */
function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[request.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
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
    return handleControllerError(res, err, 'createRequest');
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
    return handleControllerError(res, err, 'getMyRequests');
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
    return handleControllerError(res, err, 'listPending');
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
    return handleControllerError(res, err, 'confirmRequest');
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
    return handleControllerError(res, err, 'rejectRequest');
  }
}

module.exports = {
  createRequest,
  getMyRequests,
  listPending,
  confirmRequest,
  rejectRequest,
};

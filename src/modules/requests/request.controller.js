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
const behaviorReportService = require('../behavior-reports/behavior-report.service');
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

    // Phase 9 (Part A redesign): creation no longer locks the bed — many
    // students may hold a pending viewing-booking for the same bed at
    // once. The bed is only actually claimed when the owner confirms.
    return success(res, { statusCode: 201, message: 'Viewing booking created — the owner will review it', data: request });
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

    const { reason, note, behavior_report_ids: behaviorReportIds } = req.body;
    if (!reason || !Object.values(REQUEST_REJECTION_REASON).includes(reason)) {
      return error(res, {
        statusCode: 422,
        message: `reason is required and must be one of: ${Object.values(REQUEST_REJECTION_REASON).join(', ')}`,
      });
    }

    const updated = await requestService.rejectRequest(req.params.requestId, req.user.userId, {
      reason,
      note: note ? String(note).trim() : null,
      behaviorReportIds: Array.isArray(behaviorReportIds) ? behaviorReportIds : [],
    });

    // Phase 9, Part C/A tie-in (implementation step 4): when the owner
    // flags this rejection with behavior_report_ids, also return the
    // student's/guardian's phone numbers plus a suggested message
    // template — content the owner copies and sends manually via their
    // own WhatsApp/SMS (Product Decision 3: this never sends anything
    // itself). Best-effort — a failure composing the template must never
    // block the rejection itself, which is already durably saved above.
    let contactTemplate = null;
    if (Array.isArray(behaviorReportIds) && behaviorReportIds.length > 0) {
      try {
        const { student } = await studentService.getFullProfileWithKyc(request.student);
        contactTemplate = behaviorReportService.buildContactTemplate(student, reason);
      } catch (templateErr) {
        console.error('[request.controller:rejectRequest] Failed to build contact template', templateErr);
      }
    }

    return success(res, {
      statusCode: 200,
      message: 'Request rejected',
      data: contactTemplate ? { ...updated.toObject(), contact_template: contactTemplate } : updated,
    });
  } catch (err) {
    return handleControllerError(res, err, 'rejectRequest');
  }
}

/**
 * POST /api/requests/:requestId/appointment-date
 * Owner only, ownership-scoped. Body: { appointment_date }
 */
async function setAppointmentDate(req, res) {
  try {
    const request = await requestService.getRequestById(req.params.requestId);

    try {
      ownershipScoping(req.user.ownerId, request.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const errors = [];
    const appointmentDate = parseOptionalDate(req.body.appointment_date, 'appointment_date', errors);
    if (!appointmentDate || errors.length > 0) {
      return error(res, { statusCode: 422, message: 'appointment_date is required and must be a valid date', errors });
    }

    const updated = await requestService.setAppointmentDate(req.params.requestId, req.user.userId, appointmentDate);
    return success(res, { statusCode: 200, message: 'Appointment date set', data: updated });
  } catch (err) {
    return handleControllerError(res, err, 'setAppointmentDate');
  }
}

module.exports = {
  createRequest,
  getMyRequests,
  listPending,
  confirmRequest,
  rejectRequest,
  setAppointmentDate,
};

/**
 * bulk-registration.controller.js
 *
 * Owner-facing (generate/revoke link, list pending, assign-to-bed,
 * manual entry) and the one public, unauthenticated endpoint
 * (submit via link) — Phase 9, Part D.
 */

const { success, error } = require('../../shared/utils/response.util');
const bulkRegistrationService = require('./bulk-registration.service');
const { registerStudentSchema, validate } = require('../students/student.validation');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

const NATIONAL_ID_PATTERN = /^\d{14}$/;

function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[bulk-registration.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

function extractKycFields(req) {
  const nationalIdNumber = (req.body.national_id_number || '').trim();
  if (!nationalIdNumber || !NATIONAL_ID_PATTERN.test(nationalIdNumber)) {
    return { errorMessage: 'national_id_number is required and must be exactly 14 digits' };
  }

  const nationalIdPhotoFile = req.files?.national_id_photo?.[0];
  const studentPhotoFile = req.files?.student_photo?.[0];
  if (!nationalIdPhotoFile || !studentPhotoFile) {
    return { errorMessage: 'Both national_id_photo and student_photo files are required' };
  }

  return {
    kycFiles: {
      nationalIdNumber,
      nationalIdPhotoBuffer: nationalIdPhotoFile.buffer,
      studentPhotoBuffer: studentPhotoFile.buffer,
    },
  };
}

/**
 * POST /api/bulk-registration/buildings/:buildingId/links
 * Owner only. Returns the raw token exactly once.
 */
async function generateLink(req, res) {
  try {
    const { link, token } = await bulkRegistrationService.generateLink(req.user.ownerId, req.params.buildingId, req.user.userId);
    return success(res, {
      statusCode: 201,
      message: 'Link generated — this token is shown only once, store it securely',
      data: { id: link._id, token, expires_at: link.expires_at },
    });
  } catch (err) {
    return handleControllerError(res, err, 'generateLink');
  }
}

/**
 * DELETE /api/bulk-registration/buildings/:buildingId/links
 * Owner only.
 */
async function revokeLink(req, res) {
  try {
    await bulkRegistrationService.revokeLinkForBuilding(req.user.ownerId, req.params.buildingId, req.user.userId);
    return success(res, { statusCode: 200, message: 'Link revoked' });
  } catch (err) {
    return handleControllerError(res, err, 'revokeLink');
  }
}

/**
 * POST /api/bulk-registration/submit/:token
 * Public, unauthenticated. Multipart form, same fields as
 * POST /api/students/register plus declared_bed_id.
 */
async function submitViaLink(req, res) {
  try {
    const profileData = validate(registerStudentSchema, req.body);
    const phone = (req.body.phone || '').trim();
    if (!phone) {
      return error(res, { statusCode: 422, message: 'phone is required' });
    }

    const { kycFiles, errorMessage } = extractKycFields(req);
    if (errorMessage) {
      return error(res, { statusCode: 422, message: errorMessage });
    }

    const submission = await bulkRegistrationService.submitViaLink(req.params.token, {
      phone,
      profileData,
      kycFiles,
      declaredBedId: req.body.declared_bed_id || null,
    });

    return success(res, {
      statusCode: 201,
      message: 'Submission received — the building owner will review it',
      data: { id: submission._id, status: submission.status },
    });
  } catch (err) {
    return handleControllerError(res, err, 'submitViaLink');
  }
}

/**
 * GET /api/bulk-registration/submissions/pending
 * Owner only, paginated.
 */
async function listPending(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { submissions, total } = await bulkRegistrationService.listPendingSubmissionsForOwner(req.user.ownerId, { skip, limit });
    return success(res, {
      statusCode: 200,
      message: 'Pending submissions retrieved',
      data: submissions,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listPending');
  }
}

/**
 * POST /api/bulk-registration/submissions/:submissionId/assign
 * Owner only, ownership-scoped. Body: { bed_id? }
 */
async function assignToBed(req, res) {
  try {
    const result = await bulkRegistrationService.assignToBed(req.params.submissionId, req.user.ownerId, req.user.userId, {
      bedId: req.body.bed_id || null,
    });
    return success(res, { statusCode: 200, message: 'Submission assigned — rental created, bed occupied', data: result });
  } catch (err) {
    return handleControllerError(res, err, 'assignToBed');
  }
}

/**
 * POST /api/bulk-registration/submissions/:submissionId/reject
 * Owner only, ownership-scoped.
 */
async function rejectSubmission(req, res) {
  try {
    const updated = await bulkRegistrationService.rejectSubmission(req.params.submissionId, req.user.ownerId, req.user.userId);
    return success(res, { statusCode: 200, message: 'Submission rejected', data: updated });
  } catch (err) {
    return handleControllerError(res, err, 'rejectSubmission');
  }
}

/**
 * POST /api/bulk-registration/buildings/:buildingId/manual-entry
 * Owner only, ownership-scoped. Multipart form, same fields as submission
 * plus bed_id (required — no declared/self-picked bed for this path).
 */
async function manualEntry(req, res) {
  try {
    const profileData = validate(registerStudentSchema, req.body);
    const phone = (req.body.phone || '').trim();
    if (!phone) {
      return error(res, { statusCode: 422, message: 'phone is required' });
    }
    if (!req.body.bed_id) {
      return error(res, { statusCode: 422, message: 'bed_id is required' });
    }

    const { kycFiles, errorMessage } = extractKycFields(req);
    if (errorMessage) {
      return error(res, { statusCode: 422, message: errorMessage });
    }

    const result = await bulkRegistrationService.manualEntry(req.user.ownerId, req.params.buildingId, req.user.userId, {
      phone,
      profileData,
      kycFiles,
      bedId: req.body.bed_id,
    });

    return success(res, { statusCode: 201, message: 'Tenant entered — rental created, bed occupied', data: result });
  } catch (err) {
    return handleControllerError(res, err, 'manualEntry');
  }
}

module.exports = {
  generateLink,
  revokeLink,
  submitViaLink,
  listPending,
  assignToBed,
  rejectSubmission,
  manualEntry,
};

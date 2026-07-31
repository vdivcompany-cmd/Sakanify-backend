/**
 * kyc.controller.js
 *
 * Handles KYC resubmission and verification-status updates. Initial KYC
 * creation happens as part of student registration (see
 * student.controller.registerStudent) — this controller covers what
 * happens after that.
 *
 * No separate kyc.validation.js file exists (matches the folder structure
 * in Docs/phase-2-students-kyc.md, which lists a validation file only for
 * the students module) — the one KYC-specific field (national_id_number)
 * is validated inline here.
 */

const { success, error } = require('../../shared/utils/response.util');
const kycService = require('./kyc.service');
const studentRepository = require('../students/student.repository');
const { VERIFICATION_STATUS } = require('./kyc.model');

const NATIONAL_ID_PATTERN = /^\d{14}$/; // Egyptian national ID: 14 digits

/**
 * GET /api/kyc/me
 * Protected (student role). Returns the authenticated student's own KYC
 * status (never national_id_number/national_id_photo — select: false).
 */
async function getMyKyc(req, res) {
  try {
    const student = await studentRepository.findByUserId(req.user.userId);
    if (!student) {
      return error(res, { statusCode: 404, message: 'Student profile not found' });
    }

    const kyc = await kycService.getMyKyc(student._id);
    return success(res, { statusCode: 200, message: 'KYC status retrieved', data: kyc });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * POST /api/kyc/me/resubmit
 * Protected (student role). Only allowed when current status is
 * "rejected". Accepts a new national_id_number and/or replacement photos.
 */
async function resubmitKyc(req, res) {
  try {
    const student = await studentRepository.findByUserId(req.user.userId);
    if (!student) {
      return error(res, { statusCode: 404, message: 'Student profile not found' });
    }

    const nationalIdNumber = req.body.national_id_number ? req.body.national_id_number.trim() : undefined;
    if (nationalIdNumber && !NATIONAL_ID_PATTERN.test(nationalIdNumber)) {
      return error(res, { statusCode: 422, message: 'national_id_number must be exactly 14 digits' });
    }

    const nationalIdPhotoFile = req.files?.national_id_photo?.[0];
    const studentPhotoFile = req.files?.student_photo?.[0];

    if (!nationalIdNumber && !nationalIdPhotoFile && !studentPhotoFile) {
      return error(res, {
        statusCode: 422,
        message: 'At least one of national_id_number, national_id_photo, or student_photo must be provided to resubmit',
      });
    }

    const kyc = await kycService.resubmitKyc(student._id, {
      nationalIdNumber,
      nationalIdPhotoBuffer: nationalIdPhotoFile?.buffer,
      studentPhotoBuffer: studentPhotoFile?.buffer,
    });

    return success(res, { statusCode: 200, message: 'KYC resubmitted, pending review', data: kyc });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * PATCH /api/kyc/:kycId/status
 * Super-admin only (see kyc.service.updateVerificationStatus for why
 * owner access is deferred to Phase 4). Body: { status: 'verified' | 'rejected' }
 */
async function updateVerificationStatus(req, res) {
  try {
    const { status } = req.body;

    if (!status || ![VERIFICATION_STATUS.VERIFIED, VERIFICATION_STATUS.REJECTED].includes(status)) {
      return error(res, {
        statusCode: 400,
        message: `status must be one of: ${VERIFICATION_STATUS.VERIFIED}, ${VERIFICATION_STATUS.REJECTED}`,
      });
    }

    const kyc = await kycService.updateVerificationStatus(req.params.kycId, status, req.user.userId);

    return success(res, { statusCode: 200, message: 'KYC verification status updated', data: kyc });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

module.exports = {
  getMyKyc,
  resubmitKyc,
  updateVerificationStatus,
};

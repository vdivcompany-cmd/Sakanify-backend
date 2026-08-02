/**
 * student.controller.js
 *
 * Handles incoming student profile requests. Delegates business logic to
 * student.service. KYC file fields (national_id_photo, student_photo,
 * national_id_number) are collected here at registration time and handed
 * off as raw buffers — student.service passes them straight through to
 * kyc.service without this controller reaching into the Kyc collection.
 */

const { success, error } = require('../../shared/utils/response.util');
const studentService = require('./student.service');
const requestService = require('../requests/request.service');
const rentalService = require('../rentals/rental.service');
const { registerStudentSchema, updateProfileSchema, validate } = require('./student.validation');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

// Security-hardening-pass addition (hardening-audit Category 5 / CLAUDE.md
// Section 7.3a). Safe to route straight through normalizeError() here
// (unlike auth.controller.js) — every error this module's own service/
// validation layer throws is either an AppError or student.validation.js's
// zod helper (a plain Error with an explicit `.statusCode` < 500 and an
// `.errors` array), both of which normalizeError() now classifies
// correctly and preserves the `errors` array for (see
// error-handler.middleware.js's normalizeError doc comment).
function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[student.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

const NATIONAL_ID_PATTERN = /^\d{14}$/; // Egyptian national ID: 14 digits

/**
 * POST /api/students/register
 * Protected (student role). Multipart form:
 *   fields: name, email?, age?, college, academic_year, university_id?, smoking_preference
 *   files: national_id_photo, student_photo
 *   field: national_id_number
 */
async function registerStudent(req, res) {
  try {
    const profileData = validate(registerStudentSchema, req.body);

    const nationalIdNumber = (req.body.national_id_number || '').trim();
    if (!nationalIdNumber) {
      return error(res, { statusCode: 422, message: 'national_id_number is required' });
    }
    if (!NATIONAL_ID_PATTERN.test(nationalIdNumber)) {
      return error(res, { statusCode: 422, message: 'national_id_number must be exactly 14 digits' });
    }

    const nationalIdPhotoFile = req.files?.national_id_photo?.[0];
    const studentPhotoFile = req.files?.student_photo?.[0];

    if (!nationalIdPhotoFile || !studentPhotoFile) {
      return error(res, {
        statusCode: 422,
        message: 'Both national_id_photo and student_photo files are required',
      });
    }

    const result = await studentService.registerStudent(req.user, profileData, {
      nationalIdNumber,
      nationalIdPhotoBuffer: nationalIdPhotoFile.buffer,
      studentPhotoBuffer: studentPhotoFile.buffer,
    });

    return success(res, {
      statusCode: 201,
      message: 'Student profile and KYC submission created',
      data: {
        student: result.student,
        kyc_status: result.kyc.verification_status,
      },
    });
  } catch (err) {
    return handleControllerError(res, err, 'registerStudent');
  }
}

/**
 * GET /api/students/me
 * Protected (student role).
 */
async function getMyProfile(req, res) {
  try {
    const result = await studentService.getMyProfile(req.user.userId);
    return success(res, {
      statusCode: 200,
      message: 'Profile retrieved',
      data: {
        student: result.student,
        kyc_status: result.kyc_status,
      },
    });
  } catch (err) {
    return handleControllerError(res, err, 'getMyProfile');
  }
}

/**
 * PATCH /api/students/me
 * Protected (student role). General profile fields only — never KYC data.
 */
async function updateMyProfile(req, res) {
  try {
    const updates = validate(updateProfileSchema, req.body);
    const student = await studentService.updateMyProfile(req.user.userId, updates);
    return success(res, {
      statusCode: 200,
      message: 'Profile updated',
      data: student,
    });
  } catch (err) {
    return handleControllerError(res, err, 'updateMyProfile');
  }
}

/**
 * GET /api/students/:studentId/full-profile
 * Owner only. Deferred from Phase 2 (Docs/phase-2-students-kyc.md
 * Implementation Step 8) to Phase 4 (Docs/phase-4-booking-engine.md
 * step 10), now that Requests/Rentals exist to scope this through.
 *
 * Access is explicitly NOT a simple owner_id match (there's no
 * "owner_id" field on Student to compare against) — it's a relationship
 * check: the requesting owner may only view a student who is connected
 * to one of their buildings through a pending request OR an
 * active/vacating rental. Checked via two service calls (request.service
 * / rental.service), OR'd together, with an explicit 403 on failure —
 * the same "isolation must be explicit" spirit as ownershipScoping(),
 * just not literally that helper, since there's no single owner_id field
 * to compare here.
 */
async function getFullProfileForOwner(req, res) {
  try {
    const { studentId } = req.params;
    const ownerId = req.user.ownerId;

    const [hasPending, hasActiveRental] = await Promise.all([
      requestService.hasPendingRequestWithOwner(studentId, ownerId),
      rentalService.hasActiveRelationshipWithOwner(studentId, ownerId),
    ]);

    if (!hasPending && !hasActiveRental) {
      return error(res, {
        statusCode: 403,
        message: 'Access denied: this student has no pending request or active rental with your buildings.',
      });
    }

    const { student, kyc } = await studentService.getFullProfileWithKyc(studentId);

    return success(res, {
      statusCode: 200,
      message: 'Student profile retrieved',
      data: {
        student,
        kyc_status: kyc ? kyc.verification_status : null,
        kyc_student_photo: kyc ? kyc.student_photo : null,
      },
    });
  } catch (err) {
    return handleControllerError(res, err, 'getFullProfileForOwner');
  }
}

module.exports = {
  registerStudent,
  getMyProfile,
  updateMyProfile,
  getFullProfileForOwner,
};

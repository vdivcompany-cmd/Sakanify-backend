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
const { registerStudentSchema, updateProfileSchema, validate } = require('./student.validation');

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
    return error(res, {
      statusCode: err.statusCode || 400,
      message: err.message,
      errors: err.errors || null,
    });
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
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
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
    return error(res, {
      statusCode: err.statusCode || 400,
      message: err.message,
      errors: err.errors || null,
    });
  }
}

module.exports = {
  registerStudent,
  getMyProfile,
  updateMyProfile,
};

/**
 * student.service.js
 *
 * Business logic for student registration and profile management.
 * KYC record creation/lookup is delegated to kyc.service — this module
 * never touches the Kyc collection directly (CLAUDE.md Section 7.2).
 */

const studentRepository = require('./student.repository');
const kycService = require('../kyc/kyc.service');
const authService = require('../auth/auth.service');
const { AppError } = require('../../middleware/error-handler.middleware');

/**
 * Register the lean student profile + initial KYC record together, for
 * an already-authenticated student user (auth account created in Phase 1
 * via /api/auth/register-student + OTP login).
 *
 * user: req.user as set by auth.middleware ({ userId, role, ownerId } —
 * decoded straight from the JWT, no phone in the token payload). The
 * profile's phone is copied from the auth User record itself, fetched via
 * authService.getUserById() (a service call, not a direct model import —
 * CLAUDE.md Section 7.2).
 *
 * profileData: validated fields from student.validation.registerStudentSchema
 * kycFiles: { nationalIdPhotoBuffer, studentPhotoBuffer, nationalIdNumber }
 */
async function registerStudent(user, profileData, kycFiles) {
  const existing = await studentRepository.findByUserId(user.userId);
  if (existing) {
    throw new AppError('Student profile already exists for this account', 409);
  }

  const authUser = await authService.getUserById(user.userId);
  if (!authUser || !authUser.phone) {
    throw new AppError('Associated auth account not found or has no phone number on file', 404);
  }

  const student = await studentRepository.create({
    user: user.userId,
    phone: authUser.phone,
    ...profileData,
  });

  const kyc = await kycService.createInitialKyc(student._id, kycFiles);

  return { student, kyc: { verification_status: kyc.verification_status } };
}

/**
 * Get the authenticated student's own profile + KYC verification status
 * (never the sensitive KYC fields — those stay behind kyc.service).
 */
async function getMyProfile(userId) {
  const student = await studentRepository.findByUserId(userId);
  if (!student) {
    throw new AppError('Student profile not found', 404);
  }

  const kyc = await kycService.getMyKyc(student._id).catch(() => null);

  return {
    student,
    kyc_status: kyc ? kyc.verification_status : null,
  };
}

/**
 * Update general profile fields (editable anytime). Never touches KYC
 * fields — those go through kyc.service.resubmitKyc, gated by rejection
 * status.
 */
async function updateMyProfile(userId, updates) {
  const student = await studentRepository.updateByUserId(userId, updates);
  if (!student) {
    throw new AppError('Student profile not found', 404);
  }
  return student;
}

module.exports = {
  registerStudent,
  getMyProfile,
  updateMyProfile,
};

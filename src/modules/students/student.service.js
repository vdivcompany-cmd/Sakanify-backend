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

/**
 * Resolve the Student profile document for an authenticated User id
 * (req.user.userId from the JWT). Used by request.service to translate
 * "which student is making this request" into the Student _id that
 * request.model actually references — added in Phase 4, kept here rather
 * than in the requests module so requests never queries the Student
 * collection directly (CLAUDE.md Section 7.2).
 */
async function getStudentRecordByUserId(userId) {
  const student = await studentRepository.findByUserId(userId);
  if (!student) {
    throw new AppError('Student profile not found for this account', 404);
  }
  return student;
}

/**
 * Full profile + KYC status for a single student, by Student _id (not
 * User id) — used by the owner-facing view built in Phase 4
 * (Docs/phase-4-booking-engine.md, implementation step 10: "Use the
 * studentService.getFullProfileWithKyc(studentId) function already
 * exposed by the Phase 2 students module"). That function did not
 * actually exist yet — Phase 2 deferred the owner-facing view entirely,
 * so nothing needed it at the time. Added now, in Phase 4, where it's
 * first actually called. Same safe subset as getMyProfile(): KYC's
 * sensitive fields (national_id_number, national_id_photo) stay excluded
 * by the schema's `select: false` default — an owner viewing a
 * connected student never sees raw national ID data through this path.
 */
async function getFullProfileWithKyc(studentId) {
  const student = await studentRepository.findById(studentId);
  if (!student) {
    throw new AppError('Student not found', 404);
  }

  const kyc = await kycService.getMyKyc(student._id).catch(() => null);

  return { student, kyc };
}

/**
 * Batched version of getFullProfileWithKyc for a page of students at
 * once — used by the owner-facing pending-requests list
 * (request.controller.listPending), so a page of N requests costs two
 * queries total (Student + Kyc, both `$in`), never N+1
 * (CLAUDE.md Section 4.4). Returns a Map keyed by student id (string).
 */
async function getFullProfilesWithKycForIds(studentIds) {
  const uniqueIds = [...new Set(studentIds.map((id) => id.toString()))];
  if (uniqueIds.length === 0) return new Map();

  const [students, kycMap] = await Promise.all([
    studentRepository.findByIds(uniqueIds),
    kycService.getKycMapForStudents(uniqueIds),
  ]);

  const result = new Map();
  for (const student of students) {
    const key = student._id.toString();
    result.set(key, { student, kyc: kycMap.get(key) || null });
  }
  return result;
}

/**
 * Phase 9 addition (Part A/B, public bed-picker / roommate-college
 * endpoint): batched student-id -> college lookup, minimal-exposure by
 * construction (returns only `college`, never the full student document)
 * — used to project an occupied bed's `current_occupant_college` without
 * ever risking leaking name/photo/phone through this specific path
 * (Part B, Product Decision: "only that occupant's college — nothing
 * else"). One query regardless of how many occupied beds exist
 * (CLAUDE.md Section 4.4).
 */
async function getCollegesForStudentIds(studentIds) {
  const uniqueIds = [...new Set(studentIds.map((id) => id.toString()))];
  if (uniqueIds.length === 0) return new Map();

  const students = await studentRepository.findByIds(uniqueIds);
  const map = new Map();
  for (const student of students) {
    map.set(student._id.toString(), student.college);
  }
  return map;
}

module.exports = {
  registerStudent,
  getMyProfile,
  updateMyProfile,
  getStudentRecordByUserId,
  getFullProfileWithKyc,
  getFullProfilesWithKycForIds,
  getCollegesForStudentIds,
};

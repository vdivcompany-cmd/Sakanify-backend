/**
 * kyc.service.js
 *
 * Business logic for KYC submission, resubmission, and verification
 * status changes. Photo bytes never touch this layer directly as raw
 * binary beyond the single storeFile() call — only references/URLs from
 * file-storage.adapter are persisted (CLAUDE.md Section 3.2).
 */

const kycRepository = require('./kyc.repository');
const { VERIFICATION_STATUS } = require('./kyc.model');
const fileStorage = require('../../shared/utils/file-storage.adapter');
const auditService = require('../audit/audit.service');
const { AppError } = require('../../middleware/error-handler.middleware');

/**
 * Create the initial KYC record for a freshly-registered student.
 * Called by student.service.registerStudent() — kyc.service owns writes
 * to the Kyc collection so student.service never touches Kyc directly
 * (CLAUDE.md Section 7.2: cross-module logic goes through service calls).
 */
async function createInitialKyc(studentId, { nationalIdPhotoBuffer, studentPhotoBuffer, nationalIdNumber }) {
  const [nationalIdPhoto, studentPhoto] = await Promise.all([
    fileStorage.storeFile(nationalIdPhotoBuffer, { folder: 'kyc' }),
    fileStorage.storeFile(studentPhotoBuffer, { folder: 'kyc' }),
  ]);

  return kycRepository.create({
    student: studentId,
    national_id_number: nationalIdNumber,
    national_id_photo: nationalIdPhoto.reference,
    student_photo: studentPhoto.reference,
    verification_status: VERIFICATION_STATUS.PENDING,
  });
}

/**
 * Get the authenticated student's own KYC status (safe subset — never
 * returns national_id_number or national_id_photo, per the schema's
 * `select: false` default).
 */
async function getMyKyc(studentId) {
  const kyc = await kycRepository.findByStudentId(studentId);
  if (!kyc) {
    throw new AppError('KYC record not found', 404);
  }
  return kyc;
}

/**
 * Batched KYC lookup for many students at once, keyed by student id
 * (string) -> kyc document or null if the student has no KYC record yet.
 * Used by student.service.getFullProfilesWithKycForIds (Phase 4's
 * owner-facing pending-requests list) — one query regardless of how many
 * students are on the page (CLAUDE.md Section 4.4).
 */
async function getKycMapForStudents(studentIds) {
  const kycRecords = await kycRepository.findByStudentIds(studentIds);
  const map = new Map();
  for (const kyc of kycRecords) {
    map.set(kyc.student.toString(), kyc);
  }
  return map;
}

/**
 * Resubmit KYC after a rejection. Only allowed when the current status is
 * `rejected` — a student cannot resubmit a pending or already-verified
 * record (implementation step 7 in the phase spec: KYC resubmission is
 * specifically for the "if rejected" case).
 */
async function resubmitKyc(studentId, { nationalIdPhotoBuffer, studentPhotoBuffer, nationalIdNumber }) {
  const existing = await kycRepository.findByStudentId(studentId);
  if (!existing) {
    throw new AppError('KYC record not found', 404);
  }

  if (existing.verification_status !== VERIFICATION_STATUS.REJECTED) {
    throw new AppError(
      `KYC can only be resubmitted when status is "${VERIFICATION_STATUS.REJECTED}" (current status: "${existing.verification_status}")`,
      409,
    );
  }

  const updates = {
    verification_status: VERIFICATION_STATUS.PENDING,
    reviewed_by: null,
    reviewed_at: null,
  };

  if (nationalIdNumber) updates.national_id_number = nationalIdNumber;

  if (nationalIdPhotoBuffer) {
    const stored = await fileStorage.storeFile(nationalIdPhotoBuffer, { folder: 'kyc' });
    updates.national_id_photo = stored.reference;
  }

  if (studentPhotoBuffer) {
    const stored = await fileStorage.storeFile(studentPhotoBuffer, { folder: 'kyc' });
    updates.student_photo = stored.reference;
  }

  return kycRepository.updateByStudentId(studentId, updates);
}

/**
 * Update verification status (Verified/Rejected).
 *
 * Restricted to super-admin only in Phase 2. The phase spec asks us to
 * "decide whether owner, admin, or both can change it" — owner access is
 * deliberately deferred (see Docs/phase-2-students-kyc.md deviation note
 * in the Phase 2 report): there is no Buildings/Rentals relationship data
 * yet to scope "which students this owner may review" by, so granting
 * owners KYC-review access now would mean any owner could verify/reject
 * any student's KYC — a real data-isolation gap. Route-level
 * requireRole(SUPER_ADMIN) enforces this; this function just records who
 * made the call.
 *
 * Retrofitted in Phase 3 (per Docs/phase-3-buildings-apartments-beds.md's
 * "Added After Phase 2 Review" section): every status change now also
 * writes to the real, central audit log via auditService.writeAuditLog(),
 * in addition to the existing reviewed_by/reviewed_at fields kept on the
 * KYC record itself for quick lookups. The audit entry is the
 * authoritative record; reviewed_by/reviewed_at remain for convenience.
 */
async function updateVerificationStatus(kycId, newStatus, reviewerUserId) {
  if (![VERIFICATION_STATUS.VERIFIED, VERIFICATION_STATUS.REJECTED].includes(newStatus)) {
    throw new AppError(`Invalid verification status: "${newStatus}"`, 400);
  }

  const kyc = await kycRepository.findById(kycId);
  if (!kyc) {
    throw new AppError('KYC record not found', 404);
  }

  const previousStatus = kyc.verification_status;

  const updated = await kycRepository.updateStatusById(kycId, {
    verification_status: newStatus,
    reviewed_by: reviewerUserId,
    reviewed_at: new Date(),
  });

  await auditService.writeAuditLog({
    actor: reviewerUserId,
    action: 'kyc_status_change',
    entityType: 'Kyc',
    entityId: kycId,
    beforeState: { verification_status: previousStatus },
    afterState: { verification_status: newStatus },
  });

  return updated;
}

module.exports = {
  createInitialKyc,
  getMyKyc,
  getKycMapForStudents,
  resubmitKyc,
  updateVerificationStatus,
};

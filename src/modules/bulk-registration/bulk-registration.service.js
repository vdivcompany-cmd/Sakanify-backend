/**
 * bulk-registration.service.js
 *
 * Phase 9, Part D. Never touches Building/Bed/Rental/Student/Kyc/User
 * collections directly — always through their own services, per
 * CLAUDE.md Section 7.2.
 */

const bulkRegistrationRepository = require('./bulk-registration.repository');
const { generateRawToken, hashToken } = require('./bulk-registration.model');
const buildingService = require('../buildings/building.service');
const bedService = require('../beds/bed.service');
const rentalService = require('../rentals/rental.service');
const authService = require('../auth/auth.service');
const studentService = require('../students/student.service');
const kycService = require('../kyc/kyc.service');
const auditService = require('../audit/audit.service');
const { BED_STATUS, BULK_SUBMISSION_STATUS } = require('../../config/constants.config');
const { AppError } = require('../../middleware/error-handler.middleware');

const LINK_EXPIRY_DAYS = 14; // Product Decision 2's recommended default
const SUBMISSIONS_PER_LINK_PER_HOUR = 20; // Product Decision 4's per-token cap, independent of source IP

// --- Link generation / revocation (implementation step 2) ---

/**
 * Generates a new link for a building, revoking any existing non-revoked
 * link for that same building first (Product Decision 2: "generating a
 * new link invalidates the old one for that building"). Returns the RAW
 * token exactly once — it is never retrievable again after this call,
 * since only its hash is persisted (Product Decision 1).
 */
async function generateLink(ownerId, buildingId, actorUserId) {
  const building = await buildingService.getBuildingById(buildingId);
  if (building.owner_id !== ownerId) {
    throw new AppError('Access denied: you do not have permission to access this building.', 403);
  }

  const existing = await bulkRegistrationRepository.findActiveLinkForBuilding(buildingId);
  if (existing) {
    await bulkRegistrationRepository.revokeLink(existing._id);
    await auditService.writeAuditLog({
      actor: actorUserId,
      action: 'bulk_registration_link_revoked',
      entityType: 'BulkRegistrationLink',
      entityId: existing._id,
      afterState: { reason: 'superseded_by_new_link' },
    });
  }

  const rawToken = generateRawToken();
  const link = await bulkRegistrationRepository.createLink({
    building: buildingId,
    owner_id: ownerId,
    token_hash: hashToken(rawToken),
    expires_at: new Date(Date.now() + LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'bulk_registration_link_generated',
    entityType: 'BulkRegistrationLink',
    entityId: link._id,
    afterState: { building: buildingId.toString(), expires_at: link.expires_at },
  });

  return { link, token: rawToken };
}

async function revokeLinkForBuilding(ownerId, buildingId, actorUserId) {
  const building = await buildingService.getBuildingById(buildingId);
  if (building.owner_id !== ownerId) {
    throw new AppError('Access denied: you do not have permission to access this building.', 403);
  }

  const existing = await bulkRegistrationRepository.findActiveLinkForBuilding(buildingId);
  if (!existing) {
    throw new AppError('No active link exists for this building.', 404);
  }

  const revoked = await bulkRegistrationRepository.revokeLink(existing._id);

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'bulk_registration_link_revoked',
    entityType: 'BulkRegistrationLink',
    entityId: existing._id,
    afterState: { reason: 'owner_revoked' },
  });

  return revoked;
}

/**
 * Validates a raw token from the public URL against its stored hash,
 * checking expiry/revocation. Returns the live link document, or throws
 * a 404 (deliberately not 403 — same existence-leakage discipline as
 * Phase 8's public endpoints) for anything invalid/expired/revoked.
 */
async function resolveLinkFromRawToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new AppError('Link not found', 404);
  }

  const link = await bulkRegistrationRepository.findLinkByTokenHash(hashToken(rawToken));
  if (!link || link.revoked_at || link.expires_at < new Date()) {
    throw new AppError('Link not found', 404);
  }

  return link;
}

// --- Submission (implementation step 3) ---

/**
 * Public "Submit via Link" endpoint's business logic. Collects the same
 * Phase 2 registration + KYC fields (reusing authService.registerStudent
 * + studentService.registerStudent directly, rather than duplicating
 * that logic — technical decision, flagged in the Phase 9 report: this
 * means a bulk-registration submission creates a REAL, fully-KYC'd
 * User+Student+Kyc account immediately, exactly as if the student had
 * self-registered through the normal app flow — only the Rental stays
 * gated behind the owner's explicit review, per Product Decision 3).
 *
 * `declaredBedId`, if provided, must currently be an AVAILABLE bed in
 * this link's building — validated here but never locked/transitioned
 * (Product Decision 6: non-binding).
 */
async function submitViaLink(rawToken, { phone, profileData, kycFiles, declaredBedId }) {
  const link = await resolveLinkFromRawToken(rawToken);

  // Product Decision 4: per-token rate limit, independent of source IP.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCount = await bulkRegistrationRepository.countSubmissionsForLinkSince(link._id, oneHourAgo);
  if (recentCount >= SUBMISSIONS_PER_LINK_PER_HOUR) {
    throw new AppError('Too many submissions via this link recently. Please try again later.', 429);
  }

  let declaredBed = null;
  if (declaredBedId) {
    declaredBed = await bedService.getBedById(declaredBedId);
    if (declaredBed.building.toString() !== link.building.toString() || declaredBed.status !== BED_STATUS.AVAILABLE) {
      throw new AppError('The selected bed is not currently available in this building.', 422);
    }
  }

  let authResult;
  try {
    authResult = await authService.registerStudent(phone);
  } catch (err) {
    throw new AppError(err.message || 'Could not register this phone number', 409);
  }

  const { student } = await studentService.registerStudent({ userId: authResult.userId }, profileData, kycFiles);

  const submission = await bulkRegistrationRepository.createSubmission({
    link: link._id,
    building: link.building,
    owner_id: link.owner_id,
    student: student._id,
    declared_bed: declaredBed ? declaredBed._id : null,
    status: BULK_SUBMISSION_STATUS.PENDING,
  });

  await auditService.writeAuditLog({
    actor: null,
    action: 'bulk_registration_submission_created',
    entityType: 'BulkSubmission',
    entityId: submission._id,
    afterState: { building: link.building.toString(), student: student._id.toString() },
  });

  return submission;
}

// --- Owner review (implementation step 4) ---

async function listPendingSubmissionsForOwner(ownerId, { skip, limit }) {
  const [submissions, total] = await Promise.all([
    bulkRegistrationRepository.findPendingForOwner(ownerId, { skip, limit }),
    bulkRegistrationRepository.countPendingForOwner(ownerId),
  ]);
  return { submissions, total };
}

/**
 * "Assign to Bed" — the ONLY path from a submission to a real Rental
 * (Product Decision 3). Defaults to the submission's self-declared bed
 * but the owner may pass a different `bedId` if the student's self-report
 * was wrong (Product Decision 6). Reuses the EXACT same atomic
 * bed-availability primitive as Part A's confirm step
 * (bedService.atomicTransition) and the EXACT same one-active-rental-
 * per-student guard (rentalService.createRental) — not a second
 * implementation of either, per the spec's explicit instruction.
 */
async function assignToBed(submissionId, ownerId, actorUserId, { bedId } = {}) {
  const submission = await bulkRegistrationRepository.findSubmissionById(submissionId);
  if (!submission) {
    throw new AppError('Submission not found', 404);
  }
  if (submission.owner_id !== ownerId) {
    throw new AppError('Access denied: you do not have permission to access this submission.', 403);
  }
  if (submission.status !== BULK_SUBMISSION_STATUS.PENDING) {
    throw new AppError(`Submission is not pending (current status: "${submission.status}")`, 409);
  }

  const targetBedId = bedId || submission.declared_bed;
  if (!targetBedId) {
    throw new AppError('bed_id is required — this submission has no declared bed to default to.', 422);
  }

  const bed = await bedService.getBedById(targetBedId);

  const lockedBed = await bedService.atomicTransition(bed._id, BED_STATUS.AVAILABLE, BED_STATUS.OCCUPIED, actorUserId);
  if (!lockedBed) {
    throw new AppError('Could not assign: the selected bed is no longer available.', 409);
  }

  let rental;
  try {
    rental = await rentalService.createRental({
      studentId: submission.student,
      bedId: lockedBed._id,
      buildingId: lockedBed.building,
      ownerId,
      monthlyRent: lockedBed.monthly_rent,
      actorUserId,
    });
  } catch (err) {
    const released = await bedService
      .atomicTransition(lockedBed._id, BED_STATUS.OCCUPIED, BED_STATUS.AVAILABLE, actorUserId)
      .catch(() => null);
    if (!released) {
      console.error(`[bulk-registration.service] Failed to roll back bed ${lockedBed._id} after rental creation failed:`, err);
    }
    throw err;
  }

  const updated = await bulkRegistrationRepository.updateSubmissionById(submissionId, {
    status: BULK_SUBMISSION_STATUS.ASSIGNED,
    resulting_rental: rental._id,
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'bulk_registration_submission_assigned',
    entityType: 'BulkSubmission',
    entityId: submissionId,
    beforeState: { status: BULK_SUBMISSION_STATUS.PENDING },
    afterState: { status: BULK_SUBMISSION_STATUS.ASSIGNED, rental: rental._id.toString(), bed: bed._id.toString() },
  });

  return { submission: updated, rental };
}

async function rejectSubmission(submissionId, ownerId, actorUserId) {
  const submission = await bulkRegistrationRepository.findSubmissionById(submissionId);
  if (!submission) {
    throw new AppError('Submission not found', 404);
  }
  if (submission.owner_id !== ownerId) {
    throw new AppError('Access denied: you do not have permission to access this submission.', 403);
  }
  if (submission.status !== BULK_SUBMISSION_STATUS.PENDING) {
    throw new AppError(`Submission is not pending (current status: "${submission.status}")`, 409);
  }

  const updated = await bulkRegistrationRepository.updateSubmissionById(submissionId, {
    status: BULK_SUBMISSION_STATUS.REJECTED,
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'bulk_registration_submission_rejected',
    entityType: 'BulkSubmission',
    entityId: submissionId,
    beforeState: { status: BULK_SUBMISSION_STATUS.PENDING },
    afterState: { status: BULK_SUBMISSION_STATUS.REJECTED },
  });

  return updated;
}

/**
 * "Manual Entry" (implementation step 5, Product Decision 5) — the owner
 * enters a pre-existing tenant's data directly, no link involved, going
 * straight to Rental creation. Owner-authenticated, ownership-scoped, same
 * atomic bed check — no new security surface, since it's just an
 * authenticated owner action (unlike the link-based public submission
 * path above).
 */
async function manualEntry(ownerId, buildingId, actorUserId, { phone, profileData, kycFiles, bedId }) {
  const building = await buildingService.getBuildingById(buildingId);
  if (building.owner_id !== ownerId) {
    throw new AppError('Access denied: you do not have permission to access this building.', 403);
  }

  const bed = await bedService.getBedById(bedId);
  if (bed.building.toString() !== buildingId.toString()) {
    throw new AppError('The selected bed does not belong to this building.', 422);
  }

  let authResult;
  try {
    authResult = await authService.registerStudent(phone);
  } catch (err) {
    throw new AppError(err.message || 'Could not register this phone number', 409);
  }

  const { student } = await studentService.registerStudent({ userId: authResult.userId }, profileData, kycFiles);

  const lockedBed = await bedService.atomicTransition(bed._id, BED_STATUS.AVAILABLE, BED_STATUS.OCCUPIED, actorUserId);
  if (!lockedBed) {
    throw new AppError('Could not assign: the selected bed is no longer available.', 409);
  }

  let rental;
  try {
    rental = await rentalService.createRental({
      studentId: student._id,
      bedId: lockedBed._id,
      buildingId: lockedBed.building,
      ownerId,
      monthlyRent: lockedBed.monthly_rent,
      actorUserId,
    });
  } catch (err) {
    const released = await bedService
      .atomicTransition(lockedBed._id, BED_STATUS.OCCUPIED, BED_STATUS.AVAILABLE, actorUserId)
      .catch(() => null);
    if (!released) {
      console.error(`[bulk-registration.service] Failed to roll back bed ${lockedBed._id} after manual-entry rental creation failed:`, err);
    }
    throw err;
  }

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'bulk_registration_manual_entry',
    entityType: 'Rental',
    entityId: rental._id,
    afterState: { student: student._id.toString(), bed: bed._id.toString() },
  });

  return { student, rental };
}

module.exports = {
  generateLink,
  revokeLinkForBuilding,
  resolveLinkFromRawToken,
  submitViaLink,
  listPendingSubmissionsForOwner,
  assignToBed,
  rejectSubmission,
  manualEntry,
  LINK_EXPIRY_DAYS,
  SUBMISSIONS_PER_LINK_PER_HOUR,
};

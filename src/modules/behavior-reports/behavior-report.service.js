/**
 * behavior-report.service.js
 *
 * Business logic for Phase 9 Part C: relationship-gated National ID
 * search and cross-owner behavior report filing. Never touches
 * Student/Kyc/Request/Rental collections directly — always through their
 * own services, per CLAUDE.md Section 7.2.
 *
 * THE core guarantee this module exists to protect (Product Decision 2):
 * an owner may only search/view/file a report about a student if that
 * owner currently has, or has had, an actual relationship with them (a
 * request or rental connecting them, ANY status, past or present) — never
 * a free-text lookup any owner can run on any student. Every search is
 * audit-logged regardless of outcome, as an additional deterrent and
 * paper trail (Product Decision 2).
 */

const behaviorReportRepository = require('./behavior-report.repository');
const requestService = require('../requests/request.service');
const rentalService = require('../rentals/rental.service');
const studentService = require('../students/student.service');
const kycService = require('../kyc/kyc.service');
const auditService = require('../audit/audit.service');
const { AppError } = require('../../middleware/error-handler.middleware');

/**
 * The relationship gate itself: does this owner have any qualifying
 * history with this student? Checked via the two existing modules'
 * "any status" relationship functions (Phase 9 additions to
 * request.service/rental.service) rather than duplicating a query here.
 */
async function hasQualifyingRelationship(ownerId, studentId) {
  const [hasRequestHistory, hasRentalHistory] = await Promise.all([
    requestService.hasAnyRelationshipWithOwner(studentId, ownerId),
    rentalService.hasAnyRelationshipWithOwner(studentId, ownerId),
  ]);
  return hasRequestHistory || hasRentalHistory;
}

/**
 * Implementation step 2: "Search by National ID." Resolves the ID to a
 * student, verifies the searching owner has a qualifying relationship,
 * then returns the student's profile/KYC summary plus every behavior
 * report ever filed about them by ANY owner (intentionally cross-owner —
 * Product Decision 1). Every search is audit-logged regardless of
 * outcome (found+authorized, found+unauthorized, or not found at all) —
 * implementation step 5.
 */
async function searchByNationalId(ownerId, nationalIdNumber, actorUserId) {
  const studentId = await kycService.findStudentIdByNationalId(nationalIdNumber);

  if (!studentId) {
    await auditService.writeAuditLog({
      actor: actorUserId,
      action: 'behavior_report_search',
      entityType: 'Kyc',
      entityId: 'not_found',
      afterState: { national_id_searched: true, result: 'not_found' },
    });
    throw new AppError('No student found with that National ID number.', 404);
  }

  const qualifies = await hasQualifyingRelationship(ownerId, studentId);

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'behavior_report_search',
    entityType: 'Student',
    entityId: studentId,
    afterState: { result: qualifies ? 'authorized' : 'rejected_no_relationship' },
  });

  if (!qualifies) {
    throw new AppError(
      'You may only search for a student you currently have, or have had, an actual relationship with (a viewing-booking, request, or rental).',
      403,
    );
  }

  const { student, kyc } = await studentService.getFullProfileWithKyc(studentId);
  const reports = await behaviorReportRepository.findByStudent(studentId);

  return {
    student,
    kyc_status: kyc ? kyc.verification_status : null,
    reports,
  };
}

/**
 * Implementation step 3: "File Behavior Report." Same relationship-gating
 * as search — an owner can't file a report about a student they never
 * actually housed/considered housing, enforced at creation too (not just
 * at search time), per implementation step 1.
 */
async function fileReport(ownerId, studentId, { incidentDescription, severity }, actorUserId) {
  const qualifies = await hasQualifyingRelationship(ownerId, studentId);
  if (!qualifies) {
    throw new AppError(
      'You may only file a behavior report about a student you currently have, or have had, an actual relationship with.',
      403,
    );
  }

  if (!incidentDescription || !String(incidentDescription).trim()) {
    throw new AppError('incident_description is required', 422);
  }

  const report = await behaviorReportRepository.create({
    student: studentId,
    filed_by_owner: ownerId,
    incident_description: String(incidentDescription).trim(),
    severity,
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'behavior_report_filed',
    entityType: 'BehaviorReport',
    entityId: report._id,
    afterState: { student: studentId.toString(), severity },
  });

  return report;
}

/**
 * Part A/C tie-in (implementation step 4): "prepares content for manual
 * sending" per Product Decision 3 — never sends anything itself. Called by
 * request.controller.rejectRequest when the owner supplies
 * behavior_report_ids on a rejection, so the response can include the
 * student's/guardian's phone numbers plus a suggested message body for
 * the owner to copy into their own WhatsApp/SMS.
 */
function buildContactTemplate(student, reasonLabel) {
  return {
    student_phone: student.phone || null,
    guardian_phone: student.guardian_phone || null,
    suggested_message: `Hi ${student.name}, unfortunately your booking request was declined`
      + `${reasonLabel ? ` (reason: ${reasonLabel})` : ''}. Feel free to reach out if you have any questions.`,
  };
}

module.exports = {
  hasQualifyingRelationship,
  searchByNationalId,
  fileReport,
  buildContactTemplate,
};

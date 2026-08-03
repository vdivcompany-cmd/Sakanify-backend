/**
 * request.service.js
 *
 * The highest-risk business logic in the whole backend
 * (Docs/phase-4-booking-engine.md: "the highest-risk, highest-priority
 * module"). `createRequest` is where the atomic bed-locking guarantee
 * actually gets exercised — see bed.service.atomicTransition /
 * bed.repository.conditionalUpdateStatus for the real atomicity
 * mechanism (a single conditional `findOneAndUpdate`, not application
 * locking or a queue).
 *
 * Never touches Student/Bed/Rental/Audit collections directly — always
 * through their own services, per CLAUDE.md Section 7.2.
 */

const requestRepository = require('./request.repository');
const bedService = require('../beds/bed.service');
const studentService = require('../students/student.service');
const rentalService = require('../rentals/rental.service');
const auditService = require('../audit/audit.service');
// Phase 6 addition (Docs/phase-6-subscriptions.md, step 5's business
// rule, wired in per explicit project-owner decision after the Phase 6
// report — see that report's "Technical Decisions" section for the
// resolved discussion). subscription.service has no back-edge into this
// module (or into any module this one depends on), so this require has
// no load-order cycle.
const subscriptionService = require('../subscriptions/subscription.service');
const dateUtil = require('../../shared/utils/date.util');
const { BED_STATUS, REQUEST_STATUS, REQUEST_REJECTION_REASON } = require('../../config/constants.config');
const { AppError } = require('../../middleware/error-handler.middleware');

const EXPIRY_WINDOW_HOURS = 48;
// Phase 9 addition (Part A, Product Decision 6): grace period after an
// owner-set appointment_date before an unanswered viewing-booking is
// auto-expired for a no-show.
const APPOINTMENT_GRACE_HOURS = 48;
// Recommended cap from the phase spec — a soft business rule (prevents
// one student from tying up the whole owner-review queue), not a
// correctness guarantee. Enforced with a plain count-then-create check;
// see the comment in createRequest() for why that's an acceptable,
// deliberate distinction from the atomic bed-locking guarantee, which as
// of Phase 9 lives at confirm-time (see confirmRequest below) rather than
// here.
const MAX_PENDING_REQUESTS_PER_STUDENT = 2;

/**
 * Create a request (viewing-booking) for a bed.
 *
 * Phase 9 REDESIGN (Docs/phase-9-booking-behavior-bulk-registration.md,
 * Part A — "Public Viewing-Booking Flow"): this used to atomically lock
 * the bed (available -> pending) as part of creation, rejecting any
 * further request for the same bed until the first was resolved. That
 * guarantee has intentionally moved to confirmRequest() below — creation
 * here NEVER touches bed.status and NEVER rejects based on other pending
 * requests for the same bed; many students may hold a pending viewing-
 * booking for the same bed at once, by design (Product Decision 1). The
 * only remaining bed check at creation time is a plain read confirming
 * the bed is still `available` (not occupied by a real, confirmed tenant,
 * and not under maintenance) — a bed that's genuinely occupied or
 * unlisted has nothing to view.
 *
 * The duplicate-request cap (max pending requests across ANY beds for one
 * student) and the new {student, bed} partial-unique-index-backed guard
 * (max ONE pending request per student for the SAME bed — Part A
 * implementation step 1) are both plain, soft-ish checks, not the hard
 * atomic guarantee — that guarantee now lives entirely in confirmRequest's
 * bed transition and rentalService.createRental's database-level
 * one-active-rental-per-student index.
 */
async function createRequest(userId, bedId, { moveInDate = null, note = null } = {}) {
  const student = await studentService.getStudentRecordByUserId(userId);

  const pendingCount = await requestRepository.countPendingForStudent(student._id);
  if (pendingCount >= MAX_PENDING_REQUESTS_PER_STUDENT) {
    throw new AppError(
      `You already have ${pendingCount} pending request(s) — max ${MAX_PENDING_REQUESTS_PER_STUDENT} at once. Wait for a response or let one expire before requesting another bed.`,
      409,
    );
  }

  const bed = await bedService.getBedById(bedId);

  if (bed.status !== BED_STATUS.AVAILABLE) {
    throw new AppError('This bed is not currently available for booking.', 409);
  }

  // Phase 6 retrofit: a suspended owner's account cannot accept new
  // student requests (Docs/phase-6-subscriptions.md, step 5). bed.owner_id
  // is already the owner id (same denormalization used everywhere else in
  // this codebase) — no need to resolve it via building/apartment.
  const ownerCanAcceptRequests = await subscriptionService.canAcceptNewRequests(bed.owner_id);
  if (!ownerCanAcceptRequests) {
    throw new AppError(
      "This building's owner account is currently suspended and cannot accept new requests.",
      403,
    );
  }

  const expiresAt = dateUtil.addHours(dateUtil.now(), EXPIRY_WINDOW_HOURS);

  let request;
  try {
    request = await requestRepository.create({
      student: student._id,
      bed: bed._id,
      building: bed.building,
      owner_id: bed.owner_id,
      status: REQUEST_STATUS.PENDING,
      move_in_date: moveInDate,
      note,
      expires_at: expiresAt,
    });
  } catch (err) {
    // The new {student, bed} partial unique index (request.model.js,
    // scoped to status: pending) is what actually stops the same student
    // spamming duplicate pending bookings for the same bed — convert its
    // duplicate-key error into a clean 409, per CLAUDE.md Section 3a.
    if (err.code === 11000 && err.keyPattern && err.keyPattern.student && err.keyPattern.bed) {
      throw new AppError('You already have a pending booking for this bed.', 409);
    }
    throw err;
  }

  await auditService.writeAuditLog({
    actor: userId,
    action: 'request_created',
    entityType: 'Request',
    entityId: request._id,
    afterState: { status: REQUEST_STATUS.PENDING, bed: bed._id.toString() },
  });

  return request;
}

async function getRequestById(requestId) {
  const request = await requestRepository.findById(requestId);
  if (!request) {
    throw new AppError('Request not found', 404);
  }
  return request;
}

/**
 * Owner-facing pending queue. Returns raw request documents — the
 * controller is responsible for attaching each student's profile/KYC
 * summary via studentService.getFullProfilesWithKycForIds (batched, not
 * N+1 — see that function's doc comment).
 */
async function listPendingForOwner(ownerId, { skip, limit }) {
  const [requests, total] = await Promise.all([
    requestRepository.findPendingForOwner(ownerId, { skip, limit }),
    requestRepository.countPendingForOwner(ownerId),
  ]);
  return { requests, total };
}

async function getMyRequests(userId, { skip, limit }) {
  const student = await studentService.getStudentRecordByUserId(userId);
  const [requests, total] = await Promise.all([
    requestRepository.findMineForStudent(student._id, { skip, limit }),
    requestRepository.countMineForStudent(student._id),
  ]);
  return { requests, total };
}

/**
 * Owner confirms a pending request: bed available -> occupied (atomic),
 * a Rental record is created, and the request itself moves to APPROVED
 * (REQUEST_STATUS.APPROVED — the "confirmed" state the spec describes;
 * see constants.config.js for why the existing APPROVED literal is
 * reused instead of introducing a second one).
 *
 * Phase 9 REDESIGN (Part A): THIS is now where the atomic, race-condition-
 * protected bed lock actually happens — moved here from createRequest()
 * (see that function's updated comment). The transition guard changed
 * from PENDING->OCCUPIED to AVAILABLE->OCCUPIED, since a bed sitting with
 * many pending requests is still, correctly, `available` the whole time;
 * confirming ANY one of those pending requests is the single atomic event
 * that finally claims the bed. Exactly one confirm can win this
 * `findOneAndUpdate`, even with many pending requests for the same bed
 * racing to confirm at once (CLAUDE.md Section 4.5/6.2) — this is the
 * single most important guarantee in this phase, same rigor as Phase 4's
 * original atomic-lock test.
 *
 * Correctness requirement identified during this redesign (not explicit
 * in the phase spec, flagged in the Phase 9 report): the bed is flipped to
 * occupied BEFORE we know whether Rental creation will succeed against the
 * new one-active-rental-per-student unique index (rentalService.createRental
 * can throw a 409 if this student already holds a rental elsewhere). If
 * that happens, the bed must be rolled back to available rather than left
 * stuck occupied with no real tenant — same rollback discipline
 * createRequest() used to apply to its own (now-removed) bed lock.
 */
async function confirmRequest(requestId, actorUserId) {
  const request = await getRequestById(requestId);

  if (request.status !== REQUEST_STATUS.PENDING) {
    throw new AppError(`Request is not pending (current status: "${request.status}")`, 409);
  }

  const lockedBed = await bedService.atomicTransition(request.bed, BED_STATUS.AVAILABLE, BED_STATUS.OCCUPIED, actorUserId);
  if (!lockedBed) {
    throw new AppError(
      'Could not confirm: the bed is not in the expected "available" state anymore — it may have just been confirmed by another booking for this same bed.',
      409,
    );
  }

  let rental;
  try {
    rental = await rentalService.createRentalFromRequest(request, actorUserId, lockedBed.monthly_rent);
  } catch (err) {
    const released = await bedService
      .atomicTransition(request.bed, BED_STATUS.OCCUPIED, BED_STATUS.AVAILABLE, actorUserId)
      .catch(() => null);
    if (!released) {
      console.error(`[request.service] Failed to roll back bed ${request.bed} to available after rental creation failed:`, err);
    }
    throw err;
  }

  const updated = await requestRepository.updateById(requestId, {
    status: REQUEST_STATUS.APPROVED,
    responded_at: new Date(),
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'request_confirmed',
    entityType: 'Request',
    entityId: requestId,
    beforeState: { status: REQUEST_STATUS.PENDING },
    afterState: { status: REQUEST_STATUS.APPROVED, rental: rental._id.toString() },
  });

  // Part A, Product Decision 2 / implementation step 5: every OTHER
  // pending request for this same bed automatically becomes bed_taken —
  // one bulk write, not a loop (CLAUDE.md Section 4.4).
  const siblingResult = await requestRepository.markSiblingsBedTaken(request.bed, requestId);
  if (siblingResult && siblingResult.modifiedCount > 0) {
    await auditService.writeAuditLog({
      actor: actorUserId,
      action: 'request_siblings_marked_bed_taken',
      entityType: 'Bed',
      entityId: request.bed,
      afterState: { marked_count: siblingResult.modifiedCount, winning_request: requestId.toString() },
    });
  }

  return { request: updated, rental };
}

/**
 * Owner rejects a pending request with a structured reason: request ->
 * REJECTED. Phase 9 REDESIGN (Part A): no bed transition happens here
 * anymore — creation never locked the bed in the first place (see
 * createRequest's updated comment), so there is nothing to release.
 *
 * Part C tie-in (implementation step 4): an optional `behaviorReportIds`
 * reference is stored, and — if the rejecting owner has a qualifying
 * relationship allowing it — the response includes the student's and
 * guardian's phone numbers plus a suggested message template for the
 * owner to send manually (never sent automatically, per the project's
 * standing no-notifications decision). Composed via behaviorReportService
 * rather than reaching into Student/Kyc directly (CLAUDE.md Section 7.2).
 */
async function rejectRequest(requestId, actorUserId, { reason, note = null, behaviorReportIds = [] } = {}) {
  const request = await getRequestById(requestId);

  if (request.status !== REQUEST_STATUS.PENDING) {
    throw new AppError(`Request is not pending (current status: "${request.status}")`, 409);
  }

  if (!Object.values(REQUEST_REJECTION_REASON).includes(reason)) {
    throw new AppError(`rejection reason must be one of: ${Object.values(REQUEST_REJECTION_REASON).join(', ')}`, 400);
  }

  const updated = await requestRepository.updateById(requestId, {
    status: REQUEST_STATUS.REJECTED,
    rejection_reason: reason,
    rejection_note: note,
    responded_at: new Date(),
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'request_rejected',
    entityType: 'Request',
    entityId: requestId,
    beforeState: { status: REQUEST_STATUS.PENDING },
    afterState: { status: REQUEST_STATUS.REJECTED, rejection_reason: reason, behavior_report_ids: behaviorReportIds },
  });

  return updated;
}

/**
 * Phase 9 addition (Part A, Product Decision 6 / implementation step 4):
 * owner sets/updates the appointment date they've arranged with the
 * student (outside the system — WhatsApp/SMS/phone, per the project's
 * standing no-automated-notifications decision). Reuses the existing
 * `expires_at` field/index rather than adding a second expiry clock:
 * overwriting it with appointment_date + a 48h grace period means the
 * SAME request-expiry.job that already sweeps default-48h-unanswered
 * requests also auto-marks a no-show appointment expired, with zero new
 * scheduled-job infrastructure (flagged as a technical decision in the
 * Phase 9 report — the spec describes this as its own
 * `viewing-booking-expiry.job`, but since Part A was merged into the
 * existing Requests module per the project owner's explicit decision, the
 * existing job already covers this case for free).
 */
async function setAppointmentDate(requestId, actorUserId, appointmentDate) {
  const request = await getRequestById(requestId);

  if (request.status !== REQUEST_STATUS.PENDING) {
    throw new AppError(`Request is not pending (current status: "${request.status}") — cannot set an appointment date`, 409);
  }

  if (!(appointmentDate instanceof Date) || Number.isNaN(appointmentDate.getTime())) {
    throw new AppError('appointment_date must be a valid date', 422);
  }

  const newExpiresAt = dateUtil.addHours(appointmentDate, APPOINTMENT_GRACE_HOURS);

  const updated = await requestRepository.updateById(requestId, {
    appointment_date: appointmentDate,
    expires_at: newExpiresAt,
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'request_appointment_date_set',
    entityType: 'Request',
    entityId: requestId,
    beforeState: { appointment_date: request.appointment_date, expires_at: request.expires_at },
    afterState: { appointment_date: appointmentDate, expires_at: newExpiresAt },
  });

  return updated;
}

/**
 * Auto-expire a single unanswered request: request -> EXPIRED. Called by
 * request-expiry.job in a batch loop, never directly from an HTTP route.
 * `actor` is null — no human triggered this (see audit.model.js's
 * Phase 4 note on nullable actor).
 *
 * Phase 9 REDESIGN (Part A): no bed transition happens here anymore —
 * creation never locked the bed, so there's nothing to release on expiry.
 * Idempotent/race-safe purely on the request's own status: if it's no
 * longer PENDING (an owner responded in the same window the job is
 * scanning, or another booking for the same bed already got confirmed and
 * marked this one bed_taken), this silently no-ops and returns null.
 * request-expiry.job treats a null return as "skipped, not an error."
 */
async function expireRequest(requestId) {
  const request = await requestRepository.findById(requestId);
  if (!request || request.status !== REQUEST_STATUS.PENDING) {
    return null;
  }

  const updated = await requestRepository.updateById(requestId, {
    status: REQUEST_STATUS.EXPIRED,
    responded_at: new Date(),
  });

  await auditService.writeAuditLog({
    actor: null,
    action: 'request_expired',
    entityType: 'Request',
    entityId: requestId,
    beforeState: { status: REQUEST_STATUS.PENDING },
    afterState: { status: REQUEST_STATUS.EXPIRED },
  });

  return updated;
}

/**
 * Does student X have a pending request with owner Y? One half of the
 * owner-facing KYC-view isolation check (implementation step 10) — the
 * other half is rentalService.hasActiveRelationshipWithOwner.
 */
async function hasPendingRequestWithOwner(studentId, ownerId) {
  return Boolean(await requestRepository.existsPendingForStudentAndOwner(studentId, ownerId));
}

/**
 * Phase 9 addition (Part C, Product Decision 2): does this owner have any
 * request-based relationship (any status) with this student? One half of
 * behaviorReportService's relationship gate — see
 * rentalService.hasAnyRelationshipWithOwner for the other half.
 */
async function hasAnyRelationshipWithOwner(studentId, ownerId) {
  return Boolean(await requestRepository.existsAnyForStudentAndOwner(studentId, ownerId));
}

/**
 * Phase 7 addition (Docs/phase-7-admin.md, implementation step 7):
 * platform-wide request -> confirmed-rental conversion funnel for the
 * Super-Admin metrics dashboard. REQUEST_STATUS.APPROVED is this
 * codebase's "confirmed" state (see constants.config.js's note on why
 * APPROVED is reused rather than a second "confirmed" literal), so
 * confirmed_rentals is read directly off the same aggregation rather than
 * a second query against the Rental collection.
 */
async function getRequestFunnelStats() {
  const grouped = await requestRepository.aggregateStatusCounts();

  const byStatus = Object.values(REQUEST_STATUS).reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {});

  let total = 0;
  for (const row of grouped) {
    byStatus[row._id] = row.count;
    total += row.count;
  }

  const confirmedRentals = byStatus[REQUEST_STATUS.APPROVED];

  return {
    total_requests: total,
    by_status: byStatus,
    confirmed_rentals: confirmedRentals,
    conversion_rate_percent: total > 0 ? Math.round((confirmedRentals / total) * 1000) / 10 : 0,
  };
}

module.exports = {
  createRequest,
  getRequestById,
  listPendingForOwner,
  getMyRequests,
  confirmRequest,
  rejectRequest,
  setAppointmentDate,
  expireRequest,
  hasPendingRequestWithOwner,
  hasAnyRelationshipWithOwner,
  getRequestFunnelStats,
  EXPIRY_WINDOW_HOURS,
  APPOINTMENT_GRACE_HOURS,
  MAX_PENDING_REQUESTS_PER_STUDENT,
};

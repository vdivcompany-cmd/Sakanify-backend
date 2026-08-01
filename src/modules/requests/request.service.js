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
const dateUtil = require('../../shared/utils/date.util');
const { BED_STATUS, REQUEST_STATUS, REQUEST_REJECTION_REASON } = require('../../config/constants.config');
const { AppError } = require('../../middleware/error-handler.middleware');

const EXPIRY_WINDOW_HOURS = 48;
// Recommended cap from the phase spec — a soft business rule (prevents
// one student from tying up the whole owner-review queue), not a
// correctness guarantee. Enforced with a plain count-then-create check;
// see the comment in createRequest() for why that's an acceptable,
// deliberate distinction from the atomic bed-locking guarantee below.
const MAX_PENDING_REQUESTS_PER_STUDENT = 2;

/**
 * Create a request for a bed, atomically locking the bed
 * (available -> pending) as part of the same operation.
 *
 * THE double-booking guarantee lives entirely in the single
 * `bedService.atomicTransition` call below: MongoDB's `findOneAndUpdate`
 * with a status-match filter is atomic at the document level, so if two
 * students hit this function for the same bed at the same instant, only
 * one of them gets a non-null result back — the other gets `null` and
 * this function throws a 409. There is no read-then-write gap for the
 * bed's status: the read (does status == available?) and the write
 * (set status = pending) happen as one indivisible operation on the
 * database side.
 *
 * The duplicate-request cap above it (step 1-2) is NOT part of that
 * guarantee — it's a plain count query followed by a separate insert,
 * which has a real (if narrow and low-stakes) TOCTOU gap: two
 * simultaneous requests from the *same* student could both pass the
 * count check and end up with 3 pending requests instead of 2. That's an
 * acceptable soft-limit overshoot (worst case, one extra pending request
 * for a single student), fundamentally different from double-booking a
 * bed between two *different* students, which would be a real business
 * and trust failure. Only the bed transition gets the hard guarantee.
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

  const lockedBed = await bedService.atomicTransition(bed._id, BED_STATUS.AVAILABLE, BED_STATUS.PENDING, userId);
  if (!lockedBed) {
    throw new AppError('This bed is no longer available — someone else may have just requested it.', 409);
  }

  try {
    const expiresAt = dateUtil.addHours(dateUtil.now(), EXPIRY_WINDOW_HOURS);

    const request = await requestRepository.create({
      student: student._id,
      bed: bed._id,
      building: bed.building,
      owner_id: bed.owner_id,
      status: REQUEST_STATUS.PENDING,
      move_in_date: moveInDate,
      note,
      expires_at: expiresAt,
    });

    await auditService.writeAuditLog({
      actor: userId,
      action: 'request_created',
      entityType: 'Request',
      entityId: request._id,
      afterState: { status: REQUEST_STATUS.PENDING, bed: bed._id.toString() },
    });

    return request;
  } catch (err) {
    // The bed is already locked (pending) at this point. If creating the
    // request document itself fails for any reason, release the lock
    // rather than leaving a bed permanently stuck in "pending" with no
    // request behind it. Best-effort: if this also fails, the bed is
    // left pending and needs manual/owner intervention — logged, not
    // silently swallowed.
    const released = await bedService.atomicTransition(bed._id, BED_STATUS.PENDING, BED_STATUS.AVAILABLE, userId).catch(() => null);
    if (!released) {
      console.error(`[request.service] Failed to roll back bed ${bed._id} to available after request creation failed:`, err);
    }
    throw err;
  }
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
 * Owner confirms a pending request: bed pending -> occupied (atomic),
 * a Rental record is created, and the request itself moves to APPROVED
 * (REQUEST_STATUS.APPROVED — the "confirmed" state the spec describes;
 * see constants.config.js for why the existing APPROVED literal is
 * reused instead of introducing a second one).
 */
async function confirmRequest(requestId, actorUserId) {
  const request = await getRequestById(requestId);

  if (request.status !== REQUEST_STATUS.PENDING) {
    throw new AppError(`Request is not pending (current status: "${request.status}")`, 409);
  }

  const lockedBed = await bedService.atomicTransition(request.bed, BED_STATUS.PENDING, BED_STATUS.OCCUPIED, actorUserId);
  if (!lockedBed) {
    throw new AppError(
      'Could not confirm: the bed is not in the expected "pending" state anymore. Refresh and check its current status.',
      409,
    );
  }

  const rental = await rentalService.createRentalFromRequest(request, actorUserId);

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

  return { request: updated, rental };
}

/**
 * Owner rejects a pending request with a structured reason: bed
 * pending -> available (atomic), request -> REJECTED.
 */
async function rejectRequest(requestId, actorUserId, { reason, note = null } = {}) {
  const request = await getRequestById(requestId);

  if (request.status !== REQUEST_STATUS.PENDING) {
    throw new AppError(`Request is not pending (current status: "${request.status}")`, 409);
  }

  if (!Object.values(REQUEST_REJECTION_REASON).includes(reason)) {
    throw new AppError(`rejection reason must be one of: ${Object.values(REQUEST_REJECTION_REASON).join(', ')}`, 400);
  }

  const releasedBed = await bedService.atomicTransition(request.bed, BED_STATUS.PENDING, BED_STATUS.AVAILABLE, actorUserId);
  if (!releasedBed) {
    throw new AppError('Could not reject: the bed is not in the expected "pending" state anymore.', 409);
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
    afterState: { status: REQUEST_STATUS.REJECTED, rejection_reason: reason },
  });

  return updated;
}

/**
 * Auto-expire a single unanswered request: bed pending -> available,
 * request -> EXPIRED. Called by request-expiry.job in a batch loop, never
 * directly from an HTTP route. `actor` is null — no human triggered this
 * (see audit.model.js's Phase 4 note on nullable actor).
 *
 * Idempotent/race-safe: if the request is no longer PENDING (an owner
 * responded in the same window the job is scanning), or the bed is no
 * longer in the expected "pending" state (same race, seen from the bed
 * side), this silently no-ops and returns null instead of corrupting a
 * request that just got a real answer. request-expiry.job treats a null
 * return as "skipped, not an error."
 */
async function expireRequest(requestId) {
  const request = await requestRepository.findById(requestId);
  if (!request || request.status !== REQUEST_STATUS.PENDING) {
    return null;
  }

  const releasedBed = await bedService.atomicTransition(request.bed, BED_STATUS.PENDING, BED_STATUS.AVAILABLE, null);
  if (!releasedBed) {
    // Bed already moved on (most likely: an owner confirmed/rejected it
    // in the same instant this job read the request as still pending).
    // Don't touch the request's status here — whichever action actually
    // won the race already updated it.
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

module.exports = {
  createRequest,
  getRequestById,
  listPendingForOwner,
  getMyRequests,
  confirmRequest,
  rejectRequest,
  expireRequest,
  hasPendingRequestWithOwner,
  EXPIRY_WINDOW_HOURS,
  MAX_PENDING_REQUESTS_PER_STUDENT,
};

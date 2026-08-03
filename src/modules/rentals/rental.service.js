/**
 * rental.service.js
 *
 * Business logic for rental creation (triggered internally by
 * request.service.confirmRequest — there is no public "create rental"
 * endpoint, per the phase spec's folder comment: "Confirm rental
 * (internal, triggered by request confirmation)") and the move-out flow.
 *
 * Vacating is tracked entirely on the Rental record — the bed stays
 * BED_STATUS.OCCUPIED for the whole `active` and `vacating` window; only
 * finalizeMoveOut() ever transitions the bed back to available. See
 * Docs/phase-4-booking-engine.md's explicit correction on this point.
 */

const rentalRepository = require('./rental.repository');
const bedService = require('../beds/bed.service');
const auditService = require('../audit/audit.service');
// Payment.service only ever reads Rental data through rental.repository
// (never rental.service), so this require has no load-order cycle — see
// createRentalFromRequest below for why this module needs it (Phase 5
// step 2: a confirmed rental always generates its first Payment record).
const paymentService = require('../payments/payment.service');
const { BED_STATUS, RENTAL_STATUS } = require('../../config/constants.config');
const { AppError } = require('../../middleware/error-handler.middleware');

/**
 * THE shared guard used by EVERY code path that creates a Rental
 * (Docs/phase-9-booking-behavior-bulk-registration.md, Part A: "Build one
 * function ... call it from every single code path that creates a
 * Rental"): the viewing-booking/request confirm action
 * (createRentalFromRequest below), Part D's assign-to-bed action, and
 * Part D's manual-entry-direct-to-rental action.
 *
 * Does not touch bed status at all — that guarantee lives entirely in
 * whichever caller already atomically transitioned the bed to occupied
 * before calling this (request.service.confirmRequest,
 * bulk-registration.service.assignToBed/manualEntry), per CLAUDE.md
 * Section 7.2 (this stays focused on rental creation + the one-active-
 * rental-per-student database guarantee only).
 *
 * The one-active-rental-per-student invariant (Part A, Product Decision 7)
 * is enforced by rental.model.js's partial unique index on
 * {student, holds_platform_slot: true} — NOT by a read-then-write
 * application check, which would have a real race-condition window under
 * concurrent confirmations. A duplicate-key error from that index is
 * caught here and converted into a single, clean, clearly-worded 409 via
 * the Section 3a error classifier, rather than leaking a raw MongoDB
 * error — this is the ONE place that translation happens, so every caller
 * gets the same message for free.
 *
 * `requestId` is null for Part D's manual-entry/assign-to-bed paths (see
 * rental.model.js's `request` field comment on why it's now optional).
 */
async function createRental({
  studentId, bedId, buildingId, ownerId, requestId = null, monthlyRent, moveInDate = null, actorUserId,
}) {
  let rental;
  try {
    rental = await rentalRepository.create({
      student: studentId,
      bed: bedId,
      building: buildingId,
      owner_id: ownerId,
      request: requestId,
      status: RENTAL_STATUS.ACTIVE,
      confirmed_date: new Date(),
      move_in_date: moveInDate,
      monthly_rent: monthlyRent || 0,
      holds_platform_slot: true,
    });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern && err.keyPattern.student) {
      throw new AppError(
        'This student already has an active rental — a student cannot hold two active rentals at once.',
        409,
      );
    }
    throw err;
  }

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'rental_created',
    entityType: 'Rental',
    entityId: rental._id,
    afterState: { status: RENTAL_STATUS.ACTIVE, bed: bedId.toString() },
  });

  await paymentService.createInitialPaymentForRental(rental, actorUserId);

  return rental;
}

/**
 * Thin wrapper over createRental() for the request/viewing-booking confirm
 * path — kept as its own named function since it's the highest-traffic
 * caller and request.service.confirmRequest already has a `request`
 * document in hand. Called immediately after the bed has already been
 * atomically transitioned available -> occupied (see request.service's
 * confirmRequest, Phase 9's Part A redesign).
 *
 * `monthlyRent` (Phase 5 addition) is the bed's monthly_rent at this exact
 * moment, passed in by the caller from the bed it just transitioned —
 * snapshotted onto rental.monthly_rent so it never drifts if the bed's
 * listing price changes later (see rental.model.js).
 */
async function createRentalFromRequest(request, actorUserId, monthlyRent) {
  return createRental({
    studentId: request.student,
    bedId: request.bed,
    buildingId: request.building,
    ownerId: request.owner_id,
    requestId: request._id,
    monthlyRent,
    moveInDate: request.move_in_date || null,
    actorUserId,
  });
}

async function getRentalById(rentalId) {
  const rental = await rentalRepository.findById(rentalId);
  if (!rental) {
    throw new AppError('Rental not found', 404);
  }
  return rental;
}

async function listRentalsForOwner(ownerId, { skip, limit }) {
  const [rentals, total] = await Promise.all([
    rentalRepository.findByOwner(ownerId, { skip, limit }),
    rentalRepository.countByOwner(ownerId),
  ]);
  return { rentals, total };
}

/**
 * Student gave move-out notice. The bed is deliberately NOT touched here
 * — it stays `occupied` (still actively lived in) until finalizeMoveOut.
 */
async function markVacating(rentalId, actorUserId) {
  const rental = await getRentalById(rentalId);

  if (rental.status !== RENTAL_STATUS.ACTIVE) {
    throw new AppError(`Rental is not active (current status: "${rental.status}") — cannot mark as vacating`, 409);
  }

  const updated = await rentalRepository.updateById(rentalId, {
    status: RENTAL_STATUS.VACATING,
    vacating_at: new Date(),
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'rental_vacating',
    entityType: 'Rental',
    entityId: rentalId,
    beforeState: { status: RENTAL_STATUS.ACTIVE },
    afterState: { status: RENTAL_STATUS.VACATING },
  });

  return updated;
}

/**
 * Finalize the move-out: bed occupied -> available (atomic), rental ->
 * closed. Allowed from either ACTIVE or VACATING — an owner doesn't have
 * to go through the "vacating" notice step first if a student already
 * left; VACATING just gives advance notice for the common case
 * (technical decision, not explicit in the phase spec — flagged in the
 * Phase 4 report).
 */
async function finalizeMoveOut(rentalId, actorUserId) {
  const rental = await getRentalById(rentalId);

  if (![RENTAL_STATUS.ACTIVE, RENTAL_STATUS.VACATING].includes(rental.status)) {
    throw new AppError(`Rental is already "${rental.status}" — nothing to finalize`, 409);
  }

  const releasedBed = await bedService.atomicTransition(rental.bed, BED_STATUS.OCCUPIED, BED_STATUS.AVAILABLE, actorUserId);
  if (!releasedBed) {
    throw new AppError('Could not finalize move-out: the bed is not in the expected "occupied" state anymore.', 409);
  }

  const updated = await rentalRepository.updateById(rentalId, {
    status: RENTAL_STATUS.CLOSED,
    closed_at: new Date(),
    // Phase 9: release the one-active-rental-per-student database slot
    // (see rental.model.js's holds_platform_slot comment) — from this
    // point on the student is free to be assigned a new bed elsewhere.
    holds_platform_slot: false,
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'rental_closed',
    entityType: 'Rental',
    entityId: rentalId,
    beforeState: { status: rental.status },
    afterState: { status: RENTAL_STATUS.CLOSED },
  });

  return updated;
}

/**
 * Does student X have a live (active/vacating) rental with owner Y? The
 * other half of the owner-facing KYC-view isolation check (Phase 4 step
 * 10) — see also request.service.hasPendingRequestWithOwner.
 */
async function hasActiveRelationshipWithOwner(studentId, ownerId) {
  return Boolean(await rentalRepository.existsActiveOrVacatingForStudentAndOwner(studentId, ownerId));
}

/**
 * Phase 9 addition (Part C, Product Decision 2): does this owner have any
 * rental-based relationship (any status, including closed) with this
 * student? The other half of behaviorReportService's relationship gate —
 * see requestService.hasAnyRelationshipWithOwner for the first half.
 */
async function hasAnyRelationshipWithOwner(studentId, ownerId) {
  return Boolean(await rentalRepository.existsAnyForStudentAndOwner(studentId, ownerId));
}

/**
 * Does this specific bed have a live rental attached? The new
 * authoritative signal for the Phase 3 deletion-restriction retrofit
 * (step 11) — see bed.service.deleteBed.
 */
async function bedHasActiveRental(bedId) {
  return Boolean(await rentalRepository.existsActiveOrVacatingForBed(bedId));
}

/**
 * Same check across many beds at once (building/apartment deletion) —
 * one query regardless of how many beds are involved.
 */
async function anyBedHasActiveRental(bedIds) {
  if (!bedIds || bedIds.length === 0) return false;
  return Boolean(await rentalRepository.existsActiveOrVacatingForBeds(bedIds));
}

/**
 * Phase 5 addition — the rollover job's source of "which rentals should
 * still be generating monthly payments" (see rental.repository's doc
 * comment on findActiveOrVacatingBatch).
 */
async function listActiveOrVacatingForRollover({ skip, limit }) {
  return rentalRepository.findActiveOrVacatingBatch({ skip, limit });
}

async function countActiveOrVacatingForRollover() {
  return rentalRepository.countActiveOrVacating();
}

/**
 * Phase 6 addition (Docs/phase-6-subscriptions.md, "Optional Utility Bill
 * Splitting", step 9): the apartment's actual currently-active rentals
 * (active or vacating — same "still living there, still paying rent"
 * definition used everywhere else in this codebase, e.g.
 * anyBedHasActiveRental above), given the apartment's bed ids.
 * utility-bill.service calls this instead of touching the Rentals
 * collection directly, per CLAUDE.md Section 7.2.
 */
async function listActiveOrVacatingRentalsForBeds(bedIds) {
  if (!bedIds || bedIds.length === 0) return [];
  return rentalRepository.findActiveOrVacatingForBeds(bedIds);
}

module.exports = {
  createRental,
  createRentalFromRequest,
  getRentalById,
  listRentalsForOwner,
  markVacating,
  finalizeMoveOut,
  hasActiveRelationshipWithOwner,
  hasAnyRelationshipWithOwner,
  bedHasActiveRental,
  anyBedHasActiveRental,
  listActiveOrVacatingRentalsForBeds,
  listActiveOrVacatingForRollover,
  countActiveOrVacatingForRollover,
};

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
 * Called by request.service.confirmRequest, immediately after the bed has
 * already been atomically transitioned pending -> occupied. This function
 * does not touch bed status at all — that guarantee lives entirely in
 * request.service/bed.service, per CLAUDE.md Section 7.2 (this stays
 * focused on rental creation only).
 *
 * `monthlyRent` (Phase 5 addition) is the bed's monthly_rent at this exact
 * moment, passed in by request.service.confirmRequest from the bed it just
 * transitioned — snapshotted onto rental.monthly_rent so it never drifts if
 * the bed's listing price changes later (see rental.model.js).
 *
 * After the rental itself is created, this also generates the rental's
 * first Payment record (Docs/phase-5-cash-payment.md step 2) via
 * payment.service, so a confirmed rental always has its first billing
 * period's payment waiting from the moment it goes active — never through
 * direct DB access into the Payments collection (CLAUDE.md Section 7.2).
 */
async function createRentalFromRequest(request, actorUserId, monthlyRent) {
  const rental = await rentalRepository.create({
    student: request.student,
    bed: request.bed,
    building: request.building,
    owner_id: request.owner_id,
    request: request._id,
    status: RENTAL_STATUS.ACTIVE,
    confirmed_date: new Date(),
    move_in_date: request.move_in_date || null,
    monthly_rent: monthlyRent || 0,
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'rental_created',
    entityType: 'Rental',
    entityId: rental._id,
    afterState: { status: RENTAL_STATUS.ACTIVE, bed: request.bed.toString() },
  });

  await paymentService.createInitialPaymentForRental(rental, actorUserId);

  return rental;
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

module.exports = {
  createRentalFromRequest,
  getRentalById,
  listRentalsForOwner,
  markVacating,
  finalizeMoveOut,
  hasActiveRelationshipWithOwner,
  bedHasActiveRental,
  anyBedHasActiveRental,
  listActiveOrVacatingForRollover,
  countActiveOrVacatingForRollover,
};

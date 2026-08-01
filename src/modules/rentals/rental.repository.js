/**
 * rental.repository.js
 *
 * Data-access layer for the Rental collection. Controllers/services never
 * touch the Rental mongoose model directly — everything goes through
 * here, per CLAUDE.md Section 7.2.
 */

const Rental = require('./rental.model');
const { RENTAL_STATUS } = require('../../config/constants.config');

function create(data) {
  return Rental.create(data);
}

function findById(rentalId) {
  return Rental.findById(rentalId);
}

function findByOwner(ownerId, { skip = 0, limit = 20 } = {}) {
  return Rental.find({ owner_id: ownerId }).sort({ created_at: -1 }).skip(skip).limit(limit);
}

function countByOwner(ownerId) {
  return Rental.countDocuments({ owner_id: ownerId });
}

function updateById(rentalId, updates) {
  return Rental.findByIdAndUpdate(rentalId, { $set: updates }, { new: true, runValidators: true });
}

/**
 * Does an active or vacating (i.e. not yet closed) rental exist linking
 * this student to this owner? Backs both: (a) the owner-facing KYC-view
 * isolation check (Phase 4 step 10), and (b) the Phase 3 deletion
 * retrofit (step 11) — a building/apartment/bed with a live rental
 * attached must not be deletable.
 */
function existsActiveOrVacatingForStudentAndOwner(studentId, ownerId) {
  return Rental.exists({
    student: studentId,
    owner_id: ownerId,
    status: { $in: [RENTAL_STATUS.ACTIVE, RENTAL_STATUS.VACATING] },
  });
}

/**
 * Does an active or vacating rental exist for this specific bed? Backs
 * the Phase 3 deletion retrofit's bed-level check — the authoritative
 * signal for "can this bed be deleted" is now this, not just bed.status
 * (kept as a secondary safety layer — see bed.service.deleteBed).
 */
function existsActiveOrVacatingForBed(bedId) {
  return Rental.exists({ bed: bedId, status: { $in: [RENTAL_STATUS.ACTIVE, RENTAL_STATUS.VACATING] } });
}

/**
 * Same check, scoped to every bed under a set of apartment ids (building
 * deletion) or a single apartment (apartment deletion) — one query
 * regardless of how many beds are involved (CLAUDE.md Section 4.4).
 */
function existsActiveOrVacatingForBeds(bedIds) {
  return Rental.exists({ bed: { $in: bedIds }, status: { $in: [RENTAL_STATUS.ACTIVE, RENTAL_STATUS.VACATING] } });
}

module.exports = {
  create,
  findById,
  findByOwner,
  countByOwner,
  updateById,
  existsActiveOrVacatingForStudentAndOwner,
  existsActiveOrVacatingForBed,
  existsActiveOrVacatingForBeds,
};

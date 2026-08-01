/**
 * payment.repository.js
 *
 * Data-access layer for the Payment collection. Controllers/services never
 * touch the Payment mongoose model directly — everything goes through
 * here, per CLAUDE.md Section 7.2 (same pattern as every other module).
 */

const mongoose = require('mongoose');
const Payment = require('./payment.model');
const { PAYMENT_STATUS } = require('../../config/constants.config');

function create(data) {
  return Payment.create(data);
}

function findById(paymentId) {
  return Payment.findById(paymentId);
}

function findByRentalAndPeriod(rentalId, billingPeriod) {
  return Payment.findOne({ rental: rentalId, billing_period: billingPeriod });
}

/**
 * Most recent payment record for a rental (by billing_period), used by
 * payment-rollover.job to decide whether the next period is due to be
 * generated yet.
 */
function findLatestForRental(rentalId) {
  return Payment.findOne({ rental: rentalId }).sort({ billing_period: -1 });
}

/**
 * Owner-facing, paginated, filterable list — every list endpoint supports
 * pagination from day one (CLAUDE.md Section 4.2). `filters` may include
 * student, building, rental, status; owner_id is always applied since this
 * is the mandatory ownership-scoping filter (CLAUDE.md Section 3.3).
 */
function buildFilter(ownerId, filters = {}) {
  const query = { owner_id: ownerId };
  if (filters.student) query.student = filters.student;
  if (filters.building) query.building = filters.building;
  if (filters.rental) query.rental = filters.rental;
  if (filters.status) query.status = filters.status;
  return query;
}

function findByOwner(ownerId, filters = {}, { skip = 0, limit = 20 } = {}) {
  return Payment.find(buildFilter(ownerId, filters))
    .sort({ due_date: -1, created_at: -1 })
    .skip(skip)
    .limit(limit);
}

function countByOwner(ownerId, filters = {}) {
  return Payment.countDocuments(buildFilter(ownerId, filters));
}

function findOverdueViewForOwner(ownerId, { skip = 0, limit = 20 } = {}) {
  const query = { owner_id: ownerId, status: PAYMENT_STATUS.OVERDUE };
  return Payment.find(query).sort({ due_date: 1 }).skip(skip).limit(limit);
}

function countOverdueViewForOwner(ownerId) {
  return Payment.countDocuments({ owner_id: ownerId, status: PAYMENT_STATUS.OVERDUE });
}

function updateById(paymentId, updates) {
  return Payment.findByIdAndUpdate(paymentId, { $set: updates }, { new: true, runValidators: true });
}

/**
 * Atomically accumulates a cash confirmation onto amount_paid and derives
 * the resulting status (PAID once the running total meets amount_due,
 * PARTIAL otherwise) in a single MongoDB pipeline update — one atomic
 * operation per document, not a read-then-write. Required per CLAUDE.md
 * Section 6.2 ("payment status updates" is explicitly named alongside bed
 * locking as concurrency-sensitive logic): two near-simultaneous
 * confirmations for the same payment (e.g. the owner double-taps
 * "confirm", or two staff members record the same cash drop) must not
 * lose one of the increments or leave status stale relative to the true
 * accumulated amount. The `$set` stages run in order within one atomic
 * operation, so the status stage always evaluates against the
 * already-incremented amount_paid from the previous stage — see
 * payment.service.confirmPayment for the caller-side validation this
 * wraps.
 *
 * The `status: { $ne: PAID }` filter doubles as the "already fully paid"
 * guard: if the payment was already PAID (including by a concurrent call
 * that just committed), this returns null instead of double-counting a
 * confirmation against a settled period.
 */
function atomicConfirm(paymentId, amount, actorUserId) {
  // Pipeline-style updates bypass Mongoose's normal cast/validate path, so
  // confirmed_by is cast to a real ObjectId explicitly here rather than
  // relying on schema casting (which does still apply when the resulting
  // document is later hydrated/read, but this avoids ever writing a raw
  // string into an ObjectId-typed field in the first place).
  const confirmedBy = actorUserId ? new mongoose.Types.ObjectId(actorUserId) : null;

  return Payment.findOneAndUpdate(
    { _id: paymentId, status: { $ne: PAYMENT_STATUS.PAID } },
    [
      { $set: { amount_paid: { $add: ['$amount_paid', amount] } } },
      {
        $set: {
          status: {
            $cond: [{ $gte: ['$amount_paid', '$amount_due'] }, PAYMENT_STATUS.PAID, PAYMENT_STATUS.PARTIAL],
          },
        },
      },
      { $set: { confirmed_by: confirmedBy, confirmed_at: '$$NOW' } },
    ],
    { new: true },
  );
}

/**
 * Batch of payments still pending/partial whose due_date + grace period
 * has passed — used by overdue-check.job. Never loads the whole
 * collection (CLAUDE.md Section 4.6); the job re-queries fresh per batch
 * since flagging a payment overdue removes it from this result set
 * (same pattern as request.repository.findExpiredPending).
 */
function findOverdueCandidates(cutoffDate, batchSize) {
  return Payment.find({
    status: { $in: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PARTIAL] },
    due_date: { $lt: cutoffDate },
  })
    .limit(batchSize)
    .sort({ _id: 1 });
}

module.exports = {
  create,
  findById,
  findByRentalAndPeriod,
  findLatestForRental,
  findByOwner,
  countByOwner,
  findOverdueViewForOwner,
  countOverdueViewForOwner,
  updateById,
  atomicConfirm,
  findOverdueCandidates,
};

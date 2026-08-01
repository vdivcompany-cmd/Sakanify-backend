/**
 * payment.service.js
 *
 * Recurring monthly cash-payment business logic (Docs/phase-5-cash-payment.md).
 * Confirmed flow: student pays the owner in person -> owner manually
 * confirms cash receipt in the dashboard. There is no gateway and no
 * separate "student marks as paid" step — confirmation is the only write
 * path into PAID/PARTIAL.
 *
 * Deliberately does NOT require rental.service (only rental.repository,
 * indirectly, via functions rental.service already exposes and calls INTO
 * this module) — rental.service requires payment.service to generate a
 * rental's first Payment record on confirmation (see
 * rental.service.createRentalFromRequest), so a reverse require here would
 * create a load-order cycle. payment-rollover.job (a separate file) is
 * where rental data actually gets read from, via rental.service, since
 * that file has no back-edge into rental.service itself. Never touches
 * the Rental or Audit collections directly — always through their own
 * services/repositories, per CLAUDE.md Section 7.2.
 */

const paymentRepository = require('./payment.repository');
const auditService = require('../audit/audit.service');
const { PAYMENT_STATUS } = require('../../config/constants.config');
const { AppError } = require('../../middleware/error-handler.middleware');

// Business default, not specified explicitly in the phase spec — how many
// days past the end of a billing month a payment is still considered
// "on time" before overdue-check.job flags it. Flagged as a technical
// decision in the Phase 5 report.
const GRACE_PERIOD_DAYS = 5;

// --- Billing period helpers ---------------------------------------------

/** "YYYY-MM" for the given date, in UTC (matches how Mongo stores Dates). */
function billingPeriodOf(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** Last instant of the billing_period's month — the rent due date. */
function periodDueDate(billingPeriod) {
  const [year, month] = billingPeriod.split('-').map(Number);
  // Day 0 of "next month" is the last day of "this month" in JS Date.
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
}

/** The next calendar month's "YYYY-MM", used by rollover. */
function nextBillingPeriod(billingPeriod) {
  const [year, month] = billingPeriod.split('-').map(Number);
  const next = new Date(Date.UTC(year, month, 1)); // month is already 1-indexed input -> day 1 of next month
  return billingPeriodOf(next);
}

// --- Core operations -------------------------------------------------

/**
 * Phase spec step 2: generate a rental's first Payment record the moment
 * it's confirmed. Called by rental.service.createRentalFromRequest, never
 * from an HTTP route directly. Idempotent against the unique
 * {rental, billing_period} index — if this is somehow called twice for
 * the same rental+period (shouldn't happen in the normal flow), the
 * duplicate-key error surfaces through normalizeError as a 409 rather than
 * silently creating a second record.
 */
async function createInitialPaymentForRental(rental, actorUserId) {
  const billingPeriod = billingPeriodOf(rental.confirmed_date || new Date());

  const payment = await paymentRepository.create({
    rental: rental._id,
    student: rental.student,
    bed: rental.bed,
    building: rental.building,
    owner_id: rental.owner_id,
    billing_period: billingPeriod,
    status: PAYMENT_STATUS.PENDING,
    amount_due: rental.monthly_rent,
    amount_paid: 0,
    due_date: periodDueDate(billingPeriod),
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'payment_created',
    entityType: 'Payment',
    entityId: payment._id,
    afterState: { status: PAYMENT_STATUS.PENDING, billing_period: billingPeriod, amount_due: rental.monthly_rent },
  });

  return payment;
}

/**
 * Called by payment-rollover.job once a rental's latest payment is
 * settled (PAID) — generates the next billing period's pending record.
 * Guards against duplicates via the unique index too, but checks first so
 * a normal sweep doesn't spam duplicate-key errors on every run.
 */
async function generateNextPeriodPayment(rental, actorUserId = null) {
  const latest = await paymentRepository.findLatestForRental(rental._id);
  if (!latest) {
    // Shouldn't happen (every active rental gets an initial payment at
    // confirmation), but don't crash a batch sweep over it — treat as
    // "nothing to roll from yet."
    return null;
  }

  if (latest.status !== PAYMENT_STATUS.PAID) {
    // Only settled periods roll forward (phase spec step 5: "once a
    // period's payment is settled (paid) ... auto-generate the next
    // period's pending record"). An unpaid/partial/overdue period stays
    // the most recent one — the owner sees it in the overdue view instead
    // of a second period silently stacking on top of an unresolved one.
    return null;
  }

  const nextPeriod = nextBillingPeriod(latest.billing_period);
  const existing = await paymentRepository.findByRentalAndPeriod(rental._id, nextPeriod);
  if (existing) {
    return null; // already rolled over (e.g. a previous sweep already handled it)
  }

  const payment = await paymentRepository.create({
    rental: rental._id,
    student: rental.student,
    bed: rental.bed,
    building: rental.building,
    owner_id: rental.owner_id,
    billing_period: nextPeriod,
    status: PAYMENT_STATUS.PENDING,
    amount_due: rental.monthly_rent,
    amount_paid: 0,
    due_date: periodDueDate(nextPeriod),
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'payment_rolled_over',
    entityType: 'Payment',
    entityId: payment._id,
    beforeState: { previous_period_payment: latest._id.toString() },
    afterState: { status: PAYMENT_STATUS.PENDING, billing_period: nextPeriod, amount_due: rental.monthly_rent },
  });

  return payment;
}

async function getPaymentById(paymentId) {
  const payment = await paymentRepository.findById(paymentId);
  if (!payment) {
    throw new AppError('Payment not found', 404);
  }
  return payment;
}

async function listPaymentsForOwner(ownerId, filters, { skip, limit }) {
  const [payments, total] = await Promise.all([
    paymentRepository.findByOwner(ownerId, filters, { skip, limit }),
    paymentRepository.countByOwner(ownerId, filters),
  ]);
  return { payments, total };
}

async function listOverdueForOwner(ownerId, { skip, limit }) {
  const [payments, total] = await Promise.all([
    paymentRepository.findOverdueViewForOwner(ownerId, { skip, limit }),
    paymentRepository.countOverdueViewForOwner(ownerId),
  ]);
  return { payments, total };
}

/**
 * Owner confirms cash received in person (phase spec step 3/4). This is
 * the ONLY write path into PAID/PARTIAL — there is no separate
 * "student marks as paid" step in the finalized recurring-billing model.
 *
 * `amountPaid` accumulates onto any amount already recorded (supports an
 * owner confirming a partial cash payment now and the remainder later in
 * the same period, per step 4) rather than overwriting it. Status is PAID
 * once the running total meets or exceeds amount_due, otherwise PARTIAL.
 * Confirming a payment that's already PAID is rejected — there's nothing
 * left to collect for a settled period.
 *
 * The actual accumulate-and-derive-status write is a single atomic
 * MongoDB pipeline update (payment.repository.atomicConfirm), not a
 * read-then-write — see that function's doc comment for why a plain
 * read/compute/save here would be a real lost-update race under
 * concurrent confirmations (CLAUDE.md Section 6.2). The `payment` fetched
 * below is only used to compute the "remaining balance" default and to
 * give a clean 404/409 error before attempting the write; the atomic
 * update re-checks the not-already-PAID condition itself as the source of
 * truth.
 */
async function confirmPayment(paymentId, actorUserId, amountPaid) {
  const payment = await getPaymentById(paymentId);

  if (payment.status === PAYMENT_STATUS.PAID) {
    throw new AppError('This payment is already fully paid — nothing left to confirm.', 409);
  }

  // Defaults to settling the full remaining balance in one confirmation —
  // the common case (owner collects the whole month's rent in one visit).
  // Based on a point-in-time read, so under true concurrency two omitted-
  // amount confirmations could each independently compute the same
  // "remaining" figure; callers that need exact-amount accumulation under
  // concurrency (e.g. two staff recording partial cash drops) should pass
  // amount_paid explicitly rather than relying on this default.
  const remaining = payment.amount_due - payment.amount_paid;
  const amount = amountPaid === undefined || amountPaid === null ? remaining : amountPaid;

  if (typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0) {
    throw new AppError('amount_paid must be a positive number', 422);
  }

  const updated = await paymentRepository.atomicConfirm(paymentId, amount, actorUserId);
  if (!updated) {
    // Lost the race: another confirmation already settled this payment to
    // PAID between our read above and this write.
    throw new AppError('This payment is already fully paid — nothing left to confirm.', 409);
  }

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'payment_confirmed',
    entityType: 'Payment',
    entityId: paymentId,
    beforeState: { status: payment.status, amount_paid: payment.amount_paid },
    afterState: { status: updated.status, amount_paid: updated.amount_paid },
  });

  return updated;
}

/**
 * Flags a single pending/partial payment overdue. Called by
 * overdue-check.job in a batch loop, never directly from an HTTP route.
 * `actor` is null — automated, same pattern as request-expiry.job
 * (audit.model.js's nullable-actor convention).
 */
async function flagOverdue(payment) {
  const updated = await paymentRepository.updateById(payment._id, {
    status: PAYMENT_STATUS.OVERDUE,
  });

  await auditService.writeAuditLog({
    actor: null,
    action: 'payment_overdue',
    entityType: 'Payment',
    entityId: payment._id,
    beforeState: { status: payment.status },
    afterState: { status: PAYMENT_STATUS.OVERDUE },
  });

  return updated;
}

module.exports = {
  createInitialPaymentForRental,
  generateNextPeriodPayment,
  getPaymentById,
  listPaymentsForOwner,
  listOverdueForOwner,
  confirmPayment,
  flagOverdue,
  billingPeriodOf,
  periodDueDate,
  nextBillingPeriod,
  GRACE_PERIOD_DAYS,
};

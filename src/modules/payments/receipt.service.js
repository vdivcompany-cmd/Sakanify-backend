/**
 * receipt.service.js
 *
 * Simple digital receipt generation on payment confirmation (phase spec
 * step 7). Deliberately NOT a persisted collection/PDF — the payment
 * record + the immutable audit log (audit.service, 'payment_confirmed'
 * entries) are already the permanent source of truth for disputes
 * (CLAUDE.md Section 5.3); this just formats that same data into a
 * receipt shape the owner-facing dashboard can render or hand to the
 * student on confirmation. If a future phase needs a downloadable
 * PDF/emailed receipt, this is the single place to extend without
 * touching payment.service's confirmation logic. Flagged as a scope
 * decision in the Phase 5 report.
 */

function buildReceiptNumber(payment) {
  return `RCPT-${payment.billing_period.replace('-', '')}-${payment._id.toString().slice(-8).toUpperCase()}`;
}

/**
 * @param {Object} payment - a fresh (post-confirmation) Payment document
 */
function generateReceipt(payment) {
  return {
    receipt_number: buildReceiptNumber(payment),
    payment_id: payment._id,
    rental_id: payment.rental,
    student_id: payment.student,
    building_id: payment.building,
    bed_id: payment.bed,
    billing_period: payment.billing_period,
    amount_due: payment.amount_due,
    amount_paid: payment.amount_paid,
    status: payment.status,
    confirmed_by: payment.confirmed_by,
    confirmed_at: payment.confirmed_at,
    issued_at: new Date().toISOString(),
  };
}

module.exports = {
  generateReceipt,
};

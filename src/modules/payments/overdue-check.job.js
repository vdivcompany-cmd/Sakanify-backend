/**
 * overdue-check.job.js
 *
 * Scheduled job flagging pending/partial payments past
 * due_date + grace period as overdue (phase spec step 6). Registered into
 * shared/jobs/scheduler.core (built in Phase 0) — this file only defines
 * the job; server.entry.js wires it in and starts it.
 *
 * Processes in batches, re-querying fresh per batch — same pattern as
 * requests/request-expiry.job, and for the same reason: flagging a
 * payment overdue removes it from the "still pending/partial past due"
 * result set, so skip/limit on a moving target would silently drop or
 * re-process rows between batches (CLAUDE.md Section 4.6).
 */

const paymentRepository = require('./payment.repository');
const paymentService = require('./payment.service');
const dateUtil = require('../../shared/utils/date.util');

const BATCH_SIZE = 100;

async function runOverdueSweep() {
  const cutoff = dateUtil.addDays(dateUtil.now(), -paymentService.GRACE_PERIOD_DAYS);

  let totalProcessed = 0;
  let totalFlagged = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await paymentRepository.findOverdueCandidates(cutoff, BATCH_SIZE);
    if (batch.length === 0) break;

    for (const payment of batch) {
      totalProcessed += 1;
      try {
        await paymentService.flagOverdue(payment);
        totalFlagged += 1;
      } catch (err) {
        console.error(`[overdue-check.job] Failed to flag payment ${payment._id} overdue:`, err);
      }
    }

    if (batch.length < BATCH_SIZE) break;
  }

  if (totalProcessed > 0) {
    console.log(`[overdue-check.job] Sweep complete: ${totalFlagged}/${totalProcessed} payment(s) flagged overdue.`);
  }

  return { totalProcessed, totalFlagged };
}

/**
 * Runs once a day — a payment's due_date + grace period is a whole-day
 * granularity concept, so checking more often than daily wouldn't change
 * outcomes, just add load. Cadence is a technical decision, not specified
 * in the phase spec — flagged in the Phase 5 report.
 */
function register(scheduler) {
  scheduler.registerJob('payment-overdue-check', '0 4 * * *', runOverdueSweep);
}

module.exports = {
  runOverdueSweep,
  register,
};

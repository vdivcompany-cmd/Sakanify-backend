/**
 * payment-rollover.job.js
 *
 * Scheduled job that generates each active/vacating rental's next
 * billing-period Payment record once its latest period is settled (phase
 * spec step 5). Registered into shared/jobs/scheduler.core (built in
 * Phase 0) — this file only defines the job; server.entry.js wires it in
 * and starts it (same pattern as requests/request-expiry.job).
 *
 * Reads rental data through rental.service (never rental.model directly,
 * CLAUDE.md Section 7.2) — this file is the one place in the payments
 * module allowed to depend on rental.service, since rental.service itself
 * depends on payment.service (see rental.service.js's comment on why);
 * putting the rental-reading logic in its own job file instead of inside
 * payment.service avoids that would-be cycle entirely.
 *
 * Processes rentals in batches, never loading the whole `rentals`
 * collection into memory (CLAUDE.md Section 4.6) — at 500k students/beds
 * scale this collection will be large. Unlike request-expiry.job, a
 * rental doesn't leave the "active or vacating" result set as a side
 * effect of this job running, so plain skip/limit batching (not a
 * re-query-per-batch loop) is safe here — see
 * rental.repository.findActiveOrVacatingBatch's doc comment.
 */

const rentalService = require('../rentals/rental.service');
const paymentService = require('./payment.service');

const BATCH_SIZE = 200;

async function runRolloverSweep() {
  let totalScanned = 0;
  let totalGenerated = 0;
  let skip = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await rentalService.listActiveOrVacatingForRollover({ skip, limit: BATCH_SIZE });
    if (batch.length === 0) break;

    for (const rental of batch) {
      totalScanned += 1;
      try {
        const generated = await paymentService.generateNextPeriodPayment(rental, null);
        if (generated) totalGenerated += 1;
      } catch (err) {
        console.error(`[payment-rollover.job] Failed to roll over rental ${rental._id}:`, err);
      }
    }

    if (batch.length < BATCH_SIZE) break;
    skip += BATCH_SIZE;
  }

  if (totalScanned > 0) {
    console.log(`[payment-rollover.job] Sweep complete: ${totalGenerated}/${totalScanned} rental(s) rolled to a new period.`);
  }

  return { totalScanned, totalGenerated };
}

/**
 * Runs once a day. A rollover only actually happens for a given rental
 * once its latest period is settled AND the calendar has moved into a new
 * month (payment.service.generateNextPeriodPayment's own guard), so a
 * daily cadence is frequent enough to pick up a settlement within a day of
 * it happening, without re-scanning the whole active-rentals set more
 * often than needed. Cadence itself is a technical decision, not specified
 * in the phase spec — flagged in the Phase 5 report (same reasoning as
 * request-expiry.job's 15-minute cadence in Phase 4).
 */
function register(scheduler) {
  scheduler.registerJob('payment-rollover', '0 3 * * *', runRolloverSweep);
}

module.exports = {
  runRolloverSweep,
  register,
};

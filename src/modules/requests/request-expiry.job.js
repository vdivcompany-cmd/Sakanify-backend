/**
 * request-expiry.job.js
 *
 * Scheduled job auto-expiring requests an owner never responded to within
 * the 48h window (request.service.EXPIRY_WINDOW_HOURS). Registered into
 * shared/jobs/scheduler.core (built in Phase 0) — this file only defines
 * the job; server.entry.js is where it actually gets wired in and started.
 *
 * Processes in batches, never loading the whole `requests` collection
 * into memory (CLAUDE.md Section 4.6) — at 500k students/beds scale this
 * collection will be large. Each batch is re-queried fresh rather than
 * paginated with skip/limit, because expiring a request removes it from
 * the "still pending and past due" result set — using skip on a moving
 * target would silently drop or re-process rows between batches.
 */

const requestRepository = require('./request.repository');
const requestService = require('./request.service');

const BATCH_SIZE = 100;

/**
 * Run one full sweep: repeatedly fetch a batch of expired-but-still-
 * pending requests and expire each one, until none are left. Each item
 * is processed independently — one failure logs and continues rather
 * than aborting the whole sweep, since these are independent documents
 * with no cross-item transaction.
 */
async function runExpirySweep() {
  let totalProcessed = 0;
  let totalExpired = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await requestRepository.findExpiredPending(BATCH_SIZE);
    if (batch.length === 0) break;

    for (const request of batch) {
      totalProcessed += 1;
      try {
        const result = await requestService.expireRequest(request._id);
        if (result) totalExpired += 1;
      } catch (err) {
        console.error(`[request-expiry.job] Failed to expire request ${request._id}:`, err);
      }
    }

    if (batch.length < BATCH_SIZE) break;
  }

  if (totalProcessed > 0) {
    console.log(`[request-expiry.job] Sweep complete: ${totalExpired}/${totalProcessed} request(s) expired.`);
  }

  return { totalProcessed, totalExpired };
}

/**
 * Register this job into the shared scheduler. Runs every 15 minutes —
 * frequent enough that a request rarely sits past its 48h deadline for
 * long, without re-scanning the collection so often it adds meaningful
 * load. The 48h threshold itself lives on each request's stored
 * `expires_at` field, not in this cron cadence (technical decision, not
 * specified in the phase spec — flagged in the Phase 4 report).
 */
function register(scheduler) {
  scheduler.registerJob('request-expiry', '*/15 * * * *', runExpirySweep);
}

module.exports = {
  runExpirySweep,
  register,
};

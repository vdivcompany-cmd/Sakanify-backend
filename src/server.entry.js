/**
 * server.entry.js
 *
 * Process entrypoint: connects to MongoDB, then starts the HTTP server.
 * No business logic here — assembly and boot only.
 */

const app = require('./app.entry');
const env = require('./config/env.config');
const { connectDB } = require('./config/database.config');
const scheduler = require('./shared/jobs/scheduler.core');
const requestExpiryJob = require('./modules/requests/request-expiry.job');
const paymentRolloverJob = require('./modules/payments/payment-rollover.job');
const overdueCheckJob = require('./modules/payments/overdue-check.job');

async function start() {
  await connectDB();

  // Job scheduler engine boots empty in Phase 0 — later phases register
  // jobs into it (request expiry, payment/subscription rollover) before
  // this call.
  // Phase 4: auto-expire unanswered bed requests after 48h.
  requestExpiryJob.register(scheduler);
  // Phase 5: recurring monthly billing rollover + overdue detection.
  paymentRolloverJob.register(scheduler);
  overdueCheckJob.register(scheduler);
  scheduler.startAll();

  const server = app.listen(env.port, () => {
    console.log(`[server.entry] Sakanify backend listening on port ${env.port} (${env.nodeEnv})`);
  });

  const shutdown = (signal) => {
    console.log(`[server.entry] Received ${signal}, shutting down gracefully...`);
    scheduler.stopAll();
    server.close(() => {
      console.log('[server.entry] HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('[server.entry] Fatal startup error:', err);
  process.exit(1);
});

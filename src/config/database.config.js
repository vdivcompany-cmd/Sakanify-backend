/**
 * database.config.js
 *
 * MongoDB connection setup via Mongoose. Works the same across
 * dev/staging/production (all driven by MONGODB_URI) and retries on
 * failure with a fixed backoff instead of crashing the process on the
 * first blip.
 */

const mongoose = require('mongoose');
const env = require('./env.config');

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

// Remediation Pass 1 / DB-001 (Docs/reports/remediation-pass-1-report.md):
// mongoose.connect() used to be called with zero options, which meant the
// MongoDB Node.js driver's own defaults applied silently (maxPoolSize: 100
// in recent driver versions) rather than a deliberately chosen value — a
// direct gap against CLAUDE.md Section 4.3 ("configure connection pooling
// explicitly rather than relying on default settings"). Values below are
// sized for the current single-instance deployment (no horizontal scaling
// yet — see SEC-004 in the audit report, deliberately deferred until that
// changes) and should be revisited together with that work:
//   - maxPoolSize: 50 — comfortably above what a single Node process
//     needs for this app's query patterns (Node is single-threaded; the
//     pool mainly absorbs concurrent in-flight async DB calls, not CPU
//     parallelism), while leaving headroom under typical MongoDB
//     Atlas shared/free-tier connection caps (~500 total) if this process
//     is ever one of a few instances sharing a cluster during a staged
//     rollout to multiple instances.
//   - minPoolSize: 5 — keeps a small number of warm connections so the
//     first request after an idle period doesn't pay full connection
//     setup cost, without holding many idle connections during quiet
//     periods.
//   - serverSelectionTimeoutMS: 5000 — fail fast (5s) if MongoDB is
//     unreachable at startup/reconnect, instead of the driver's ~30s
//     default. This directly closes the audit's Reliability finding #4:
//     without an explicit short timeout here, an unreachable database
//     could leave the process hanging for tens of seconds per retry
//     attempt before MAX_RETRIES below even has a chance to matter,
//     which is a legibility/fail-fast problem as much as a performance
//     one. Matches the value tests/integration/auth-real.test.js already
//     uses for its own direct mongoose.connect() call.
const CONNECTION_OPTIONS = {
  maxPoolSize: 50,
  minPoolSize: 5,
  serverSelectionTimeoutMS: 5000,
};

mongoose.set('strictQuery', true);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectDB(attempt = 1) {
  try {
    await mongoose.connect(env.mongodbUri, CONNECTION_OPTIONS);
    console.log(`[database.config] MongoDB connected (${mongoose.connection.name})`);
  } catch (err) {
    console.error(`[database.config] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);

    if (attempt >= MAX_RETRIES) {
      console.error('[database.config] Max retries reached. Exiting.');
      process.exit(1);
    }

    await sleep(RETRY_DELAY_MS);
    return connectDB(attempt + 1);
  }
}

mongoose.connection.on('error', (err) => {
  console.error('[database.config] Connection error:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.warn('[database.config] MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('[database.config] MongoDB reconnected');
});

/**
 * Mongoose readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
 */
function isConnected() {
  return mongoose.connection.readyState === 1;
}

module.exports = {
  connectDB,
  isConnected,
  connection: mongoose.connection,
  // Exported so tests/unit/database.config.pool.test.js can assert on the
  // actual values used, rather than duplicating/hardcoding them in the
  // test and risking the two silently drifting apart.
  CONNECTION_OPTIONS,
};

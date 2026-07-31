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

mongoose.set('strictQuery', true);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectDB(attempt = 1) {
  try {
    await mongoose.connect(env.mongodbUri);
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
};

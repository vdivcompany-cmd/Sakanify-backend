/**
 * env.config.js
 *
 * Loads .env and validates required environment variables at startup.
 * Fails fast (process.exit) if anything truly required to boot is missing,
 * so a misconfiguration is caught immediately instead of surfacing later
 * as a confusing runtime error.
 *
 * Storage (S3) variables are validated as a group but are NOT fatal if
 * absent: Phase 0 only needs to *connect the bucket if configured* — real
 * usage doesn't start until Phase 2, and the project must still boot for
 * a developer who hasn't provisioned a bucket yet. storage.config.js
 * reads `env.storage.isConfigured` to decide whether to connect.
 */

const dotenv = require('dotenv');

dotenv.config();

const REQUIRED_VARS = [
  'MONGODB_URI',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];
const STORAGE_VARS = [
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
];
const JWT_VARS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];

function loadEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`[env.config] Missing required environment variable(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  const storageValuesPresent = STORAGE_VARS.filter((key) => process.env[key]);
  const storageIsConfigured = storageValuesPresent.length === STORAGE_VARS.length;

  if (storageValuesPresent.length > 0 && !storageIsConfigured) {
    const missingStorage = STORAGE_VARS.filter((key) => !process.env[key]);
    console.warn(
      `[env.config] Partial storage configuration detected. Missing: ${missingStorage.join(', ')}. Storage will be treated as not configured.`,
    );
  }

  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT) || 5000,
    mongodbUri: process.env.MONGODB_URI,
    jwt: {
      accessSecret: process.env.JWT_ACCESS_SECRET,
      refreshSecret: process.env.JWT_REFRESH_SECRET,
      accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
      refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
    },
    otp: {
      expiry: Number(process.env.OTP_EXPIRY) || 5 * 60, // 5 minutes in seconds
      maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS) || 3,
    },
    storage: {
      isConfigured: storageIsConfigured,
      endpoint: process.env.STORAGE_ENDPOINT || null,
      region: process.env.STORAGE_REGION || null,
      bucket: process.env.STORAGE_BUCKET || null,
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || null,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || null,
    },
    rateLimit: {
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
      max: Number(process.env.RATE_LIMIT_MAX) || 100,
    },
  };
}

const env = loadEnv();

module.exports = env;

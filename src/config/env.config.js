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
  // Remediation Pass 2 / SEC-002 (Super-Admin MFA): required, not optional,
  // same tier as the JWT secrets — the moment MFA enrollment is mandatory
  // for every Super-Admin account, the app cannot correctly serve a
  // Super-Admin login without a working key to encrypt/decrypt TOTP
  // secrets at rest. Failing fast here (same philosophy as every other
  // REQUIRED_VARS entry) is safer than discovering a missing/misconfigured
  // key only when the first Super-Admin tries to enroll.
  'MFA_ENCRYPTION_KEY',
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

  // Remediation Pass 2 / SEC-002: validate MFA_ENCRYPTION_KEY's shape at
  // boot too, not just its presence — AES-256-GCM needs exactly a 32-byte
  // key, and the chosen encoding (64 hex characters) is checked here so a
  // typo'd/truncated key fails loudly at startup instead of surfacing as a
  // confusing decrypt failure the first time a Super-Admin logs in.
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.MFA_ENCRYPTION_KEY)) {
    console.error(
      '[env.config] MFA_ENCRYPTION_KEY must be exactly 64 hexadecimal characters '
        + '(32 bytes, for AES-256-GCM). Generate one with: '
        + 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
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
    // Remediation Pass 2 / SEC-002 (Super-Admin MFA). Kept deliberately
    // separate from `jwt` above even though both are "auth secrets" — this
    // key encrypts data at rest (TOTP secrets), the JWT secrets sign
    // tokens; mixing them would make it impossible to rotate one without
    // touching the other's blast radius.
    mfa: {
      encryptionKey: process.env.MFA_ENCRYPTION_KEY,
      // TOTP tokens are single-use in principle, but a network retry or a
      // slow admin can legitimately submit the *same* code twice within
      // its 30s validity window — replay prevention against a captured
      // code is a separate, harder problem (would need per-user
      // last-used-timeStep tracking) not attempted in this pass; the
      // ±window tolerance below is purely clock-drift tolerance between
      // the server and the admin's authenticator app, not a security
      // control.
      totpWindowSeconds: 30,
      setupTokenExpiry: '10m',
      pendingTokenExpiry: '10m',
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
    // Security-hardening-pass addition (Aug 2026, hardening-audit Category
    // 6): CORS must default to allowing NO cross-origin browser requests
    // rather than the wildcard `*` app.entry.js used to pass to the `cors`
    // middleware unconfigured. ALLOWED_ORIGINS is a comma-separated list of
    // exact origins (e.g. "https://app.sakanify.com,https://admin.sakanify.com").
    // Empty/unset means "no browser origin is allowed" — safe by default,
    // matching CLAUDE.md Section 3.11 (least privilege by default). The
    // real frontend's domain(s) must be added here once they exist; this is
    // also restated as a pre-launch checklist item in the hardening report.
    cors: {
      allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    },
  };
}

const env = loadEnv();

module.exports = env;

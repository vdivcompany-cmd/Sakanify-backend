/**
 * mfa.service.js
 *
 * Remediation Pass 2 / SEC-002 (Docs/reports/remediation-pass-2-mfa-report.md):
 * TOTP-based multi-factor authentication for Super-Admin accounts — the
 * single highest-value account type in the system. Mandatory for every
 * Super-Admin (existing and future), enforced at login (see
 * auth.service.loginOwner) rather than being an opt-in setting.
 *
 * Owns: TOTP secret generation/verification, backup-code generation/
 * verification, and the AES-256-GCM encrypt/decrypt helpers used to store
 * the TOTP secret at rest (product decision 5: encrypted, not hashed —
 * hashing is one-way, but the server must be able to reproduce/verify
 * codes against the real secret every 30 seconds, which requires
 * decrypting it back to plaintext at verification time).
 *
 * Never touches the User collection directly for anything except reading/
 * writing the MFA-specific fields — same module as auth.model.js
 * (src/modules/auth/), same pattern as otp.service.js directly requiring
 * ./otp.model (CLAUDE.md Section 7.2 governs cross-module access; this is
 * intra-module).
 */

const crypto = require('crypto');
const bcryptjs = require('bcryptjs');
const { generateSecret, generateURI, verify: verifyOtp } = require('otplib');

const User = require('./auth.model');
const env = require('../../config/env.config');
const { AppError } = require('../../middleware/error-handler.middleware');

const BACKUP_CODE_COUNT = 10;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96-bit IV, the standard/recommended size for GCM
const AUTH_TAG_LENGTH_BYTES = 16;
const ISSUER = 'Sakanify';

/**
 * The 32-byte AES-256-GCM key, decoded once from the hex-encoded
 * MFA_ENCRYPTION_KEY env var. env.config.js already validates the format
 * (64 hex chars) at boot, so a throw here would only ever indicate a
 * programming error, not a real misconfiguration reaching production.
 */
function getEncryptionKey() {
  return Buffer.from(env.mfa.encryptionKey, 'hex');
}

/**
 * Encrypt a plaintext TOTP secret for storage. Returns a single
 * self-contained base64 string (iv + authTag + ciphertext concatenated)
 * so decryptSecret() needs nothing but this one value to reverse it —
 * no separate IV column to keep in sync.
 */
function encryptSecret(plainSecret) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Reverse of encryptSecret(). Throws if the ciphertext/authTag don't
 * match the key (tampered or wrong key) — GCM's built-in integrity check,
 * not just confidentiality.
 */
function decryptSecret(encryptedB64) {
  const key = getEncryptionKey();
  const raw = Buffer.from(encryptedB64, 'base64');
  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const ciphertext = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Generate 10 single-use backup codes (decision 6). Plaintext form is
 * returned to the caller for the one-time API response; callers must hash
 * them (hashBackupCodes below) before persisting — this function itself
 * never touches the database.
 *
 * Format: 10 hex characters, uppercased, e.g. "A1B2C3D4E5" — short enough
 * to type by hand if needed, long enough (40 bits of entropy) that
 * guessing one is not a realistic attack next to the rate-limited
 * verify-login endpoint.
 */
function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i += 1) {
    codes.push(crypto.randomBytes(5).toString('hex').toUpperCase());
  }
  return codes;
}

/**
 * Bcrypt-hash a batch of plaintext backup codes for storage — same
 * standard as password_hash (genSalt(10)), per decision 6 ("stored
 * server-side as bcrypt hashes... not encrypted, since they're never
 * displayed again after generation, only compared").
 */
async function hashBackupCodes(plainCodes) {
  return Promise.all(plainCodes.map((code) => bcryptjs.hash(code, 10)));
}

/**
 * Generate a brand-new TOTP secret + otpauth:// URI (for QR rendering,
 * a frontend concern — this returns the URI/secret string only) + a fresh
 * batch of backup codes, both plaintext (for the one-time API response)
 * and their bcrypt hashes (for embedding, encrypted, in the setup token —
 * see mfa.controller.setup). Nothing is written to the database here;
 * see this file's header comment and mfa.controller.verifySetup for why
 * persistence only happens after the admin proves they can generate a
 * real code from the secret.
 */
async function generateEnrollment(email) {
  const secret = generateSecret();
  const otpauthUri = generateURI({ issuer: ISSUER, label: email, secret });
  const backupCodesPlain = generateBackupCodes();
  const backupCodeHashes = await hashBackupCodes(backupCodesPlain);

  return { secret, otpauthUri, backupCodesPlain, backupCodeHashes };
}

/**
 * Verify a 6-digit TOTP code against a (decrypted) secret.
 *
 * epochTolerance is clock-drift tolerance between this server and the
 * admin's authenticator app (env.mfa.totpWindowSeconds, currently 30s —
 * roughly one time-step in either direction) — a UX/reliability concern,
 * not a security control. otplib's `verify()` throws on a malformed token
 * (e.g. not exactly 6 digits) rather than returning `{ valid: false }`, so
 * that's caught here and treated as "not valid" rather than surfacing as
 * an unhandled rejection / 500 to the caller.
 */
async function verifyTotpCode(secret, token) {
  if (!token || typeof token !== 'string') return false;

  try {
    const result = await verifyOtp({
      secret,
      token,
      epochTolerance: env.mfa.totpWindowSeconds,
    });
    return Boolean(result.valid);
  } catch (err) {
    return false;
  }
}

/**
 * Check a plaintext backup code against a user's stored (hashed,
 * not-yet-used) backup codes. Returns the matching sub-document if found,
 * or null. Does NOT mark it used or save — that's the caller's job
 * (mfa.controller.verifyLogin), specifically so the caller can do it as
 * part of the same save() that also updates whatever else changed,
 * keeping this function a pure read/compare with no side effects.
 */
async function findMatchingUnusedBackupCode(user, plainCode) {
  if (!plainCode || !Array.isArray(user.backup_codes)) return null;

  for (const entry of user.backup_codes) {
    if (entry.used_at) continue;
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose:
    // bcrypt.compare is deliberately slow (that's the point), and codes
    // are checked oldest-first; short-circuiting on first match avoids
    // paying that cost for all 10 entries on every successful check.
    const matches = await bcryptjs.compare(plainCode, entry.code_hash);
    if (matches) return entry;
  }

  return null;
}

/**
 * Fetch a user with the MFA-sensitive fields explicitly selected (they're
 * `select: false` on the schema — see auth.model.js). Centralized here
 * (rather than every caller writing its own `.select('+mfa_secret_encrypted
 * +backup_codes')`) so the exact field list only has to match the schema
 * in one place.
 */
async function getUserWithMfaSecrets(userId) {
  const user = await User.findById(userId).select('+mfa_secret_encrypted +backup_codes');
  if (!user) {
    throw new AppError('User not found', 404);
  }
  return user;
}

/**
 * The ONE place enrollment is actually written to the User document —
 * called only by mfa.controller.verifySetup(), only after a real 6-digit
 * TOTP code has been confirmed against the pending secret (see this
 * file's header comment on why nothing is persisted before that point).
 * `backupCodeHashes` are wrapped into the schema's {code_hash, used_at:
 * null} shape here so the controller doesn't need to know that shape.
 */
async function persistConfirmedEnrollment(userId, secretEncrypted, backupCodeHashes) {
  const user = await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        mfa_enabled: true,
        mfa_secret_encrypted: secretEncrypted,
        mfa_enrolled_at: new Date(),
        backup_codes: backupCodeHashes.map((hash) => ({ code_hash: hash, used_at: null })),
      },
    },
    { new: true },
  );

  if (!user) {
    throw new AppError('User not found', 404);
  }

  return user;
}

/**
 * Mark a single backup-code sub-document as used (single-use enforcement —
 * decision 6) and save. Takes the already-matched sub-document from
 * findMatchingUnusedBackupCode() above rather than re-searching, so there's
 * no gap between "found a match" and "marked it used" where the same code
 * could be matched twice.
 */
async function markBackupCodeUsed(user, matchedEntry) {
  matchedEntry.used_at = new Date();
  await user.save();
  return matchedEntry;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  generateEnrollment,
  hashBackupCodes,
  verifyTotpCode,
  findMatchingUnusedBackupCode,
  getUserWithMfaSecrets,
  persistConfirmedEnrollment,
  markBackupCodeUsed,
  BACKUP_CODE_COUNT,
};

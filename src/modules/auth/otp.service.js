/**
 * otp.service.js
 *
 * OTP generation, sending, and verification for student phone-based login.
 * For Phase 1, the SMS sending is mocked (console.log only).
 * Real SMS integration (e.g., SMS Misr) will be added in a later phase
 * once pricing is finalized.
 *
 * Remediation Pass 1 / SEC-001 (Docs/reports/remediation-pass-1-report.md):
 * the OTP code used to be returned directly in requestOtp()'s response
 * object (as `_dev_code`), which meant the real API response — in every
 * environment, including production — included the working OTP code with
 * zero gating. That is a complete authentication-factor bypass: anyone who
 * can call the endpoint for a phone number gets back the code needed to
 * log in as that number. Fixed by removing the code from the returned
 * object entirely (see requestOtp() below) rather than gating it behind
 * `NODE_ENV`, per the audit's own reasoning: staging environments often
 * also run as `development`/non-`production`, so an env-name check alone
 * is not a safe boundary for "never send this over the wire."
 */

const crypto = require('crypto');
const OTP = require('./otp.model');
const env = require('../../config/env.config');

// Flips to false the moment a real SMS provider (e.g. SMS Misr) is wired
// into sendOtp() below. At that point __getLastOtpForPhone() must stop
// working entirely — there would be no local code to read back — and
// should be deleted rather than left to silently return stale data.
// Referenced by sendOtp() (gates the console.log) and __getLastOtpForPhone()
// (gates the whole function) so both fail loudly/obviously once a real
// provider lands, instead of quietly doing the wrong thing.
const IS_MOCK_PROVIDER = true;

/**
 * Generate a random 6-digit OTP code
 */
function generateOTPCode() {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Send OTP to phone (mock implementation for Phase 1)
 *
 * In production, this would integrate with SMS Misr or another
 * Egypt-focused SMS provider. For now, we log it to console for local
 * developer visibility — this log line is gated to the mock provider only
 * (see IS_MOCK_PROVIDER above) so it doesn't silently keep firing once a
 * real SMS gateway is wired in and this function actually sends the code
 * to the student's phone instead.
 */
async function sendOtp(phone, code) {
  // TODO: Replace with real SMS provider (SMS Misr or equivalent) in Phase 2+
  if (IS_MOCK_PROVIDER) {
    console.log(`[OTP Mock] Sending OTP ${code} to phone ${phone}`);
  }
  return {
    success: true,
    message: 'OTP sent (mocked for Phase 1)',
  };
}

/**
 * Request OTP for a phone number
 *
 * - Validates phone format
 * - Checks rate-limiting (max OTP_MAX_ATTEMPTS within OTP_EXPIRY window)
 * - Generates and stores OTP
 * - Sends OTP (mocked)
 * - Does NOT return the code (SEC-001 fix — see __getLastOtpForPhone()
 *   below for how tests read it back instead)
 */
async function requestOtp(phone) {
  if (!phone || !/^\+?[0-9]{10,15}$/.test(phone)) {
    throw new Error('Invalid phone number format');
  }

  // Clean phone number (ensure it starts with +20 for Egypt)
  const cleanPhone = phone.startsWith('+') ? phone : `+20${phone.slice(-10)}`;

  // Check rate-limiting: how many OTPs in the last OTP_EXPIRY window?
  const recentOtps = await OTP.countDocuments({
    phone: cleanPhone,
    created_at: {
      $gte: new Date(Date.now() - env.otp.expiry * 1000),
    },
  });

  if (recentOtps >= env.otp.maxAttempts) {
    throw new Error('Too many OTP requests. Please try again later.');
  }

  // Generate OTP
  const code = generateOTPCode();

  // Calculate expiry (5 minutes by default)
  const expiresAt = new Date(Date.now() + env.otp.expiry * 1000);

  // Store OTP
  const otpRecord = await OTP.create({
    phone: cleanPhone,
    code,
    expires_at: expiresAt,
    status: 'pending',
  });

  // Send OTP (mocked)
  await sendOtp(cleanPhone, code);

  // SEC-001 fix: the OTP code is deliberately NOT included anywhere in
  // this returned object. It used to be attached here as `_dev_code` and
  // flowed straight through to the real HTTP response with no gating at
  // all (auth.controller.requestOtp passes this object through verbatim
  // as `data`) — a complete authentication-factor bypass. Tests that need
  // the code now read it back via __getLastOtpForPhone() below, which is
  // a test-only accessor into the OTP store itself, never part of the API
  // response contract.
  return {
    success: true,
    phone: cleanPhone,
    expiresAt,
  };
}

/**
 * Test-only accessor: read back the most recently issued, still-pending
 * OTP code for a phone number directly from the store the mock provider
 * writes to (the OTP collection) — NOT from the API response, which no
 * longer includes it (see requestOtp() above, SEC-001 fix). This exists
 * purely so integration tests can complete the OTP login flow without the
 * code ever being part of the real response contract.
 *
 * Guarded by IS_MOCK_PROVIDER so it throws clearly — instead of silently
 * returning stale or wrong data — if it's ever called after a real SMS
 * provider is wired in, at which point this function should be deleted
 * from both here and every test that calls it.
 */
async function __getLastOtpForPhone(phone) {
  if (!IS_MOCK_PROVIDER) {
    throw new Error(
      '__getLastOtpForPhone() is only available with the mock OTP provider — '
        + 'a real provider is configured, so there is no local code to read back.',
    );
  }

  const cleanPhone = phone.startsWith('+') ? phone : `+20${phone.slice(-10)}`;

  const record = await OTP.findOne({ phone: cleanPhone, status: 'pending' }).sort({ created_at: -1 });
  if (!record) {
    throw new Error(`__getLastOtpForPhone: no pending OTP found for ${cleanPhone}`);
  }

  return record.code;
}

/**
 * Verify OTP code for a phone number
 *
 * - Validates OTP exists and matches
 * - Checks OTP hasn't expired
 * - Marks OTP as verified
 * - Returns the phone number if valid
 */
async function verifyOtp(phone, code) {
  if (!phone || !code) {
    throw new Error('Phone and OTP code are required');
  }

  // Clean phone number
  const cleanPhone = phone.startsWith('+') ? phone : `+20${phone.slice(-10)}`;

  // Find the OTP record
  const otpRecord = await OTP.findOne({
    phone: cleanPhone,
    code,
    status: 'pending',
    expires_at: { $gt: new Date() }, // Not expired
  });

  if (!otpRecord) {
    throw new Error('Invalid or expired OTP');
  }

  // Mark as verified
  otpRecord.status = 'verified';
  await otpRecord.save();

  return {
    success: true,
    phone: cleanPhone,
    verified: true,
  };
}

/**
 * Invalidate all OTPs for a phone (used after successful verification)
 */
async function invalidateOtpsForPhone(phone) {
  const cleanPhone = phone.startsWith('+') ? phone : `+20${phone.slice(-10)}`;
  await OTP.updateMany(
    { phone: cleanPhone },
    { status: 'expired' },
  );
}

/**
 * Get OTP attempt count for rate-limiting
 */
async function getOtpAttempts(phone) {
  const cleanPhone = phone.startsWith('+') ? phone : `+20${phone.slice(-10)}`;
  return await OTP.countDocuments({
    phone: cleanPhone,
    created_at: {
      $gte: new Date(Date.now() - env.otp.expiry * 1000),
    },
  });
}

module.exports = {
  generateOTPCode,
  sendOtp,
  requestOtp,
  verifyOtp,
  invalidateOtpsForPhone,
  getOtpAttempts,
  __getLastOtpForPhone,
};
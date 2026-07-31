/**
 * otp.service.js
 *
 * OTP generation, sending, and verification for student phone-based login.
 * For Phase 1, the SMS sending is mocked (console.log only).
 * Real SMS integration (e.g., SMS Misr) will be added in a later phase
 * once pricing is finalized.
 */

const crypto = require('crypto');
const OTP = require('./otp.model');
const env = require('../../config/env.config');

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
 * Egypt-focused SMS provider. For now, we log it to console
 * and return the code for testing purposes.
 */
async function sendOtp(phone, code) {
  // TODO: Replace with real SMS provider (SMS Misr or equivalent) in Phase 2+
  console.log(`[OTP Mock] Sending OTP ${code} to phone ${phone}`);
  return {
    success: true,
    message: 'OTP sent (mocked for Phase 1)',
    code, // Only for development/testing
  };
}

/**
 * Request OTP for a phone number
 *
 * - Validates phone format
 * - Checks rate-limiting (max OTP_MAX_ATTEMPTS within OTP_EXPIRY window)
 * - Generates and stores OTP
 * - Sends OTP (mocked)
 * - Returns code for development (should be removed in production)
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

  return {
    success: true,
    phone: cleanPhone,
    expiresAt,
    // For development only — remove in production
    _dev_code: code,
  };
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
};
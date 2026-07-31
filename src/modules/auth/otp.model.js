/**
 * otp.model.js
 *
 * OTP model for student phone-based login. Tracks generated OTPs, their
 * expiry, and failed verification attempts for rate-limiting.
 */

const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema(
  {
    // --- Phone number the OTP was requested for ---
    phone: {
      type: String,
      required: true,
      trim: true,
    },

    // --- The OTP code itself (will be encrypted/hashed in production) ---
    code: {
      type: String,
      required: true,
    },

    // --- Attempt counter (for rate-limiting repeated OTP requests) ---
    attempts: {
      type: Number,
      default: 0,
    },

    // --- OTP status ---
    status: {
      type: String,
      enum: ['pending', 'verified', 'expired'],
      default: 'pending',
    },

    // --- Expiry time (OTP becomes invalid after this time) ---
    expires_at: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // Auto-delete after expiry
    },

    // --- Timestamps ---
    created_at: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    collection: 'otps',
    timestamps: false,
  },
);

// --- Indexes ---
otpSchema.index({ phone: 1 });
otpSchema.index({ status: 1 });

module.exports = mongoose.model('OTP', otpSchema);

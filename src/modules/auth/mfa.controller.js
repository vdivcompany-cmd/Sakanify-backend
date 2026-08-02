/**
 * mfa.controller.js
 *
 * Remediation Pass 2 / SEC-002 (Docs/reports/remediation-pass-2-mfa-report.md):
 * HTTP layer for Super-Admin TOTP enrollment/verification. Every route
 * here is mounted under /api/auth/mfa (see mfa.routes.js) and authorized
 * by one of the two scoped-token middlewares in auth.middleware.js
 * (verifyMfaSetupAccess / verifyMfaPendingAccess) — never the normal
 * verifyToken(), since these tokens are deliberately narrower than a real
 * session.
 *
 * Same error-handling pattern as every other controller retrofitted in
 * the Security Hardening Pass (CLAUDE.md Section 7.3a): every catch runs
 * the error through normalizeError() and logs anything that isn't an
 * expected AppError.
 */

const { success, error } = require('../../shared/utils/response.util');
const authService = require('./auth.service');
const mfaService = require('./mfa.service');
const auditService = require('../audit/audit.service');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[mfa.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

/**
 * POST /api/auth/mfa/setup
 * Auth: verifyMfaSetupAccess (full Super-Admin session OR a bare/enriched
 * mfa_setup token — see that middleware's doc comment).
 *
 * Generates a brand-new TOTP secret + otpauth URI + 10 backup codes.
 * Nothing is written to the database here (see mfa.service.js's header
 * comment) — the pending secret (encrypted) and the backup codes' bcrypt
 * hashes are embedded in a freshly-issued, short-lived 'mfa_setup' token
 * instead, which the client must send back to /verify-setup. The
 * plaintext backup codes are returned in THIS response only, exactly
 * once — the API never returns them again after this call (decision 6).
 */
async function setup(req, res) {
  try {
    // req.user.userId is a Mongo ObjectId string either way (from the
    // access token or the bare setup token) — need the user's email for
    // the otpauth URI's label (shows in the authenticator app).
    const user = await authService.getUserById(req.user.userId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const enrollment = await mfaService.generateEnrollment(user.email);
    const pendingSecretEncrypted = mfaService.encryptSecret(enrollment.secret);

    const setupToken = authService.issueMfaSetupToken(
      req.user.userId,
      pendingSecretEncrypted,
      enrollment.backupCodeHashes,
    );

    return success(res, {
      statusCode: 200,
      message: 'Scan the QR code (or enter the secret manually) in your authenticator app, then confirm with a 6-digit code via POST /api/auth/mfa/verify-setup. Save the backup codes now — they will never be shown again.',
      data: {
        otpauth_uri: enrollment.otpauthUri,
        secret: enrollment.secret,
        backup_codes: enrollment.backupCodesPlain,
        setup_token: setupToken,
      },
    });
  } catch (err) {
    return handleControllerError(res, err, 'setup');
  }
}

/**
 * POST /api/auth/mfa/verify-setup
 * Auth: verifyMfaSetupAccess, but ALSO requires the token to carry the
 * pending fields set by setup() above — a bare setup token (the one
 * loginOwner() issues, with no pending fields) is rejected here with a
 * clear "call /setup first" error, rather than silently doing nothing.
 * Body: { code: "123456" }
 *
 * On a valid code: persists the enrollment for real (mfa.service
 * .persistConfirmedEnrollment — the only place this ever happens),
 * audit-logs `mfa_enrolled`, and — per decision 3 ("Full tokens are
 * issued only after setup is confirmed with a real TOTP code") — issues a
 * real access/refresh token pair immediately, so the admin doesn't have
 * to log in a second time right after finishing enrollment.
 */
async function verifySetup(req, res) {
  try {
    if (!req.user.pendingSecretEncrypted || !req.user.pendingBackupCodeHashes) {
      throw new AppError('Call POST /api/auth/mfa/setup first to generate a pending secret.', 400);
    }

    const { code } = req.body;
    if (!code) {
      throw new AppError('code is required', 400);
    }

    const pendingSecret = mfaService.decryptSecret(req.user.pendingSecretEncrypted);
    const isValid = await mfaService.verifyTotpCode(pendingSecret, code);

    if (!isValid) {
      throw new AppError('Invalid or expired code. Re-scan the QR code and try again.', 401);
    }

    await mfaService.persistConfirmedEnrollment(
      req.user.userId,
      req.user.pendingSecretEncrypted,
      req.user.pendingBackupCodeHashes,
    );

    await auditService.writeAuditLog({
      actor: req.user.userId,
      action: 'mfa_enrolled',
      entityType: 'User',
      entityId: req.user.userId,
      afterState: { mfa_enabled: true },
    });

    const { accessToken, refreshToken } = authService.issueTokens(req.user.userId, 'super-admin', null);

    return success(res, {
      statusCode: 200,
      message: 'MFA enrollment complete. You are now logged in.',
      data: {
        success: true,
        userId: req.user.userId,
        role: 'super-admin',
        ownerId: null,
        accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    return handleControllerError(res, err, 'verifySetup');
  }
}

/**
 * POST /api/auth/mfa/verify-login
 * Auth: verifyMfaPendingAccess (strictly a 'mfa_pending' token — see that
 * middleware's doc comment).
 * Body: EITHER { code: "123456" } OR { backup_code: "A1B2C3D4E5" }.
 *
 * On success, issues real access/refresh tokens — the same shape
 * authService.loginOwner() returns for a non-MFA Owner login, so the
 * client's "I have a session now" handling doesn't need a special case
 * for how it got here.
 */
async function verifyLogin(req, res) {
  try {
    const { code, backup_code: backupCode } = req.body;
    if (!code && !backupCode) {
      throw new AppError('Either code or backup_code is required', 400);
    }

    const user = await mfaService.getUserWithMfaSecrets(req.user.userId);

    if (!user.mfa_enabled || !user.mfa_secret_encrypted) {
      // Shouldn't be reachable in practice (a mfa_pending token is only
      // ever issued for a user with mfa_enabled: true), but guards against
      // a pending token outliving an admin-triggered MFA reset that
      // happened in between login and this call.
      throw new AppError('MFA is not enrolled for this account. Please log in again.', 409);
    }

    let usedBackupCode = false;

    if (code) {
      const secret = mfaService.decryptSecret(user.mfa_secret_encrypted);
      const isValid = await mfaService.verifyTotpCode(secret, code);
      if (!isValid) {
        throw new AppError('Invalid or expired code', 401);
      }
    } else {
      const matchedEntry = await mfaService.findMatchingUnusedBackupCode(user, backupCode);
      if (!matchedEntry) {
        throw new AppError('Invalid or already-used backup code', 401);
      }
      await mfaService.markBackupCodeUsed(user, matchedEntry);
      usedBackupCode = true;

      // Decision 6 / implementation step 6: backup-code use is a weaker
      // signal than a live TOTP code and must be visible/flagged
      // prominently — a distinct audit action (not folded into a generic
      // "login" event) is what makes it show up as its own, searchable
      // entry in the Super-Admin activity feed (Phase 7).
      await auditService.writeAuditLog({
        actor: req.user.userId,
        action: 'mfa_backup_code_used',
        entityType: 'User',
        entityId: req.user.userId,
        afterState: { backup_codes_remaining: user.backup_codes.filter((c) => !c.used_at).length },
      });
    }

    const { accessToken, refreshToken } = authService.issueTokens(user._id.toString(), user.role, user.owner_id);

    return success(res, {
      statusCode: 200,
      message: usedBackupCode
        ? 'Logged in with a backup code. Consider regenerating your MFA setup soon.'
        : 'Logged in successfully',
      data: {
        success: true,
        userId: user._id,
        role: user.role,
        ownerId: user.owner_id,
        accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    return handleControllerError(res, err, 'verifyLogin');
  }
}

module.exports = {
  setup,
  verifySetup,
  verifyLogin,
};

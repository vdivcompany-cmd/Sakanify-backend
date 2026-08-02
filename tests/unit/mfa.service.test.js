/**
 * mfa.service.test.js
 *
 * Remediation Pass 2 / SEC-002 (Docs/reports/remediation-pass-2-mfa-report.md).
 * Pure unit tests for mfa.service.js's crypto/TOTP/backup-code logic —
 * deliberately no database or app boot involved, so this suite runs
 * locally in this sandbox (unlike tests/integration/mfa.test.js, which
 * needs mongodb-memory-server and cannot execute here — see that file's
 * header comment and the phase report's "Test Evidence" section for the
 * documented sandbox limitation).
 *
 * Covers:
 *   - encryptSecret/decryptSecret round-trip (AES-256-GCM).
 *   - decryptSecret rejects a tampered ciphertext (GCM auth-tag check).
 *   - generateEnrollment produces a usable secret, a well-formed otpauth
 *     URI, and exactly BACKUP_CODE_COUNT (10) backup codes with matching
 *     bcrypt hashes.
 *   - verifyTotpCode: true for a freshly-generated real code, false for a
 *     wrong code, false (not a throw) for a malformed token.
 *   - findMatchingUnusedBackupCode: matches a valid unused code, ignores
 *     already-used entries, returns null for a code that was never issued.
 */

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sakanify_unit_test_placeholder';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'unit-test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'unit-test-refresh-secret';
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || '0'.repeat(64);

const { generate: generateTotp } = require('otplib');
const mfaService = require('../../src/modules/auth/mfa.service');

describe('mfa.service — encryption round-trip', () => {
  it('encryptSecret then decryptSecret returns the original plaintext secret', () => {
    const plainSecret = 'JBSWY3DPEHPK3PXP';
    const encrypted = mfaService.encryptSecret(plainSecret);
    expect(encrypted).not.toBe(plainSecret);
    expect(mfaService.decryptSecret(encrypted)).toBe(plainSecret);
  });

  it('produces a different ciphertext each time (random IV), even for the same secret', () => {
    const plainSecret = 'JBSWY3DPEHPK3PXP';
    const first = mfaService.encryptSecret(plainSecret);
    const second = mfaService.encryptSecret(plainSecret);
    expect(first).not.toBe(second);
    expect(mfaService.decryptSecret(first)).toBe(plainSecret);
    expect(mfaService.decryptSecret(second)).toBe(plainSecret);
  });

  it('rejects a tampered ciphertext (GCM auth-tag integrity check)', () => {
    const encrypted = mfaService.encryptSecret('JBSWY3DPEHPK3PXP');
    const raw = Buffer.from(encrypted, 'base64');
    raw[raw.length - 1] ^= 0xff; // flip the last byte of the ciphertext
    const tampered = raw.toString('base64');
    expect(() => mfaService.decryptSecret(tampered)).toThrow();
  });
});

describe('mfa.service — generateEnrollment', () => {
  it('returns a secret, a well-formed otpauth:// URI, and 10 backup codes with matching hashes', async () => {
    const enrollment = await mfaService.generateEnrollment('super-admin@sakanify.com');

    expect(typeof enrollment.secret).toBe('string');
    expect(enrollment.secret.length).toBeGreaterThan(0);

    expect(enrollment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(enrollment.otpauthUri).toContain('Sakanify');

    expect(enrollment.backupCodesPlain).toHaveLength(mfaService.BACKUP_CODE_COUNT);
    expect(enrollment.backupCodeHashes).toHaveLength(mfaService.BACKUP_CODE_COUNT);
    enrollment.backupCodesPlain.forEach((code) => {
      expect(code).toMatch(/^[0-9A-F]{10}$/);
    });

    // All 10 codes must be unique.
    expect(new Set(enrollment.backupCodesPlain).size).toBe(mfaService.BACKUP_CODE_COUNT);
  });
});

describe('mfa.service — verifyTotpCode', () => {
  it('returns true for a real, freshly-generated TOTP code', async () => {
    const enrollment = await mfaService.generateEnrollment('super-admin@sakanify.com');
    const code = await generateTotp({ secret: enrollment.secret });
    const isValid = await mfaService.verifyTotpCode(enrollment.secret, code);
    expect(isValid).toBe(true);
  });

  it('returns false for an incorrect code', async () => {
    const enrollment = await mfaService.generateEnrollment('super-admin@sakanify.com');
    const realCode = await generateTotp({ secret: enrollment.secret });
    const wrongCode = realCode === '000000' ? '111111' : '000000';
    const isValid = await mfaService.verifyTotpCode(enrollment.secret, wrongCode);
    expect(isValid).toBe(false);
  });

  it('returns false (does not throw) for a malformed token', async () => {
    const enrollment = await mfaService.generateEnrollment('super-admin@sakanify.com');
    await expect(mfaService.verifyTotpCode(enrollment.secret, 'not-a-code')).resolves.toBe(false);
    await expect(mfaService.verifyTotpCode(enrollment.secret, '')).resolves.toBe(false);
    await expect(mfaService.verifyTotpCode(enrollment.secret, null)).resolves.toBe(false);
  });
});

describe('mfa.service — findMatchingUnusedBackupCode', () => {
  it('matches a valid, unused backup code against its stored hash', async () => {
    const enrollment = await mfaService.generateEnrollment('super-admin@sakanify.com');
    const user = {
      backup_codes: enrollment.backupCodeHashes.map((hash) => ({ code_hash: hash, used_at: null })),
    };

    const matched = await mfaService.findMatchingUnusedBackupCode(user, enrollment.backupCodesPlain[0]);
    expect(matched).not.toBeNull();
    expect(matched.code_hash).toBe(enrollment.backupCodeHashes[0]);
  });

  it('ignores an already-used entry even if the plaintext code matches', async () => {
    const enrollment = await mfaService.generateEnrollment('super-admin@sakanify.com');
    const user = {
      backup_codes: enrollment.backupCodeHashes.map((hash, i) => ({
        code_hash: hash,
        used_at: i === 0 ? new Date() : null,
      })),
    };

    const matched = await mfaService.findMatchingUnusedBackupCode(user, enrollment.backupCodesPlain[0]);
    expect(matched).toBeNull();
  });

  it('returns null for a code that was never issued', async () => {
    const enrollment = await mfaService.generateEnrollment('super-admin@sakanify.com');
    const user = {
      backup_codes: enrollment.backupCodeHashes.map((hash) => ({ code_hash: hash, used_at: null })),
    };

    const matched = await mfaService.findMatchingUnusedBackupCode(user, 'FFFFFFFFFF');
    expect(matched).toBeNull();
  });
});

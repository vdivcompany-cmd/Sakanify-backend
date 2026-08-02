/**
 * auth-jwt-algorithm.test.js
 *
 * Security-hardening-pass addition (threat-catalog Category B — "JWT
 * algorithm confusion"). Pure unit test, no database required: confirms
 * auth.service.verifyToken() rejects a token that is validly signed with
 * the right secret but a DIFFERENT algorithm than the HS256 this project
 * uses, and still accepts a normal HS256 token. Before this pass,
 * jwt.verify() was called without an `algorithms` allowlist, so it would
 * trust whatever `alg` the token's own header claimed.
 */

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sakanify_unit_test_placeholder';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'unit-test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'unit-test-refresh-secret';
// Remediation Pass 2 / SEC-002: env.config.js now requires a correctly-shaped
// MFA_ENCRYPTION_KEY (64 hex chars) to boot at all — this placeholder keeps
// this file independently runnable outside the full CI env, same reasoning
// as the two JWT placeholders above.
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || '0'.repeat(64);

const jwt = require('jsonwebtoken');
const authService = require('../../src/modules/auth/auth.service');
const env = require('../../src/config/env.config');

describe('auth.service JWT algorithm restriction', () => {
  it('accepts a normally-issued HS256 access token', () => {
    const { accessToken } = authService.issueTokens('507f1f77bcf86cd799439011', 'student', null);
    const decoded = authService.verifyToken(accessToken, 'access');
    expect(decoded.role).toBe('student');
  });

  it('rejects a token signed with a different algorithm (HS384) using the same secret', () => {
    const forged = jwt.sign(
      { userId: '507f1f77bcf86cd799439011', role: 'super-admin', ownerId: null, type: 'access', jti: 'forged' },
      env.jwt.accessSecret,
      { algorithm: 'HS384', expiresIn: '15m' },
    );

    expect(() => authService.verifyToken(forged, 'access')).toThrow();
  });

  it('rejects a token with alg "none" and no signature', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId: 'x', role: 'super-admin', type: 'access' })).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    expect(() => authService.verifyToken(noneToken, 'access')).toThrow();
  });
});

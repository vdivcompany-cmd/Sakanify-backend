/**
 * mfa.test.js
 *
 * Integration tests for Remediation Pass 2 / SEC-002
 * (Docs/reports/remediation-pass-2-mfa-report.md): mandatory Super-Admin
 * TOTP MFA. Covers, per the spec's implementation step 9 and CLAUDE.md
 * Section 6:
 *
 *   - Enrollment flow: login-owner (mfa_enabled: false) -> setup token ->
 *     POST /mfa/setup -> POST /mfa/verify-setup with a real TOTP code ->
 *     mfa_enabled flips to true in the DB, real tokens issued, mfa_enrolled
 *     audit-logged.
 *   - Login flow before/after enrollment (the same login-owner call takes
 *     a different branch depending on mfa_enabled).
 *   - Backup-code single-use enforcement (second use of the same code
 *     fails).
 *   - Admin-assisted MFA reset by a DIFFERENT Super-Admin, and explicit
 *     rejection of self-reset.
 *   - Rate limiting on verify-setup and verify-login.
 *   - Negative case: a Super-Admin cannot reach a real protected endpoint
 *     using only a setup/pending token (no real session exists until MFA
 *     is actually completed).
 *
 * TOTP codes are generated for real via otplib's own `generate()` against
 * the plaintext secret returned by /mfa/setup — nothing is faked/stubbed,
 * per CLAUDE.md's "the code runs is not sufficient evidence" testing rule.
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { generate: generateTotp } = require('otplib');
const app = require('../../src/app.entry');

const User = require('../../src/modules/auth/auth.model');
const Audit = require('../../src/modules/audit/audit.model');
const authService = require('../../src/modules/auth/auth.service');
const authRoutes = require('../../src/modules/auth/auth.routes');
const mfaRoutes = require('../../src/modules/auth/mfa.routes');
const { ROLES } = require('../../src/config/constants.config');

let mongoServer;
let uniqueCounter = 0;
function uniqueTag() {
  uniqueCounter += 1;
  return `${Date.now()}-${uniqueCounter}-${Math.random().toString(36).slice(2)}`;
}

const SUPER_ADMIN_PASSWORD = 'correct-horse-battery-staple';

/**
 * Creates a real Super-Admin row (mfa_enabled: false by schema default) —
 * deliberately goes through authService.hashPassword rather than a raw
 * string, since these tests exercise the real POST /api/auth/login-owner
 * endpoint, same pattern as admin.test.js's "Reactivate Account" test.
 */
async function createSuperAdminUser() {
  const tag = uniqueTag();
  const email = `super-${tag}@sakanify.com`;
  const user = await User.create({
    email,
    password_hash: await authService.hashPassword(SUPER_ADMIN_PASSWORD),
    role: ROLES.SUPER_ADMIN,
    status: 'active',
  });
  return { user, email };
}

async function loginAndGetSetupToken(email) {
  const res = await request(app)
    .post('/api/auth/login-owner')
    .send({ email, password: SUPER_ADMIN_PASSWORD });
  return res;
}

/**
 * Full enrollment: login -> /mfa/setup -> generate a real TOTP code from
 * the returned secret -> /mfa/verify-setup. Returns the confirmed tokens
 * plus the raw secret/backup codes so callers can exercise verify-login
 * afterwards.
 */
async function enrollSuperAdmin(email) {
  const loginRes = await loginAndGetSetupToken(email);
  const { setupToken } = loginRes.body.data;

  const setupRes = await request(app)
    .post('/api/auth/mfa/setup')
    .set('Authorization', `Bearer ${setupToken}`);

  const { secret, backup_codes: backupCodes, setup_token: enrichedSetupToken } = setupRes.body.data;
  const code = await generateTotp({ secret });

  const verifyRes = await request(app)
    .post('/api/auth/mfa/verify-setup')
    .set('Authorization', `Bearer ${enrichedSetupToken}`)
    .send({ code });

  return {
    secret, backupCodes, verifyRes, loginRes, setupRes,
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Audit.deleteMany({});

  // Same reasoning as auth.test.js/admin.test.js: every supertest request
  // in this process shares one simulated IP, so the IP-keyed
  // express-rate-limit stores must be reset between tests, not just given
  // unique test data.
  await authRoutes.rateLimitStores.login.resetAll();
  await mfaRoutes.rateLimitStores.setup.resetAll();
  await mfaRoutes.rateLimitStores.verifySetup.resetAll();
  await mfaRoutes.rateLimitStores.verifyLogin.resetAll();
});

describe('MFA — Login before enrollment', () => {
  it('login-owner returns mfaSetupRequired + setupToken, NOT real tokens, for a Super-Admin with mfa_enabled: false', async () => {
    const { email } = await createSuperAdminUser();
    const res = await loginAndGetSetupToken(email);

    expect(res.status).toBe(200);
    expect(res.body.data.mfaSetupRequired).toBe(true);
    expect(res.body.data.setupToken).toBeDefined();
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.body.data.refreshToken).toBeUndefined();
  });

  it('does not touch Owner login at all — an Owner logs in normally with real tokens', async () => {
    const tag = uniqueTag();
    const email = `owner-${tag}@sakanify.com`;
    const password = 'owner-password-123';
    await User.create({
      email,
      password_hash: await authService.hashPassword(password),
      role: ROLES.OWNER,
      owner_id: `owner-${tag}`,
      status: 'active',
    });

    const res = await request(app).post('/api/auth/login-owner').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.mfaSetupRequired).toBeUndefined();
    expect(res.body.data.mfaVerificationRequired).toBeUndefined();
  });
});

describe('MFA — Enrollment flow', () => {
  it('setup -> verify-setup with a real TOTP code persists mfa_enabled: true, issues real tokens, and audit-logs mfa_enrolled', async () => {
    const { user, email } = await createSuperAdminUser();
    const { verifyRes } = await enrollSuperAdmin(email);

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.accessToken).toBeDefined();
    expect(verifyRes.body.data.refreshToken).toBeDefined();

    const dbUser = await User.findById(user._id).select('+mfa_secret_encrypted +backup_codes');
    expect(dbUser.mfa_enabled).toBe(true);
    expect(dbUser.mfa_secret_encrypted).toBeTruthy();
    expect(dbUser.backup_codes.length).toBe(10);

    const auditEntry = await Audit.findOne({ action: 'mfa_enrolled', entity_id: user._id });
    expect(auditEntry).not.toBeNull();
  });

  it('rejects verify-setup with a wrong 6-digit code (401), and does not enable MFA', async () => {
    const { user, email } = await createSuperAdminUser();
    const loginRes = await loginAndGetSetupToken(email);
    const setupRes = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Authorization', `Bearer ${loginRes.body.data.setupToken}`);

    const res = await request(app)
      .post('/api/auth/mfa/verify-setup')
      .set('Authorization', `Bearer ${setupRes.body.data.setup_token}`)
      .send({ code: '000000' });

    expect(res.status).toBe(401);
    const dbUser = await User.findById(user._id);
    expect(dbUser.mfa_enabled).toBe(false);
  });

  it('rejects verify-setup called with a bare setup token that never called /setup first (400)', async () => {
    const { email } = await createSuperAdminUser();
    const loginRes = await loginAndGetSetupToken(email);

    const res = await request(app)
      .post('/api/auth/mfa/verify-setup')
      .set('Authorization', `Bearer ${loginRes.body.data.setupToken}`)
      .send({ code: '123456' });

    expect(res.status).toBe(400);
  });
});

describe('MFA — Login flow after enrollment', () => {
  it('login-owner now returns mfaVerificationRequired + pendingToken, not real tokens', async () => {
    const { email } = await createSuperAdminUser();
    await enrollSuperAdmin(email);

    await authRoutes.rateLimitStores.login.resetAll();
    const res = await loginAndGetSetupToken(email);

    expect(res.status).toBe(200);
    expect(res.body.data.mfaVerificationRequired).toBe(true);
    expect(res.body.data.pendingToken).toBeDefined();
    expect(res.body.data.accessToken).toBeUndefined();
  });

  it('verify-login with a real TOTP code issues real tokens', async () => {
    const { email } = await createSuperAdminUser();
    const { secret } = await enrollSuperAdmin(email);

    await authRoutes.rateLimitStores.login.resetAll();
    const loginRes = await loginAndGetSetupToken(email);
    const code = await generateTotp({ secret });

    const res = await request(app)
      .post('/api/auth/mfa/verify-login')
      .set('Authorization', `Bearer ${loginRes.body.data.pendingToken}`)
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
  });

  it('rejects verify-login with a wrong code (401)', async () => {
    const { email } = await createSuperAdminUser();
    await enrollSuperAdmin(email);

    await authRoutes.rateLimitStores.login.resetAll();
    const loginRes = await loginAndGetSetupToken(email);

    const res = await request(app)
      .post('/api/auth/mfa/verify-login')
      .set('Authorization', `Bearer ${loginRes.body.data.pendingToken}`)
      .send({ code: '000000' });

    expect(res.status).toBe(401);
  });
});

describe('MFA — Backup codes (single-use enforcement)', () => {
  it('a backup code works exactly once; the second use of the same code fails, and the first use is audit-logged distinctly', async () => {
    const { user, email } = await createSuperAdminUser();
    const { backupCodes } = await enrollSuperAdmin(email);
    const code = backupCodes[0];

    await authRoutes.rateLimitStores.login.resetAll();
    const firstLoginRes = await loginAndGetSetupToken(email);
    const firstUseRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .set('Authorization', `Bearer ${firstLoginRes.body.data.pendingToken}`)
      .send({ backup_code: code });

    expect(firstUseRes.status).toBe(200);
    expect(firstUseRes.body.data.accessToken).toBeDefined();

    const usageAudit = await Audit.findOne({ action: 'mfa_backup_code_used', entity_id: user._id });
    expect(usageAudit).not.toBeNull();

    // Second attempt with the SAME code must fail — needs a fresh pending
    // token (a real login-owner call), since the previous one already
    // consumed the pending session by succeeding.
    await authRoutes.rateLimitStores.login.resetAll();
    await mfaRoutes.rateLimitStores.verifyLogin.resetAll();
    const secondLoginRes = await loginAndGetSetupToken(email);
    const secondUseRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .set('Authorization', `Bearer ${secondLoginRes.body.data.pendingToken}`)
      .send({ backup_code: code });

    expect(secondUseRes.status).toBe(401);
  });
});

describe('MFA — Admin-assisted reset', () => {
  it('a DIFFERENT Super-Admin can reset a locked-out Super-Admin\'s MFA, clearing mfa_enabled and audit-logging mfa_reset_by_admin', async () => {
    const { user: targetUser, email: targetEmail } = await createSuperAdminUser();
    await enrollSuperAdmin(targetEmail);

    const { email: actorEmail } = await createSuperAdminUser();
    const actorUser = await User.findOne({ email: actorEmail });
    const actorToken = authService.issueTokens(actorUser._id.toString(), ROLES.SUPER_ADMIN, null).accessToken;

    const res = await request(app)
      .post(`/api/admin/super-admins/${targetUser._id}/reset-mfa`)
      .set('Authorization', `Bearer ${actorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.mfa_enabled).toBe(false);

    const dbUser = await User.findById(targetUser._id).select('+mfa_secret_encrypted +backup_codes');
    expect(dbUser.mfa_enabled).toBe(false);
    expect(dbUser.mfa_secret_encrypted).toBeNull();
    expect(dbUser.backup_codes.length).toBe(0);

    const resetAudit = await Audit.findOne({ action: 'mfa_reset_by_admin', entity_id: targetUser._id });
    expect(resetAudit).not.toBeNull();
    expect(resetAudit.actor.toString()).toBe(actorUser._id.toString());

    // The reset target is now back in the "needs setup" branch on next login.
    const postResetLogin = await loginAndGetSetupToken(targetEmail);
    expect(postResetLogin.body.data.mfaSetupRequired).toBe(true);
  });

  it('rejects a Super-Admin attempting to reset their OWN MFA (403)', async () => {
    const { user, email } = await createSuperAdminUser();
    await enrollSuperAdmin(email);
    const selfToken = authService.issueTokens(user._id.toString(), ROLES.SUPER_ADMIN, null).accessToken;

    const res = await request(app)
      .post(`/api/admin/super-admins/${user._id}/reset-mfa`)
      .set('Authorization', `Bearer ${selfToken}`);

    expect(res.status).toBe(403);
  });

  it('rejects resetting MFA for a non-Super-Admin target (422)', async () => {
    const { email: actorEmail } = await createSuperAdminUser();
    const actorUser = await User.findOne({ email: actorEmail });
    const actorToken = authService.issueTokens(actorUser._id.toString(), ROLES.SUPER_ADMIN, null).accessToken;

    const tag = uniqueTag();
    const owner = await User.create({
      email: `owner-${tag}@sakanify.com`,
      password_hash: 'hash',
      role: ROLES.OWNER,
      owner_id: `owner-${tag}`,
      status: 'active',
    });

    const res = await request(app)
      .post(`/api/admin/super-admins/${owner._id}/reset-mfa`)
      .set('Authorization', `Bearer ${actorToken}`);

    expect(res.status).toBe(422);
  });
});

describe('MFA — Rate limiting', () => {
  it('rate-limits verify-setup after repeated wrong-code attempts (429)', async () => {
    const { email } = await createSuperAdminUser();
    const loginRes = await loginAndGetSetupToken(email);
    const setupRes = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Authorization', `Bearer ${loginRes.body.data.setupToken}`);
    const enrichedToken = setupRes.body.data.setup_token;

    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post('/api/auth/mfa/verify-setup')
        .set('Authorization', `Bearer ${enrichedToken}`)
        .send({ code: '000000' });
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });

  it('rate-limits verify-login after repeated wrong-code attempts (429)', async () => {
    const { email } = await createSuperAdminUser();
    await enrollSuperAdmin(email);

    await authRoutes.rateLimitStores.login.resetAll();
    const loginRes = await loginAndGetSetupToken(email);
    const pendingToken = loginRes.body.data.pendingToken;

    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post('/api/auth/mfa/verify-login')
        .set('Authorization', `Bearer ${pendingToken}`)
        .send({ code: '000000' });
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });
});

describe('MFA — Negative case: scoped tokens cannot reach real endpoints', () => {
  it('a bare setup token cannot be used to call a real protected endpoint (401)', async () => {
    const { email } = await createSuperAdminUser();
    const loginRes = await loginAndGetSetupToken(email);

    const res = await request(app)
      .get('/api/admin/owners')
      .set('Authorization', `Bearer ${loginRes.body.data.setupToken}`);

    expect(res.status).toBe(401);
  });

  it('a pending (mfa_pending) token cannot be used to call a real protected endpoint (401)', async () => {
    const { email } = await createSuperAdminUser();
    await enrollSuperAdmin(email);

    await authRoutes.rateLimitStores.login.resetAll();
    const loginRes = await loginAndGetSetupToken(email);

    const res = await request(app)
      .get('/api/admin/owners')
      .set('Authorization', `Bearer ${loginRes.body.data.pendingToken}`);

    expect(res.status).toBe(401);
  });

  it('a pending token cannot be used to call POST /mfa/setup (wrong scope, 401)', async () => {
    const { email } = await createSuperAdminUser();
    await enrollSuperAdmin(email);

    await authRoutes.rateLimitStores.login.resetAll();
    const loginRes = await loginAndGetSetupToken(email);

    const res = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Authorization', `Bearer ${loginRes.body.data.pendingToken}`);

    expect(res.status).toBe(401);
  });
});

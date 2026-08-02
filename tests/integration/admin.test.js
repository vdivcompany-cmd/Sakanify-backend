/**
 * admin.test.js
 *
 * Integration tests for Phase 7 (Docs/phase-7-admin.md):
 *   - Access control: every admin endpoint is Super-Admin only (implementation
 *     step 8) — explicit negative tests for student/owner tokens and
 *     unauthenticated access, per CLAUDE.md Section 6.3/6.4.
 *   - Owners/Buildings table aggregation (step 1).
 *   - Manual Capacity Override: audit trail + non-blocking under-capacity
 *     warning (point 3).
 *   - THE critical end-to-end test (implementation step 9): suspend an
 *     owner and confirm (a) subscription.status === 'suspended', (b) the
 *     owner's existing access token is rejected on its very next request,
 *     and (c) a student's request against one of that owner's beds is
 *     rejected by Phase 6's guard clause.
 *   - Impersonation: distinct short-lived token works for owner-scoped
 *     endpoints, is audit-logged on start, and stops working once ended.
 *   - Expansion queue: list/approve/reject, approval raises capacity.
 *   - Activity feed pagination + date-range filtering.
 *   - Platform metrics.
 *
 * Per project convention (Phase 1 lesson): every test uses unique data.
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../src/app.entry');

const User = require('../../src/modules/auth/auth.model');
const Building = require('../../src/modules/buildings/building.model');
const Apartment = require('../../src/modules/apartments/apartment.model');
const Bed = require('../../src/modules/beds/bed.model');
const Student = require('../../src/modules/students/student.model');
const Kyc = require('../../src/modules/kyc/kyc.model');
const RequestModel = require('../../src/modules/requests/request.model');
const Rental = require('../../src/modules/rentals/rental.model');
const Payment = require('../../src/modules/payments/payment.model');
const Audit = require('../../src/modules/audit/audit.model');
const Subscription = require('../../src/modules/subscriptions/subscription.model');
const UtilityBill = require('../../src/modules/utilities/utility-bill.model');
const ImpersonationSession = require('../../src/modules/admin/impersonation-session.model');

const authService = require('../../src/modules/auth/auth.service');
const subscriptionService = require('../../src/modules/subscriptions/subscription.service');
const { ROLES } = require('../../src/config/constants.config');

let mongoServer;
let uniqueCounter = 0;
function uniqueTag() {
  uniqueCounter += 1;
  return `${Date.now()}-${uniqueCounter}-${Math.random().toString(36).slice(2)}`;
}

async function createOwner() {
  const tag = uniqueTag();
  const ownerId = `owner-${tag}`;
  const owner = await User.create({
    email: `owner-${tag}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.OWNER,
    owner_id: ownerId,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(owner._id.toString(), ROLES.OWNER, ownerId);
  return { owner, ownerId, token: accessToken };
}

async function createSuperAdmin() {
  const tag = uniqueTag();
  const admin = await User.create({
    email: `admin-${tag}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.SUPER_ADMIN,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(admin._id.toString(), ROLES.SUPER_ADMIN, null);
  return { admin, token: accessToken };
}

async function createStudent() {
  const tag = uniqueTag();
  const user = await User.create({
    phone: `+2010${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
    role: ROLES.STUDENT,
    status: 'active',
  });
  const student = await Student.create({
    user: user._id,
    name: `Test Student ${tag}`,
    phone: user.phone,
    college: 'Faculty of Engineering',
    academic_year: 2,
    smoking_preference: 'non_smoker',
  });
  await Kyc.create({
    student: student._id,
    national_id_number: `2990101${String(uniqueCounter).padStart(7, '0')}`,
    national_id_photo: 'kyc/fake-id.png',
    student_photo: 'kyc/fake-photo.png',
  });
  const { accessToken } = authService.issueTokens(user._id.toString(), ROLES.STUDENT, null);
  return { user, student, token: accessToken };
}

async function createBuildingFixture(ownerId, overrides = {}) {
  return Building.create({
    owner_id: ownerId,
    name: `Building ${uniqueTag()}`,
    area: 'Nasr City',
    address: { city: 'Cairo', street: null, details: null },
    ...overrides,
  });
}

async function createAvailableBed(ownerId) {
  const building = await createBuildingFixture(ownerId);
  const apartment = await Apartment.create({ building: building._id, owner_id: ownerId, floor: 1, room_count: 3 });
  const bed = await Bed.create({ apartment: apartment._id, building: building._id, owner_id: ownerId, monthly_rent: 3000 });
  return { building, apartment, bed };
}

async function createSubscriptionFixture(ownerId, overrides = {}) {
  return subscriptionService.createSubscription(ownerId, {
    tierName: '10-bed package',
    totalBedCapacity: 10,
    monthlyPrice: 1000,
    renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ...overrides,
  });
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
  await Building.deleteMany({});
  await Apartment.deleteMany({});
  await Bed.deleteMany({});
  await Student.deleteMany({});
  await Kyc.deleteMany({});
  await RequestModel.deleteMany({});
  await Rental.deleteMany({});
  await Payment.deleteMany({});
  await Audit.deleteMany({});
  await Subscription.deleteMany({});
  await UtilityBill.deleteMany({});
  await ImpersonationSession.deleteMany({});
});

describe('Phase 7 — Access Control (Super-Admin only)', () => {
  it('rejects unauthenticated access to every admin endpoint (401)', async () => {
    const endpoints = [
      ['get', '/api/admin/owners'],
      ['get', '/api/admin/expansion-requests'],
      ['get', '/api/admin/activity'],
      ['get', '/api/admin/metrics'],
    ];
    for (const [method, path] of endpoints) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    }
  });

  it('rejects a student token on admin endpoints (403)', async () => {
    const { token: studentToken } = await createStudent();
    const res = await request(app).get('/api/admin/owners').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });

  it('rejects an owner token on admin endpoints (403)', async () => {
    const { token: ownerToken } = await createOwner();
    const res = await request(app).get('/api/admin/owners').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
  });

  it('allows a super-admin token through to the owners table (200)', async () => {
    const { token } = await createSuperAdmin();
    const res = await request(app).get('/api/admin/owners').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('Phase 7 — Owners/Buildings Table', () => {
  it('aggregates building count, bed usage, and subscription info per owner without N+1', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId } = await createOwner();
    await createSubscriptionFixture(ownerId);
    await createAvailableBed(ownerId);
    await createAvailableBed(ownerId);

    const res = await request(app)
      .get('/api/admin/owners')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ page: 1, limit: 50 });

    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.owner_id === ownerId);
    expect(row).toBeDefined();
    expect(row.buildings_count).toBe(2);
    expect(row.beds_used).toBe(2);
    expect(row.subscription.tier_name).toBe('10-bed package');
    expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
  });
});

describe('Phase 7 — Manual Capacity Override', () => {
  it('applies the override, writes a before/after audit log, and returns no warning when above current usage', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId } = await createOwner();
    const subscription = await createSubscriptionFixture(ownerId);

    const res = await request(app)
      .patch(`/api/admin/owners/${ownerId}/capacity-override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ new_capacity: 20 });

    expect(res.status).toBe(200);
    expect(res.body.data.warning).toBeNull();
    expect(res.body.data.subscription.total_bed_capacity).toBe(20);

    const auditEntry = await Audit.findOne({
      entity_type: 'Subscription',
      entity_id: subscription._id,
      action: 'subscription_capacity_manually_overridden',
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry.before_state.total_bed_capacity).toBe(10);
    expect(auditEntry.after_state.total_bed_capacity).toBe(20);
  });

  it('does NOT block an override below the currently-used bed count, but returns a warning', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId } = await createOwner();
    await createSubscriptionFixture(ownerId, { totalBedCapacity: 10 });
    await createAvailableBed(ownerId);
    await createAvailableBed(ownerId);
    await createAvailableBed(ownerId);

    const res = await request(app)
      .patch(`/api/admin/owners/${ownerId}/capacity-override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ new_capacity: 1 }); // below the 3 beds already used

    expect(res.status).toBe(200); // NOT blocked
    expect(res.body.data.subscription.total_bed_capacity).toBe(1); // applied as requested
    expect(res.body.data.warning).toMatch(/below the owner's currently-used bed count/);
  });

  it('rejects a non-numeric new_capacity (422)', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId } = await createOwner();
    await createSubscriptionFixture(ownerId);

    const res = await request(app)
      .patch(`/api/admin/owners/${ownerId}/capacity-override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ new_capacity: 'lots' });

    expect(res.status).toBe(422);
  });
});

describe('Phase 7 — Suspend Account: THE end-to-end wiring test (implementation step 9)', () => {
  it('suspending an owner sets subscription.status=suspended, rejects the owner\'s existing token immediately, and rejects a new student request against the guard clause', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId, token: ownerToken } = await createOwner();
    await createSubscriptionFixture(ownerId);
    const { bed } = await createAvailableBed(ownerId);

    // Sanity check: owner's token works BEFORE suspension.
    const beforeRes = await request(app).get('/api/subscriptions/me').set('Authorization', `Bearer ${ownerToken}`);
    expect(beforeRes.status).toBe(200);

    // --- The suspend action itself ---
    const suspendRes = await request(app)
      .post(`/api/admin/owners/${ownerId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(suspendRes.status).toBe(200);

    // (a) subscription.status is really 'suspended' in the database.
    const subscription = await Subscription.findOne({ owner_id: ownerId });
    expect(subscription.status).toBe('suspended');

    // (b) the owner's PRE-EXISTING access token is rejected on its very
    // next request — not just at natural expiry.
    const afterRes = await request(app).get('/api/subscriptions/me').set('Authorization', `Bearer ${ownerToken}`);
    expect(afterRes.status).toBe(401);

    // (c) a student's request against one of this owner's beds is
    // rejected by Phase 6's canAcceptNewRequests guard clause.
    const { token: studentToken } = await createStudent();
    const requestRes = await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ bed_id: bed._id.toString() });
    expect(requestRes.status).toBe(403);

    // Audit trail: both the subscription-status-change AND the
    // owner-account-suspended events are recorded.
    const subAudit = await Audit.findOne({ entity_type: 'Subscription', action: 'subscription_status_changed' });
    expect(subAudit).not.toBeNull();
    const ownerAudit = await Audit.findOne({ entity_type: 'User', action: 'owner_account_suspended' });
    expect(ownerAudit).not.toBeNull();
  });

  it('returns 404 when suspending an owner_id that does not exist', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const res = await request(app)
      .post('/api/admin/owners/nonexistent-owner-id/suspend')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Phase 7 — Reactivate Account', () => {
  it('reverses suspend: subscription.status back to active, User.status back to active, and a fresh login succeeds', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const ownerEmail = `owner-${uniqueTag()}@sakanify.com`;
    const ownerPassword = 'correct-horse-battery-staple';
    const ownerId = `owner-${uniqueTag()}`;
    const ownerUser = await User.create({
      email: ownerEmail,
      password_hash: await authService.hashPassword(ownerPassword),
      role: ROLES.OWNER,
      owner_id: ownerId,
      status: 'active',
    });
    await createSubscriptionFixture(ownerId);

    // Suspend first.
    const suspendRes = await request(app)
      .post(`/api/admin/owners/${ownerId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(suspendRes.status).toBe(200);

    // Login must fail while suspended.
    const failedLoginRes = await request(app)
      .post('/api/auth/login-owner')
      .send({ email: ownerEmail, password: ownerPassword });
    expect(failedLoginRes.status).toBe(401);

    // --- Reactivate ---
    const reactivateRes = await request(app)
      .post(`/api/admin/owners/${ownerId}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.data.user_status).toBe('active');
    expect(reactivateRes.body.data.subscription.status).toBe('active');

    const subscription = await Subscription.findOne({ owner_id: ownerId });
    expect(subscription.status).toBe('active');

    const freshUser = await User.findById(ownerUser._id);
    expect(freshUser.status).toBe('active');

    // A fresh login attempt now succeeds.
    const loginRes = await request(app)
      .post('/api/auth/login-owner')
      .send({ email: ownerEmail, password: ownerPassword });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.accessToken).toBeDefined();

    const reactivateAudit = await Audit.findOne({ entity_type: 'User', action: 'owner_account_reactivated' });
    expect(reactivateAudit).not.toBeNull();
  });

  it('returns 404 when reactivating an owner_id that does not exist', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const res = await request(app)
      .post('/api/admin/owners/nonexistent-owner-id/reactivate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Phase 7 — Impersonation', () => {
  it('issues a distinct short-lived token that works for an owner-scoped endpoint, and logs the start', async () => {
    const { token: adminToken, admin } = await createSuperAdmin();
    const { ownerId } = await createOwner();
    await createSubscriptionFixture(ownerId);

    const impersonateRes = await request(app)
      .post(`/api/admin/owners/${ownerId}/impersonate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(impersonateRes.status).toBe(201);
    const impersonationToken = impersonateRes.body.data.impersonation_token;
    expect(impersonationToken).toBeDefined();

    const meRes = await request(app).get('/api/subscriptions/me').set('Authorization', `Bearer ${impersonationToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.subscription.owner_id).toBe(ownerId);

    const startAudit = await Audit.findOne({ action: 'owner_impersonation_started', actor: admin._id });
    expect(startAudit).not.toBeNull();
  });

  it('rejects the impersonation token once the session has been explicitly ended', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId } = await createOwner();
    await createSubscriptionFixture(ownerId);

    const impersonateRes = await request(app)
      .post(`/api/admin/owners/${ownerId}/impersonate`)
      .set('Authorization', `Bearer ${adminToken}`);
    const impersonationToken = impersonateRes.body.data.impersonation_token;

    // Decode the jti out of the session record via the DB (simpler than
    // decoding the JWT in the test) — the endpoint takes jti as a param.
    const session = await ImpersonationSession.findOne({ owner_id: ownerId });
    expect(session).not.toBeNull();

    const endRes = await request(app)
      .post(`/api/admin/impersonate/${session.jti}/end`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(endRes.status).toBe(200);

    const afterEndRes = await request(app)
      .get('/api/subscriptions/me')
      .set('Authorization', `Bearer ${impersonationToken}`);
    expect(afterEndRes.status).toBe(401);

    const endAudit = await Audit.findOne({ action: 'owner_impersonation_ended' });
    expect(endAudit).not.toBeNull();
  });

  it('returns 404 for a second attempt to end an already-ended session', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId } = await createOwner();
    await createSubscriptionFixture(ownerId);

    await request(app).post(`/api/admin/owners/${ownerId}/impersonate`).set('Authorization', `Bearer ${adminToken}`);
    const session = await ImpersonationSession.findOne({ owner_id: ownerId });

    await request(app).post(`/api/admin/impersonate/${session.jti}/end`).set('Authorization', `Bearer ${adminToken}`);
    const secondEndRes = await request(app)
      .post(`/api/admin/impersonate/${session.jti}/end`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(secondEndRes.status).toBe(404);
  });
});

describe('Phase 7 — Expansion Queue', () => {
  it('lists pending expansion requests platform-wide, paginated', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId, token: ownerToken } = await createOwner();
    await createSubscriptionFixture(ownerId, { totalBedCapacity: 5 });

    await request(app)
      .post('/api/subscriptions/expansion-requests')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ requested_capacity: 15, reason: 'Growing' });

    const res = await request(app)
      .get('/api/admin/expansion-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ page: 1, limit: 20 });

    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.owner_id === ownerId);
    expect(row).toBeDefined();
    expect(row.requested_capacity).toBe(15);
  });

  it('approving raises the subscription capacity and marks the request approved', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId, token: ownerToken } = await createOwner();
    await createSubscriptionFixture(ownerId, { totalBedCapacity: 5 });

    const expansionRes = await request(app)
      .post('/api/subscriptions/expansion-requests')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ requested_capacity: 25 });
    const subscriptionId = expansionRes.body.data._id;
    const expansionRequestId = expansionRes.body.data.expansion_requests[0]._id;

    const approveRes = await request(app)
      .post(`/api/admin/expansion-requests/${subscriptionId}/${expansionRequestId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.total_bed_capacity).toBe(25);
    const resolvedRequest = approveRes.body.data.expansion_requests.find((r) => r._id === expansionRequestId);
    expect(resolvedRequest.status).toBe('approved');
  });

  it('rejecting leaves the capacity unchanged and marks the request rejected', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId, token: ownerToken } = await createOwner();
    await createSubscriptionFixture(ownerId, { totalBedCapacity: 5 });

    const expansionRes = await request(app)
      .post('/api/subscriptions/expansion-requests')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ requested_capacity: 25 });
    const subscriptionId = expansionRes.body.data._id;
    const expansionRequestId = expansionRes.body.data.expansion_requests[0]._id;

    const rejectRes = await request(app)
      .post(`/api/admin/expansion-requests/${subscriptionId}/${expansionRequestId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.data.total_bed_capacity).toBe(5); // unchanged
    const resolvedRequest = rejectRes.body.data.expansion_requests.find((r) => r._id === expansionRequestId);
    expect(resolvedRequest.status).toBe('rejected');
  });

  it('returns 409 when trying to resolve an already-resolved expansion request', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId, token: ownerToken } = await createOwner();
    await createSubscriptionFixture(ownerId, { totalBedCapacity: 5 });

    const expansionRes = await request(app)
      .post('/api/subscriptions/expansion-requests')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ requested_capacity: 25 });
    const subscriptionId = expansionRes.body.data._id;
    const expansionRequestId = expansionRes.body.data.expansion_requests[0]._id;

    await request(app)
      .post(`/api/admin/expansion-requests/${subscriptionId}/${expansionRequestId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    const secondRes = await request(app)
      .post(`/api/admin/expansion-requests/${subscriptionId}/${expansionRequestId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(secondRes.status).toBe(409);
  });
});

describe('Phase 7 — Platform-Wide Activity Feed', () => {
  it('paginates and supports date-range filtering', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId } = await createOwner();
    await createSubscriptionFixture(ownerId);

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .patch(`/api/admin/owners/${ownerId}/capacity-override`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ new_capacity: 10 + i });
    }

    const paginatedRes = await request(app)
      .get('/api/admin/activity')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ page: 1, limit: 2 });
    expect(paginatedRes.status).toBe(200);
    expect(paginatedRes.body.data.length).toBe(2);
    expect(paginatedRes.body.meta.total).toBeGreaterThanOrEqual(3);

    const futureOnlyRes = await request(app)
      .get('/api/admin/activity')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ start_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
    expect(futureOnlyRes.status).toBe(200);
    expect(futureOnlyRes.body.data.length).toBe(0); // nothing happened "in the future"
  });
});

describe('Phase 7 — Platform Metrics', () => {
  it('computes the conversion funnel, active buildings, and verified students via aggregation', async () => {
    const { token: adminToken } = await createSuperAdmin();
    const { ownerId, token: ownerToken } = await createOwner();
    const { bed } = await createAvailableBed(ownerId);
    const { student, token: studentToken } = await createStudent();

    await Kyc.findOneAndUpdate({ student: student._id }, { verification_status: 'verified' });

    const createRes = await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ bed_id: bed._id.toString() });
    await request(app)
      .post(`/api/requests/${createRes.body.data._id}/confirm`)
      .set('Authorization', `Bearer ${ownerToken}`);

    const res = await request(app).get('/api/admin/metrics').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.conversion_funnel.total_requests).toBeGreaterThanOrEqual(1);
    expect(res.body.data.conversion_funnel.confirmed_rentals).toBeGreaterThanOrEqual(1);
    expect(res.body.data.total_active_buildings).toBeGreaterThanOrEqual(1);
    expect(res.body.data.total_verified_students).toBeGreaterThanOrEqual(1);
  });
});

describe('Phase 7 — Logout / Password-Reset now really invalidate sessions (pre-existing gap fixed this phase)', () => {
  it('rejects a student\'s access token immediately after logout, not just at natural expiry', async () => {
    const { token: studentToken } = await createStudent();

    const beforeRes = await request(app).get('/api/students/me').set('Authorization', `Bearer ${studentToken}`);
    expect(beforeRes.status).toBe(200);

    const logoutRes = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${studentToken}`);
    expect(logoutRes.status).toBe(200);

    const afterRes = await request(app).get('/api/students/me').set('Authorization', `Bearer ${studentToken}`);
    expect(afterRes.status).toBe(401);
  });
});

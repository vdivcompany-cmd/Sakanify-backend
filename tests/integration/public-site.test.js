/**
 * public-site.test.js
 *
 * Integration tests for Phase 8 (Docs/phase-8-public-site.md), covering:
 * - Public building directory: only buildings whose owner has an ACTIVE
 *   subscription appear at all; area filtering; pagination.
 * - Public building detail: 404 (not 403) for a building whose owner
 *   isn't actively subscribed (SUSPENDED/OVERDUE/no subscription);
 *   occupancy collapsed to a rounded percentage; verified badge.
 * - Public transparency counters.
 * - THE core corrected-design guarantee: submitting a public lead never
 *   changes Bed.status and never creates a Request document (Docs/
 *   phase-8-public-site.md's "Critical Design Decision — Public Leads
 *   Are NOT Requests").
 * - Lead submission rejected for a bed belonging to a non-actively-
 *   subscribed owner (same 404 shape as bed-not-found).
 * - IP rate limiting: stricter limit on POST /api/public/leads than on
 *   the browsing endpoints (implementation step 7/8).
 * - Owner-facing "my public leads" list/detail: ownership isolation
 *   negative test (CLAUDE.md Section 6.3), role guards (student/
 *   super-admin rejected).
 *
 * Per project convention (Phase 1 lesson): every test uses unique data.
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../src/app.entry');
const publicRoutes = require('../../src/modules/public-site/public.routes');

const User = require('../../src/modules/auth/auth.model');
const Building = require('../../src/modules/buildings/building.model');
const Apartment = require('../../src/modules/apartments/apartment.model');
const Bed = require('../../src/modules/beds/bed.model');
const Subscription = require('../../src/modules/subscriptions/subscription.model');
const RequestModel = require('../../src/modules/requests/request.model');
const PublicLead = require('../../src/modules/public-site/public-lead.model');
const Audit = require('../../src/modules/audit/audit.model');

const authService = require('../../src/modules/auth/auth.service');
const { ROLES, BED_STATUS, SUBSCRIPTION_STATUS } = require('../../src/config/constants.config');

let mongoServer;
let uniqueCounter = 0;
function uniqueTag() {
  uniqueCounter += 1;
  return `${Date.now()}-${uniqueCounter}-${Math.random().toString(36).slice(2)}`;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
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
  await Subscription.deleteMany({});
  await RequestModel.deleteMany({});
  await PublicLead.deleteMany({});
  await Audit.deleteMany({});

  // Same reasoning as auth.test.js: every supertest request in this
  // process shares one simulated IP, so the IP-keyed limiters below need
  // an explicit reset between tests.
  await publicRoutes.rateLimitStores.browsing.resetAll();
  await publicRoutes.rateLimitStores.lead.resetAll();
});

async function createOwnerWithSubscription(status = SUBSCRIPTION_STATUS.ACTIVE) {
  const tag = uniqueTag();
  const ownerId = `owner-${tag}`;
  const owner = await User.create({
    email: `owner-${tag}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.OWNER,
    owner_id: ownerId,
    status: 'active',
  });
  await Subscription.create({
    owner_id: ownerId,
    tier_name: 'Standard',
    total_bed_capacity: 50,
    monthly_price: 1000,
    status,
    renewal_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  const { accessToken } = authService.issueTokens(owner._id.toString(), ROLES.OWNER, ownerId);
  return { owner, ownerId, token: accessToken };
}

async function createStudentToken() {
  const tag = uniqueTag();
  const user = await User.create({
    phone: `+2010${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
    role: ROLES.STUDENT,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(user._id.toString(), ROLES.STUDENT, null);
  return accessToken;
}

async function createSuperAdminToken() {
  const tag = uniqueTag();
  const admin = await User.create({
    email: `admin-${tag}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.SUPER_ADMIN,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(admin._id.toString(), ROLES.SUPER_ADMIN, null);
  return accessToken;
}

async function createBuildingWithBed(ownerId, { area = 'Nasr City', bedStatus = BED_STATUS.AVAILABLE } = {}) {
  const building = await Building.create({
    owner_id: ownerId,
    name: `Building ${uniqueTag()}`,
    area,
    address: { city: 'Cairo', street: 'Main St', details: 'Floor 2' },
  });
  const apartment = await Apartment.create({ building: building._id, owner_id: ownerId, floor: 1, room_count: 3 });
  const bed = await Bed.create({
    apartment: apartment._id,
    building: building._id,
    owner_id: ownerId,
    status: bedStatus,
    monthly_rent: 2500,
  });
  return { building, apartment, bed };
}

describe('Phase 8 - Public Site API', () => {
  describe('GET /api/public/buildings', () => {
    it('only lists buildings whose owner has an ACTIVE subscription', async () => {
      const { ownerId: activeOwnerId } = await createOwnerWithSubscription(SUBSCRIPTION_STATUS.ACTIVE);
      const { ownerId: suspendedOwnerId } = await createOwnerWithSubscription(SUBSCRIPTION_STATUS.SUSPENDED);
      const { ownerId: overdueOwnerId } = await createOwnerWithSubscription(SUBSCRIPTION_STATUS.OVERDUE);

      const { building: activeBuilding } = await createBuildingWithBed(activeOwnerId);
      await createBuildingWithBed(suspendedOwnerId);
      await createBuildingWithBed(overdueOwnerId);

      const res = await request(app).get('/api/public/buildings');

      expect(res.status).toBe(200);
      const ids = res.body.data.map((b) => b._id || b.id);
      expect(ids).toContain(activeBuilding._id.toString());
      expect(res.body.data.length).toBe(1);
    });

    it('never lists a building for an owner with no subscription at all', async () => {
      const tag = uniqueTag();
      const ownerId = `owner-${tag}`;
      await User.create({
        email: `owner-${tag}@sakanify.com`,
        password_hash: 'hash',
        role: ROLES.OWNER,
        owner_id: ownerId,
        status: 'active',
      });
      await createBuildingWithBed(ownerId);

      const res = await request(app).get('/api/public/buildings');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(0);
    });

    it('filters by area', async () => {
      const { ownerId } = await createOwnerWithSubscription();
      await createBuildingWithBed(ownerId, { area: 'Nasr City' });
      await createBuildingWithBed(ownerId, { area: 'Sohag' });

      const res = await request(app).get('/api/public/buildings').query({ area: 'Sohag' });
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].area).toBe('Sohag');
    });

    it('never exposes owner_id or address.details in the public listing', async () => {
      const { ownerId } = await createOwnerWithSubscription();
      await createBuildingWithBed(ownerId);

      const res = await request(app).get('/api/public/buildings');
      expect(res.status).toBe(200);
      expect(res.body.data[0].owner_id).toBeUndefined();
      expect(res.body.data[0].address.details).toBeUndefined();
    });

    it('is paginated', async () => {
      const res = await request(app).get('/api/public/buildings');
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual(
        expect.objectContaining({ total: expect.any(Number), page: expect.any(Number), limit: expect.any(Number) }),
      );
    });
  });

  describe('GET /api/public/buildings/:buildingId', () => {
    it('returns occupancy percent and a verified badge for an actively-subscribed building', async () => {
      const { ownerId } = await createOwnerWithSubscription();
      const { building } = await createBuildingWithBed(ownerId, { bedStatus: BED_STATUS.OCCUPIED });

      const res = await request(app).get(`/api/public/buildings/${building._id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.verified).toBe(true);
      expect(res.body.data.occupancy_percent).toBe(100);
      expect(res.body.data.owner_id).toBeUndefined();
    });

    it('never returns a per-bed breakdown', async () => {
      const { ownerId } = await createOwnerWithSubscription();
      const { building } = await createBuildingWithBed(ownerId);

      const res = await request(app).get(`/api/public/buildings/${building._id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.beds).toBeUndefined();
      expect(res.body.data.available).toBeUndefined();
      expect(res.body.data.occupied).toBeUndefined();
    });

    it('returns 404 (not 403) for a building whose owner is SUSPENDED', async () => {
      const { ownerId } = await createOwnerWithSubscription(SUBSCRIPTION_STATUS.SUSPENDED);
      const { building } = await createBuildingWithBed(ownerId);

      const res = await request(app).get(`/api/public/buildings/${building._id}`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for a nonexistent building id', async () => {
      const res = await request(app).get(`/api/public/buildings/${new mongoose.Types.ObjectId()}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/public/counters', () => {
    it('returns non-sensitive aggregate counters', async () => {
      const res = await request(app).get('/api/public/counters');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          total_verified_buildings: expect.any(Number),
          total_verified_students: expect.any(Number),
        }),
      );
    });
  });

  describe('POST /api/public/leads — the corrected design', () => {
    it('creates a PublicLead without touching Bed.status or creating a Request', async () => {
      const { ownerId } = await createOwnerWithSubscription();
      const { bed } = await createBuildingWithBed(ownerId, { bedStatus: BED_STATUS.AVAILABLE });

      const res = await request(app).post('/api/public/leads').send({
        name: 'Sara Ahmed',
        phone: '+201001234567',
        note: 'Interested in a September move-in',
        bed_id: bed._id.toString(),
      });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('new');

      const bedAfter = await Bed.findById(bed._id);
      expect(bedAfter.status).toBe(BED_STATUS.AVAILABLE); // untouched

      const requestCount = await RequestModel.countDocuments({});
      expect(requestCount).toBe(0); // never created

      const leadCount = await PublicLead.countDocuments({ bed: bed._id });
      expect(leadCount).toBe(1);
    });

    it('never lets an anonymous submission lock a bed even if repeated rapidly', async () => {
      const { ownerId } = await createOwnerWithSubscription();
      const { bed } = await createBuildingWithBed(ownerId, { bedStatus: BED_STATUS.AVAILABLE });

      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await request(app).post('/api/public/leads').send({
          name: `Visitor ${i}`,
          phone: `+20100000000${i}`,
          bed_id: bed._id.toString(),
        });
      }

      const bedAfter = await Bed.findById(bed._id);
      expect(bedAfter.status).toBe(BED_STATUS.AVAILABLE);
      expect(await RequestModel.countDocuments({})).toBe(0);
    });

    it('rejects a lead for a bed whose owner is not actively subscribed, as a 404', async () => {
      const { ownerId } = await createOwnerWithSubscription(SUBSCRIPTION_STATUS.SUSPENDED);
      const { bed } = await createBuildingWithBed(ownerId);

      const res = await request(app).post('/api/public/leads').send({
        name: 'Sara Ahmed',
        phone: '+201001234567',
        bed_id: bed._id.toString(),
      });

      expect(res.status).toBe(404);
      expect(await PublicLead.countDocuments({})).toBe(0);
    });

    it('validates required fields', async () => {
      const res = await request(app).post('/api/public/leads').send({ phone: '+201001234567' });
      expect(res.status).toBe(422);
    });

    it('writes an audit log entry with a null actor', async () => {
      const { ownerId } = await createOwnerWithSubscription();
      const { bed } = await createBuildingWithBed(ownerId);

      await request(app).post('/api/public/leads').send({
        name: 'Sara Ahmed',
        phone: '+201001234567',
        bed_id: bed._id.toString(),
      });

      const entry = await Audit.findOne({ action: 'public_lead_submitted' });
      expect(entry).not.toBeNull();
      expect(entry.actor).toBeNull();
    });

    it('rate-limits lead submission more strictly than browsing (max 5 per window)', async () => {
      const { ownerId } = await createOwnerWithSubscription();
      const { bed } = await createBuildingWithBed(ownerId);

      let lastStatus;
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app).post('/api/public/leads').send({
          name: `Visitor ${i}`,
          phone: `+20100000000${i}`,
          bed_id: bed._id.toString(),
        });
        lastStatus = res.status;
      }

      expect(lastStatus).toBe(429);
    });
  });

  describe('Owner-facing: GET /api/public/leads/mine', () => {
    it('lists only the authenticated owner\'s own leads', async () => {
      const { ownerId: ownerAId, token: ownerAToken } = await createOwnerWithSubscription();
      const { ownerId: ownerBId } = await createOwnerWithSubscription();
      const { bed: bedA } = await createBuildingWithBed(ownerAId);
      const { bed: bedB } = await createBuildingWithBed(ownerBId);

      await request(app).post('/api/public/leads').send({ name: 'A', phone: '+201000000001', bed_id: bedA._id.toString() });
      await request(app).post('/api/public/leads').send({ name: 'B', phone: '+201000000002', bed_id: bedB._id.toString() });

      const res = await request(app).get('/api/public/leads/mine').set('Authorization', `Bearer ${ownerAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].owner_id).toBe(ownerAId);
    });

    it('rejects student and super-admin tokens (role guard)', async () => {
      const studentToken = await createStudentToken();
      const adminToken = await createSuperAdminToken();

      const studentRes = await request(app).get('/api/public/leads/mine').set('Authorization', `Bearer ${studentToken}`);
      expect(studentRes.status).toBe(403);

      const adminRes = await request(app).get('/api/public/leads/mine').set('Authorization', `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(403);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request(app).get('/api/public/leads/mine');
      expect(res.status).toBe(401);
    });
  });

  describe('Owner-facing: GET /api/public/leads/mine/:leadId — ownership isolation', () => {
    it('lets Owner A read their own lead', async () => {
      const { ownerId, token } = await createOwnerWithSubscription();
      const { bed } = await createBuildingWithBed(ownerId);

      const createRes = await request(app).post('/api/public/leads').send({
        name: 'Sara',
        phone: '+201001234567',
        bed_id: bed._id.toString(),
      });

      const res = await request(app)
        .get(`/api/public/leads/mine/${createRes.body.data.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.owner_id).toBe(ownerId);
    });

    it('blocks Owner B from reading Owner A\'s lead (explicit negative test, CLAUDE.md Section 6.3)', async () => {
      const { ownerId: ownerAId } = await createOwnerWithSubscription();
      const { token: ownerBToken } = await createOwnerWithSubscription();
      const { bed } = await createBuildingWithBed(ownerAId);

      const createRes = await request(app).post('/api/public/leads').send({
        name: 'Sara',
        phone: '+201001234567',
        bed_id: bed._id.toString(),
      });

      const res = await request(app)
        .get(`/api/public/leads/mine/${createRes.body.data.id}`)
        .set('Authorization', `Bearer ${ownerBToken}`);

      expect(res.status).toBe(403);
    });
  });
});

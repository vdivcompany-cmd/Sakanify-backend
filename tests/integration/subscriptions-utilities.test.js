/**
 * subscriptions-utilities.test.js
 *
 * Integration tests for Phase 6 (Docs/phase-6-subscriptions.md):
 *   - Owner subscriptions: usage calculation vs. capacity, the 90%
 *     warning threshold, expansion requests (including rejection of a
 *     non-expanding request), ownership isolation, role guards.
 *   - Building retrofit: utilities_included_in_rent toggle, default
 *     `true`, ownership isolation.
 *   - Optional utility bill splitting: equal split incl. the rounding-
 *     remainder case, rejection when utilities are included in rent,
 *     rejection when zero active students, the mandatory audit trail,
 *     and the explicit ownership-isolation negative test
 *     (CLAUDE.md Section 6.3).
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

const authService = require('../../src/modules/auth/auth.service');
const subscriptionService = require('../../src/modules/subscriptions/subscription.service');
const utilityBillService = require('../../src/modules/utilities/utility-bill.service');
const { ROLES, SUBSCRIPTION_STATUS } = require('../../src/config/constants.config');

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

/**
 * One apartment with `numBeds` beds, each rented out to a distinct
 * (freshly-confirmed) active student via the real request -> confirm
 * flow — the same "currently active rentals in an apartment" set
 * utility-bill.service splits a bill across.
 */
async function createApartmentWithActiveRentals(ownerId, ownerToken, numBeds, buildingOverrides = {}) {
  const building = await createBuildingFixture(ownerId, buildingOverrides);
  const apartment = await Apartment.create({ building: building._id, owner_id: ownerId, floor: 1, room_count: 3 });

  const rentals = [];
  for (let i = 0; i < numBeds; i += 1) {
    const bed = await Bed.create({
      apartment: apartment._id,
      building: building._id,
      owner_id: ownerId,
      monthly_rent: 3000,
    });
    // eslint-disable-next-line no-await-in-loop
    const { token: studentToken } = await createStudent();
    // eslint-disable-next-line no-await-in-loop
    const createRes = await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ bed_id: bed._id.toString() });
    // eslint-disable-next-line no-await-in-loop
    const confirmRes = await request(app)
      .post(`/api/requests/${createRes.body.data._id}/confirm`)
      .set('Authorization', `Bearer ${ownerToken}`);

    // eslint-disable-next-line no-await-in-loop
    const rental = await Rental.findById(confirmRes.body.data.rental._id);
    rentals.push(rental);
  }

  return { building, apartment, rentals };
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
});

describe('Phase 6 — Owner Subscriptions', () => {
  describe('Usage & Capacity', () => {
    it('should return 404 when an owner has no subscription yet', async () => {
      const { token } = await createOwner();
      const res = await request(app).get('/api/subscriptions/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('should compute beds_used vs. total_bed_capacity and flag near-capacity at >= 90%', async () => {
      const { ownerId, token } = await createOwner();
      await subscriptionService.createSubscription(ownerId, {
        tierName: '10-bed package',
        totalBedCapacity: 10,
        monthlyPrice: 1000,
        renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      const building = await createBuildingFixture(ownerId);
      const apartment = await Apartment.create({ building: building._id, owner_id: ownerId, floor: 1, room_count: 3 });
      for (let i = 0; i < 9; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Bed.create({ apartment: apartment._id, building: building._id, owner_id: ownerId, monthly_rent: 3000 });
      }

      const res = await request(app).get('/api/subscriptions/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.beds_used).toBe(9);
      expect(res.body.data.total_bed_capacity).toBe(10);
      expect(res.body.data.is_near_capacity).toBe(true); // 90% exactly
    });

    it('should NOT flag near-capacity below the 90% threshold', async () => {
      const { ownerId, token } = await createOwner();
      await subscriptionService.createSubscription(ownerId, {
        tierName: '10-bed package',
        totalBedCapacity: 10,
        monthlyPrice: 1000,
        renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      const building = await createBuildingFixture(ownerId);
      const apartment = await Apartment.create({ building: building._id, owner_id: ownerId, floor: 1, room_count: 3 });
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Bed.create({ apartment: apartment._id, building: building._id, owner_id: ownerId, monthly_rent: 3000 });
      }

      const res = await request(app).get('/api/subscriptions/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.is_near_capacity).toBe(false);
    });
  });

  describe('Expansion Requests', () => {
    it('should create a pending expansion request and write an audit log', async () => {
      const { ownerId, token } = await createOwner();
      const subscription = await subscriptionService.createSubscription(ownerId, {
        tierName: '10-bed package',
        totalBedCapacity: 10,
        monthlyPrice: 1000,
        renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      const res = await request(app)
        .post('/api/subscriptions/expansion-requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ requested_capacity: 25, reason: 'Growing fast' });

      expect(res.status).toBe(201);
      expect(res.body.data.expansion_requests.length).toBe(1);
      expect(res.body.data.expansion_requests[0].requested_capacity).toBe(25);
      expect(res.body.data.expansion_requests[0].status).toBe('pending');

      const auditEntry = await Audit.findOne({
        entity_type: 'Subscription',
        entity_id: subscription._id,
        action: 'subscription_expansion_requested',
      });
      expect(auditEntry).not.toBeNull();
    });

    it('should reject a requested_capacity that is not greater than current capacity (422)', async () => {
      const { ownerId, token } = await createOwner();
      await subscriptionService.createSubscription(ownerId, {
        tierName: '10-bed package',
        totalBedCapacity: 10,
        monthlyPrice: 1000,
        renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      const res = await request(app)
        .post('/api/subscriptions/expansion-requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ requested_capacity: 10 });

      expect(res.status).toBe(422);
    });

    it('should reject a non-numeric requested_capacity (422)', async () => {
      const { ownerId, token } = await createOwner();
      await subscriptionService.createSubscription(ownerId, {
        tierName: '10-bed package',
        totalBedCapacity: 10,
        monthlyPrice: 1000,
        renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      const res = await request(app)
        .post('/api/subscriptions/expansion-requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ requested_capacity: 'a lot please' });

      expect(res.status).toBe(422);
    });
  });

  describe('Ownership Isolation', () => {
    it("Owner B must never see Owner A's subscription via /me", async () => {
      const { ownerId: ownerAId } = await createOwner();
      await subscriptionService.createSubscription(ownerAId, {
        tierName: '10-bed package',
        totalBedCapacity: 10,
        monthlyPrice: 1000,
        renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      const { token: ownerBToken } = await createOwner(); // no subscription of their own

      const res = await request(app).get('/api/subscriptions/me').set('Authorization', `Bearer ${ownerBToken}`);
      expect(res.status).toBe(404); // never Owner A's data
    });
  });

  describe('Role Guards', () => {
    it('should reject a student token on subscription endpoints (403) and unauthenticated access (401)', async () => {
      const studentRes = await (async () => {
        const { token: studentToken } = await createStudent();
        return request(app).get('/api/subscriptions/me').set('Authorization', `Bearer ${studentToken}`);
      })();
      expect(studentRes.status).toBe(403);

      const unauthRes = await request(app).get('/api/subscriptions/me');
      expect(unauthRes.status).toBe(401);
    });
  });
});

describe('Phase 6 — Building Utilities Setting Retrofit', () => {
  it('should default utilities_included_in_rent to true on a new building', async () => {
    const { ownerId } = await createOwner();
    const building = await createBuildingFixture(ownerId);
    expect(building.utilities_included_in_rent).toBe(true);
  });

  it('should let the owner toggle utilities_included_in_rent to false and write an audit log', async () => {
    const { ownerId, token } = await createOwner();
    const building = await createBuildingFixture(ownerId);

    const res = await request(app)
      .patch(`/api/buildings/${building._id}/utilities-setting`)
      .set('Authorization', `Bearer ${token}`)
      .send({ utilities_included_in_rent: false });

    expect(res.status).toBe(200);
    expect(res.body.data.utilities_included_in_rent).toBe(false);

    const auditEntry = await Audit.findOne({
      entity_type: 'Building',
      entity_id: building._id,
      action: 'building_utilities_setting_changed',
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry.after_state.utilities_included_in_rent).toBe(false);
  });

  it('should reject a non-boolean value (422)', async () => {
    const { ownerId, token } = await createOwner();
    const building = await createBuildingFixture(ownerId);

    const res = await request(app)
      .patch(`/api/buildings/${building._id}/utilities-setting`)
      .set('Authorization', `Bearer ${token}`)
      .send({ utilities_included_in_rent: 'yes' });

    expect(res.status).toBe(422);
  });

  it("THE EXPLICIT ISOLATION TEST: Owner B must not be able to toggle Owner A's building setting", async () => {
    const { ownerId: ownerAId } = await createOwner();
    const building = await createBuildingFixture(ownerAId);
    const { token: ownerBToken } = await createOwner();

    const res = await request(app)
      .patch(`/api/buildings/${building._id}/utilities-setting`)
      .set('Authorization', `Bearer ${ownerBToken}`)
      .send({ utilities_included_in_rent: false });

    expect(res.status).toBe(403);

    const fresh = await Building.findById(building._id);
    expect(fresh.utilities_included_in_rent).toBe(true); // untouched
  });
});

describe('Phase 6 — Optional Utility Bill Splitting', () => {
  describe('Splitting math', () => {
    it('should split evenly with no remainder', () => {
      const shares = utilityBillService.splitAmountEqually(300, 3);
      expect(shares).toEqual([100, 100, 100]);
      expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(300, 2);
    });

    it('should assign the rounding remainder to the LAST student when the split does not divide evenly', () => {
      const shares = utilityBillService.splitAmountEqually(100, 3);
      expect(shares[0]).toBe(33.33);
      expect(shares[1]).toBe(33.33);
      expect(shares[2]).toBe(33.34); // remainder lands on the last student
      const sum = Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100;
      expect(sum).toBe(100); // shares sum EXACTLY to total_amount
    });
  });

  describe('Submitting a bill', () => {
    it("should reject a bill when the building's utilities are included in rent (409)", async () => {
      const { ownerId, token } = await createOwner();
      // utilities_included_in_rent defaults to true — never toggled off.
      const { apartment } = await createApartmentWithActiveRentals(ownerId, token, 2);

      const res = await request(app)
        .post(`/api/utilities/apartments/${apartment._id}/bills`)
        .set('Authorization', `Bearer ${token}`)
        .send({ bill_type: 'electricity', billing_period: '2026-08', total_amount: 300 });

      expect(res.status).toBe(409);
    });

    it('should reject a bill for an apartment with zero active rentals (409)', async () => {
      const { ownerId, token } = await createOwner();
      const building = await createBuildingFixture(ownerId, { utilities_included_in_rent: false });
      const apartment = await Apartment.create({ building: building._id, owner_id: ownerId, floor: 1, room_count: 3 });
      // No beds/rentals created under this apartment at all.

      const res = await request(app)
        .post(`/api/utilities/apartments/${apartment._id}/bills`)
        .set('Authorization', `Bearer ${token}`)
        .send({ bill_type: 'water', billing_period: '2026-08', total_amount: 150 });

      expect(res.status).toBe(409);
    });

    it('should split a bill equally among active students, update each Payment.utility_amount/amount_due, and record the full breakdown + audit trail', async () => {
      const { ownerId, token } = await createOwner();
      const { apartment, rentals } = await createApartmentWithActiveRentals(ownerId, token, 3, {
        utilities_included_in_rent: false,
      });

      const res = await request(app)
        .post(`/api/utilities/apartments/${apartment._id}/bills`)
        .set('Authorization', `Bearer ${token}`)
        .send({ bill_type: 'electricity', billing_period: '2026-08', total_amount: 100 });

      expect(res.status).toBe(201);
      expect(res.body.data.split.length).toBe(3);

      const shareAmounts = res.body.data.split.map((s) => s.share_amount).sort((a, b) => a - b);
      expect(shareAmounts).toEqual([33.33, 33.33, 33.34]);
      const sum = Math.round(res.body.data.split.reduce((a, s) => a + s.share_amount, 0) * 100) / 100;
      expect(sum).toBe(100);

      // Every affected rental's payment for that period actually got the charge applied.
      for (const rental of rentals) {
        // eslint-disable-next-line no-await-in-loop
        const payment = await Payment.findOne({ rental: rental._id, billing_period: '2026-08' });
        expect(payment).not.toBeNull();
        expect(payment.utility_amount).toBeGreaterThan(0);
        expect(payment.amount_due).toBeCloseTo(payment.rent_amount + payment.utility_amount, 2);

        // eslint-disable-next-line no-await-in-loop
        const chargeAudit = await Audit.findOne({
          entity_type: 'Payment',
          entity_id: payment._id,
          action: 'payment_utility_charge_applied',
        });
        expect(chargeAudit).not.toBeNull();
      }

      const billAudit = await Audit.findOne({
        entity_type: 'UtilityBill',
        entity_id: res.body.data._id,
        action: 'utility_bill_created',
      });
      expect(billAudit).not.toBeNull();
    });

    it('should reject a non-positive total_amount (422)', async () => {
      const { ownerId, token } = await createOwner();
      const { apartment } = await createApartmentWithActiveRentals(ownerId, token, 1, {
        utilities_included_in_rent: false,
      });

      const res = await request(app)
        .post(`/api/utilities/apartments/${apartment._id}/bills`)
        .set('Authorization', `Bearer ${token}`)
        .send({ bill_type: 'gas', billing_period: '2026-08', total_amount: -50 });

      expect(res.status).toBe(422);
    });
  });

  describe('Ownership Isolation', () => {
    it("THE EXPLICIT ISOLATION TEST: Owner B must not be able to submit a bill for Owner A's apartment", async () => {
      const { ownerId: ownerAId, token: ownerAToken } = await createOwner();
      const { apartment } = await createApartmentWithActiveRentals(ownerAId, ownerAToken, 2, {
        utilities_included_in_rent: false,
      });
      const { token: ownerBToken } = await createOwner();

      const res = await request(app)
        .post(`/api/utilities/apartments/${apartment._id}/bills`)
        .set('Authorization', `Bearer ${ownerBToken}`)
        .send({ bill_type: 'electricity', billing_period: '2026-08', total_amount: 200 });

      expect(res.status).toBe(403);

      const bills = await UtilityBill.find({ apartment: apartment._id });
      expect(bills.length).toBe(0); // nothing was created
    });

    it("Owner B must not be able to list Owner A's utility bills for an apartment or building", async () => {
      const { ownerId: ownerAId, token: ownerAToken } = await createOwner();
      const { apartment, building } = await createApartmentWithActiveRentals(ownerAId, ownerAToken, 1, {
        utilities_included_in_rent: false,
      });
      await request(app)
        .post(`/api/utilities/apartments/${apartment._id}/bills`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .send({ bill_type: 'water', billing_period: '2026-08', total_amount: 90 });

      const { token: ownerBToken } = await createOwner();

      const apartmentListRes = await request(app)
        .get(`/api/utilities/apartments/${apartment._id}/bills`)
        .set('Authorization', `Bearer ${ownerBToken}`);
      expect(apartmentListRes.status).toBe(403);

      const buildingListRes = await request(app)
        .get(`/api/utilities/buildings/${building._id}/bills`)
        .set('Authorization', `Bearer ${ownerBToken}`);
      expect(buildingListRes.status).toBe(403);
    });
  });

  describe('Pagination', () => {
    it('should paginate the apartment bill list (CLAUDE.md Section 4.2)', async () => {
      const { ownerId, token } = await createOwner();
      const { apartment } = await createApartmentWithActiveRentals(ownerId, token, 1, {
        utilities_included_in_rent: false,
      });

      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await request(app)
          .post(`/api/utilities/apartments/${apartment._id}/bills`)
          .set('Authorization', `Bearer ${token}`)
          .send({ bill_type: 'electricity', billing_period: `2026-0${i + 1}`, total_amount: 60 });
      }

      const res = await request(app)
        .get(`/api/utilities/apartments/${apartment._id}/bills`)
        .set('Authorization', `Bearer ${token}`)
        .query({ page: 1, limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.meta.total).toBe(3);
    });
  });
});

describe('Phase 6 — Payment Model Retrofit (non-breaking)', () => {
  it('should set rent_amount = monthly_rent and utility_amount = 0 on every newly-created payment', async () => {
    const { ownerId, token } = await createOwner();
    const { rentals } = await createApartmentWithActiveRentals(ownerId, token, 1);
    const rental = rentals[0];

    const payment = await Payment.findOne({ rental: rental._id });
    expect(payment.rent_amount).toBe(rental.monthly_rent);
    expect(payment.utility_amount).toBe(0);
    expect(payment.amount_due).toBe(payment.rent_amount + payment.utility_amount);
  });

  it('should default rent_amount = amount_due and utility_amount = 0 for a pre-Phase-6 record with no rent_amount/utility_amount stored', async () => {
    const { ownerId } = await createOwner();
    // Simulate a legacy record inserted the way Phase 5 code would have,
    // with no rent_amount/utility_amount keys at all in the raw document.
    const building = await createBuildingFixture(ownerId);
    const apt = await Apartment.create({ building: building._id, owner_id: ownerId, floor: 1, room_count: 2 });
    const bed = await Bed.create({ apartment: apt._id, building: building._id, owner_id: ownerId, monthly_rent: 2500 });
    const student = await Student.create({
      user: (await User.create({ phone: `+2011${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`, role: ROLES.STUDENT, status: 'active' }))._id,
      name: 'Legacy Student',
      phone: '+201100000000',
      college: 'Faculty of Science',
      academic_year: 1,
      smoking_preference: 'non_smoker',
    });
    const rental = await Rental.create({
      student: student._id,
      bed: bed._id,
      building: building._id,
      owner_id: ownerId,
      request: new mongoose.Types.ObjectId(), // fixture only — no real Request needed for this model-hydration test
      status: 'active',
      confirmed_date: new Date(),
      monthly_rent: 2500,
    });

    await mongoose.connection.collection('payments').insertOne({
      rental: rental._id,
      student: student._id,
      bed: bed._id,
      building: building._id,
      owner_id: ownerId,
      billing_period: '2026-07',
      status: 'pending',
      amount_due: 2500,
      amount_paid: 0,
      due_date: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      // rent_amount / utility_amount deliberately omitted — this is the
      // raw shape a Phase 5 (pre-retrofit) record actually has in Mongo.
    });

    const hydrated = await Payment.findOne({ rental: rental._id, billing_period: '2026-07' });
    expect(hydrated.rent_amount).toBe(2500); // defaulted from amount_due
    expect(hydrated.utility_amount).toBe(0);
    expect(hydrated.amount_due).toBe(hydrated.rent_amount + hydrated.utility_amount);
  });
});

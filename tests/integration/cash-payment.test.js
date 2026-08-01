/**
 * cash-payment.test.js
 *
 * Integration tests for Phase 5 (Cash Payment Tracking — recurring
 * monthly billing). Covers: initial payment auto-generation on rental
 * confirmation, full/partial cash confirmation, the atomic accumulate-
 * and-derive-status update under concurrency (CLAUDE.md Section 6.2 names
 * "payment status updates" alongside bed locking as concurrency-sensitive
 * logic), the overdue-check.job and payment-rollover.job batch sweeps,
 * ownership isolation with an explicit negative test (Section 6.3), role
 * guards, and the mandatory audit trail for every status change.
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

const authService = require('../../src/modules/auth/auth.service');
const paymentService = require('../../src/modules/payments/payment.service');
const overdueCheckJob = require('../../src/modules/payments/overdue-check.job');
const paymentRolloverJob = require('../../src/modules/payments/payment-rollover.job');
const { ROLES, PAYMENT_STATUS } = require('../../src/config/constants.config');

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

async function createBedFixture(ownerId, overrides = {}) {
  const building = await Building.create({
    owner_id: ownerId,
    name: `Building ${uniqueTag()}`,
    area: 'Nasr City',
    address: { city: 'Cairo', street: null, details: null },
  });
  const apartment = await Apartment.create({
    building: building._id,
    owner_id: ownerId,
    floor: 1,
    room_count: 3,
  });
  const bed = await Bed.create({
    apartment: apartment._id,
    building: building._id,
    owner_id: ownerId,
    monthly_rent: 3000,
    ...overrides,
  });
  return { building, apartment, bed };
}

/** Full request -> confirm flow, ending with an ACTIVE rental and its
 * auto-generated first Payment record (the thing this whole phase adds). */
async function createActiveRentalWithPayment(ownerOverrides = {}) {
  const { ownerId, token: ownerToken } = await createOwner();
  const { bed } = await createBedFixture(ownerId, ownerOverrides);
  const { student, token: studentToken } = await createStudent();

  const createRes = await request(app)
    .post('/api/requests')
    .set('Authorization', `Bearer ${studentToken}`)
    .send({ bed_id: bed._id.toString() });
  const confirmRes = await request(app)
    .post(`/api/requests/${createRes.body.data._id}/confirm`)
    .set('Authorization', `Bearer ${ownerToken}`);

  const rentalId = confirmRes.body.data.rental._id;
  const payment = await Payment.findOne({ rental: rentalId });

  return { ownerId, ownerToken, student, studentToken, bed, rentalId, payment };
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
});

describe('Cash Payment Tracking (Phase 5) — Integration Tests', () => {
  // ========================================================================
  // Initial payment auto-generation on rental confirmation (step 2)
  // ========================================================================
  describe('Initial Payment Generation', () => {
    it('should auto-generate a pending payment for the current billing period when a rental is confirmed', async () => {
      const { rentalId, payment, bed } = await createActiveRentalWithPayment();

      expect(payment).not.toBeNull();
      expect(payment.status).toBe(PAYMENT_STATUS.PENDING);
      expect(payment.amount_due).toBe(bed.monthly_rent);
      expect(payment.amount_paid).toBe(0);
      expect(payment.rental.toString()).toBe(rentalId);
      expect(payment.billing_period).toBe(paymentService.billingPeriodOf(new Date()));

      const auditEntry = await Audit.findOne({ entity_type: 'Payment', entity_id: payment._id, action: 'payment_created' });
      expect(auditEntry).not.toBeNull();
    });

    it('should copy monthly_rent onto the rental at confirmation time, not recalculate it from the bed later', async () => {
      const { rentalId, bed } = await createActiveRentalWithPayment({ monthly_rent: 4500 });

      const rental = await Rental.findById(rentalId);
      expect(rental.monthly_rent).toBe(4500);

      // Changing the bed's listing price afterwards must not retroactively
      // change the already-confirmed rental or its existing payment.
      await Bed.findByIdAndUpdate(bed._id, { monthly_rent: 9999 });
      const rentalAfter = await Rental.findById(rentalId);
      expect(rentalAfter.monthly_rent).toBe(4500);
    });

    it('should never create two payment records for the same rental+billing_period (unique index)', async () => {
      const { rentalId } = await createActiveRentalWithPayment();
      const rental = await Rental.findById(rentalId);

      await expect(
        Payment.create({
          rental: rental._id,
          student: rental.student,
          bed: rental.bed,
          building: rental.building,
          owner_id: rental.owner_id,
          billing_period: paymentService.billingPeriodOf(new Date()),
          amount_due: rental.monthly_rent,
          due_date: paymentService.periodDueDate(paymentService.billingPeriodOf(new Date())),
        }),
      ).rejects.toThrow();
    });
  });

  // ========================================================================
  // Confirm Cash Payment — full, partial, and accumulation
  // ========================================================================
  describe('Confirm Cash Payment', () => {
    it('should confirm a full cash payment: status -> paid, confirmed_by/confirmed_at set, audit logged', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment();

      const res = await request(app)
        .post(`/api/payments/${payment._id}/confirm`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.payment.status).toBe(PAYMENT_STATUS.PAID);
      expect(res.body.data.payment.amount_paid).toBe(payment.amount_due);
      expect(res.body.data.payment.confirmed_by).not.toBeNull();
      expect(res.body.data.payment.confirmed_at).not.toBeNull();
      expect(res.body.data.receipt.receipt_number).toContain('RCPT-');

      const auditEntry = await Audit.findOne({ entity_type: 'Payment', entity_id: payment._id, action: 'payment_confirmed' });
      expect(auditEntry).not.toBeNull();
      expect(auditEntry.after_state.status).toBe(PAYMENT_STATUS.PAID);
    });

    it('should confirm a partial cash payment: status -> partial when amount_paid < amount_due', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment();
      const halfAmount = payment.amount_due / 2;

      const res = await request(app)
        .post(`/api/payments/${payment._id}/confirm`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ amount_paid: halfAmount });

      expect(res.status).toBe(200);
      expect(res.body.data.payment.status).toBe(PAYMENT_STATUS.PARTIAL);
      expect(res.body.data.payment.amount_paid).toBe(halfAmount);
    });

    it('should accumulate a second partial confirmation on top of the first, reaching paid once the total covers amount_due', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment();
      const halfAmount = payment.amount_due / 2;

      await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).send({ amount_paid: halfAmount });
      const secondRes = await request(app)
        .post(`/api/payments/${payment._id}/confirm`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ amount_paid: halfAmount });

      expect(secondRes.status).toBe(200);
      expect(secondRes.body.data.payment.status).toBe(PAYMENT_STATUS.PAID);
      expect(secondRes.body.data.payment.amount_paid).toBe(payment.amount_due);
    });

    it('should reject confirming a payment that is already fully paid (409)', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment();

      await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).send({});
      const secondConfirm = await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).send({});

      expect(secondConfirm.status).toBe(409);
    });

    it('should reject a zero or negative amount_paid (422)', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment();

      const res = await request(app)
        .post(`/api/payments/${payment._id}/confirm`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ amount_paid: -10 });

      expect(res.status).toBe(422);
    });

    // ------------------------------------------------------------------
    // THE concurrency requirement (CLAUDE.md Section 6.2 names "payment
    // status updates" explicitly, alongside bed locking).
    // ------------------------------------------------------------------
    it('should NOT lose an update when two partial confirmations for the same payment happen near-simultaneously (atomic accumulate)', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment({ monthly_rent: 4000 });
      const quarterAmount = payment.amount_due / 4; // 1000 each, 4 of them = exactly amount_due

      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(app)
            .post(`/api/payments/${payment._id}/confirm`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ amount_paid: quarterAmount }),
        ),
      );

      // All 4 concurrent confirmations should succeed (none should have been
      // rejected as "already fully paid" mid-flight, and none should have
      // silently lost another's increment).
      const succeeded = responses.filter((r) => r.status === 200);
      expect(succeeded.length).toBe(4);

      const freshPayment = await Payment.findById(payment._id);
      expect(freshPayment.amount_paid).toBe(payment.amount_due); // exactly 4000, not less (lost update) or more (double count)
      expect(freshPayment.status).toBe(PAYMENT_STATUS.PAID);

      // Every one of the 4 confirmations must be individually audited —
      // the audit trail is the dispute source of truth (CLAUDE.md 5.3).
      const auditEntries = await Audit.find({ entity_type: 'Payment', entity_id: payment._id, action: 'payment_confirmed' });
      expect(auditEntries.length).toBe(4);
    });

    it('should reject a 5th confirmation once the payment is already fully settled by the other 4 concurrent ones (409, not a silent overpay)', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment({ monthly_rent: 1000 });

      // Settle it fully first.
      await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).send({ amount_paid: 1000 });

      const res = await request(app)
        .post(`/api/payments/${payment._id}/confirm`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ amount_paid: 500 });

      expect(res.status).toBe(409);
      const freshPayment = await Payment.findById(payment._id);
      expect(freshPayment.amount_paid).toBe(1000); // unchanged, not 1500
    });
  });

  // ========================================================================
  // Ownership scoping — mandatory explicit negative test (Section 3.3/6.3)
  // ========================================================================
  describe('Ownership Scoping', () => {
    it('should allow Owner A to view and confirm their own payment', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment();

      const getRes = await request(app).get(`/api/payments/${payment._id}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(getRes.status).toBe(200);
    });

    it('THE EXPLICIT ISOLATION TEST: Owner B must not be able to view or confirm Owner A\'s payment', async () => {
      const { payment } = await createActiveRentalWithPayment();
      const { token: ownerBToken } = await createOwner();

      const getRes = await request(app).get(`/api/payments/${payment._id}`).set('Authorization', `Bearer ${ownerBToken}`);
      expect(getRes.status).toBe(403);

      const confirmRes = await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${ownerBToken}`).send({});
      expect(confirmRes.status).toBe(403);

      // And Owner A's payment itself must be untouched by Owner B's attempt.
      const freshPayment = await Payment.findById(payment._id);
      expect(freshPayment.status).toBe(PAYMENT_STATUS.PENDING);
    });

    it('should only list Owner A\'s own payments, never Owner B\'s, from the list endpoint', async () => {
      const { ownerToken: ownerAToken } = await createActiveRentalWithPayment();
      await createActiveRentalWithPayment(); // Owner B's own unrelated rental+payment

      const res = await request(app).get('/api/payments').set('Authorization', `Bearer ${ownerAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
    });
  });

  // ========================================================================
  // Role guards
  // ========================================================================
  describe('Role Guards', () => {
    it('should reject a student token on every payment endpoint (owner only)', async () => {
      const { payment } = await createActiveRentalWithPayment();
      const { token: studentToken } = await createStudent();

      const listRes = await request(app).get('/api/payments').set('Authorization', `Bearer ${studentToken}`);
      const confirmRes = await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${studentToken}`).send({});

      expect(listRes.status).toBe(403);
      expect(confirmRes.status).toBe(403);
    });

    it('should reject unauthenticated access to every payment endpoint (401)', async () => {
      const { payment } = await createActiveRentalWithPayment();

      const listRes = await request(app).get('/api/payments');
      const overdueRes = await request(app).get('/api/payments/overdue');
      const confirmRes = await request(app).post(`/api/payments/${payment._id}/confirm`).send({});

      expect(listRes.status).toBe(401);
      expect(overdueRes.status).toBe(401);
      expect(confirmRes.status).toBe(401);
    });
  });

  // ========================================================================
  // Pagination (CLAUDE.md Section 4.2 — no unpaginated list endpoints)
  // ========================================================================
  describe('Pagination', () => {
    it('should bound the payment list to the requested page size, with an accurate total in meta', async () => {
      const { ownerId, ownerToken } = await createActiveRentalWithPayment();
      // Two more rentals (and their auto-generated payments) under the SAME owner.
      for (let i = 0; i < 2; i += 1) {
        const { bed } = await createBedFixture(ownerId);
        const { token: studentToken } = await createStudent();
        const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
        await request(app).post(`/api/requests/${createRes.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);
      }

      const res = await request(app).get('/api/payments').set('Authorization', `Bearer ${ownerToken}`).query({ page: 1, limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.meta.total).toBe(3);
    });
  });

  // ========================================================================
  // overdue-check.job — batch sweep
  // ========================================================================
  describe('overdue-check.job — batch overdue flagging', () => {
    it('should flag a pending payment overdue once past due_date + grace period, and write a system audit entry', async () => {
      const { payment } = await createActiveRentalWithPayment();

      // Force the due_date far enough into the past to be outside the grace window.
      const pastDue = new Date(Date.now() - (paymentService.GRACE_PERIOD_DAYS + 1) * 24 * 60 * 60 * 1000);
      await Payment.findByIdAndUpdate(payment._id, { due_date: pastDue });

      const summary = await overdueCheckJob.runOverdueSweep();
      expect(summary.totalFlagged).toBeGreaterThanOrEqual(1);

      const freshPayment = await Payment.findById(payment._id);
      expect(freshPayment.status).toBe(PAYMENT_STATUS.OVERDUE);

      const auditEntry = await Audit.findOne({ entity_type: 'Payment', entity_id: payment._id, action: 'payment_overdue' });
      expect(auditEntry).not.toBeNull();
      expect(auditEntry.actor).toBeNull();
    });

    it('should NOT flag a payment still within the grace period as overdue', async () => {
      const { payment } = await createActiveRentalWithPayment();

      const withinGrace = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day past due_date, grace is larger
      await Payment.findByIdAndUpdate(payment._id, { due_date: withinGrace });

      await overdueCheckJob.runOverdueSweep();

      const freshPayment = await Payment.findById(payment._id);
      expect(freshPayment.status).toBe(PAYMENT_STATUS.PENDING);
    });

    it('should NOT touch a payment that is already paid, even if its due_date is long past', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment();
      await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).send({});

      const pastDue = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await Payment.findByIdAndUpdate(payment._id, { due_date: pastDue });

      await overdueCheckJob.runOverdueSweep();

      const freshPayment = await Payment.findById(payment._id);
      expect(freshPayment.status).toBe(PAYMENT_STATUS.PAID); // untouched
    });

    it('should process overdue flagging in batches without loading the whole collection at once (CLAUDE.md Section 4.6)', async () => {
      const pastDue = new Date(Date.now() - (paymentService.GRACE_PERIOD_DAYS + 1) * 24 * 60 * 60 * 1000);
      const payments = [];
      for (let i = 0; i < 5; i += 1) {
        const { payment } = await createActiveRentalWithPayment();
        await Payment.findByIdAndUpdate(payment._id, { due_date: pastDue });
        payments.push(payment);
      }

      const summary = await overdueCheckJob.runOverdueSweep();
      expect(summary.totalFlagged).toBe(5);

      const stillOverdue = await Payment.countDocuments({ _id: { $in: payments.map((p) => p._id) }, status: PAYMENT_STATUS.OVERDUE });
      expect(stillOverdue).toBe(5);
    });
  });

  // ========================================================================
  // payment-rollover.job — batch sweep, stops once a rental is closed
  // ========================================================================
  describe('payment-rollover.job — recurring monthly rollover', () => {
    it('should generate the next billing period\'s pending payment once the current period is settled (paid)', async () => {
      const { ownerToken, rentalId, payment } = await createActiveRentalWithPayment({ monthly_rent: 2500 });
      await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).send({});

      const summary = await paymentRolloverJob.runRolloverSweep();
      expect(summary.totalGenerated).toBeGreaterThanOrEqual(1);

      const nextPeriod = paymentService.nextBillingPeriod(payment.billing_period);
      const rolled = await Payment.findOne({ rental: rentalId, billing_period: nextPeriod });
      expect(rolled).not.toBeNull();
      expect(rolled.status).toBe(PAYMENT_STATUS.PENDING);
      expect(rolled.amount_due).toBe(2500);

      const auditEntry = await Audit.findOne({ entity_type: 'Payment', entity_id: rolled._id, action: 'payment_rolled_over' });
      expect(auditEntry).not.toBeNull();
      expect(auditEntry.actor).toBeNull();
    });

    it('should NOT roll over a rental whose current period is still pending/unsettled', async () => {
      const { rentalId, payment } = await createActiveRentalWithPayment();

      await paymentRolloverJob.runRolloverSweep();

      const nextPeriod = paymentService.nextBillingPeriod(payment.billing_period);
      const rolled = await Payment.findOne({ rental: rentalId, billing_period: nextPeriod });
      expect(rolled).toBeNull();
    });

    it('should be idempotent: running the sweep twice after settlement must not create a duplicate next-period payment', async () => {
      const { ownerToken, rentalId, payment } = await createActiveRentalWithPayment();
      await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).send({});

      await paymentRolloverJob.runRolloverSweep();
      await paymentRolloverJob.runRolloverSweep();

      const nextPeriod = paymentService.nextBillingPeriod(payment.billing_period);
      const count = await Payment.countDocuments({ rental: rentalId, billing_period: nextPeriod });
      expect(count).toBe(1);
    });

    it('should stop generating new periods once the rental is closed', async () => {
      const { ownerToken, rentalId, payment } = await createActiveRentalWithPayment();
      await request(app).post(`/api/payments/${payment._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).send({});
      await request(app).post(`/api/rentals/${rentalId}/finalize-move-out`).set('Authorization', `Bearer ${ownerToken}`);

      await paymentRolloverJob.runRolloverSweep();

      const nextPeriod = paymentService.nextBillingPeriod(payment.billing_period);
      const rolled = await Payment.findOne({ rental: rentalId, billing_period: nextPeriod });
      expect(rolled).toBeNull();
    });
  });

  // ========================================================================
  // Overdue-accounts view (step 8)
  // ========================================================================
  describe('Owner-Facing Overdue-Accounts View', () => {
    it('should list only payments actually flagged overdue, scoped to the requesting owner', async () => {
      const { ownerToken, payment } = await createActiveRentalWithPayment();
      const pastDue = new Date(Date.now() - (paymentService.GRACE_PERIOD_DAYS + 1) * 24 * 60 * 60 * 1000);
      await Payment.findByIdAndUpdate(payment._id, { due_date: pastDue });
      await overdueCheckJob.runOverdueSweep();

      // A second, still-pending (not overdue) payment for the same owner must not appear.
      await createActiveRentalWithPayment(); // different owner, irrelevant either way

      const res = await request(app).get('/api/payments/overdue').set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0]._id).toBe(payment._id.toString());
    });
  });
});

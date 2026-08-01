/**
 * utility-bill.service.js
 *
 * Business logic for the optional utility-bill-splitting feature
 * (Docs/phase-6-subscriptions.md, "Optional Utility Bill Splitting",
 * steps 9-11). Never touches the Building/Apartment/Rental/Payment
 * collections directly — always through their own services, per
 * CLAUDE.md Section 7.2.
 */

const utilityBillRepository = require('./utility-bill.repository');
const apartmentService = require('../apartments/apartment.service');
const buildingService = require('../buildings/building.service');
const bedService = require('../beds/bed.service');
const rentalService = require('../rentals/rental.service');
const paymentService = require('../payments/payment.service');
const auditService = require('../audit/audit.service');
const { AppError } = require('../../middleware/error-handler.middleware');

/**
 * Equal split of `totalAmount` across `count` students, using
 * integer-cents arithmetic (not floating-point division) so the shares
 * always sum EXACTLY back to totalAmount — floating point division/
 * rounding (e.g. 100 / 3 = 33.333...) can otherwise leave the sum a cent
 * off from totalAmount depending on rounding direction. Per the phase
 * spec's step 9: "round each share to 2 decimal places, and assign any
 * rounding remainder to the last student in the split."
 */
function splitAmountEqually(totalAmount, count) {
  const totalCents = Math.round(totalAmount * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainderCents = totalCents - baseCents * count;

  const shares = new Array(count).fill(baseCents / 100);
  shares[count - 1] = (baseCents + remainderCents) / 100;
  return shares;
}

/**
 * Step 9: submit a utility bill for an apartment. `apartment` is passed
 * in already-fetched (the controller fetches it first to run the
 * ownership-scoping check before ever reaching the service, same pattern
 * as every other module) so this function doesn't need to re-derive
 * ownership itself.
 */
async function submitBill(apartment, { billType, billingPeriod, totalAmount }, actorUserId) {
  const building = await buildingService.getBuildingById(apartment.building);

  if (building.utilities_included_in_rent) {
    throw new AppError(
      'Utilities are included in rent for this building — bill splitting does not apply. Turn off "utilities included in rent" for this building first if you want to split bills.',
      409,
    );
  }

  if (typeof totalAmount !== 'number' || Number.isNaN(totalAmount) || totalAmount <= 0) {
    throw new AppError('total_amount must be a positive number', 422);
  }

  const beds = await bedService.listAllBedsForApartments([apartment._id]);
  const bedIds = beds.map((bed) => bed._id);
  const activeRentals = await rentalService.listActiveOrVacatingRentalsForBeds(bedIds);

  if (activeRentals.length === 0) {
    throw new AppError('Cannot split a utility bill: this apartment has no currently active students.', 409);
  }

  const shares = splitAmountEqually(totalAmount, activeRentals.length);

  // Sequential, not Promise.all — bounded by a single apartment's active
  // student count (small, not a scale concern per CLAUDE.md Section 4.4,
  // which is about avoiding N+1 across large collections, not about a
  // handful of awaits over one apartment's tenants), and each iteration's
  // ensurePaymentForPeriod/applyUtilityCharge pair should land on the
  // same student's payment in creation-then-update order rather than
  // racing itself.
  const splitBreakdown = [];
  for (let i = 0; i < activeRentals.length; i += 1) {
    const rental = activeRentals[i];
    const shareAmount = shares[i];

    // eslint-disable-next-line no-await-in-loop
    const payment = await paymentService.ensurePaymentForPeriod(rental, billingPeriod, actorUserId);
    // eslint-disable-next-line no-await-in-loop
    await paymentService.applyUtilityCharge(payment._id, shareAmount, actorUserId);

    splitBreakdown.push({
      student: rental.student,
      rental: rental._id,
      payment: payment._id,
      share_amount: shareAmount,
    });
  }

  const bill = await utilityBillRepository.create({
    apartment: apartment._id,
    building: apartment.building,
    owner_id: apartment.owner_id,
    bill_type: billType,
    billing_period: billingPeriod,
    total_amount: totalAmount,
    split: splitBreakdown,
    entered_by: actorUserId,
    entered_at: new Date(),
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'utility_bill_created',
    entityType: 'UtilityBill',
    entityId: bill._id,
    afterState: {
      bill_type: billType,
      billing_period: billingPeriod,
      total_amount: totalAmount,
      split_count: splitBreakdown.length,
    },
  });

  return bill;
}

async function getBillById(billId) {
  const bill = await utilityBillRepository.findById(billId);
  if (!bill) {
    throw new AppError('Utility bill not found', 404);
  }
  return bill;
}

async function listBillsForApartment(ownerId, apartmentId, { skip, limit }) {
  const [bills, total] = await Promise.all([
    utilityBillRepository.findByApartment(ownerId, apartmentId, { skip, limit }),
    utilityBillRepository.countByApartment(ownerId, apartmentId),
  ]);
  return { bills, total };
}

async function listBillsForBuilding(ownerId, buildingId, { skip, limit }) {
  const [bills, total] = await Promise.all([
    utilityBillRepository.findByBuilding(ownerId, buildingId, { skip, limit }),
    utilityBillRepository.countByBuilding(ownerId, buildingId),
  ]);
  return { bills, total };
}

module.exports = {
  splitAmountEqually,
  submitBill,
  getBillById,
  listBillsForApartment,
  listBillsForBuilding,
};

/**
 * public-lead.service.js
 *
 * Business logic for anonymous public-site interest capture. THE ENTIRE
 * POINT of this file, per Docs/phase-8-public-site.md's "Critical Design
 * Decision — Public Leads Are NOT Requests": createLead() below must
 * NEVER call bedService.atomicTransition (the Phase 4 bed-lock primitive)
 * and must NEVER create a requests/request.model document. It only ever
 * reads a Bed (to validate/denormalize) and writes a PublicLead. Wiring
 * this into the real booking engine would let an anonymous, unverified
 * visitor soft-lock any real bed with zero friction — a trivial
 * denial-of-service vector at this project's target scale (500k
 * students/beds) — which is exactly the security gap this phase exists
 * to correct from the original scope.
 */

const publicLeadRepository = require('./public-lead.repository');
const bedService = require('../beds/bed.service');
const subscriptionService = require('../subscriptions/subscription.service');
const auditService = require('../audit/audit.service');
const { AppError } = require('../../middleware/error-handler.middleware');

const NOTE_MAX_LENGTH = 500;

/**
 * Create a public lead. Read-only against Bed (via bedService.getBedById
 * — no status touched, no atomic transition called), then a single
 * insert into the PublicLead collection. `name`/`phone` are the only
 * required fields beyond `bedId` — this form is deliberately frictionless
 * for an anonymous visitor, unlike request.service.createRequest which
 * requires an authenticated, KYC'd student.
 */
async function createLead({ name, phone, note, bedId }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new AppError('name is required', 422);
  }
  if (!phone || typeof phone !== 'string' || !phone.trim()) {
    throw new AppError('phone is required', 422);
  }
  if (!bedId) {
    throw new AppError('bed_id is required', 422);
  }
  if (note !== undefined && note !== null && String(note).length > NOTE_MAX_LENGTH) {
    throw new AppError(`note must be ${NOTE_MAX_LENGTH} characters or fewer`, 422);
  }

  // Read-only lookup — see this file's top comment. bedService.getBedById
  // is the same Phase 3 read used everywhere else in the codebase; it is
  // never followed here by bedService.atomicTransition or
  // requestRepository.create.
  const bed = await bedService.getBedById(bedId);

  // A lead can only be submitted for a bed whose owner is currently
  // actively subscribed — the same eligibility gate the public listing
  // itself uses (building.service.getPublicBuildingDetail). Returns the
  // same 404 shape as "bed not found" rather than a distinguishing 403,
  // so this endpoint can't be used to probe which owners are subscribed
  // vs. suspended/lapsed (same existence-leakage discipline as
  // building.service.getPublicBuildingDetail).
  const isPubliclyListed = await subscriptionService.isOwnerPubliclyListed(bed.owner_id);
  if (!isPubliclyListed) {
    throw new AppError('Bed not found', 404);
  }

  const lead = await publicLeadRepository.create({
    name: name.trim(),
    phone: phone.trim(),
    note: note ? String(note).trim() : null,
    bed: bed._id,
    building: bed.building,
    owner_id: bed.owner_id,
  });

  // Anonymous actor (actor: null) — no authenticated user exists on this
  // endpoint, same nullable-actor pattern request-expiry.job uses for
  // system-triggered entries (see audit.model.js's Phase 4 comment).
  // CLAUDE.md Section 3.9's literal list of what must be audited
  // (KYC/payments/suspension/impersonation) doesn't name public leads
  // explicitly, but every other state-changing write in this codebase —
  // including request.service.createRequest, a much lower-stakes write
  // than this one in isolation — already goes through the audit log.
  // Logging this too costs nothing and gives V Div a real trail if a
  // lead submission is later disputed or investigated as spam/abuse.
  // Flagged as a deliberate extension in the Phase 8 report.
  await auditService.writeAuditLog({
    actor: null,
    action: 'public_lead_submitted',
    entityType: 'PublicLead',
    entityId: lead._id,
    afterState: { bed: bed._id.toString(), owner_id: bed.owner_id },
  });

  return lead;
}

/**
 * Owner-facing, paginated, ownership-scoped-by-caller (the controller
 * always passes req.user.ownerId) list of an owner's own public leads —
 * a distinct list from their real Pending Requests queue (request
 * .service.listPendingForOwner), never merged with it.
 */
async function listLeadsForOwner(ownerId, { skip, limit }) {
  const [leads, total] = await Promise.all([
    publicLeadRepository.findByOwner(ownerId, { skip, limit }),
    publicLeadRepository.countByOwner(ownerId),
  ]);
  return { leads, total };
}

async function getLeadById(leadId) {
  const lead = await publicLeadRepository.findById(leadId);
  if (!lead) {
    throw new AppError('Public lead not found', 404);
  }
  return lead;
}

module.exports = {
  createLead,
  listLeadsForOwner,
  getLeadById,
};

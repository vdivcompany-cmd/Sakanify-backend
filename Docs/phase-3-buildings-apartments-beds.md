# Phase 3 — Buildings, Apartments, and Beds

## Goal
Establish the property hierarchy (Building → Apartment → Bed) that the booking engine (Phase 4) operates on.

## Context
Every bed traces to one apartment, which traces to one building, owned by one owner. Get these relationships and the bed-status logging right before Phase 4 begins.

## Folders & Files to Create This Phase

```
src/modules/buildings/
├── building.routes        → Create/edit/delete/list buildings (owner-scoped)
├── building.controller
├── building.service
└── building.model          → name, area/neighborhood, owner reference

src/modules/apartments/
├── apartment.routes        → Create/edit/delete/list apartments per building
├── apartment.controller
├── apartment.service
└── apartment.model          → floor number, room count, building reference

src/modules/beds/
├── bed.routes               → Create/edit/delete/list beds per apartment; get nested building→apartment→bed structure
├── bed.controller
├── bed.service               → Occupancy calculation logic lives here; atomic locking logic is built out fully in Phase 4 but the status field itself is defined here
├── bed.model                  → apartment reference, status (available/requested/confirmed/vacating)
└── bed-history.service         → Thin wrapper writing into the real `audit` module below — no separate logging mechanism

src/modules/audit/
├── audit.routes             → Query audit records (super-admin facing, read-only)
├── audit.controller
├── audit.service              → Generic writeAuditLog(actor, action, entityType, entityId, beforeState?, afterState?) used by every module
└── audit.model                → actor reference, action, entity type/id, timestamp, before/after state (where relevant)
```

## Added After Phase 2 Review — Build the Real Audit Module Now

Phase 2's report flagged that the central `audit` module was still an empty placeholder, and used a temporary `reviewed_by`/`reviewed_at` pattern directly on the KYC record instead. Rather than deferring this until just before Phase 5 as originally recommended, build the **real `audit` module in this phase** — Phase 3 already needs conceptually the same thing (`bed-history.service`, an append-only log of every bed status transition), so build one real mechanism instead of two.

- `bed-history.service` should be implemented as a thin wrapper around `audit.service`'s `writeAuditLog()`, not a separate standalone logging table.
- Retrofit Phase 2's KYC verification status changes to also call `writeAuditLog()` (small addition — keep the existing `reviewed_by`/`reviewed_at` fields on the KYC record too for quick lookups, but the authoritative log now lives in `audit`).
- This gives Phase 4 (Requests/Rentals) and Phase 5 (Payments) a single, real, already-tested audit mechanism to build on from day one.

## Implementation Steps

1. Build `building.model`: name, owner reference (from Phase 1), area/neighborhood (not distance-based), address details.
2. Build `apartment.model`: floor, room count, reference to parent building.
3. Build `bed.model`: reference to parent apartment (and room if tracked as a sub-unit), status field with the four defined values.
4. Build the real `audit.model` and `audit.service` (per the "Added After Phase 2 Review" section above), then build `bed-history.service` as a thin wrapper around it — never overwrite audit entries.
5. Build owner-facing CRUD endpoints for buildings/apartments/beds, scoped via the Phase 1 ownership helper so an owner only manages their own properties.
6. Build a read endpoint returning the full nested structure (building → its apartments → their beds) for dashboard consumption.
7. Build occupancy calculation logic in `bed.service` (occupied vs. total beds per building/apartment) — this will be reused by Subscriptions (Phase 6) and Admin (Phase 7).
8. Test hierarchy integrity: deleting/editing a building correctly cascades or restricts based on defined rules (e.g., block deletion of a building with active rentals).
9. Retrofit Phase 2's KYC status-change endpoint to call `writeAuditLog()` on every verify/reject action, and add a test confirming the audit entry is created correctly.

## Deliverable
Owners can build their full property structure, every bed status change is logged, and occupancy numbers are available for later modules.

## Dependency Note
Phase 4 operates directly on `bed.model`'s status field and `bed-history.service` built here — this phase must be stable before Phase 4 begins.

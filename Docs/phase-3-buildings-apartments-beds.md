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
└── bed-history.service         → Append-only log of every status transition, with timestamp and actor (student/owner/system)
```

## Implementation Steps

1. Build `building.model`: name, owner reference (from Phase 1), area/neighborhood (not distance-based), address details.
2. Build `apartment.model`: floor, room count, reference to parent building.
3. Build `bed.model`: reference to parent apartment (and room if tracked as a sub-unit), status field with the four defined values.
4. Build `bed-history.service` as an append-only log, separate from `bed.model` itself — never overwrite entries.
5. Build owner-facing CRUD endpoints for buildings/apartments/beds, scoped via the Phase 1 ownership helper so an owner only manages their own properties.
6. Build a read endpoint returning the full nested structure (building → its apartments → their beds) for dashboard consumption.
7. Build occupancy calculation logic in `bed.service` (occupied vs. total beds per building/apartment) — this will be reused by Subscriptions (Phase 6) and Admin (Phase 7).
8. Test hierarchy integrity: deleting/editing a building correctly cascades or restricts based on defined rules (e.g., block deletion of a building with active rentals).

## Deliverable
Owners can build their full property structure, every bed status change is logged, and occupancy numbers are available for later modules.

## Dependency Note
Phase 4 operates directly on `bed.model`'s status field and `bed-history.service` built here — this phase must be stable before Phase 4 begins.

# Phase 3 — Buildings, Apartments, and Beds

## Goal
Establish the property hierarchy structure (Building → Apartment → Bed) that the booking engine in Phase 4 will operate on.

## Context for the Implementer
Every bed must ultimately trace back to one apartment, which traces back to one building, which is owned by one owner. This hierarchy is the backbone of the entire booking system — get the relationships right here before Phase 4 begins.

## Steps

1. **Build the Building model**: name, owner reference (linking to the Owner from Phase 1), area/neighborhood (not "distance from university" — the system uses neighborhood/area-based location, per project decisions), address details.

2. **Build the Apartment model**: floor number, number of rooms, reference to parent Building.

3. **Build the Bed model**: reference to parent Apartment (and room, if rooms are tracked as sub-units within an apartment), and a status field with these possible values: `available`, `requested`, `confirmed`, `vacating`.

4. **Build a Bed History / status-log service**, separate from the Bed model itself, that records every status transition with a timestamp and the actor who triggered it (student, owner, or system/scheduled job). This log must never be overwritten — it is append-only and will later feed occupancy analytics and the AI assistant.

5. **Build Owner-facing endpoints** to create/edit/delete Buildings, Apartments, and Beds — scoped so an owner can only manage their own buildings (enforcing the ownership-scoping rule from Phase 1).

6. **Build read endpoints** that return the full nested structure (Building → its Apartments → their Beds) for an owner's dashboard view.

7. **Build basic occupancy calculation logic**: given a building or apartment, calculate how many beds are occupied vs. total — this will be reused by the Subscription module (Phase 6) and Admin dashboards (Phase 7).

8. **Test hierarchy integrity**: deleting or editing a building should correctly cascade or restrict actions on its child apartments/beds according to defined rules (e.g., prevent deleting a building that has active rentals).

## Deliverable
Owners can fully build out their property structure (buildings, apartments, beds) in the system, with every bed status change logged, and basic occupancy numbers available for later modules to consume.

## Dependency Note
Phase 4 (the booking engine) operates directly on the Bed model's status field and history log built here — this phase must be complete and stable before Phase 4 begins.

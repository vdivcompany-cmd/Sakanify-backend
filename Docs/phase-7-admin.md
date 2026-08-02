# Phase 7 — Super-Admin / V Div Control Center

## Goal
Give the V Div internal team full platform-wide visibility and control over all owners, buildings, and subscriptions.

## Context
This module is restricted entirely to the Super-Admin role (Phase 1). It aggregates data from most prior modules into one administrative surface — it introduces no new core data models of its own beyond what's listed below.

## Folders & Files to Create This Phase

```
src/modules/admin/
├── admin.routes                → Owners/buildings table, suspend, impersonate, manual override
├── admin.controller
├── admin.service                 → Suspend logic, impersonation session handling, manual capacity override
└── expansion-queue.service        → Lists, approves, and rejects pending expansion requests from Phase 6
```

## Added After Phase 6 Review — Critical Wiring & Security Details

1. **Suspend must actually set `subscription.status = 'suspended'` via `subscriptionService`**, not an ad-hoc flag on the Owner. This is what activates the guard clause already built in Phase 6/Phase 4 (`canAcceptNewRequests`) — without this exact wiring, suspension would look like it works but silently do nothing to stop new bookings.
2. **Suspend must also invalidate all of that owner's active sessions immediately**, reusing the same token-invalidation mechanism built in Phase 1 for password resets. A suspended owner should be locked out of the entire API right away, not just blocked from accepting new requests.
3. **Manual Capacity Override must audit-log the before/after capacity values.** If the new capacity is set below the owner's currently-used bed count, allow it (it's an explicit admin action) but return a clear warning in the response rather than silently succeeding — don't block it outright, since the admin may be doing this intentionally.
4. **Impersonation must use a distinct, short-lived token** (not a reissued normal owner token) — include a clear claim marking it as an impersonation session (impersonating admin's ID, target owner ID, short expiry e.g. ~30 minutes). Log the start of every impersonation session explicitly; if an "end impersonation" action exists, log that too.
5. **Platform-wide metrics (step 7 below) must be computed via MongoDB aggregation pipelines**, not by loading full collections into application memory — this matters concretely given the project's target scale (~500K students, ~1000 buildings).

## Implementation Steps

1. Build the platform-wide Owners/Buildings table endpoint, aggregating data from Phases 3 and 6 (owner, buildings, subscription tier, actual usage, status).
2. Build the "Manual Capacity Override" endpoint for direct subscription adjustments outside the normal request/approval flow — per point 3 above (audit-logged before/after, warning on under-capacity override rather than a block).
3. Build the "Suspend Account" endpoint — per points 1 and 2 above (real subscription status change + immediate session invalidation), logged to `audit`.
4. Build the "Impersonate Owner" capability — per point 4 above (distinct short-lived token, heavily audit-logged: who impersonated whom, when, duration).
5. Build the Expansion Queue endpoint: list, approve, reject pending requests from Phase 6; approving updates the relevant subscription's capacity.
6. Build a platform-wide activity feed pulling from the `audit` module across all owners/buildings, with pagination (mandatory per CLAUDE.md) and optional date-range filtering (recommended, for usability at scale).
7. Build basic platform-wide metrics endpoints: total requests vs. confirmed rentals (conversion funnel), total active buildings, total verified students — via aggregation pipelines per point 5 above.
8. Test strict access control: every endpoint here must be Super-Admin only — verify explicitly, since a leak exposes all owners' and students' data.
9. Test the suspend → guard-clause chain end-to-end: suspend an owner, confirm their subscription status is `suspended`, confirm their existing token is now rejected, and confirm a student's request against one of their beds is rejected per Phase 6's guard clause — this is the real integration test that proves points 1–2 actually work together, not just in isolation.

## Deliverable
The V Div team can view/manage every owner, building, and subscription, approve/reject expansions, and monitor platform health — with sensitive actions fully audit-logged, and suspension actually taking effect immediately across the whole API, not just in the booking flow.

## Dependency Note
This is purely an aggregation layer over Phases 1, 3, 4, 5, and 6 — build only after those are stable. The suspend → guard-clause integration (point 9) is the one piece of real cross-phase wiring in this module and deserves its own explicit end-to-end test, not just unit-level coverage of each piece separately.

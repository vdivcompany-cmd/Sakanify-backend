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

## Implementation Steps

1. Build the platform-wide Owners/Buildings table endpoint, aggregating data from Phases 3 and 6 (owner, buildings, subscription tier, actual usage, status).
2. Build the "Manual Capacity Override" endpoint for direct subscription adjustments outside the normal request/approval flow.
3. Build the "Suspend Account" endpoint, tied to the subscription status rules from Phase 6, logged to `audit`.
4. Build the "Impersonate Owner" capability — heavily audit-logged (who impersonated whom, when, duration), since it's sensitive.
5. Build the Expansion Queue endpoint: list, approve, reject pending requests from Phase 6; approving updates the relevant subscription's capacity.
6. Build a platform-wide activity feed pulling from the `audit` module across all owners/buildings.
7. Build basic platform-wide metrics endpoints: total requests vs. confirmed rentals (conversion funnel), total active buildings, total verified students.
8. Test strict access control: every endpoint here must be Super-Admin only — verify explicitly, since a leak exposes all owners' and students' data.

## Deliverable
The V Div team can view/manage every owner, building, and subscription, approve/reject expansions, and monitor platform health — with sensitive actions fully audit-logged.

## Dependency Note
This is purely an aggregation layer over Phases 1, 3, 5, and 6 — build only after those are stable.

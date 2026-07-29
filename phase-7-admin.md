# Phase 7 — Super-Admin / V Div Control Center

## Goal
Give the V Div internal team full platform-wide visibility and control over all owners, buildings, and subscriptions.

## Context for the Implementer
This module is restricted entirely to the Super-Admin role established in Phase 1. It aggregates data from nearly every prior module (owners, buildings, subscriptions, requests, payments, audit logs) into a single administrative control surface.

## Steps

1. **Build the platform-wide Owners/Buildings table endpoint**: returns every owner, their buildings, current subscription tier, actual bed usage, and subscription status — aggregated from Phases 3 and 6.

2. **Build the "Manual Capacity Override" endpoint**: allows a super-admin to directly adjust an owner's subscription capacity without going through the standard request/approval flow (for edge cases, manual sales agreements, etc.).

3. **Build the "Suspend Account" endpoint**: freezes an owner's account (per the subscription status rules defined in Phase 6), with the action logged to the audit service.

4. **Build the "Impersonate Owner" capability**: allows a super-admin to view the system as a specific owner would see it, for support/troubleshooting purposes — ensure this action itself is heavily audit-logged (who impersonated whom, when, for how long), since it is a sensitive capability.

5. **Build the Expansion Queue endpoint**: lists all pending bed-capacity expansion requests from Phase 6, with approve/reject actions. Approving should automatically update the relevant subscription's capacity (from Phase 6).

6. **Build a platform-wide activity feed / audit log viewer**: surfaces recent state changes across all owners and buildings (bed status changes, payment confirmations, request confirmations) pulled from the audit service built in Phase 3 onward.

7. **Build basic platform-wide metrics endpoints**: total requests vs. confirmed rentals across the whole platform (conversion funnel), total active buildings, total verified students — these are the core business health numbers for the V Div team.

8. **Ensure strict access control**: every endpoint in this module must be accessible only to the Super-Admin role — test this explicitly, since a leak here would expose all owners' and students' data.

## Deliverable
The V Div team has one place to view and manage every owner, building, and subscription on the platform, approve or reject expansion requests, and monitor platform health — with sensitive actions like impersonation and suspension fully audit-logged.

## Dependency Note
This phase is the aggregation layer — it should not introduce new core data models, only read from and act upon the models built in Phases 1, 3, 5, and 6. Build this only after those phases are stable.

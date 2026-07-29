# Phase 6 — Owner Subscriptions & Bed Capacity

## Goal
Track each Owner's subscription tier (allowed bed/building capacity) and support requests to expand it.

## Context
Sakanify's business model is tiered by bed capacity (e.g., "50-bed package" at a set monthly price). This module tracks current tier and usage, and the request pathway for expansion, which Phase 7 (Super-Admin) approves or rejects.

## Folders & Files to Create This Phase

```
src/modules/subscriptions/
├── subscription.routes        → Get current subscription/usage, request expansion
├── subscription.controller
├── subscription.service         → Usage calculation, threshold warnings, expansion request creation
└── subscription.model            → owner reference, tier/package name, total bed capacity, monthly price, status (active/overdue/suspended), renewal date
```

## Implementation Steps

1. Build `subscription.model` with the fields above.
2. Build usage calculation logic in `subscription.service`, comparing actual bed count (from Phase 3's `bed.service`) against the subscription's allowed capacity.
3. Build a warning threshold (e.g., 90%+ utilized) to surface as a dashboard alert later.
4. Build the "Request Bed Expansion" endpoint: creates a record consumed by the Super-Admin expansion queue (Phase 7).
5. Build subscription status transitions (active/overdue/suspended) and the business rules tied to each (e.g., a suspended owner may be blocked from accepting new requests).
6. Ensure all subscription data is scoped via the Phase 1 ownership helper — an owner only ever sees their own subscription.

## Deliverable
Each owner has a tracked subscription tier with real usage data, can request capacity expansion, and capacity-based rules are enforced.

## Dependency Note
Expansion requests created here are consumed in Phase 7's expansion queue — design the request record with that downstream consumer in mind.

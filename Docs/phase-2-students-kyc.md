# Phase 2 — Students & Simplified KYC

## Goal
Allow students to register with a lean profile and a minimal identity-verification (KYC) layer, and allow Owners to view verified student data for students linked to their buildings.

## Context
The student model is deliberately lean. Do **not** add fields beyond what's specified (no selfie/face-match, no blood type, no sleep schedule, no quiet-level preference). KYC is intentionally minimal: National ID number, National ID photo, and student's photo only.

## Folders & Files to Create This Phase

```
src/modules/students/
├── student.routes         → Register, update profile, get profile (self and owner-facing)
├── student.controller
├── student.service
├── student.model           → name, phone, email (optional), age, profile photo, college, academic year, university ID (optional), smoking preference
└── student.validation      → Required vs optional field rules

src/modules/kyc/
├── kyc.routes              → Submit KYC, update/resubmit KYC, update verification status
├── kyc.controller
├── kyc.service
└── kyc.model               → national ID number, national ID photo (reference), student photo (reference), verification status (Pending/Verified/Rejected)
```

## Implementation Steps

1. Build `student.model` with exactly the fields listed above — nothing more.
2. Build `kyc.model` as a separate collection linked to the student, so verification status can be tracked/audited independently of the general profile.
3. Use the shared `file-upload.util` (Phase 0) to handle ID photo and profile photo uploads, storing files in the configured cloud bucket — store only the file reference/URL in the database, never raw binary.
4. Build `student.validation` for required/optional fields.
5. Build the verification status field on the KYC record, defaulting to `Pending` on submission, with an update endpoint to change it to `Verified`/`Rejected` (decide whether owner, admin, or both can change it).
6. Build the student registration endpoint creating both the profile and an initial KYC record together.
7. Build separate update endpoints: one for general profile fields (editable anytime), one for KYC resubmission (if rejected).
8. Build the owner-facing endpoint to view a student's profile + KYC data — restricted (via the Phase 1 ownership-scoping helper) to only students connected to that owner's buildings through an active or pending request/rental.
9. Test explicitly: Owner A must not be able to view KYC data for a student with no relationship to Owner A's buildings.

## Deliverable
Students can register with the lean profile, submit simplified KYC, and Owners can view full verified data only for students connected to their own buildings.

## Dependency Note
The Requests module (Phase 4) references this student and KYC data directly when displaying a request to an owner — it should pull from here rather than duplicating data.

## Product Decision Resolved Before Implementation (Added After Review)

**File storage provider decision (finalized):** Following the same abstraction approach used for OTP in Phase 1, do NOT integrate a real cloud storage provider yet. Implement `file-upload.util` (from Phase 0) behind a storage interface (e.g., a `storeFile(buffer, metadata)` / `getFileUrl(reference)` pair of functions) so swapping the real provider in later requires no changes to calling code in `student.service` or `kyc.service`.

For Phase 2 and CI testing, implement the storage adapter as a **local/mock implementation** (e.g., writes to a temp directory or in-memory store during tests, returns a realistic-looking reference/URL). Do not provision or pay for real cloud storage at this stage.

When real storage is needed (ahead of the first real pilot building onboarding in Sohag), the planned provider is **Cloudflare R2** — it is S3-API-compatible (so the existing `@aws-sdk/client-s3` integration from Phase 0 works without code changes, only a different endpoint/credentials), and has no egress fees, making it meaningfully cheaper than AWS S3 for this project's budget-conscious, Egypt-only stage. This decision should be documented in the phase report, and the storage interface must be built now so this swap requires zero changes to `student.service` or `kyc.service` when it happens.

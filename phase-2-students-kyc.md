# Phase 2 — Students & Simplified KYC

## Goal
Allow students to register with a lean profile and a minimal identity-verification (KYC) layer, and allow Owners to view verified student data for students linked to their buildings.

## Context for the Implementer
The student data model has been deliberately kept lean to minimize signup friction. Do **not** add extra fields beyond what is specified below (no selfie/face-match step, no blood type, no sleep schedule, no quiet-level preference) — these were explicitly considered and rejected to keep onboarding fast.

## Student Profile Fields (Core)
- Full name
- Phone number (verified via OTP from Phase 1)
- Email (optional)
- Age
- Profile photo
- College/Faculty
- Academic year
- University ID number (optional)
- Smoking preference (smoker / non-smoker) — the only lifestyle field kept

## KYC Fields (Simplified — Final)
- National ID number
- National ID photo
- Student's photo (this may be the same as the profile photo, or a separate verification photo — decide and document which)

## Steps

1. **Build the student profile model** with exactly the fields listed above — nothing more.

2. **Build the separate KYC model** (National ID number, National ID photo reference, student photo reference) linked to the student profile. Keep KYC data structurally separate from the general profile so verification status can be tracked and audited independently.

3. **Build file upload handling** for ID photos and profile photos, storing files in the cloud storage bucket configured in Phase 0 — store only the file reference/URL in the database document, never the raw binary.

4. **Build field validation** for all required vs. optional fields (e.g., national ID number format, required fields for KYC submission).

5. **Build a verification status field** on the KYC record: `Pending` (default on submission), `Verified`, `Rejected`. Define who can change this status (owner, admin, or both) and build the corresponding update endpoint.

6. **Build the student registration endpoint** that creates both the profile and an initial (empty/pending) KYC record together.

7. **Build the student profile update endpoint** (for non-KYC fields — editable anytime) and a separate KYC update endpoint (for resubmission if rejected).

8. **Build the owner-facing endpoint** to view a student's full profile + KYC data — but only for students who are linked to that owner's buildings via an active or pending rental/request (multi-tenancy isolation — an owner must never see a student they have no relationship with).

9. **Test the isolation rule explicitly**: confirm Owner A cannot query or view KYC data for a student who has never interacted with Owner A's buildings.

## Deliverable
Students can register with the lean profile above, submit simplified KYC data, and Owners can view full verified student data only for students connected to their own buildings.

## Dependency Note
The Request/Booking module (Phase 4) will reference this student profile and KYC data directly — the request record shown to an owner should pull from this module rather than duplicating student data elsewhere.

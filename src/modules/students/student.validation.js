/**
 * student.validation.js
 *
 * zod schemas for the student profile. Required vs optional matches
 * Docs/phase-2-students-kyc.md exactly:
 *
 * Required:  name, college, academic_year, smoking_preference
 * Optional:  email, age, university_id, profile_photo (photo comes via
 *            multipart upload, not this body validation)
 * Server-set (not client-supplied): phone (copied from the authenticated
 * User at registration time).
 */

const { z } = require('zod');
const { SMOKING_PREFERENCE } = require('./student.model');

const registerStudentSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100),
  email: z.string().trim().email('Invalid email format').optional().nullable(),
  age: z.coerce.number().int().min(16).max(99).optional().nullable(),
  college: z.string().trim().min(2).max(150),
  academic_year: z.coerce.number().int().min(1).max(7),
  university_id: z.string().trim().max(50).optional().nullable(),
  smoking_preference: z.enum(Object.values(SMOKING_PREFERENCE)),
});

// Profile update: every field optional, phone is never editable here
// (identity is anchored to the auth User's phone from Phase 1).
const updateProfileSchema = registerStudentSchema.partial();

function validate(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    const err = new Error('Validation failed');
    err.statusCode = 422;
    err.errors = errors;
    throw err;
  }
  return result.data;
}

module.exports = {
  registerStudentSchema,
  updateProfileSchema,
  validate,
};

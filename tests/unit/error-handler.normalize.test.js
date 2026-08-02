/**
 * error-handler.normalize.test.js
 *
 * Security-hardening-pass addition (hardening-audit Category 5 — Error
 * Handling & Information Disclosure). Pure unit tests, no database
 * required: exercises normalizeError() directly for the specific defect
 * this pass fixed — a genuinely unexpected/unclassified error's raw
 * `err.message` used to be returned to the client verbatim regardless of
 * NODE_ENV, which could leak internal details (DB connection strings,
 * library internals, file paths) in production. Also covers the new
 * branch that preserves a plain Error's `.errors` array (student.
 * validation.js's zod helper shape) instead of dropping it, which the
 * naive "just redact everything" fix would otherwise have regressed.
 */

const { AppError, normalizeError } = require('../../src/middleware/error-handler.middleware');

describe('error-handler.middleware normalizeError', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('never redacts an AppError message, even at 5xx, regardless of environment', () => {
    process.env.NODE_ENV = 'production';
    const err = new AppError('Client-safe message for a 500', 500);
    const result = normalizeError(err);
    expect(result).toEqual({ statusCode: 500, message: 'Client-safe message for a 500', errors: null });
  });

  it('classifies a Mongoose CastError into a clean 400 without leaking the raw message', () => {
    const err = new Error("Cast to ObjectId failed for value \"abc\" (type string) at path \"_id\" for model \"Bed\"");
    err.name = 'CastError';
    err.path = '_id';
    const result = normalizeError(err);
    expect(result.statusCode).toBe(400);
    expect(result.message).toBe('Invalid value for field "_id"');
  });

  it('preserves the errors array for a plain Error with an explicit 4xx statusCode (e.g. student.validation.js zod helper)', () => {
    const err = new Error('Validation failed');
    err.statusCode = 422;
    err.errors = ['name: Name must be at least 2 characters', 'college: Required'];
    const result = normalizeError(err);
    expect(result).toEqual({
      statusCode: 422,
      message: 'Validation failed',
      errors: ['name: Name must be at least 2 characters', 'college: Required'],
    });
  });

  it('redacts an unclassified error message to a generic string in production when it resolves to 5xx', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('MongoServerError: connect ECONNREFUSED 10.0.4.12:27017');
    const result = normalizeError(err);
    expect(result.statusCode).toBe(500);
    expect(result.message).toBe('Internal Server Error');
    expect(result.message).not.toMatch(/10\.0\.4\.12/);
  });

  it('keeps the real unclassified error message outside production, so local/CI debugging still sees it', () => {
    process.env.NODE_ENV = 'test';
    const err = new Error('MongoServerError: connect ECONNREFUSED 10.0.4.12:27017');
    const result = normalizeError(err);
    expect(result.statusCode).toBe(500);
    expect(result.message).toBe('MongoServerError: connect ECONNREFUSED 10.0.4.12:27017');
  });

  it('does not redact a plain Error carrying an explicit 4xx statusCode, even in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Owner not found');
    err.statusCode = 404;
    const result = normalizeError(err);
    expect(result).toEqual({ statusCode: 404, message: 'Owner not found', errors: null });
  });
});

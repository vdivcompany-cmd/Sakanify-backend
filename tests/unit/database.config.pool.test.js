/**
 * database.config.pool.test.js
 *
 * Remediation Pass 1 / DB-001 (Docs/reports/remediation-pass-1-report.md):
 * confirms mongoose.connect() is called with explicit connection-pool
 * options (maxPoolSize/minPoolSize/serverSelectionTimeoutMS) rather than
 * silently relying on the MongoDB driver's own defaults — see
 * database.config.js's CONNECTION_OPTIONS comment for the full reasoning.
 * Exists so this specific fix can't silently regress later (e.g. someone
 * "simplifying" the connect() call back down to zero options).
 *
 * Pure unit test, no database required: mongoose.connect() itself is
 * mocked, so this never attempts a real connection.
 */

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sakanify_unit_test_placeholder';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'unit-test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'unit-test-refresh-secret';
// Remediation Pass 2 / SEC-002: env.config.js now requires a correctly-shaped
// MFA_ENCRYPTION_KEY (64 hex chars) to boot at all.
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || '0'.repeat(64);

const mongoose = require('mongoose');
const database = require('../../src/config/database.config');

describe('database.config connection pool options', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('exports explicit maxPoolSize/minPoolSize/serverSelectionTimeoutMS (not left to driver defaults)', () => {
    expect(database.CONNECTION_OPTIONS).toEqual(
      expect.objectContaining({
        maxPoolSize: expect.any(Number),
        minPoolSize: expect.any(Number),
        serverSelectionTimeoutMS: expect.any(Number),
      }),
    );

    // Fail fast (audit Reliability finding #4), not the driver's ~30s
    // default server-selection timeout.
    expect(database.CONNECTION_OPTIONS.serverSelectionTimeoutMS).toBeLessThanOrEqual(10000);

    // Pool bounds should be sane relative to each other.
    expect(database.CONNECTION_OPTIONS.minPoolSize).toBeLessThanOrEqual(database.CONNECTION_OPTIONS.maxPoolSize);
    expect(database.CONNECTION_OPTIONS.maxPoolSize).toBeGreaterThan(0);
  });

  it('passes CONNECTION_OPTIONS through to mongoose.connect() on every connectDB() call', async () => {
    const connectSpy = jest.spyOn(mongoose, 'connect').mockResolvedValue(undefined);

    await database.connectDB();

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining(database.CONNECTION_OPTIONS),
    );
  });

  it('still retries with the same explicit options on a connection failure, not a bare call', async () => {
    const connectSpy = jest
      .spyOn(mongoose, 'connect')
      .mockRejectedValueOnce(new Error('simulated connection failure'))
      .mockResolvedValueOnce(undefined);

    // Avoid the real 5s retry delay slowing this test down.
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

    await database.connectDB();

    expect(connectSpy).toHaveBeenCalledTimes(2);
    for (const call of connectSpy.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining(database.CONNECTION_OPTIONS));
    }
  });
});

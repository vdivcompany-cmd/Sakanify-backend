process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/x';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'a';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'b';
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || '0'.repeat(64);

const assert = require('assert');
const { generate: generateTotp } = require('otplib');
const mfaService = require('./src/modules/auth/mfa.service');

async function main() {
  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log('PASS -', name); }
    catch (e) { failed++; console.log('FAIL -', name, '::', e.message); }
  }

  await test('encrypt/decrypt round-trip', async () => {
    const enc = mfaService.encryptSecret('JBSWY3DPEHPK3PXP');
    assert.notStrictEqual(enc, 'JBSWY3DPEHPK3PXP');
    assert.strictEqual(mfaService.decryptSecret(enc), 'JBSWY3DPEHPK3PXP');
  });

  await test('tampered ciphertext rejected', async () => {
    const enc = mfaService.encryptSecret('JBSWY3DPEHPK3PXP');
    const raw = Buffer.from(enc, 'base64');
    raw[raw.length - 1] ^= 0xff;
    assert.throws(() => mfaService.decryptSecret(raw.toString('base64')));
  });

  await test('generateEnrollment shape', async () => {
    const e = await mfaService.generateEnrollment('x@sakanify.com');
    assert.ok(e.secret.length > 0);
    assert.ok(e.otpauthUri.startsWith('otpauth://totp/'));
    assert.strictEqual(e.backupCodesPlain.length, 10);
    assert.strictEqual(e.backupCodeHashes.length, 10);
    assert.strictEqual(new Set(e.backupCodesPlain).size, 10);
  });

  await test('verifyTotpCode true for real code', async () => {
    const e = await mfaService.generateEnrollment('x@sakanify.com');
    const code = await generateTotp({ secret: e.secret });
    const ok = await mfaService.verifyTotpCode(e.secret, code);
    assert.strictEqual(ok, true);
  });

  await test('verifyTotpCode false for wrong code', async () => {
    const e = await mfaService.generateEnrollment('x@sakanify.com');
    const real = await generateTotp({ secret: e.secret });
    const wrong = real === '000000' ? '111111' : '000000';
    const ok = await mfaService.verifyTotpCode(e.secret, wrong);
    assert.strictEqual(ok, false);
  });

  await test('verifyTotpCode false for malformed token (no throw)', async () => {
    const e = await mfaService.generateEnrollment('x@sakanify.com');
    const ok = await mfaService.verifyTotpCode(e.secret, 'not-a-code');
    assert.strictEqual(ok, false);
  });

  await test('findMatchingUnusedBackupCode matches unused code', async () => {
    const e = await mfaService.generateEnrollment('x@sakanify.com');
    const user = { backup_codes: e.backupCodeHashes.map((h) => ({ code_hash: h, used_at: null })) };
    const m = await mfaService.findMatchingUnusedBackupCode(user, e.backupCodesPlain[0]);
    assert.ok(m);
    assert.strictEqual(m.code_hash, e.backupCodeHashes[0]);
  });

  await test('findMatchingUnusedBackupCode ignores used entry', async () => {
    const e = await mfaService.generateEnrollment('x@sakanify.com');
    const user = { backup_codes: e.backupCodeHashes.map((h, i) => ({ code_hash: h, used_at: i === 0 ? new Date() : null })) };
    const m = await mfaService.findMatchingUnusedBackupCode(user, e.backupCodesPlain[0]);
    assert.strictEqual(m, null);
  });

  await test('findMatchingUnusedBackupCode returns null for unknown code', async () => {
    const e = await mfaService.generateEnrollment('x@sakanify.com');
    const user = { backup_codes: e.backupCodeHashes.map((h) => ({ code_hash: h, used_at: null })) };
    const m = await mfaService.findMatchingUnusedBackupCode(user, 'FFFFFFFFFF');
    assert.strictEqual(m, null);
  });

  console.log('\n---SUMMARY---');
  console.log('passed:', passed, 'failed:', failed);
  process.exit(failed > 0 ? 1 : 0);
}

main();

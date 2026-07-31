/**
 * file-storage.adapter.js
 *
 * Storage interface used by student.service and kyc.service to persist
 * uploaded files (national ID photo, student photo) without those modules
 * knowing or caring which physical provider is behind it.
 *
 * Interface:
 *   storeFile(buffer, metadata) -> { reference, url }
 *   getFileUrl(reference)       -> url (signed/expiring when a real
 *                                  provider is configured)
 *   deleteFile(reference)       -> void (used by KYC anonymization, later)
 *
 * Product decision (see Docs/phase-2-students-kyc.md, "Product Decision
 * Resolved Before Implementation"): do NOT integrate a real cloud provider
 * yet. This phase ships a local/mock adapter that satisfies the same
 * interface a real S3-compatible adapter (Cloudflare R2, planned) will
 * satisfy later. Swapping providers means changing only this file — no
 * changes to student.service or kyc.service.
 *
 * Mock adapter behavior:
 * - Writes the buffer to a local temp directory (never committed, never
 *   served publicly) so uploads are inspectable during development/tests.
 * - Returns a reference string shaped like a real object key
 *   (kyc/<uuid>.<ext>) so calling code and tests never see a difference
 *   between "mock" and "real" reference formats.
 * - getFileUrl() returns a fake but realistic-looking "signed" URL with an
 *   expiry query param, mirroring what a real presigned S3/R2 URL looks
 *   like, so calling code that treats URLs as expiring/opaque doesn't need
 *   to change when the real provider is wired in.
 *
 * CLAUDE.md Section 3.2 (encryption at rest / no public links) and 3.8
 * (validate actual file content, not just declared mimetype) both apply
 * here: content-type is sniffed from magic bytes below, and the mock
 * storage directory is never exposed by an Express static route.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const storageConfig = require('../../config/storage.config');

// --- Real, content-sniffed magic bytes for the 3 allowed image types ---
// (matches ALLOWED_MIME_TYPES in file-upload.util.js). Never trust the
// client-supplied `mimetype` alone (that comes from a header, which is
// trivially spoofable) — inspect the actual bytes instead.
const MAGIC_BYTES = [
  { mime: 'image/jpeg', ext: 'jpg', check: (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff },
  { mime: 'image/png', ext: 'png', check: (buf) => buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 },
  // WEBP: "RIFF" .... "WEBP"
  { mime: 'image/webp', ext: 'webp', check: (buf) => buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' },
];

class UnsupportedFileTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedFileTypeError';
  }
}

/**
 * Sniff the real content type of a buffer from its magic bytes.
 * Throws UnsupportedFileTypeError if the buffer doesn't match any allowed
 * image signature, regardless of what the client claimed.
 */
function sniffContentType(buffer) {
  const match = MAGIC_BYTES.find((entry) => entry.check(buffer));
  if (!match) {
    throw new UnsupportedFileTypeError('File content does not match an allowed image type (jpeg/png/webp)');
  }
  return match;
}

// --- Mock local storage location ---
// Never inside the repo, never served by Express — purely a local sink so
// the mock adapter has somewhere real to write bytes during dev/CI.
const MOCK_STORAGE_DIR = process.env.MOCK_STORAGE_DIR || path.join(os.tmpdir(), 'sakanify-mock-storage');

function ensureMockDir() {
  if (!fs.existsSync(MOCK_STORAGE_DIR)) {
    fs.mkdirSync(MOCK_STORAGE_DIR, { recursive: true });
  }
}

/**
 * storeFile(buffer, metadata)
 *
 * metadata: { folder: 'kyc' | 'students', ownerHint?: string }
 *
 * Returns: { reference, url }
 *   reference — opaque key to store in the database (never raw binary,
 *               never a public path)
 *   url       — a URL usable right now to fetch the file (mock: local
 *               file:// style reference; real: presigned S3/R2 URL)
 */
async function storeFile(buffer, metadata = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('storeFile: buffer must be a Buffer');
  }

  const { mime, ext } = sniffContentType(buffer);
  const folder = metadata.folder || 'misc';
  const reference = `${folder}/${crypto.randomUUID()}.${ext}`;

  const client = storageConfig.getClient();

  if (client) {
    // Real S3/R2 path — left as a documented stub. Wiring this in when the
    // Cloudflare R2 credentials are provisioned is the only change needed;
    // student.service/kyc.service call storeFile()/getFileUrl() and never
    // see this branch.
    throw new Error(
      'file-storage.adapter: STORAGE_* env vars are configured but the real-provider upload path is not implemented yet. ' +
        'Remove STORAGE_* env vars to use the mock adapter, or implement the PutObjectCommand path here before enabling it.',
    );
  }

  // --- Mock adapter: local temp-dir write ---
  ensureMockDir();
  const filePath = path.join(MOCK_STORAGE_DIR, reference.replace(/\//g, '__'));
  await fs.promises.writeFile(filePath, buffer);

  return {
    reference,
    url: getFileUrl(reference),
    mime,
  };
}

/**
 * getFileUrl(reference)
 *
 * Mock adapter: returns a realistic-looking "signed" URL shape (expiring
 * query param) so callers/tests never need to special-case mock vs. real.
 * Real adapter (future): call S3Client + getSignedUrl from
 * @aws-sdk/s3-request-presigner for a genuinely short-lived URL — per
 * CLAUDE.md Section 3.2, KYC files must never be permanently public.
 */
function getFileUrl(reference) {
  if (!reference) return null;

  const client = storageConfig.getClient();
  if (client) {
    throw new Error('file-storage.adapter: real-provider getFileUrl() is not implemented yet.');
  }

  const expiresAt = Date.now() + 15 * 60 * 1000; // mirrors a 15-min presigned URL
  return `https://mock-storage.local/${reference}?expires=${expiresAt}`;
}

/**
 * deleteFile(reference)
 *
 * Used by the future KYC anonymization flow (CLAUDE.md Section 5.2) to
 * remove sensitive files without deleting the student's rental history.
 * Implemented now (mock only) so that future work has a real function to
 * call rather than another "TODO, decide later."
 */
async function deleteFile(reference) {
  if (!reference) return;

  const client = storageConfig.getClient();
  if (client) {
    throw new Error('file-storage.adapter: real-provider deleteFile() is not implemented yet.');
  }

  const filePath = path.join(MOCK_STORAGE_DIR, reference.replace(/\//g, '__'));
  await fs.promises.rm(filePath, { force: true });
}

module.exports = {
  storeFile,
  getFileUrl,
  deleteFile,
  sniffContentType,
  UnsupportedFileTypeError,
  MOCK_STORAGE_DIR,
};

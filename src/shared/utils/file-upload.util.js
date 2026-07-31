/**
 * file-upload.util.js
 *
 * Shared multer configuration for handling incoming file uploads
 * (KYC national ID photo, student photo, etc). Actual usage starts in
 * Phase 2 — this phase only builds the reusable helper.
 *
 * Files are buffered in memory (not written to local disk) because they
 * get streamed straight to S3-compatible storage via storage.config.
 */

const multer = require('multer');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter,
});

module.exports = {
  upload,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
};

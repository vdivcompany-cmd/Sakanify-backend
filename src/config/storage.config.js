/**
 * storage.config.js
 *
 * S3-compatible bucket connection, set up now even though actual upload
 * logic (KYC/profile photos) is built in Phase 2, per the Phase 0 spec.
 *
 * Uses @aws-sdk/client-s3 (AWS SDK v3), which works against any
 * S3-compatible provider (AWS S3, DigitalOcean Spaces, MinIO, etc) by
 * pointing `endpoint` at the provider's URL. Declared as a project
 * dependency in package.json; run `npm install` to fetch it if
 * node_modules doesn't have it yet.
 *
 * If STORAGE_* env vars aren't fully set (see env.config.js), storage is
 * treated as "not configured": getClient() returns null and
 * checkConnection() reports { configured: false } instead of throwing,
 * so the rest of the app can boot without a bucket during early
 * development.
 */

const env = require('./env.config');

let s3Client = null;
let S3Client;
let HeadBucketCommand;

function loadSdk() {
  if (S3Client && HeadBucketCommand) return;
  // eslint-disable-next-line global-require
  const sdk = require('@aws-sdk/client-s3');
  S3Client = sdk.S3Client;
  HeadBucketCommand = sdk.HeadBucketCommand;
}

function getClient() {
  if (!env.storage.isConfigured) return null;

  if (!s3Client) {
    loadSdk();
    s3Client = new S3Client({
      region: env.storage.region,
      endpoint: env.storage.endpoint,
      credentials: {
        accessKeyId: env.storage.accessKeyId,
        secretAccessKey: env.storage.secretAccessKey,
      },
    });
  }

  return s3Client;
}

async function checkConnection() {
  if (!env.storage.isConfigured) {
    return { configured: false, connected: false, message: 'Storage env vars not set' };
  }

  try {
    const client = getClient();
    await client.send(new HeadBucketCommand({ Bucket: env.storage.bucket }));
    return { configured: true, connected: true, bucket: env.storage.bucket };
  } catch (err) {
    return { configured: true, connected: false, message: err.message };
  }
}

module.exports = {
  getClient,
  checkConnection,
  bucket: env.storage.bucket,
};

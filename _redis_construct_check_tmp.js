process.env.MONGODB_URI = 'mongodb://localhost:27017/x';
process.env.JWT_ACCESS_SECRET = 'a';
process.env.JWT_REFRESH_SECRET = 'b';
process.env.MFA_ENCRYPTION_KEY = '0'.repeat(64);
process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { createRateLimitStore, RedisRateLimitStore } = require('./src/shared/utils/redis-rate-limit-store');
const store = createRateLimitStore('otp:');
console.log('store is RedisRateLimitStore:', store instanceof RedisRateLimitStore);
console.log('localKeys:', store.localKeys);
console.log('constructed without throwing - OK');

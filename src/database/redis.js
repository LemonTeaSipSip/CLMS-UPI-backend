const redis = require('redis');
require('dotenv').config();

const client = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
});

client.on('error', (err) => {
    console.error('❌ Redis connection failed:', err.message);
});

client.on('connect', () => {
    console.log('✅ Redis connected successfully (Shadow Ledger ONLINE)');
});

// Connect immediately
(async () => {
    await client.connect();
})();

module.exports = client;


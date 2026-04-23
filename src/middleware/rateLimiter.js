const rateLimit = require('express-rate-limit');

// General API rate limiter
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: {
        success: false,
        error: 'TOO MANY REQUESTS',
        message: 'Too many requests from this IP. Try again after 15 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Strict limiter for auth routes (prevent brute force)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        success: false,
        error: 'TOO MANY LOGIN ATTEMPTS',
        message: 'Too many login attempts. Account temporarily locked for 15 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Transaction limiter (prevent transaction flooding)
const transactionLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20,
    message: {
        success: false,
        error: 'TRANSACTION RATE LIMIT',
        message: 'Too many transactions. Maximum 20 transactions per minute allowed.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = { apiLimiter, authLimiter, transactionLimiter };


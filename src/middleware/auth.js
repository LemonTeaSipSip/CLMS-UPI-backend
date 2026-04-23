const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'clms_super_secret_key_2024';

// Generate JWT token
const generateToken = (payload) => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
};

// Verify JWT token middleware
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'ACCESS DENIED',
            message: 'No token provided. Use POST /api/auth/login to get a token.'
        });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({
            success: false,
            error: 'INVALID TOKEN',
            message: 'Token is expired or invalid. Please login again.'
        });
    }
};

// Simulate mTLS verification for NPCI switch requests
const verifyNPCISignature = (req, res, next) => {
    const npciKey = req.headers['x-npci-api-key'];
    const timestamp = req.headers['x-timestamp'];

    if (!npciKey || !timestamp) {
        return res.status(401).json({
            success: false,
            error: 'NPCI AUTHENTICATION FAILED',
            message: 'Missing x-npci-api-key or x-timestamp headers'
        });
    }

    // Validate NPCI API key
    if (npciKey !== process.env.NPCI_API_KEY) {
        return res.status(403).json({
            success: false,
            error: 'INVALID NPCI KEY',
            message: 'The provided NPCI API key is not authorized'
        });
    }

    // Check timestamp freshness (reject requests older than 5 minutes)
    const requestTime = parseInt(timestamp);
    const currentTime = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    if (currentTime - requestTime > fiveMinutes) {
        return res.status(401).json({
            success: false,
            error: 'REQUEST EXPIRED',
            message: 'Request timestamp is older than 5 minutes. Replay attack prevented.'
        });
    }

    console.log(`🔐 NPCI Switch authenticated successfully`);
    next();
};

module.exports = { generateToken, verifyToken, verifyNPCISignature };

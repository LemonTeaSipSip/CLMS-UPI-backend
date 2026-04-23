const express = require('express');
const router = express.Router();
const pool = require('../../database/db');
const { generateToken } = require('../../middleware/auth');
const { authLimiter } = require('../../middleware/rateLimiter');

// Login - get JWT token
router.post('/login', authLimiter, async (req, res) => {
    const { mobile, upi_id } = req.body;

    if (!mobile || !upi_id) {
        return res.status(400).json({
            success: false,
            message: 'mobile and upi_id are required'
        });
    }

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE mobile = $1 AND upi_id = $2',
            [mobile, upi_id]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                error: 'AUTHENTICATION FAILED',
                message: 'Invalid mobile number or UPI ID'
            });
        }

        const user = result.rows[0];

        // Generate JWT token
        const token = generateToken({
            user_id: user.id,
            mobile: user.mobile,
            upi_id: user.upi_id,
            name: user.name
        });

        res.json({
            success: true,
            message: `Welcome ${user.name}!`,
            token,
            token_type: 'Bearer',
            expires_in: '24h',
            user: {
                id: user.id,
                name: user.name,
                mobile: user.mobile,
                upi_id: user.upi_id
            }
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Public registration — creates user + credit account in one shot
router.post('/register', async (req, res) => {
    const { name, mobile, upi_id, loan_type, upi_pin } = req.body;

    if (!name || !mobile || !upi_id || !loan_type || !upi_pin) {
        return res.status(400).json({
            success: false,
            message: 'name, mobile, upi_id, loan_type and upi_pin are required',
        });
    }

    if (!/^\d{4,6}$/.test(upi_pin)) {
        return res.status(400).json({
            success: false,
            message: 'UPI PIN must be 4–6 digits',
        });
    }

    const validLoanTypes = ['EDUCATION_LOAN', 'CONSUMER_LOAN', 'AGRI_LOAN'];
    if (!validLoanTypes.includes(loan_type)) {
        return res.status(400).json({
            success: false,
            message: `loan_type must be one of: ${validLoanTypes.join(', ')}`,
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userResult = await client.query(
            `INSERT INTO users (name, mobile, upi_id) VALUES ($1, $2, $3) RETURNING *`,
            [name, mobile, upi_id]
        );
        const user = userResult.rows[0];

        const DEFAULT_LIMIT = 25000.00;
        await client.query(
            `INSERT INTO credit_accounts (user_id, loan_type, total_limit, available_limit, status, upi_pin_hash)
             VALUES ($1, $2, $3, $3, 'ACTIVE', $4)`,
            [user.id, loan_type, DEFAULT_LIMIT, upi_pin]
        );

        await client.query('COMMIT');
        res.status(201).json({
            success: true,
            message: `Account created! You can now log in with mobile ${mobile} and UPI ID ${upi_id}.`,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({
                success: false,
                message: 'Mobile number or UPI ID already registered',
            });
        }
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// Verify token validity
router.get('/verify', require('../../middleware/auth').verifyToken, (req, res) => {
    res.json({
        success: true,
        message: 'Token is valid',
        user: req.user
    });
});

// Get NPCI API key (for mock switch authentication)
router.post('/npci-key', async (req, res) => {
    const { admin_secret } = req.body;

    if (admin_secret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({
            success: false,
            message: 'Invalid admin secret'
        });
    }

    res.json({
        success: true,
        npci_api_key: process.env.NPCI_API_KEY,
        message: 'Use this key in x-npci-api-key header for NPCI switch calls'
    });
});

module.exports = router;

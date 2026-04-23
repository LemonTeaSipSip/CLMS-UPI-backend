const express = require('express');
const router = express.Router();
const pool = require('../../database/db');

// Register a new user
router.post('/register', async (req, res) => {
    const { name, mobile, upi_id } = req.body;

    if (!name || !mobile || !upi_id) {
        return res.status(400).json({ 
            success: false, 
            message: 'name, mobile and upi_id are required' 
        });
    }

    try {
        const result = await pool.query(
            `INSERT INTO users (name, mobile, upi_id) 
             VALUES ($1, $2, $3) RETURNING *`,
            [name, mobile, upi_id]
        );
        res.status(201).json({ 
            success: true, 
            message: 'User registered successfully',
            user: result.rows[0] 
        });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ 
                success: false, 
                message: 'Mobile or UPI ID already exists' 
            });
        }
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get user by mobile number
router.get('/mobile/:mobile', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.*, ca.id as account_id, ca.loan_type, 
                    ca.total_limit, ca.available_limit, ca.status
             FROM users u
             LEFT JOIN credit_accounts ca ON ca.user_id = u.id
             WHERE u.mobile = $1`,
            [req.params.mobile]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found' 
            });
        }
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get all users
router.get('/all', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.id, u.name, u.mobile, u.upi_id, u.created_at,
                    COUNT(ca.id) as credit_accounts
             FROM users u
             LEFT JOIN credit_accounts ca ON ca.user_id = u.id
             GROUP BY u.id`
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;


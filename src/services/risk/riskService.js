const express = require('express');
const router = express.Router();
const pool = require('../../database/db');

// Core risk evaluation function (used by transaction service)
const evaluateRisk = async (loan_type, mcc, amount, account) => {
    const reasons = [];
    let approved = true;

    // Check 1: Account Status
    if (account.status !== 'ACTIVE') {
        approved = false;
        reasons.push(`Account is ${account.status} - transactions blocked`);
    }

    // Check 2: Sufficient Limit
    if (amount > parseFloat(account.available_limit)) {
        approved = false;
        reasons.push(
            `Insufficient limit. Requested: ₹${amount}, Available: ₹${account.available_limit}`
        );
    }

    // Check 3: MCC Filtering (Purpose-Bound Check)
    const mccResult = await pool.query(
        `SELECT is_allowed, description FROM mcc_rules 
         WHERE loan_type = $1 AND mcc = $2`,
        [loan_type, mcc]
    );

    if (mccResult.rows.length === 0) {
        // MCC not in our rules = not explicitly allowed = block it
        approved = false;
        reasons.push(`MCC ${mcc} is not permitted for ${loan_type}`);
    } else if (!mccResult.rows[0].is_allowed) {
        approved = false;
        reasons.push(
            `MCC ${mcc} (${mccResult.rows[0].description}) is blocked for ${loan_type}`
        );
    }

    return {
        approved,
        reasons,
        mcc_description: mccResult.rows[0]?.description || 'Unknown Merchant Category'
    };
};

// API endpoint to test risk engine directly
router.post('/evaluate', async (req, res) => {
    const { loan_type, mcc, amount, account_id } = req.body;

    if (!loan_type || !mcc || !amount || !account_id) {
        return res.status(400).json({
            success: false,
            message: 'loan_type, mcc, amount, account_id are required'
        });
    }

    try {
        const accountResult = await pool.query(
            'SELECT * FROM credit_accounts WHERE id = $1',
            [account_id]
        );

        if (accountResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false, message: 'Account not found' 
            });
        }

        const account = accountResult.rows[0];
        const result = await evaluateRisk(loan_type, mcc, amount, account);

        res.json({
            success: true,
            decision: result.approved ? 'APPROVED' : 'REJECTED',
            reasons: result.reasons,
            mcc_description: result.mcc_description,
            account_status: account.status,
            available_limit: account.available_limit
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// View all MCC rules
router.get('/mcc-rules', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM mcc_rules ORDER BY loan_type, is_allowed DESC`
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Add a new MCC rule
router.post('/mcc-rules', async (req, res) => {
    const { loan_type, mcc, is_allowed, description } = req.body;

    if (!loan_type || !mcc || is_allowed === undefined || !description) {
        return res.status(400).json({
            success: false,
            message: 'loan_type, mcc, is_allowed, description are required'
        });
    }

    try {
        const result = await pool.query(
            `INSERT INTO mcc_rules (loan_type, mcc, is_allowed, description)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [loan_type, mcc, is_allowed, description]
        );
        res.status(201).json({ 
            success: true, 
            message: 'MCC rule added',
            rule: result.rows[0] 
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = { router, evaluateRisk };


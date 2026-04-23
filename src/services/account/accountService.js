const express = require('express');
const router = express.Router();
const pool = require('../../database/db');
const redisClient = require('../../database/redis');

// Helper: Write limit to Redis Shadow Ledger
const syncToShadowLedger = async (account_id, available_limit, total_limit, status, loan_type) => {
    await redisClient.hSet(`account:${account_id}`, {
        available_limit: available_limit.toString(),
        total_limit: total_limit.toString(),
        status: status || 'ACTIVE',
        loan_type: loan_type || 'UNKNOWN'
    });
    await redisClient.expire(`account:${account_id}`, 86400);
    console.log(`⚡ Shadow Ledger synced: account ${account_id} | loan:${loan_type} | status:${status} | limit:₹${available_limit}`);
};

// Helper: Read limit from Redis Shadow Ledger
const readFromShadowLedger = async (account_id) => {
    const data = await redisClient.hGetAll(`account:${account_id}`);
    if (Object.keys(data).length === 0) return null;
    return data;
};

// Link a credit line to a user (Onboarding)
router.post('/link', async (req, res) => {
    const { user_id, loan_type, total_limit, upi_pin } = req.body;

    if (!user_id || !loan_type || !total_limit || !upi_pin) {
        return res.status(400).json({
            success: false,
            message: 'user_id, loan_type, total_limit, upi_pin are required'
        });
    }

    const validLoanTypes = ['EDUCATION_LOAN', 'CONSUMER_LOAN', 'AGRI_LOAN'];
    if (!validLoanTypes.includes(loan_type)) {
        return res.status(400).json({
            success: false,
            message: `loan_type must be one of: ${validLoanTypes.join(', ')}`
        });
    }

    try {
        // Check user exists
        const userCheck = await pool.query(
            'SELECT id FROM users WHERE id = $1', [user_id]
        );
        if (userCheck.rows.length === 0) {
            return res.status(404).json({
                success: false, message: 'User not found'
            });
        }

        // Create credit account in PostgreSQL
        const account = await pool.query(
            `INSERT INTO credit_accounts
             (user_id, loan_type, total_limit, available_limit, upi_pin_hash)
             VALUES ($1, $2, $3, $3, $4) RETURNING *`,
            [user_id, loan_type, total_limit, upi_pin]
        );

        // Log consent
        await pool.query(
            `INSERT INTO consent_log (user_id, account_id, consent_text)
             VALUES ($1, $2, $3)`,
            [user_id, account.rows[0].id,
             `User consented to link ${loan_type} credit line of ₹${total_limit}`]
        );

        // ⚡ Write to Redis Shadow Ledger immediately
        await syncToShadowLedger(
            account.rows[0].id,
            total_limit,
            total_limit,
            'ACTIVE',
            loan_type
        );

        res.status(201).json({
            success: true,
            message: 'Credit line linked successfully',
            shadow_ledger: '⚡ Synced to Redis',
            account: account.rows[0]
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get account by user_id
router.get('/by-user/:user_id', async (req, res) => {
    const { user_id } = req.params;
    try {
        const result = await pool.query(
            `SELECT ca.*, u.name, u.mobile, u.upi_id
             FROM credit_accounts ca
             JOIN users u ON u.id = ca.user_id
             WHERE ca.user_id = $1 LIMIT 1`,
            [user_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }
        const acc = result.rows[0];
        await syncToShadowLedger(acc.id, acc.available_limit, acc.total_limit, acc.status, acc.loan_type);
        res.json({ success: true, data: acc });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get account balance - checks Redis first, falls back to PostgreSQL
router.get('/:account_id', async (req, res) => {
    const { account_id } = req.params;
    const start = Date.now();

    try {
        // Try Redis first (Shadow Ledger)
        const shadowData = await readFromShadowLedger(account_id);

        if (shadowData) {
            const latency = Date.now() - start;
            return res.json({
                success: true,
                source: '⚡ Redis Shadow Ledger',
                latency_ms: latency,
                data: {
                    account_id,
                    available_limit: parseFloat(shadowData.available_limit),
                    total_limit: parseFloat(shadowData.total_limit),
                    status: shadowData.status,
                    loan_type: shadowData.loan_type
                }
            });
        }

        // Fallback to PostgreSQL if Redis miss
        console.log(`⚠️  Redis miss for ${account_id} - falling back to PostgreSQL`);
        const result = await pool.query(
            `SELECT ca.*, u.name, u.mobile, u.upi_id
             FROM credit_accounts ca
             JOIN users u ON u.id = ca.user_id
             WHERE ca.id = $1`,
            [account_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false, message: 'Account not found'
            });
        }

        // Re-sync to Redis since it was missing
        const acc = result.rows[0];
        await syncToShadowLedger(
            acc.id, acc.available_limit,
            acc.total_limit, acc.status, acc.loan_type
        );

        const latency = Date.now() - start;
        res.json({
            success: true,
            source: '🐘 PostgreSQL (Redis miss - now resynced)',
            latency_ms: latency,
            data: result.rows[0]
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Block or Unblock account - updates BOTH Redis and PostgreSQL
router.patch('/:account_id/status', async (req, res) => {
    const { status } = req.body;
    const validStatuses = ['ACTIVE', 'FROZEN', 'BLOCKED'];

    if (!validStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: `Status must be one of: ${validStatuses.join(', ')}`
        });
    }

    try {
        // Update PostgreSQL
        const result = await pool.query(
            `UPDATE credit_accounts SET status = $1
             WHERE id = $2 RETURNING *`,
            [status, req.params.account_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false, message: 'Account not found'
            });
        }

        // ⚡ Update Redis Shadow Ledger immediately
        await redisClient.hSet(`account:${req.params.account_id}`, {
            status
        });

        res.json({
            success: true,
            message: `Account status updated to ${status}`,
            shadow_ledger: '⚡ Redis updated',
            account: result.rows[0]
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// Force resync all accounts from PostgreSQL to Redis
router.post('/resync-shadow-ledger', async (req, res) => {
    try {
        const accounts = await pool.query('SELECT * FROM credit_accounts');
        let synced = 0;

        for (const acc of accounts.rows) {
            await syncToShadowLedger(
                acc.id,
                acc.available_limit,
                acc.total_limit,
                acc.status,
                acc.loan_type
            );
            synced++;
        }

        res.json({
            success: true,
            message: `✅ Resynced ${synced} accounts to Redis Shadow Ledger`
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = { router, syncToShadowLedger, readFromShadowLedger };
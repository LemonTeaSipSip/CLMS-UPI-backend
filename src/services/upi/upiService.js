const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const QRCode = require('qrcode');
const pool = require('../../database/db');
const redisClient = require('../../database/redis');
const { evaluateRisk } = require('../risk/riskService');
const { syncToShadowLedger } = require('../account/accountService');
require('dotenv').config();

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ─────────────────────────────────────────
// FLOW 1: DISCOVERY
// Find all credit lines linked to a mobile number
// ─────────────────────────────────────────
router.get('/discover/:mobile', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT 
                u.name, u.mobile, u.upi_id,
                ca.id as account_id,
                ca.loan_type,
                ca.total_limit,
                ca.available_limit,
                ca.status,
                ca.created_at
             FROM users u
             JOIN credit_accounts ca ON ca.user_id = u.id
             WHERE u.mobile = $1 AND ca.status = 'ACTIVE'`,
            [req.params.mobile]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No active credit lines found for this mobile number'
            });
        }

        // Check Redis for live limit for each account
        const accounts = await Promise.all(result.rows.map(async (acc) => {
            const shadowData = await redisClient.hGetAll(`account:${acc.account_id}`);
            return {
                ...acc,
                available_limit: shadowData.available_limit 
                    ? parseFloat(shadowData.available_limit) 
                    : parseFloat(acc.available_limit),
                limit_source: shadowData.available_limit ? '⚡ Redis' : '🐘 PostgreSQL'
            };
        }));

        res.json({
            success: true,
            message: `Found ${accounts.length} active credit line(s)`,
            upi_flow: 'DISCOVERY',
            accounts
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────
// FLOW 2: GENERATE UPI QR CODE FOR MERCHANT
// ─────────────────────────────────────────
router.post('/generate-qr', async (req, res) => {
    const { merchant_name, amount, mcc, description } = req.body;

    if (!merchant_name || !amount || !mcc) {
        return res.status(400).json({
            success: false,
            message: 'merchant_name, amount, mcc are required'
        });
    }

    try {
        // Create Razorpay order (test mode)
        const order = await razorpay.orders.create({
            amount: Math.round(amount * 100), // Razorpay uses paise
            currency: 'INR',
            notes: {
                merchant_name,
                mcc,
                description: description || `Payment to ${merchant_name}`,
                payment_type: 'CREDIT_LINE_UPI'
            }
        });

        // Build UPI deep link (standard UPI URL format)
        const upiLink = `upi://pay?pa=merchant@razorpay&pn=${encodeURIComponent(merchant_name)}&am=${amount}&cu=INR&tn=${encodeURIComponent(description || `Payment to ${merchant_name}`)}&tr=${order.id}`;

        // Generate QR code as base64 image
        const qrCodeBase64 = await QRCode.toDataURL(upiLink, {
            width: 300,
            margin: 2,
            color: {
                dark: '#1a1a2e',
                light: '#ffffff'
            }
        });

        // Store order in Redis for quick lookup during payment
        await redisClient.setEx(
            `order:${order.id}`,
            3600, // 1 hour expiry
            JSON.stringify({
                order_id: order.id,
                merchant_name,
                amount,
                mcc,
                status: 'PENDING'
            })
        );

        res.json({
            success: true,
            upi_flow: 'QR_GENERATION',
            order: {
                order_id: order.id,
                amount,
                currency: 'INR',
                merchant_name,
                mcc,
                status: order.status
            },
            upi_link: upiLink,
            qr_code: qrCodeBase64,
            instructions: [
                '1. Show this QR to customer',
                '2. Customer scans with UPI app',
                '3. Customer selects Credit Line as payment source',
                '4. CLMS validates MCC + limit in real-time',
                '5. Payment approved/rejected instantly'
            ]
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────
// FLOW 3: PAY FROM CREDIT LINE
// Called when customer confirms payment
// ─────────────────────────────────────────
router.post('/pay', async (req, res) => {
    const { account_id, upi_pin, order_id, upi_id } = req.body;

    if (!account_id || !upi_pin || !order_id || !upi_id) {
        return res.status(400).json({
            success: false,
            message: 'account_id, upi_pin, order_id, upi_id are required'
        });
    }

    const startTime = Date.now();

    try {
        // Step 1: Fetch order details from Redis
        const orderData = await redisClient.get(`order:${order_id}`);
        if (!orderData) {
            return res.status(404).json({
                success: false,
                message: 'Order not found or expired. Generate a new QR code.'
            });
        }

        const order = JSON.parse(orderData);

        if (order.status === 'PAID') {
            return res.status(409).json({
                success: false,
                message: 'This order has already been paid'
            });
        }

        // Step 2: Get account from Redis Shadow Ledger
        const shadowData = await redisClient.hGetAll(`account:${account_id}`);
        if (Object.keys(shadowData).length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Account not found in Shadow Ledger. Please resync.'
            });
        }

        const account = {
            id: account_id,
            available_limit: parseFloat(shadowData.available_limit),
            total_limit: parseFloat(shadowData.total_limit),
            status: shadowData.status,
            loan_type: shadowData.loan_type
        };

        // Step 3: Validate UPI PIN from PostgreSQL
        const pinCheck = await pool.query(
            'SELECT upi_pin_hash, upi_id FROM credit_accounts ca JOIN users u ON u.id = ca.user_id WHERE ca.id = $1',
            [account_id]
        );

        if (!pinCheck.rows[0] || pinCheck.rows[0].upi_pin_hash !== upi_pin) {
            return res.status(401).json({
                success: false,
                error: 'INVALID_UPI_PIN',
                message: 'Invalid UPI PIN. Transaction declined.'
            });
        }

        // Step 4: Run Risk Engine (MCC + Limit check)
        const riskResult = await evaluateRisk(
            account.loan_type,
            order.mcc,
            order.amount,
            account
        );

        if (!riskResult.approved) {
            // Log rejected transaction
            await pool.query(
                `INSERT INTO transactions
                 (account_id, amount, merchant_name, mcc, purpose_code, status, rejection_reason)
                 VALUES ($1, $2, $3, $4, $5, 'REJECTED', $6)`,
                [account_id, order.amount, order.merchant_name,
                 order.mcc, account.loan_type, riskResult.reasons.join(' | ')]
            );

            return res.status(422).json({
                success: false,
                upi_flow: 'PAYMENT',
                decision: 'REJECTED',
                order_id,
                reasons: riskResult.reasons,
                mcc_description: riskResult.mcc_description
            });
        }

        // Step 5: Capture payment via Razorpay (test mode)
        const razorpayOrder = await razorpay.orders.fetch(order_id);

        // Step 6: Debit Redis Shadow Ledger instantly
        const newLimit = parseFloat(account.available_limit) - parseFloat(order.amount);
        await redisClient.hSet(`account:${account_id}`, {
            available_limit: newLimit.toString()
        });

        // Step 7: Update order status in Redis
        await redisClient.setEx(
            `order:${order_id}`,
            3600,
            JSON.stringify({ ...order, status: 'PAID', paid_by: account_id })
        );

        // Step 8: Persist to PostgreSQL
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                `UPDATE credit_accounts 
                 SET available_limit = available_limit - $1 
                 WHERE id = $2`,
                [order.amount, account_id]
            );

            const txn = await client.query(
                `INSERT INTO transactions
                 (account_id, amount, merchant_name, mcc, purpose_code, status)
                 VALUES ($1, $2, $3, $4, $5, 'SUCCESS') RETURNING *`,
                [account_id, order.amount, order.merchant_name,
                 order.mcc, account.loan_type]
            );

            await client.query('COMMIT');

            const latency = Date.now() - startTime;

            res.json({
                success: true,
                upi_flow: 'PAYMENT',
                decision: 'APPROVED',
                message: `✅ Payment of ₹${order.amount} to ${order.merchant_name} successful!`,
                transaction: {
                    transaction_id: txn.rows[0].id,
                    order_id,
                    amount: order.amount,
                    merchant: order.merchant_name,
                    mcc_description: riskResult.mcc_description,
                    paid_from: `Credit Line (${account.loan_type})`,
                    upi_id: pinCheck.rows[0].upi_id,
                    remaining_limit: newLimit,
                    timestamp: new Date().toISOString()
                },
                performance: {
                    total_latency_ms: latency,
                    limit_check: '⚡ Redis Shadow Ledger',
                    persistence: '🐘 PostgreSQL'
                },
                razorpay: {
                    order_id: razorpayOrder.id,
                    status: razorpayOrder.status,
                    environment: 'TEST MODE'
                }
            });

        } catch (err) {
            await client.query('ROLLBACK');
            // Rollback Redis
            await redisClient.hSet(`account:${account_id}`, {
                available_limit: account.available_limit.toString()
            });
            throw err;
        } finally {
            client.release();
        }

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─────────────────────────────────────────
// FLOW 4: REPAYMENT via UPI
// ─────────────────────────────────────────
router.post('/repay', async (req, res) => {
    const { account_id, amount, upi_id } = req.body;

    if (!account_id || !amount || !upi_id) {
        return res.status(400).json({
            success: false,
            message: 'account_id, amount, upi_id are required'
        });
    }

    try {
        // Create repayment order on Razorpay
        const order = await razorpay.orders.create({
            amount: Math.round(amount * 100),
            currency: 'INR',
            notes: {
                payment_type: 'CREDIT_LINE_REPAYMENT',
                account_id,
                upi_id
            }
        });

        // Get account details
        const accountResult = await pool.query(
            'SELECT * FROM credit_accounts WHERE id = $1',
            [account_id]
        );

        if (accountResult.rows.length === 0) {
            return res.status(404).json({
                success: false, message: 'Account not found'
            });
        }

        const acc = accountResult.rows[0];
        const newLimit = Math.min(
            parseFloat(acc.available_limit) + parseFloat(amount),
            parseFloat(acc.total_limit)
        );

        // Update PostgreSQL
        await pool.query(
            'UPDATE credit_accounts SET available_limit = $1 WHERE id = $2',
            [newLimit, account_id]
        );

        // Log repayment transaction
        await pool.query(
            `INSERT INTO transactions
             (account_id, amount, merchant_name, mcc, purpose_code, status)
             VALUES ($1, $2, 'UPI_REPAYMENT', '0000', $3, 'SUCCESS')`,
            [account_id, amount, acc.loan_type]
        );

        // Update Redis Shadow Ledger
        await redisClient.hSet(`account:${account_id}`, {
            available_limit: newLimit.toString()
        });

        res.json({
            success: true,
            upi_flow: 'REPAYMENT',
            message: `✅ Repayment of ₹${amount} received successfully`,
            repayment: {
                order_id: order.id,
                amount_paid: amount,
                previous_limit: acc.available_limit,
                new_limit: newLimit,
                upi_id,
                timestamp: new Date().toISOString()
            },
            razorpay: {
                order_id: order.id,
                status: order.status,
                environment: 'TEST MODE'
            },
            shadow_ledger: '⚡ Redis updated'
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get order status
router.get('/order/:order_id', async (req, res) => {
    try {
        const orderData = await redisClient.get(`order:${req.params.order_id}`);
        if (!orderData) {
            return res.status(404).json({
                success: false,
                message: 'Order not found or expired'
            });
        }

        const order = JSON.parse(orderData);
        const razorpayOrder = await razorpay.orders.fetch(req.params.order_id);

        res.json({
            success: true,
            order: {
                ...order,
                razorpay_status: razorpayOrder.status,
                amount_in_paise: razorpayOrder.amount
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;

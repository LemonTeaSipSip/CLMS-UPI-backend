const express = require("express");
const router = express.Router();
const pool = require("../../database/db");
const redisClient = require("../../database/redis");
const { evaluateRisk } = require("../risk/riskService");
const { syncToShadowLedger } = require("../account/accountService");

// PAY - Main transaction flow with Redis Shadow Ledger
router.post("/pay", async (req, res) => {
  const { account_id, upi_pin, amount, merchant_name, mcc } = req.body;

  if (!account_id || !upi_pin || !amount || !merchant_name || !mcc) {
    return res.status(400).json({
      success: false,
      message: "account_id, upi_pin, amount, merchant_name, mcc are required",
    });
  }

  const startTime = Date.now();

  try {
    // ⚡ STEP 1: Read from Redis Shadow Ledger (sub-millisecond)
    const shadowData = await redisClient.hGetAll(`account:${account_id}`);
    const redisHit = Object.keys(shadowData).length > 0;

    let account;

    if (redisHit) {
      console.log(`⚡ Redis HIT for account ${account_id}`);
      console.log(`⚡ Redis data:`, shadowData);
      account = {
        id: account_id,
        available_limit: parseFloat(shadowData.available_limit) || 0,
        total_limit: parseFloat(shadowData.total_limit) || 0,
        status: shadowData.status || "ACTIVE",
        loan_type: shadowData.loan_type || "EDUCATION_LOAN",
        upi_pin_hash: shadowData.upi_pin_hash || null,
      };
    } else {
      // Fallback to PostgreSQL
      console.log(`⚠️  Redis MISS - fetching from PostgreSQL`);
      const dbResult = await pool.query(
        "SELECT * FROM credit_accounts WHERE id = $1",
        [account_id],
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Account not found",
        });
      }
      account = dbResult.rows[0];
    }

    // STEP 2: Validate UPI PIN (always from PostgreSQL for security)
    const pinCheck = await pool.query(
      "SELECT upi_pin_hash FROM credit_accounts WHERE id = $1",
      [account_id],
    );

    if (pinCheck.rows[0].upi_pin_hash !== upi_pin) {
      await pool.query(
        `INSERT INTO transactions
                 (account_id, amount, merchant_name, mcc, status, rejection_reason)
                 VALUES ($1, $2, $3, $4, 'FAILED', 'Invalid UPI PIN')`,
        [account_id, amount, merchant_name, mcc],
      );
      return res.status(401).json({
        success: false,
        message: "Invalid UPI PIN",
      });
    }

    // STEP 3: Run Risk Engine
    const riskResult = await evaluateRisk(
      account.loan_type,
      mcc,
      amount,
      account,
    );

    if (!riskResult.approved) {
      await pool.query(
        `INSERT INTO transactions
                 (account_id, amount, merchant_name, mcc,
                  purpose_code, status, rejection_reason)
                 VALUES ($1, $2, $3, $4, $5, 'REJECTED', $6)`,
        [
          account_id,
          amount,
          merchant_name,
          mcc,
          account.loan_type,
          riskResult.reasons.join(" | "),
        ],
      );
      return res.status(422).json({
        success: false,
        decision: "REJECTED",
        reasons: riskResult.reasons,
        mcc_description: riskResult.mcc_description,
      });
    }

    // ⚡ STEP 4: Debit Redis Shadow Ledger FIRST (instant response)
    const newLimit = parseFloat(account.available_limit) - parseFloat(amount);
    await redisClient.hSet(`account:${account_id}`, {
      available_limit: newLimit.toString(),
    });
    console.log(
      `⚡ Shadow Ledger debited: ₹${amount} | New limit: ₹${newLimit}`,
    );

    // STEP 5: Persist to PostgreSQL asynchronously (durability)
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE credit_accounts
                 SET available_limit = available_limit - $1
                 WHERE id = $2`,
        [amount, account_id],
      );
      const txn = await client.query(
        `INSERT INTO transactions
                 (account_id, amount, merchant_name, mcc, purpose_code, status)
                 VALUES ($1, $2, $3, $4, $5, 'SUCCESS') RETURNING *`,
        [account_id, amount, merchant_name, mcc, account.loan_type],
      );
      await client.query("COMMIT");

      const latency = Date.now() - startTime;

      res.status(200).json({
        success: true,
        decision: "APPROVED",
        message: `Payment of ₹${amount} to ${merchant_name} successful`,
        transaction_id: txn.rows[0].id,
        mcc_description: riskResult.mcc_description,
        remaining_limit: newLimit,
        performance: {
          total_latency_ms: latency,
          limit_check_source: redisHit ? "⚡ Redis (sub-ms)" : "🐘 PostgreSQL",
        },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      // Rollback Redis too
      await redisClient.hSet(`account:${account_id}`, {
        available_limit: account.available_limit.toString(),
      });
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// REPAYMENT - updates both Redis and PostgreSQL
router.post("/repay", async (req, res) => {
  const { account_id, amount } = req.body;

  if (!account_id || !amount) {
    return res.status(400).json({
      success: false,
      message: "account_id and amount are required",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const accountResult = await client.query(
      "SELECT * FROM credit_accounts WHERE id = $1 FOR UPDATE",
      [account_id],
    );

    if (accountResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    const account = accountResult.rows[0];
    const newLimit = Math.min(
      parseFloat(account.available_limit) + parseFloat(amount),
      parseFloat(account.total_limit),
    );

    // Update PostgreSQL
    await client.query(
      "UPDATE credit_accounts SET available_limit = $1 WHERE id = $2",
      [newLimit, account_id],
    );

    await client.query(
      `INSERT INTO transactions
             (account_id, amount, merchant_name, mcc, purpose_code, status)
             VALUES ($1, $2, 'REPAYMENT', '0000', $3, 'SUCCESS')`,
      [account_id, amount, account.loan_type],
    );

    await client.query("COMMIT");

    // ⚡ Update Redis Shadow Ledger
    await redisClient.hSet(`account:${account_id}`, {
      available_limit: newLimit.toString(),
    });
    console.log(
      `⚡ Shadow Ledger repayment synced: ₹${newLimit} now available`,
    );

    res.json({
      success: true,
      message: `Repayment of ₹${amount} received`,
      new_available_limit: newLimit,
      shadow_ledger: "⚡ Redis updated",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// Mini Statement
router.get("/:account_id/statement", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, amount, merchant_name, mcc, purpose_code,
                    status, rejection_reason, created_at
             FROM transactions
             WHERE account_id = $1
             ORDER BY created_at DESC LIMIT 10`,
      [req.params.account_id],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

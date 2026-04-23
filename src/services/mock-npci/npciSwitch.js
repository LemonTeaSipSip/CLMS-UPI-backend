const express = require("express");
const router = express.Router();

// Simulates NPCI sending transaction requests to our CLMS
// In real life, NPCI sends ISO 8583 messages - we simulate with JSON

const testScenarios = [
  {
    name: "✅ Valid Education Loan - College Fee",
    payload: {
      merchant_name: "Delhi University",
      mcc: "8220",
      amount: 5000,
    },
  },
  {
    name: "❌ Education Loan - Restaurant BLOCKED",
    payload: {
      merchant_name: "Pizza Hut",
      mcc: "5812",
      amount: 500,
    },
  },
  {
    name: "❌ Education Loan - Gambling BLOCKED",
    payload: {
      merchant_name: "Casino Royale",
      mcc: "7995",
      amount: 1000,
    },
  },
  {
    name: "❌ Insufficient Limit",
    payload: {
      merchant_name: "Delhi University",
      mcc: "8220",
      amount: 999999,
    },
  },
  {
    name: "✅ Valid Education Loan - School Fee",
    payload: {
      merchant_name: "DPS School",
      mcc: "8211",
      amount: 2000,
    },
  },
];

// Show all test scenarios
router.get("/scenarios", (req, res) => {
  res.json({
    success: true,
    message: "Mock NPCI Switch - Available Test Scenarios",
    note: "Use POST /mock-npci/simulate with account_id and upi_pin to run a scenario",
    scenarios: testScenarios.map((s, i) => ({
      scenario_number: i + 1,
      name: s.name,
      payload: s.payload,
    })),
  });
});

// Simulate NPCI sending a specific scenario
router.post("/simulate", async (req, res) => {
  const { account_id, upi_pin, scenario_number } = req.body;

  if (!account_id || !upi_pin || !scenario_number) {
    return res.status(400).json({
      success: false,
      message: "account_id, upi_pin, scenario_number (1-5) are required",
    });
  }

  const scenario = testScenarios[scenario_number - 1];
  if (!scenario) {
    return res.status(400).json({
      success: false,
      message: `Invalid scenario. Choose between 1 and ${testScenarios.length}`,
    });
  }

  // Build the transaction request exactly as NPCI would send it
  const npciRequest = {
    account_id,
    upi_pin,
    ...scenario.payload,
  };

  console.log("\n🏦 NPCI SWITCH SENDING REQUEST:");
  console.log("Scenario:", scenario.name);
  console.log("Payload:", JSON.stringify(npciRequest, null, 2));

  try {
    // Internally call our Transaction Service
    const { generateToken } = require("../../middleware/auth");
    const systemToken = generateToken({
      user_id: "npci-switch",
      mobile: "system",
      upi_id: "npci@system",
      name: "NPCI Switch",
    });

    const response = await fetch(
      `http://localhost:${process.env.PORT}/api/transaction/pay`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${systemToken}`,
        },
        body: JSON.stringify(npciRequest),
      },
    );

    const result = await response.json();

    console.log("📨 CLMS RESPONSE:", JSON.stringify(result, null, 2));

    res.json({
      success: true,
      scenario: scenario.name,
      npci_request: npciRequest,
      clms_response: result,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Simulate a full lifecycle (all 5 scenarios in sequence)
router.post("/simulate-all", async (req, res) => {
  const { account_id, upi_pin } = req.body;

  if (!account_id || !upi_pin) {
    return res.status(400).json({
      success: false,
      message: "account_id and upi_pin are required",
    });
  }

  const results = [];

  for (let i = 0; i < testScenarios.length; i++) {
    const scenario = testScenarios[i];
    const npciRequest = { account_id, upi_pin, ...scenario.payload };

    try {
      const { generateToken } = require("../../middleware/auth");
      const systemToken = generateToken({
        user_id: "npci-switch",
        mobile: "system",
        upi_id: "npci@system",
        name: "NPCI Switch",
      });

      const response = await fetch(
        `http://localhost:${process.env.PORT}/api/transaction/pay`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${systemToken}`,
          },
          body: JSON.stringify(npciRequest),
        },
      );
      const result = await response.json();
      results.push({
        scenario_number: i + 1,
        scenario_name: scenario.name,
        decision: result.decision || "FAILED",
        message: result.message || result.reasons?.join(", "),
      });
    } catch (err) {
      results.push({
        scenario_number: i + 1,
        scenario_name: scenario.name,
        decision: "ERROR",
        message: err.message,
      });
    }
  }

  res.json({
    success: true,
    message: "Full NPCI simulation complete",
    results,
  });
});

module.exports = router;

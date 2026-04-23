const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const app = express();

// Security headers
app.use(helmet());
app.use(cors());
app.use(express.json());

// Import middleware
const { verifyToken, verifyNPCISignature } = require("./middleware/auth");
const { apiLimiter, transactionLimiter } = require("./middleware/rateLimiter");

// Import all services
const authService = require("./services/user/authService");
const userService = require("./services/user/userService");
const { router: accountService } = require("./services/account/accountService");
const transactionService = require("./services/transaction/transactionService");
const { router: riskRouter } = require("./services/risk/riskService");
const npciSwitch = require("./services/mock-npci/npciSwitch");

const upiService = require("./services/upi/upiService");
// Apply global rate limiter
app.use(apiLimiter);

// Public routes (no auth needed)
app.use("/api/auth", authService);

// Protected routes (JWT required)
app.use("/api/user", verifyToken, userService);
app.use("/api/account", verifyToken, accountService);
app.use("/api/risk", verifyToken, riskRouter);

// Transaction routes (JWT + rate limit)
app.use(
  "/api/transaction",
  verifyToken,
  transactionLimiter,
  transactionService,
);

// NPCI Switch routes (NPCI signature required)
app.use("/api/mock-npci", verifyNPCISignature, npciSwitch);

// Health check (public)
app.get("/", (req, res) => {
  res.json({
    system: "Credit Line Management System (CLMS)",
    version: "2.0.0",
    status: "🟢 ONLINE",
    security: {
      jwt_auth: "✅ ENABLED",
      rate_limiting: "✅ ENABLED",
      npci_signature: "✅ ENABLED",
      helmet_headers: "✅ ENABLED",
    },
    endpoints: {
      public: ["POST /api/auth/login", "GET  /api/auth/verify"],
      protected: [
        "POST /api/user/register (JWT)",
        "GET  /api/account/:id (JWT)",
        "POST /api/transaction/pay (JWT)",
        "POST /api/transaction/repay (JWT)",
      ],
      npci: [
        "POST /api/mock-npci/simulate (NPCI-KEY)",
        "POST /api/mock-npci/simulate-all (NPCI-KEY)",
    ],
      upi_credit_line: {
        discovery: "GET  /api/upi/discover/:mobile (JWT)",
        generate_qr: "POST /api/upi/generate-qr (JWT)",
        pay: "POST /api/upi/pay (JWT)",
        repay: "POST /api/upi/repay (JWT)",
        order_status: "GET  /api/upi/order/:order_id (JWT)",
      },
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n🚀 CLMS Server running on port", PORT);
  console.log("🔐 Security Layer: ACTIVE");
  console.log("📡 Health check: http://localhost:" + PORT);
});

app.use("/api/upi", verifyToken, upiService);

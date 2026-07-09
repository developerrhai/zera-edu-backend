const express = require("express");
const { getPool, query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const { body } = require("express-validator");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { generateUlid } = require("../utils/ulid");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();

const subscribeRules = [
  body("planId").trim().notEmpty().withMessage("Plan ID is required"),
];

// Helper to map DB row to plan object
function mapPlan(row) {
  return {
    id: row.public_id,
    name: row.name,
    price: Number(row.price),
    billingCycle: row.billing_cycle,
    features: row.features.split(",").map(f => f.trim()),
  };
}

// ── GET /api/subscriptions/plans ─────────────────────────────────────────────
router.get(
  "/plans",
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM subscription_plans WHERE deleted_at IS NULL ORDER BY price ASC");
    return res.json({
      success: true,
      plans: rows.map(mapPlan),
    });
  })
);

// ── GET /api/subscriptions/my ────────────────────────────────────────────────
router.get(
  "/my",
  authenticate,
  asyncHandler(async (req, res) => {
    const subs = await query(
      `SELECT us.*, sp.name AS plan_name, sp.price AS plan_price, sp.billing_cycle,
              us.public_id AS subscription_public_id, sp.public_id AS plan_public_id
       FROM user_subscriptions us
       JOIN subscription_plans sp ON us.plan_id = sp.id
       WHERE us.user_id = ? AND us.status = 'Active' AND us.end_date > NOW()
         AND us.deleted_at IS NULL AND sp.deleted_at IS NULL
       ORDER BY us.end_date DESC LIMIT 1`,
      [req.user.id]
    );

    if (subs.length === 0) {
      return res.json({
        success: true,
        subscription: null,
      });
    }

    const sub = subs[0];
    return res.json({
      success: true,
      subscription: {
        id: sub.subscription_public_id,
        planId: sub.plan_public_id,
        planName: sub.plan_name,
        price: Number(sub.plan_price),
        status: sub.status,
        startDate: sub.start_date,
        endDate: sub.end_date,
      },
    });
  })
);

// ── POST /api/subscriptions/subscribe (Student only) ─────────────────────────
router.post(
  "/subscribe",
  authenticate,
  authorize(["student"]),
  validate(subscribeRules),
  asyncHandler(async (req, res, next) => {
    const { planId } = req.body;
    const userId = req.user.id;

    // Verify plan exists using public_id or id
    const plans = await query("SELECT * FROM subscription_plans WHERE (public_id = ? OR id = ?) AND deleted_at IS NULL", [planId, Number(planId) || 0]);
    if (plans.length === 0) {
      return next(new AppError("Subscription plan not found.", 404));
    }

    const plan = plans[0];

    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // Cancel any current active subscriptions (sliding transition)
      await conn.execute(
        "UPDATE user_subscriptions SET status = 'Cancelled', updated_by = ? WHERE user_id = ? AND status = 'Active'",
        [req.user.id, userId]
      );

      // Create new subscription record (30 days cycle)
      const startDate = new Date();
      const endDate = new Date();
      endDate.setDate(startDate.getDate() + 30);
      const subscriptionPublicId = generateUlid();

      const [subResult] = await conn.execute(
        `INSERT INTO user_subscriptions (public_id, user_id, plan_id, status, start_date, end_date, created_by)
         VALUES (?, ?, ?, 'Active', ?, ?, ?)`,
        [subscriptionPublicId, userId, plan.id, startDate, endDate, req.user.id]
      );

      // Log subscription creation
      await logAudit("user_subscription", subResult.insertId, "create", req.user.id, null, { plan_id: plan.id, status: "Active" });

      // Log payment history auditor
      const txnId = "TXN_" + Math.floor(10000 + Math.random() * 90000);
      const paymentPublicId = generateUlid();
      const [paymentResult] = await conn.execute(
        `INSERT INTO payments (public_id, transaction_id, user_id, amount, currency, gateway_method, status, created_by)
         VALUES (?, ?, ?, ?, 'INR', 'UPI Razorpay API', 'settled', ?)`,
        [paymentPublicId, txnId, userId, plan.price, req.user.id]
      );

      // Log payment audit
      await logAudit("payment", paymentResult.insertId, "create", req.user.id, null, { transaction_id: txnId, amount: plan.price });

      await conn.commit();

      const [newSub] = await query(
        `SELECT us.*, sp.name AS plan_name, sp.price AS plan_price,
                us.public_id AS subscription_public_id, sp.public_id AS plan_public_id
         FROM user_subscriptions us
         JOIN subscription_plans sp ON us.plan_id = sp.id
         WHERE us.id = ?`,
        [subResult.insertId]
      );

      return res.status(201).json({
        success: true,
        subscription: {
          id: newSub.subscription_public_id,
          planId: newSub.plan_public_id,
          planName: newSub.plan_name,
          price: Number(newSub.plan_price),
          status: newSub.status,
          startDate: newSub.start_date,
          endDate: newSub.end_date,
        },
      });
    } catch (err) {
      await conn.rollback();
      return next(err);
    } finally {
      conn.release();
    }
  })
);

module.exports = router;

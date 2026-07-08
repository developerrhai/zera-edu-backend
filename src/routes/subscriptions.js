const express = require("express");
const { getPool, query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const { body } = require("express-validator");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const router = express.Router();

const subscribeRules = [
  body("planId").isInt().withMessage("Plan ID must be an integer"),
];

// Helper to map DB row to plan object
function mapPlan(row) {
  return {
    id: row.id,
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
    const rows = await query("SELECT * FROM subscription_plans ORDER BY price ASC");
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
      `SELECT us.*, sp.name AS plan_name, sp.price AS plan_price, sp.billing_cycle
       FROM user_subscriptions us
       JOIN subscription_plans sp ON us.plan_id = sp.id
       WHERE us.user_id = ? AND us.status = 'Active' AND us.end_date > NOW()
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
        id: sub.id,
        planId: sub.plan_id,
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

    // Verify plan exists
    const plans = await query("SELECT * FROM subscription_plans WHERE id = ?", [planId]);
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
        "UPDATE user_subscriptions SET status = 'Cancelled' WHERE user_id = ? AND status = 'Active'",
        [userId]
      );

      // Create new subscription record (30 days cycle)
      const startDate = new Date();
      const endDate = new Date();
      endDate.setDate(startDate.getDate() + 30);

      const [subResult] = await conn.execute(
        `INSERT INTO user_subscriptions (user_id, plan_id, status, start_date, end_date)
         VALUES (?, ?, 'Active', ?, ?)`,
        [userId, planId, startDate, endDate]
      );

      // Log payment history auditor
      const txnId = "TXN_" + Math.floor(10000 + Math.random() * 90000);
      await conn.execute(
        `INSERT INTO payments (transaction_id, user_id, amount, gateway_method, status)
         VALUES (?, ?, ?, 'UPI Razorpay API', 'settled')`,
        [txnId, userId, plan.price]
      );

      await conn.commit();

      const [newSub] = await query(
        `SELECT us.*, sp.name AS plan_name, sp.price AS plan_price
         FROM user_subscriptions us
         JOIN subscription_plans sp ON us.plan_id = sp.id
         WHERE us.id = ?`,
        [subResult.insertId]
      );

      return res.status(201).json({
        success: true,
        subscription: {
          id: newSub.id,
          planId: newSub.plan_id,
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

const express = require("express");
const { getPool, query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const router = express.Router();

// Helper: map onboarding DB row to frontend queue shape
function mapOnboardingQueue(row) {
  return {
    id: "Q_" + row.id,
    queueId: row.id,
    userId: row.user_id,
    tutorName: row.tutor_name,
    specializations: row.specializations,
    costQuote: Number(row.cost_quote),
    credentials: row.credentials || "Credentials verification pending",
    status: row.status,
  };
}

// ── GET /api/admin/dashboard (Aggregate stats) ──────────────────────────────
router.get(
  "/dashboard",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res) => {
    // 1. Total Aggregated Billings
    const billingRows = await query("SELECT SUM(amount) AS total FROM payments WHERE status = 'settled'");
    const totalBillings = Number(billingRows[0].total || 0);

    // 2. Retention Fee (15%)
    const retentionFee = Number((totalBillings * 0.15).toFixed(2));

    // 3. Registered Tutors
    const tutorRows = await query("SELECT COUNT(id) AS count FROM teacher_profiles WHERE is_verified = 1");
    const totalTutors = Number(tutorRows[0].count || 0);

    // 4. Onboarding Queue Count
    const queueRows = await query("SELECT COUNT(id) AS count FROM onboarding_queue WHERE status = 'pending'");
    const queueCount = Number(queueRows[0].count || 0);

    return res.json({
      success: true,
      stats: {
        totalBillings,
        retentionFee,
        totalTutors,
        queueCount,
      },
    });
  })
);

// ── GET /api/admin/onboarding (Queue retrieval) ──────────────────────────────
router.get(
  "/onboarding",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res) => {
    const rows = await query(`
      SELECT oq.*, u.name AS tutor_name
      FROM onboarding_queue oq
      JOIN users u ON oq.user_id = u.id
      ORDER BY oq.created_at ASC
    `);

    return res.json({
      success: true,
      queue: rows.map(mapOnboardingQueue),
    });
  })
);

// ── PUT /api/admin/onboarding/:id (Approve/Reject application) ───────────────
router.put(
  "/onboarding/:id",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res, next) => {
    const queueId = Number(req.params.id);
    const { status } = req.body; // 'approved' or 'rejected'

    if (!["approved", "rejected"].includes(status)) {
      return next(new AppError("Invalid onboarding validation status flag.", 400));
    }

    const applications = await query("SELECT * FROM onboarding_queue WHERE id = ?", [queueId]);
    if (applications.length === 0) {
      return next(new AppError("Onboarding application not found.", 404));
    }

    const application = applications[0];
    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // Update onboarding status
      await conn.execute(
        "UPDATE onboarding_queue SET status = ?, reviewed_by = ? WHERE id = ?",
        [status, req.user.id, queueId]
      );

      // If approved, verify the teacher profile
      if (status === "approved") {
        await conn.execute(
          "UPDATE teacher_profiles SET is_verified = 1 WHERE user_id = ?",
          [application.user_id]
        );
      }

      await conn.commit();

      // Clear search filters cache
      const teachersRouter = require("./teachers");
      if (teachersRouter.localCache) {
        teachersRouter.localCache.clear();
      }

      return res.json({
        success: true,
        message: `Teacher onboarding application ${status}.`,
      });
    } catch (err) {
      await conn.rollback();
      return next(err);
    } finally {
      conn.release();
    }
  })
);

// ── GET /api/admin/users (Users listing) ─────────────────────────────────────
router.get(
  "/users",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res) => {
    const roleFilter = req.query.role;
    let sql = "SELECT id, email, name, role, is_active, created_at FROM users";
    const params = [];
    if (roleFilter) {
      sql += " WHERE role = ?";
      params.push(roleFilter);
    }
    sql += " ORDER BY created_at DESC";
    const rows = await query(sql, params);
    return res.json({
      success: true,
      users: rows.map(r => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        isActive: !!r.is_active,
        createdAt: r.created_at,
      })),
    });
  })
);

// ── PUT /api/admin/users/:id (Update user role or status) ───────────────────
router.put(
  "/users/:id",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res, next) => {
    const userId = Number(req.params.id);
    const { role, isActive } = req.body;

    const users = await query("SELECT * FROM users WHERE id = ?", [userId]);
    if (users.length === 0) {
      return next(new AppError("User account not found.", 404));
    }

    const updates = [];
    const params = [];
    if (role !== undefined) {
      if (!["student", "teacher", "admin"].includes(role)) {
        return next(new AppError("Invalid authorization level.", 400));
      }
      updates.push("role = ?");
      params.push(role);
    }
    if (isActive !== undefined) {
      updates.push("is_active = ?");
      params.push(isActive ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(userId);
      await query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);
    }

    return res.json({
      success: true,
      message: "User account state synced successfully.",
    });
  })
);

// ── DELETE /api/admin/users/:id (Deactivate user) ──────────────────────────
router.delete(
  "/users/:id",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res, next) => {
    const userId = Number(req.params.id);
    const result = await query("UPDATE users SET is_active = 0 WHERE id = ?", [userId]);
    if (result.affectedRows === 0) {
      return next(new AppError("User not found.", 404));
    }
    return res.json({
      success: true,
      message: "User deactivated successfully.",
    });
  })
);

// ── GET /api/admin/subscriptions/overview (Subscriptions metrics) ────────────
router.get(
  "/subscriptions/overview",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res) => {
    const subscribers = await query(`
      SELECT us.*, u.name AS user_name, sp.name AS plan_name, sp.price AS plan_price, sp.billing_cycle
      FROM user_subscriptions us
      JOIN users u ON us.user_id = u.id
      JOIN subscription_plans sp ON us.plan_id = sp.id
      ORDER BY us.end_date DESC
    `);
    
    return res.json({
      success: true,
      subscribers: subscribers.map(s => ({
        id: s.id,
        userId: s.user_id,
        userName: s.user_name,
        planName: s.plan_name,
        price: Number(s.plan_price),
        billingCycle: s.billing_cycle,
        startDate: s.start_date,
        endDate: s.end_date,
        status: s.status,
      })),
    });
  })
);

module.exports = router;


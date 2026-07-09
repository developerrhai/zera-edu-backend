const express = require("express");
const { getPool, query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { logAudit } = require("../utils/auditLogger");
const authService = require("../services/authService");
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { generateUlid } = require("../utils/ulid");

const router = express.Router();

// Helper: map onboarding DB row to frontend queue shape
function mapOnboardingQueue(row) {
  return {
    id: "Q_" + row.public_id,
    queueId: row.public_id,
    userId: row.user_public_id,
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
    const billingRows = await query("SELECT SUM(amount) AS total FROM payments WHERE status = 'settled' AND deleted_at IS NULL");
    const totalBillings = Number(billingRows[0].total || 0);

    // 2. Retention Fee (15%)
    const retentionFee = Number((totalBillings * 0.15).toFixed(2));

    // 3. Registered Tutors
    const tutorRows = await query("SELECT COUNT(id) AS count FROM teacher_profiles WHERE is_verified = 1 AND deleted_at IS NULL");
    const totalTutors = Number(tutorRows[0].count || 0);

    // 4. Onboarding Queue Count
    const queueRows = await query("SELECT COUNT(id) AS count FROM onboarding_queue WHERE status = 'pending' AND deleted_at IS NULL");
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
      SELECT oq.*, u.name AS tutor_name, oq.public_id AS public_id, u.public_id AS user_public_id
      FROM onboarding_queue oq
      JOIN users u ON oq.user_id = u.id
      WHERE oq.deleted_at IS NULL AND u.deleted_at IS NULL
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
    const queuePublicId = req.params.id;
    const { status } = req.body; // 'approved' or 'rejected'

    if (!["approved", "rejected"].includes(status)) {
      return next(new AppError("Invalid onboarding validation status flag.", 400));
    }

    const applications = await query("SELECT * FROM onboarding_queue WHERE public_id = ? AND deleted_at IS NULL", [queuePublicId]);
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
        [status, req.user.id, application.id]
      );

      // If approved, verify the teacher profile
      if (status === "approved") {
        await conn.execute(
          "UPDATE teacher_profiles SET is_verified = 1 WHERE user_id = ?",
          [application.user_id]
        );
      }

      // Log status change audit
      await logAudit("onboarding_queue", application.id, "status_change", req.user.id, { status: application.status }, { status });

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
    let sql = `
      SELECT u.id, u.public_id, u.email, u.name, u.role, u.is_active, u.created_at,
             tp.display_order
      FROM users u
      LEFT JOIN teacher_profiles tp ON tp.user_id = u.id AND tp.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
    `;
    const params = [];
    if (roleFilter) {
      sql += " AND u.role = ?";
      params.push(roleFilter);
    }
    sql += " ORDER BY u.created_at DESC";
    const rows = await query(sql, params);
    return res.json({
      success: true,
      users: rows.map(r => ({
        id: r.public_id, // Map public_id to id
        email: r.email,
        name: r.name,
        role: r.role,
        isActive: !!r.is_active,
        createdAt: r.created_at,
        displayOrder: r.display_order !== null ? r.display_order : 0,
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
    const userPublicId = req.params.id;
    const { role, isActive } = req.body;

    const users = await query("SELECT * FROM users WHERE (public_id = ? OR id = ?) AND deleted_at IS NULL", [userPublicId, Number(userPublicId) || 0]);
    if (users.length === 0) {
      return next(new AppError("User account not found.", 404));
    }

    const user = users[0];
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
      params.push(user.id);
      await query(`UPDATE users SET ${updates.join(", ")}, updated_by = ? WHERE id = ?`, [...params, req.user.id, user.id]);
      
      if (process.env.NODE_ENV !== "test") {
        const [updatedUser] = await query("SELECT * FROM users WHERE id = ?", [user.id]);
        // Log update audit
        await logAudit("user", user.id, "update", req.user.id, user, updatedUser);
      }
    }

    return res.json({
      success: true,
      message: "User account state synced successfully.",
    });
  })
);

// ── DELETE /api/admin/users/:id (Deactivate/Soft-delete user) ───────────────
router.delete(
  "/users/:id",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res, next) => {
    const userPublicId = req.params.id;
    
    // Deactivate user as soft delete representation, checking both public_id and numeric id
    const result = await query(
      "UPDATE users SET is_active = 0, deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE (public_id = ? OR id = ?) AND deleted_at IS NULL",
      [req.user.id, userPublicId, Number(userPublicId) || 0]
    );
    if (result.affectedRows === 0) {
      return next(new AppError("User not found.", 404));
    }
    
    if (process.env.NODE_ENV !== "test") {
      await logAudit("user", userPublicId, "delete", req.user.id, { is_active: 1 }, { is_active: 0, deleted_at: new Date() });
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
      SELECT us.*, u.name AS user_name, sp.name AS plan_name, sp.price AS plan_price, sp.billing_cycle,
             us.public_id AS subscription_public_id, u.public_id AS user_public_id
      FROM user_subscriptions us
      JOIN users u ON us.user_id = u.id
      JOIN subscription_plans sp ON us.plan_id = sp.id
      WHERE us.deleted_at IS NULL AND u.deleted_at IS NULL AND sp.deleted_at IS NULL
      ORDER BY us.end_date DESC
    `);
    
    return res.json({
      success: true,
      subscribers: subscribers.map(s => ({
        id: s.subscription_public_id, // Map public_id to id
        userId: s.user_public_id,
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

const addTeacherRules = [
  body("email").isEmail().withMessage("Enter a valid email address").normalizeEmail(),
  body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("subject").optional().trim().default("Specialized Subject"),
  body("costPerHour").optional().isDecimal().withMessage("Cost must be a valid number").default("500.00"),
];

// ── POST /api/admin/teachers (Admin directly provisions a teacher profile) ───
router.post(
  "/teachers",
  authenticate,
  authorize(["admin"]),
  validate(addTeacherRules),
  asyncHandler(async (req, res, next) => {
    const { email, password, name, subject, costPerHour } = req.body;

    // Check if email already registered
    const exists = await query("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", [email]);
    if (exists.length > 0) {
      return next(new AppError("An account with this email address already exists.", 409));
    }

    const passwordHash = await authService.hashPassword(password);
    const userPublicId = generateUlid();
    
    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // 1. Insert user
      const [userResult] = await conn.execute(
        "INSERT INTO users (public_id, email, password_hash, name, role, is_active, created_by) VALUES (?, ?, ?, ?, 'teacher', 1, ?)",
        [userPublicId, email, passwordHash, name, req.user.id]
      );
      const userId = userResult.insertId;

      if (process.env.NODE_ENV !== "test") {
        await logAudit("user", userId, "create", req.user.id, null, { email, name, role: "teacher" });
      }

      // 2. Insert teacher profile (is_verified = 1 directly!)
      const profilePublicId = generateUlid();
      const [profileResult] = await conn.execute(
        "INSERT INTO teacher_profiles (public_id, user_id, subject, cost_per_hour, is_verified, created_by) VALUES (?, ?, ?, ?, 1, ?)",
        [profilePublicId, userId, subject || "Specialized Subject", costPerHour || 500.00, req.user.id]
      );
      const profileId = profileResult.insertId;

      if (process.env.NODE_ENV !== "test") {
        await logAudit("teacher_profile", profileId, "create", req.user.id, null, { subject, cost_per_hour: costPerHour });
      }

      // 3. Add to onboarding queue (status = 'approved' directly)
      const queuePublicId = generateUlid();
      await conn.execute(
        "INSERT INTO onboarding_queue (public_id, user_id, specializations, cost_quote, credentials, status, reviewed_by, created_by) VALUES (?, ?, ?, ?, 'Directly provisioned by Admin', 'approved', ?, ?)",
        [queuePublicId, userId, subject || "General Studies", costPerHour || 500.00, req.user.id, req.user.id]
      );

      await conn.commit();

      // Clear search filters cache
      const teachersRouter = require("./teachers");
      if (teachersRouter.localCache) {
        teachersRouter.localCache.clear();
      }

      return res.status(201).json({
        success: true,
        message: "Teacher account and profile provisioned successfully.",
        teacher: {
          id: userPublicId,
          profileId: profilePublicId,
          email,
          name,
          role: "teacher",
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

// ── DELETE /api/admin/teachers/:id (Admin removes/deletes a teacher user & profile)
router.delete(
  "/teachers/:id",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res, next) => {
    const targetId = req.params.id; // Can be user public_id or teacher_profile public_id

    // Resolve user and teacher profile details
    // We check if targetId matches users.public_id, users.id, teacher_profiles.public_id, or teacher_profiles.id
    const teachers = await query(
      `SELECT u.id AS user_id, u.public_id AS user_public_id, u.name AS user_name,
              tp.id AS profile_id, tp.public_id AS profile_public_id
       FROM users u
       LEFT JOIN teacher_profiles tp ON tp.user_id = u.id
       WHERE (u.public_id = ? OR u.id = ? OR tp.public_id = ? OR tp.id = ?)
         AND u.deleted_at IS NULL AND u.role = 'teacher'`,
      [targetId, Number(targetId) || 0, targetId, Number(targetId) || 0]
    );

    if (teachers.length === 0) {
      return next(new AppError("Specified teacher record not found.", 404));
    }

    const teacher = teachers[0];

    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // 1. Soft delete user
      await conn.execute(
        "UPDATE users SET is_active = 0, deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?",
        [req.user.id, teacher.user_id]
      );

      // 2. Soft delete teacher profile (if exists)
      if (teacher.profile_id) {
        await conn.execute(
          "UPDATE teacher_profiles SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE id = ?",
          [req.user.id, teacher.profile_id]
        );
      }

      // 3. Soft delete teacher slots
      if (teacher.profile_id) {
        await conn.execute(
          "UPDATE teacher_slots SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE teacher_profile_id = ?",
          [req.user.id, teacher.profile_id]
        );
      }

      // 4. Soft delete onboarding queue entries
      await conn.execute(
        "UPDATE onboarding_queue SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE user_id = ?",
        [req.user.id, teacher.user_id]
      );

      // Log audits
      if (process.env.NODE_ENV !== "test") {
        await logAudit("user", teacher.user_id, "delete", req.user.id, null, { deleted_at: new Date() });
        if (teacher.profile_id) {
          await logAudit("teacher_profile", teacher.profile_id, "delete", req.user.id, null, { deleted_at: new Date() });
        }
      }

      await conn.commit();

      // Clear search filters cache
      const teachersRouter = require("./teachers");
      if (teachersRouter.localCache) {
        teachersRouter.localCache.clear();
      }

      return res.json({
        success: true,
        message: `Teacher ${teacher.user_name} and all associated profile configurations successfully removed.`,
      });
    } catch (err) {
      await conn.rollback();
      return next(err);
    } finally {
      conn.release();
    }
  })
);

// ── PUT /api/admin/teachers/:id/display-order ──────────────────────────────
router.put(
  "/teachers/:id/display-order",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res, next) => {
    const userPublicId = req.params.id;
    const { displayOrder } = req.body;

    if (displayOrder === undefined || isNaN(Number(displayOrder))) {
      return next(new AppError("Invalid display order weight.", 400));
    }

    // Resolve teacher profile internal ID
    const teachers = await query(
      `SELECT tp.id FROM teacher_profiles tp
       JOIN users u ON tp.user_id = u.id
       WHERE (u.public_id = ? OR u.id = ? OR tp.public_id = ? OR tp.id = ?)
         AND u.deleted_at IS NULL AND u.role = 'teacher'`,
      [userPublicId, Number(userPublicId) || 0, userPublicId, Number(userPublicId) || 0]
    );

    if (teachers.length === 0) {
      return next(new AppError("Teacher profile not found.", 404));
    }

    const teacher = teachers[0];

    await query(
      "UPDATE teacher_profiles SET display_order = ?, updated_by = ? WHERE id = ?",
      [Number(displayOrder), req.user.id, teacher.id]
    );

    // Clear search filters cache
    const teachersRouter = require("./teachers");
    if (teachersRouter.localCache) {
      teachersRouter.localCache.clear();
    }

    return res.json({
      success: true,
      message: `Teacher display order priority configured to ${displayOrder}.`,
    });
  })
);

module.exports = router;

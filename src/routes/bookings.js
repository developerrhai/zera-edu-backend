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

const bookingRules = [
  body("teacherProfileId").trim().notEmpty().withMessage("Teacher profile identifier is required"),
  body("slotId").trim().notEmpty().withMessage("Slot identifier is required"),
];

const statusRules = [
  body("status").isIn(["Pending Completion", "Completed", "Cancelled"]).withMessage("Invalid booking status value"),
];

const swapRules = [
  body("newTeacherProfileId").trim().notEmpty().withMessage("New teacher profile identifier is required"),
];

// Helper: map DB row to frontend booking shape
function mapBooking(row) {
  return {
    id: "B_" + row.public_id,
    bookingId: row.public_id,
    refCode: row.ref_code,
    studentName: row.student_name,
    studentId: "U" + row.student_public_id,
    teacherId: "T" + row.teacher_public_id,
    teacherName: row.teacher_name,
    slotInfo: row.slot_info,
    location: row.location,
    status: row.status,
    createdAt: row.created_at,
  };
}

// ── GET /api/bookings ────────────────────────────────────────────────────────
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    let sql = `
      SELECT b.*, us.name AS student_name, ut.name AS teacher_name, us.public_id AS student_public_id, tp.public_id AS teacher_public_id
      FROM bookings b
      JOIN users us ON b.student_id = us.id
      JOIN teacher_profiles tp ON b.teacher_profile_id = tp.id
      JOIN users ut ON tp.user_id = ut.id
      WHERE b.deleted_at IS NULL AND us.deleted_at IS NULL AND tp.deleted_at IS NULL
    `;
    const params = [];

    if (req.user.role === "student") {
      sql += " AND b.student_id = ?";
      params.push(req.user.id);
    } else if (req.user.role === "teacher") {
      sql += " AND tp.user_id = ?";
      params.push(req.user.id);
    } // Admins view all records

    sql += " ORDER BY b.created_at DESC";

    const rows = await query(sql, params);

    return res.json({
      success: true,
      bookings: rows.map(mapBooking),
    });
  })
);

// ── POST /api/bookings (Create booking - transactional with Optimistic Locking) ──
router.post(
  "/",
  authenticate,
  authorize(["student"]),
  validate(bookingRules),
  asyncHandler(async (req, res, next) => {
    const { teacherProfileId, slotId, idempotencyKey } = req.body;
    const studentId = req.user.id;

    // Check for idempotency key to prevent double bookings / double clicks
    if (idempotencyKey) {
      const existing = await query(
        `SELECT b.*, us.name AS student_name, ut.name AS teacher_name, us.public_id AS student_public_id, tp.public_id AS teacher_public_id
         FROM bookings b
         JOIN users us ON b.student_id = us.id
         JOIN teacher_profiles tp ON b.teacher_profile_id = tp.id
         JOIN users ut ON tp.user_id = ut.id
         WHERE b.idempotency_key = ? AND b.deleted_at IS NULL`,
        [idempotencyKey]
      );
      if (existing.length > 0) {
        return res.json({
          success: true,
          booking: mapBooking(existing[0]),
          isDuplicate: true,
        });
      }
    }

    const tpPublicId = teacherProfileId.replace("T", "");
    
    // Resolve teacher profile internal ID
    const tpRows = await query("SELECT id, cost_per_hour FROM teacher_profiles WHERE public_id = ? AND deleted_at IS NULL", [tpPublicId]);
    if (tpRows.length === 0) {
      return next(new AppError("Specified teacher profile not found.", 404));
    }
    const tpId = tpRows[0].id;
    const cost = Number(tpRows[0].cost_per_hour);

    // Resolve availability slot details
    const slotRows = await query("SELECT id, is_booked, version, day, time_window, location FROM teacher_slots WHERE public_id = ? AND teacher_profile_id = ? AND deleted_at IS NULL", [slotId, tpId]);
    if (slotRows.length === 0) {
      return next(new AppError("The specified availability slot does not exist.", 404));
    }
    const slot = slotRows[0];
    if (slot.is_booked) {
      return next(new AppError("The selected slot has already been booked by another user.", 409));
    }

    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // 1. Mark slot as booked using Optimistic Locking (where version = slot.version and is_booked = 0)
      const [updateResult] = await conn.execute(
        "UPDATE teacher_slots SET is_booked = 1, version = version + 1 WHERE id = ? AND version = ? AND is_booked = 0",
        [slot.id, slot.version]
      );

      if (updateResult.affectedRows === 0) {
        throw new AppError("The selected slot is no longer available. Concurrency lock activated.", 409);
      }

      // 2. Insert booking using generated ULID
      const bookingPublicId = generateUlid();
      const refCode = "ZERA-" + Math.floor(Math.random() * 900 + 100);
      const slotInfo = `${slot.day} (${slot.time_window})`;
      
      const [insertResult] = await conn.execute(
        `INSERT INTO bookings
           (public_id, ref_code, student_id, teacher_profile_id, slot_id, slot_info, location, status, idempotency_key, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending Completion', ?, ?)`,
        [bookingPublicId, refCode, studentId, tpId, slot.id, slotInfo, slot.location, idempotencyKey || null, req.user.id]
      );

      const bookingId = insertResult.insertId;

      // Log booking creation
      await logAudit("booking", bookingId, "create", req.user.id, null, { ref_code: refCode, slot_info: slotInfo });

      // 3. Record entry in payment ledger automatically
      const amountWithTax = Math.round(cost * 1.18); // 18% Statutory GST included
      const paymentPublicId = generateUlid();
      const txnId = "TXN_" + Math.floor(10000 + Math.random() * 90000);
      
      const [paymentResult] = await conn.execute(
        `INSERT INTO payments (public_id, transaction_id, user_id, booking_id, amount, currency, gateway_method, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'INR', 'UPI Razorpay API', 'settled', ?)`,
        [paymentPublicId, txnId, studentId, bookingId, amountWithTax, req.user.id]
      );

      // Log payment creation
      await logAudit("payment", paymentResult.insertId, "create", req.user.id, null, { transaction_id: txnId, amount: amountWithTax });

      await conn.commit();

      // Clear search filters cache
      const teachersRouter = require("./teachers");
      if (teachersRouter.localCache) {
        teachersRouter.localCache.clear();
      }

      const [newBooking] = await query(
        `SELECT b.*, us.name AS student_name, ut.name AS teacher_name, us.public_id AS student_public_id, tp.public_id AS teacher_public_id
         FROM bookings b
         JOIN users us ON b.student_id = us.id
         JOIN teacher_profiles tp ON b.teacher_profile_id = tp.id
         JOIN users ut ON tp.user_id = ut.id
         WHERE b.id = ?`,
        [bookingId]
      );

      return res.status(201).json({
        success: true,
        booking: mapBooking(newBooking),
      });
    } catch (err) {
      await conn.rollback();
      return next(err);
    } finally {
      conn.release();
    }
  })
);

// ── PUT /api/bookings/:id/status (Mark complete / cancel) ────────────────────
router.put(
  "/:id/status",
  authenticate,
  validate(statusRules),
  asyncHandler(async (req, res, next) => {
    const bookingPublicId = req.params.id;
    const { status } = req.body;

    const bookings = await query("SELECT * FROM bookings WHERE public_id = ? AND deleted_at IS NULL", [bookingPublicId]);
    if (bookings.length === 0) {
      return next(new AppError("Booking record not found.", 404));
    }

    const booking = bookings[0];

    // Authorize updates based on role
    // Students can cancel or complete; Teachers can complete/toggle; Admins can do anything
    if (req.user.role === "student" && booking.student_id !== req.user.id) {
      return next(new AppError("Unauthorized access to booking update.", 403));
    }

    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      await conn.execute("UPDATE bookings SET status = ?, updated_by = ? WHERE id = ?", [status, req.user.id, booking.id]);

      // If cancelled, release slot
      if (status === "Cancelled") {
        await conn.execute("UPDATE teacher_slots SET is_booked = 0, version = version + 1 WHERE id = ?", [booking.slot_id]);
      } else if (status === "Completed" && booking.status === "Cancelled") {
        // Re-reserve slot if transitioning back
        await conn.execute("UPDATE teacher_slots SET is_booked = 1, version = version + 1 WHERE id = ?", [booking.slot_id]);
      }

      // Log status change audit
      await logAudit("booking", booking.id, "status_change", req.user.id, { status: booking.status }, { status });

      await conn.commit();

      // Clear search filters cache
      const teachersRouter = require("./teachers");
      if (teachersRouter.localCache) {
        teachersRouter.localCache.clear();
      }

      return res.json({
        success: true,
        message: `Booking status updated to ${status}.`,
      });
    } catch (err) {
      await conn.rollback();
      return next(err);
    } finally {
      conn.release();
    }
  })
);

// ── PUT /api/bookings/:id/swap (Tutor Swap Routing Engine) ────────────────────
router.put(
  "/:id/swap",
  authenticate,
  authorize(["student", "admin"]),
  validate(swapRules),
  asyncHandler(async (req, res, next) => {
    const bookingPublicId = req.params.id;
    const { newTeacherProfileId } = req.body;

    const targetTpPublicId = newTeacherProfileId.replace("T", "");

    const bookings = await query("SELECT * FROM bookings WHERE public_id = ? AND deleted_at IS NULL", [bookingPublicId]);
    if (bookings.length === 0) {
      return next(new AppError("Booking record not found.", 404));
    }

    const booking = bookings[0];

    // Ensure student is swapping their own booking
    if (req.user.role !== "admin" && booking.student_id !== req.user.id) {
      return next(new AppError("Unauthorized booking modification access.", 403));
    }

    // Verify new teacher profile exists and is verified
    const teachers = await query("SELECT id FROM teacher_profiles WHERE public_id = ? AND is_verified = 1 AND deleted_at IS NULL", [targetTpPublicId]);
    if (teachers.length === 0) {
      return next(new AppError("Selected target teacher profile is not verified or active.", 404));
    }

    const targetTpId = teachers[0].id;

    // Release old teacher slot and book new teacher slot if slot_id matches,
    // or just perform basic teacher swap on booking record to retain slot timeline
    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // For ZERA EDU hot-swap logic:
      // Replace the tutor assigned to a booking code while retaining current schedule state timeline.
      await conn.execute(
        "UPDATE bookings SET teacher_profile_id = ?, updated_by = ? WHERE id = ?",
        [targetTpId, req.user.id, booking.id]
      );

      // Log the swap to audit logs
      await logAudit("booking", booking.id, "swap", req.user.id, { teacher_profile_id: booking.teacher_profile_id }, { teacher_profile_id: targetTpId });

      await conn.commit();

      return res.json({
        success: true,
        message: "Tutor Swap routing reconfigured.",
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

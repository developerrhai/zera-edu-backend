const express = require("express");
const { getPool, query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const { body } = require("express-validator");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const router = express.Router();

const bookingRules = [
  body("teacherProfileId").trim().notEmpty().withMessage("Teacher profile identifier is required"),
  body("slotId").isInt().withMessage("Slot identifier must be an integer"),
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
    id: "B_" + row.id,
    bookingId: row.id,
    refCode: row.ref_code,
    studentName: row.student_name,
    studentId: "U" + row.student_id,
    teacherId: "T" + row.teacher_profile_id,
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
      SELECT b.*, us.name AS student_name, ut.name AS teacher_name
      FROM bookings b
      JOIN users us ON b.student_id = us.id
      JOIN teacher_profiles tp ON b.teacher_profile_id = tp.id
      JOIN users ut ON tp.user_id = ut.id
    `;
    const params = [];

    if (req.user.role === "student") {
      sql += " WHERE b.student_id = ?";
      params.push(req.user.id);
    } else if (req.user.role === "teacher") {
      sql += " WHERE tp.user_id = ?";
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

// ── POST /api/bookings (Create booking - transactional) ──────────────────────
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
        `SELECT b.*, us.name AS student_name, ut.name AS teacher_name
         FROM bookings b
         JOIN users us ON b.student_id = us.id
         JOIN teacher_profiles tp ON b.teacher_profile_id = tp.id
         JOIN users ut ON tp.user_id = ut.id
         WHERE b.idempotency_key = ?`,
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

    const tpIdStr = teacherProfileId.replace("T", "");
    const tpId = Number(tpIdStr);

    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // 1. Lock slot select and verify availability
      const [slots] = await conn.execute(
        "SELECT * FROM teacher_slots WHERE id = ? AND teacher_profile_id = ? FOR UPDATE",
        [slotId, tpId]
      );

      if (slots.length === 0) {
        throw new AppError("The specified availability slot does not exist.", 404);
      }

      const slot = slots[0];
      if (slot.is_booked) {
        throw new AppError("The selected slot has already been booked by another user.", 409);
      }

      // 2. Mark slot as booked
      await conn.execute("UPDATE teacher_slots SET is_booked = 1 WHERE id = ?", [slotId]);

      // 3. Insert booking
      const refCode = "ZERA-" + Math.floor(Math.random() * 900 + 100);
      const slotInfo = `${slot.day} (${slot.time_window})`;
      
      const [insertResult] = await conn.execute(
        `INSERT INTO bookings
           (ref_code, student_id, teacher_profile_id, slot_id, slot_info, location, status, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, 'Pending Completion', ?)`,
        [refCode, studentId, tpId, slotId, slotInfo, slot.location, idempotencyKey || null]
      );

      const bookingId = insertResult.insertId;

      // 4. Record entry in payment ledger automatically
      // Fetch teacher cost for GST calculations
      const [teachers] = await conn.execute("SELECT cost_per_hour FROM teacher_profiles WHERE id = ?", [tpId]);
      const cost = Number(teachers[0].cost_per_hour);
      const amountWithTax = Math.round(cost * 1.18); // 18% Statutory GST included

      const txnId = "TXN_" + Math.floor(10000 + Math.random() * 90000);
      await conn.execute(
        `INSERT INTO payments (transaction_id, user_id, booking_id, amount, gateway_method, status)
         VALUES (?, ?, ?, ?, 'UPI Razorpay API', 'settled')`,
        [txnId, studentId, bookingId, amountWithTax]
      );

      await conn.commit();

      // Clear search filters cache
      const teachersRouter = require("./teachers");
      if (teachersRouter.localCache) {
        teachersRouter.localCache.clear();
      }

      const [newBooking] = await query(
        `SELECT b.*, us.name AS student_name, ut.name AS teacher_name
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
    const bookingId = Number(req.params.id);
    const { status } = req.body;

    const bookings = await query("SELECT * FROM bookings WHERE id = ?", [bookingId]);
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

      await conn.execute("UPDATE bookings SET status = ? WHERE id = ?", [status, bookingId]);

      // If cancelled, release slot
      if (status === "Cancelled") {
        await conn.execute("UPDATE teacher_slots SET is_booked = 0 WHERE id = ?", [booking.slot_id]);
      } else if (status === "Completed" && booking.status === "Cancelled") {
        // Re-reserve slot if transitioning back
        await conn.execute("UPDATE teacher_slots SET is_booked = 1 WHERE id = ?", [booking.slot_id]);
      }

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
    const bookingId = Number(req.params.id);
    const { newTeacherProfileId } = req.body;

    const targetTpIdStr = newTeacherProfileId.replace("T", "");
    const targetTpId = Number(targetTpIdStr);

    const bookings = await query("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    if (bookings.length === 0) {
      return next(new AppError("Booking record not found.", 404));
    }

    const booking = bookings[0];

    // Ensure student is swapping their own booking
    if (req.user.role !== "admin" && booking.student_id !== req.user.id) {
      return next(new AppError("Unauthorized booking modification access.", 403));
    }

    // Verify new teacher profile exists and is verified
    const teachers = await query("SELECT id FROM teacher_profiles WHERE id = ? AND is_verified = 1", [targetTpId]);
    if (teachers.length === 0) {
      return next(new AppError("Selected target teacher profile is not verified or active.", 404));
    }

    // Release old teacher slot and book new teacher slot if slot_id matches,
    // or just perform basic teacher swap on booking record to retain slot timeline
    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // For ZERA EDU hot-swap logic:
      // Replace the tutor assigned to a booking code while retaining current schedule state timeline.
      // So we just update the teacher_profile_id on the booking record.
      await conn.execute(
        "UPDATE bookings SET teacher_profile_id = ? WHERE id = ?",
        [targetTpId, bookingId]
      );

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

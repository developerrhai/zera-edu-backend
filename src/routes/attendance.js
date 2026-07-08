const express = require("express");
const { query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const { body } = require("express-validator");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const router = express.Router();

const attendanceCreateRules = [
  body("bookingId").isInt().withMessage("Booking ID must be an integer"),
  body("date").isDate().withMessage("Enter a valid date (YYYY-MM-DD)"),
  body("status").isIn(["Present", "Absent", "Excused"]).withMessage("Status must be Present, Absent, or Excused"),
  body("remarks").optional().trim().escape(),
];

const attendanceUpdateRules = [
  body("status").optional().isIn(["Present", "Absent", "Excused"]).withMessage("Status must be Present, Absent, or Excused"),
  body("remarks").optional().trim().escape(),
];

// Helper to map DB record to frontend shape
function mapAttendance(row) {
  return {
    id: "A_" + row.id,
    recordId: row.id,
    studentName: row.student_name,
    teacherName: row.teacher_name,
    date: row.date,
    status: row.status,
    remarks: row.remarks || "No comments log.",
  };
}

// ── GET /api/attendance ──────────────────────────────────────────────────────
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    let sql = `
      SELECT ar.*, us.name AS student_name, ut.name AS teacher_name
      FROM attendance_records ar
      JOIN users us ON ar.student_id = us.id
      JOIN bookings b ON ar.booking_id = b.id
      JOIN teacher_profiles tp ON b.teacher_profile_id = tp.id
      JOIN users ut ON tp.user_id = ut.id
    `;
    const params = [];

    if (req.user.role === "student") {
      sql += " WHERE ar.student_id = ?";
      params.push(req.user.id);
    } else if (req.user.role === "teacher") {
      sql += " WHERE tp.user_id = ?";
      params.push(req.user.id);
    } // Admin retrieves all records

    sql += " ORDER BY ar.date DESC, ar.created_at DESC";

    const rows = await query(sql, params);

    return res.json({
      success: true,
      attendance: rows.map(mapAttendance),
    });
  })
);

// ── POST /api/attendance (Teacher/Admin only) ────────────────────────────────
router.post(
  "/",
  authenticate,
  authorize(["teacher", "admin"]),
  validate(attendanceCreateRules),
  asyncHandler(async (req, res, next) => {
    const { bookingId, date, status, remarks } = req.body;

    // Verify booking exists and get student_id
    const bookings = await query("SELECT student_id, teacher_profile_id FROM bookings WHERE id = ?", [bookingId]);
    if (bookings.length === 0) {
      return next(new AppError("Booking record not found.", 404));
    }

    const booking = bookings[0];

    // Ensure teacher logged in is assigned to the booking (unless admin)
    if (req.user.role === "teacher") {
      const teacherProfiles = await query("SELECT id FROM teacher_profiles WHERE user_id = ?", [req.user.id]);
      if (teacherProfiles.length === 0 || teacherProfiles[0].id !== booking.teacher_profile_id) {
        return next(new AppError("You are not authorized to log attendance for this booking.", 403));
      }
    }

    const result = await query(
      `INSERT INTO attendance_records (student_id, booking_id, date, status, remarks)
       VALUES (?, ?, ?, ?, ?)`,
      [booking.student_id, bookingId, date, status, remarks || ""]
    );

    const [inserted] = await query(
      `SELECT ar.*, us.name AS student_name, ut.name AS teacher_name
       FROM attendance_records ar
       JOIN users us ON ar.student_id = us.id
       JOIN bookings b ON ar.booking_id = b.id
       JOIN teacher_profiles tp ON b.teacher_profile_id = tp.id
       JOIN users ut ON tp.user_id = ut.id
       WHERE ar.id = ?`,
      [result.insertId]
    );

    return res.status(201).json({
      success: true,
      attendance: mapAttendance(inserted),
    });
  })
);

// ── PUT /api/attendance/:id (Teacher/Admin only) ─────────────────────────────
router.put(
  "/:id",
  authenticate,
  authorize(["teacher", "admin"]),
  validate(attendanceUpdateRules),
  asyncHandler(async (req, res, next) => {
    const recordId = Number(req.params.id);
    const { status, remarks } = req.body;

    const records = await query(
      `SELECT ar.*, b.teacher_profile_id 
       FROM attendance_records ar
       JOIN bookings b ON ar.booking_id = b.id
       WHERE ar.id = ?`,
      [recordId]
    );
    if (records.length === 0) {
      return next(new AppError("Attendance record not found.", 404));
    }

    const record = records[0];

    // Authorize update for assigned teacher
    if (req.user.role === "teacher") {
      const teacherProfiles = await query("SELECT id FROM teacher_profiles WHERE user_id = ?", [req.user.id]);
      if (teacherProfiles.length === 0 || teacherProfiles[0].id !== record.teacher_profile_id) {
        return next(new AppError("You are not authorized to update this attendance record.", 403));
      }
    }

    await query(
      `UPDATE attendance_records SET
         status = COALESCE(?, status),
         remarks = COALESCE(?, remarks)
       WHERE id = ?`,
      [status || null, remarks !== undefined ? remarks : null, recordId]
    );

    const [updated] = await query(
      `SELECT ar.*, us.name AS student_name, ut.name AS teacher_name
       FROM attendance_records ar
       JOIN users us ON ar.student_id = us.id
       JOIN bookings b ON ar.booking_id = b.id
       JOIN teacher_profiles tp ON b.teacher_profile_id = tp.id
       JOIN users ut ON tp.user_id = ut.id
       WHERE ar.id = ?`,
      [recordId]
    );

    return res.json({
      success: true,
      attendance: mapAttendance(updated),
    });
  })
);

module.exports = router;

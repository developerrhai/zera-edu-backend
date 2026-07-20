const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const { body } = require("express-validator");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { generateUlid } = require("../utils/ulid");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();

const checkinGenerateRules = [
  body("subject").trim().notEmpty().withMessage("Subject is required").isLength({ max: 100 }).withMessage("Subject is too long"),
  body("teacherId").trim().notEmpty().withMessage("Teacher ID is required"),
  body("lectureNumber").isInt({ min: 1 }).withMessage("Lecture number must be an integer >= 1"),
];

const verifyOtpRules = [
  body("sessionId").trim().notEmpty().withMessage("Session ID is required"),
  body("otp").isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits").isNumeric().withMessage("OTP must be numeric"),
];

const checkoutGenerateRules = [
  body("sessionId").trim().notEmpty().withMessage("Session ID is required"),
];

// Helper to map DB row to response model
function mapSession(row) {
  return {
    id: row.public_id,
    studentId: row.student_id,
    studentName: row.student_name,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    subject: row.subject,
    lectureNumber: row.lecture_number,
    status: row.status,
    checkinVerifiedAt: row.checkin_verified_at,
    checkoutVerifiedAt: row.checkout_verified_at,
    checkinOtpExpiry: row.checkin_otp_expiry,
    checkoutOtpExpiry: row.checkout_otp_expiry,
    createdAt: row.created_at,
  };
}

// ── GET /api/attendance/class-sessions ───────────────────────────────────────
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    let sql = `
      SELECT cs.*, us.name AS student_name, ut.name AS teacher_name
      FROM class_sessions cs
      JOIN users us ON cs.student_id = us.id
      JOIN users ut ON cs.teacher_id = ut.id
      WHERE cs.deleted_at IS NULL AND us.deleted_at IS NULL AND ut.deleted_at IS NULL
    `;
    const params = [];

    if (req.user.role === "student") {
      sql += " AND cs.student_id = ?";
      params.push(req.user.id);
    } else if (req.user.role === "teacher") {
      sql += " AND cs.teacher_id = ?";
      params.push(req.user.id);
    }

    sql += " ORDER BY cs.created_at DESC";

    const rows = await query(sql, params);

    return res.json({
      success: true,
      sessions: rows.map(mapSession),
    });
  })
);

// ── POST /api/attendance/class-sessions/generate-checkin ──────────────────────
router.post(
  "/generate-checkin",
  authenticate,
  authorize(["student"]),
  validate(checkinGenerateRules),
  asyncHandler(async (req, res, next) => {
    const { subject, teacherId, lectureNumber } = req.body;

    // 1. Verify teacher exists and has teacher role
    const teachers = await query(
      "SELECT id, name FROM users WHERE (public_id = ? OR id = ?) AND role = 'teacher' AND deleted_at IS NULL",
      [teacherId, Number(teacherId) || 0]
    );
    if (teachers.length === 0) {
      return next(new AppError("Specified teacher record not found.", 404));
    }
    const teacher = teachers[0];

    // 2. Invalidate previous 'scheduled' sessions for this student
    await query(
      `UPDATE class_sessions 
       SET deleted_at = CURRENT_TIMESTAMP, deletion_reason = 'Superseded by new scheduled session'
       WHERE student_id = ? AND status = 'scheduled' AND deleted_at IS NULL`,
      [req.user.id]
    );

    // 3. Check if student already has a session in progress
    const activeSessions = await query(
      "SELECT id FROM class_sessions WHERE student_id = ? AND status = 'in-progress' AND deleted_at IS NULL",
      [req.user.id]
    );
    if (activeSessions.length > 0) {
      return next(new AppError("You already have an active class session in progress. Please check out first.", 400));
    }

    // 4. Check for duplicate completed lectures for this student + subject + lectureNumber
    const duplicateLectures = await query(
      "SELECT id FROM class_sessions WHERE student_id = ? AND subject = ? AND lecture_number = ? AND status IN ('completed', 'auto-completed') AND deleted_at IS NULL",
      [req.user.id, subject, lectureNumber]
    );
    if (duplicateLectures.length > 0) {
      return next(new AppError("This lecture number has already been verified and completed for this subject.", 400));
    }

    // 5. Generate check-in OTP (6 digits) and hash it
    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(plainOtp, 10);
    const expiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes validity

    const publicId = generateUlid();

    const result = await query(
      `INSERT INTO class_sessions (public_id, student_id, teacher_id, subject, lecture_number, checkin_otp_hash, checkin_otp_expiry, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      [publicId, req.user.id, teacher.id, subject, lectureNumber, otpHash, expiry, req.user.id]
    );

    await logAudit("class_session", result.insertId, "create", req.user.id, null, {
      subject,
      lectureNumber,
      teacherId: teacher.id,
      status: "scheduled",
    });

    return res.status(201).json({
      success: true,
      sessionId: publicId,
      otp: plainOtp,
      expiresIn: 300,
    });
  })
);

// ── POST /api/attendance/class-sessions/verify-checkin ────────────────────────
router.post(
  "/verify-checkin",
  authenticate,
  authorize(["teacher"]),
  validate(verifyOtpRules),
  asyncHandler(async (req, res, next) => {
    const { sessionId, otp } = req.body;

    const sessions = await query(
      "SELECT * FROM class_sessions WHERE public_id = ? AND deleted_at IS NULL",
      [sessionId]
    );
    if (sessions.length === 0) {
      return next(new AppError("Class session not found.", 404));
    }
    const session = sessions[0];

    // 1. Authorize: Only the assigned teacher can verify
    if (session.teacher_id !== req.user.id) {
      return next(new AppError("You are not authorized to log attendance for this session.", 403));
    }

    // 2. Validate current state
    if (session.status !== "scheduled") {
      return next(new AppError(`Session status is not scheduled (currently: ${session.status}).`, 400));
    }

    // 3. Brute-force block check
    if (session.checkin_blocked_until && new Date(session.checkin_blocked_until) > new Date()) {
      const waitTimeSec = Math.ceil((new Date(session.checkin_blocked_until) - new Date()) / 1000);
      return next(new AppError(`Verification temporarily blocked. Try again in ${waitTimeSec} seconds.`, 429));
    }

    // 4. Expiry validation
    if (new Date(session.checkin_otp_expiry) < new Date()) {
      return next(new AppError("OTP has expired. Please ask the student to generate a new check-in code.", 400));
    }

    // 5. Compare OTP hashes
    const isMatch = await bcrypt.compare(otp, session.checkin_otp_hash);
    if (!isMatch) {
      const attempts = session.checkin_failed_attempts + 1;
      let blockedUntil = null;
      if (attempts >= 3) {
        blockedUntil = new Date(Date.now() + 60 * 1000); // Block for 1 min
      }

      await query(
        "UPDATE class_sessions SET checkin_failed_attempts = ?, checkin_blocked_until = ? WHERE id = ?",
        [attempts, blockedUntil, session.id]
      );

      const errorMsg = attempts >= 3 
        ? "Invalid OTP entered 3 times. Verification blocked for 1 minute." 
        : `Invalid OTP code. ${3 - attempts} attempt(s) remaining.`;
      return next(new AppError(errorMsg, 400));
    }

    // 6. OTP matched: transition to 'in-progress'
    const now = new Date();
    await query(
      `UPDATE class_sessions 
       SET status = 'in-progress', checkin_verified_at = ?, checkin_otp_hash = NULL, checkin_failed_attempts = 0, checkin_blocked_until = NULL, updated_by = ?
       WHERE id = ?`,
      [now, req.user.id, session.id]
    );

    await logAudit("class_session", session.id, "status_change", req.user.id, session, {
      status: "in-progress",
      checkin_verified_at: now,
    });

    return res.json({
      success: true,
      checkInTime: now,
      status: "in-progress",
    });
  })
);

// ── POST /api/attendance/class-sessions/generate-checkout ─────────────────────
router.post(
  "/generate-checkout",
  authenticate,
  authorize(["student"]),
  validate(checkoutGenerateRules),
  asyncHandler(async (req, res, next) => {
    const { sessionId } = req.body;

    const sessions = await query(
      "SELECT * FROM class_sessions WHERE public_id = ? AND deleted_at IS NULL",
      [sessionId]
    );
    if (sessions.length === 0) {
      return next(new AppError("Class session not found.", 404));
    }
    const session = sessions[0];

    // 1. Authorize: Only the student of this session can request
    if (session.student_id !== req.user.id) {
      return next(new AppError("You are not authorized to access this session.", 403));
    }

    // 2. Validate current state
    if (session.status !== "in-progress") {
      return next(new AppError("Check-out OTP can only be generated for sessions in progress.", 400));
    }

    // 3. Generate check-out OTP (6 digits) and hash it
    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(plainOtp, 10);
    const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes validity

    await query(
      `UPDATE class_sessions 
       SET checkout_otp_hash = ?, checkout_otp_expiry = ?, updated_by = ?
       WHERE id = ?`,
      [otpHash, expiry, req.user.id, session.id]
    );

    return res.json({
      success: true,
      otp: plainOtp,
      expiresIn: 600,
    });
  })
);

// ── POST /api/attendance/class-sessions/verify-checkout ───────────────────────
router.post(
  "/verify-checkout",
  authenticate,
  authorize(["teacher"]),
  validate(verifyOtpRules),
  asyncHandler(async (req, res, next) => {
    const { sessionId, otp } = req.body;

    const sessions = await query(
      "SELECT * FROM class_sessions WHERE public_id = ? AND deleted_at IS NULL",
      [sessionId]
    );
    if (sessions.length === 0) {
      return next(new AppError("Class session not found.", 404));
    }
    const session = sessions[0];

    // 1. Authorize: Only the assigned teacher can verify
    if (session.teacher_id !== req.user.id) {
      return next(new AppError("You are not authorized to log attendance for this session.", 403));
    }

    // 2. Validate current state
    if (session.status !== "in-progress") {
      return next(new AppError("Check-out can only be verified for sessions in progress.", 400));
    }
    if (!session.checkout_otp_hash) {
      return next(new AppError("Check-out OTP has not been generated by the student yet.", 400));
    }

    // 3. Brute-force block check
    if (session.checkout_blocked_until && new Date(session.checkout_blocked_until) > new Date()) {
      const waitTimeSec = Math.ceil((new Date(session.checkout_blocked_until) - new Date()) / 1000);
      return next(new AppError(`Verification temporarily blocked. Try again in ${waitTimeSec} seconds.`, 429));
    }

    // 4. Expiry validation
    if (new Date(session.checkout_otp_expiry) < new Date()) {
      return next(new AppError("OTP has expired. Please ask the student to generate a new check-out code.", 400));
    }

    // 5. Compare OTP hashes
    const isMatch = await bcrypt.compare(otp, session.checkout_otp_hash);
    if (!isMatch) {
      const attempts = session.checkout_failed_attempts + 1;
      let blockedUntil = null;
      if (attempts >= 3) {
        blockedUntil = new Date(Date.now() + 60 * 1000); // Block for 1 min
      }

      await query(
        "UPDATE class_sessions SET checkout_failed_attempts = ?, checkout_blocked_until = ? WHERE id = ?",
        [attempts, blockedUntil, session.id]
      );

      const errorMsg = attempts >= 3 
        ? "Invalid OTP entered 3 times. Verification blocked for 1 minute." 
        : `Invalid OTP code. ${3 - attempts} attempt(s) remaining.`;
      return next(new AppError(errorMsg, 400));
    }

    // 6. OTP matched: finalize session
    const now = new Date();
    const checkinTime = new Date(session.checkin_verified_at);
    const durationMs = now - checkinTime;
    const durationHours = durationMs / (1000 * 60 * 60);

    let finalStatus = "completed";
    let warning = null;
    if (durationHours > 2.0) {
      finalStatus = "auto-completed";
      warning = "Class duration exceeded 2 hours. Session auto-completed.";
    }

    await query(
      `UPDATE class_sessions 
       SET status = ?, checkout_verified_at = ?, checkout_otp_hash = NULL, checkout_failed_attempts = 0, checkout_blocked_until = NULL, updated_by = ?
       WHERE id = ?`,
      [finalStatus, now, req.user.id, session.id]
    );

    await logAudit("class_session", session.id, "status_change", req.user.id, session, {
      status: finalStatus,
      checkout_verified_at: now,
    });

    // ─── Seamless Integration with existing attendance system ───────────────
    // We resolve the matching booking, or create a mock one if none exists,
    // to write a record to the `attendance_records` table which has a foreign key to `bookings`
    try {
      // 1. Resolve teacher's profile id
      const teacherProfiles = await query(
        "SELECT id FROM teacher_profiles WHERE user_id = ? AND deleted_at IS NULL",
        [session.teacher_id]
      );
      
      if (teacherProfiles.length > 0) {
        const teacherProfileId = teacherProfiles[0].id;
        
        // 2. Find booking
        let bookingId = null;
        const bookings = await query(
          `SELECT id FROM bookings 
           WHERE student_id = ? AND teacher_profile_id = ? AND deleted_at IS NULL 
           ORDER BY created_at DESC LIMIT 1`,
          [session.student_id, teacherProfileId]
        );
        
        if (bookings.length > 0) {
          bookingId = bookings[0].id;
        } else {
          // If no booking exists, auto-provision a slot and booking to satisfy constraints
          let slotId = null;
          const slots = await query(
            "SELECT id FROM teacher_slots WHERE teacher_profile_id = ? AND deleted_at IS NULL LIMIT 1",
            [teacherProfileId]
          );
          
          if (slots.length > 0) {
            slotId = slots[0].id;
          } else {
            const slotPublicId = generateUlid();
            const slotRes = await query(
              `INSERT INTO teacher_slots (public_id, teacher_profile_id, day, time_window, location, is_booked) 
               VALUES (?, ?, 'Monday', '04:00 PM - 06:00 PM', 'Offline Center', 1)`,
              [slotPublicId, teacherProfileId]
            );
            slotId = slotRes.insertId;
          }
          
          const bookingPublicId = generateUlid();
          const bookingRefCode = "CS-" + Date.now().toString().slice(-6);
          const bookingRes = await query(
            `INSERT INTO bookings (public_id, ref_code, student_id, teacher_profile_id, slot_id, slot_info, location, status) 
             VALUES (?, ?, ?, ?, ?, 'In-Person Session Slot', 'Offline Center', 'Completed')`,
            [bookingPublicId, bookingRefCode, session.student_id, teacherProfileId, slotId]
          );
          bookingId = bookingRes.insertId;
        }
        
        // 3. Write record to `attendance_records` table
        const attendancePublicId = generateUlid();
        await query(
          `INSERT INTO attendance_records (public_id, student_id, booking_id, date, status, remarks, created_by)
           VALUES (?, ?, ?, CURDATE(), 'Present', ?, ?)`,
          [
            attendancePublicId, 
            session.student_id, 
            bookingId, 
            `In-person attendance. Lecture #${session.lecture_number}. Subject: ${session.subject}. Status: ${finalStatus.toUpperCase()}`,
            req.user.id
          ]
        );
      }
    } catch (dbErr) {
      // Log the integration error but don't fail the verification response
      console.error("[OTP Attendance Integration Error] Failed to auto-provision attendance record: ", dbErr);
    }

    return res.json({
      success: true,
      checkOutTime: now,
      status: finalStatus,
      warning,
    });
  })
);

module.exports = router;

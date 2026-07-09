const express = require("express");
const { query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Helper: map DB row to frontend payment shape
function mapPayment(row) {
  return {
    id: row.transaction_id,
    paymentId: row.public_id, // Map public_id to paymentId
    userScope: row.student_name ? `${row.student_name} (Student)` : "Anonymous User",
    amount: Number(row.amount),
    currency: row.currency || "INR",
    gatewayMethod: row.gateway_method || "UPI Razorpay API",
    timestamp: row.created_at,
    status: row.status === "settled" ? "Settled Success" : row.status,
  };
}

// ── GET /api/payments ────────────────────────────────────────────────────────
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    let sql = `
      SELECT p.*, u.name AS student_name
      FROM payments p
      JOIN users u ON p.user_id = u.id
    `;
    const params = [];

    if (req.user.role === "student") {
      sql += " WHERE p.user_id = ? AND p.deleted_at IS NULL AND u.deleted_at IS NULL";
      params.push(req.user.id);
    } else if (req.user.role === "teacher") {
      sql = `
        SELECT p.*, u.name AS student_name
        FROM payments p
        JOIN users u ON p.user_id = u.id
        JOIN bookings b ON p.booking_id = b.id
        JOIN teacher_profiles tp ON b.teacher_profile_id = tp.id
        WHERE tp.user_id = ? AND p.deleted_at IS NULL AND u.deleted_at IS NULL AND b.deleted_at IS NULL AND tp.deleted_at IS NULL
      `;
      params.push(req.user.id);
    } else {
      sql += " WHERE p.deleted_at IS NULL AND u.deleted_at IS NULL";
    }

    sql += " ORDER BY p.created_at DESC";

    const rows = await query(sql, params);

    return res.json({
      success: true,
      payments: rows.map(mapPayment),
    });
  })
);

module.exports = router;

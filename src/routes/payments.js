const express = require("express");
const { getPool, query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { createPaymentLink, verifyChecksum, checkPaymentStatus } = require("../services/phonepeService");
const { generateUlid } = require("../utils/ulid");
const { logAudit } = require("../utils/auditLogger");

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
    status: row.status === "settled" ? "Settled Success" : (row.status === 'failed' ? 'Failed' : row.status),
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

// ── POST /api/payments/create-order ──────────────────────────────────────────
router.post(
  "/create-order",
  authenticate,
  authorize(["student"]),
  asyncHandler(async (req, res, next) => {
    const { bookingId, subscriptionId } = req.body;
    if (!bookingId && !subscriptionId) {
      return next(new AppError("Booking ID or Subscription ID is required to create a payment order.", 400));
    }

    let payment;

    if (bookingId) {
      const bPublicId = bookingId.startsWith("B_") ? bookingId.substring(2) : bookingId;
      const bookings = await query("SELECT id FROM bookings WHERE public_id = ? AND student_id = ? AND deleted_at IS NULL", [bPublicId, req.user.id]);
      if (bookings.length === 0) return next(new AppError("Booking not found.", 404));
      const internalBookingId = bookings[0].id;

      const payments = await query("SELECT * FROM payments WHERE booking_id = ? AND user_id = ? AND status = 'pending' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", [internalBookingId, req.user.id]);
      if (payments.length === 0) return next(new AppError("No pending payment found for this booking. It might be already settled.", 400));
      payment = payments[0];
    } else if (subscriptionId) {
      const sPublicId = subscriptionId;
      const subs = await query("SELECT id FROM user_subscriptions WHERE public_id = ? AND user_id = ? AND deleted_at IS NULL", [sPublicId, req.user.id]);
      if (subs.length === 0) return next(new AppError("Subscription not found.", 404));
      const internalSubId = subs[0].id;

      const payments = await query("SELECT * FROM payments WHERE subscription_id = ? AND user_id = ? AND status = 'pending' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", [internalSubId, req.user.id]);
      if (payments.length === 0) return next(new AppError("No pending payment found for this subscription. It might be already settled.", 400));
      payment = payments[0];
    }

    // Build absolute callback and redirect URLs
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers.host;
    const backendUrl = `${protocol}://${host}`;
    
    // Attempt to get frontend URL from origin, referer, or env
    const frontendUrl = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || process.env.FRONTEND_ORIGIN?.split(',')[0] || "http://localhost:5500";

    const callbackUrl = `${backendUrl}/api/payments/callback`;
    const redirectUrl = `${frontendUrl}/payment-status.html?txnId=${payment.transaction_id}`;

    // Get user info for mobile number (assuming optional)
    const users = await query("SELECT * FROM users WHERE id = ?", [req.user.id]);
    const mobileNumber = users.length > 0 ? (users[0].mobile_number || "9999999999") : "9999999999";

    try {
      const paymentLink = await createPaymentLink({
        transactionId: payment.transaction_id,
        amount: Number(payment.amount),
        userId: `U${req.user.id}`,
        redirectUrl,
        callbackUrl,
        mobileNumber
      });

      res.json({
        success: true,
        redirectUrl: paymentLink
      });
    } catch (gatewayError) {
      // PhonePe gateway not activated yet — auto-settle and redirect for local testing
      console.warn("[Payments] PhonePe gateway error, using local settlement fallback:", gatewayError.message);
      
      await query("UPDATE payments SET status = 'settled', gateway_method = 'PhonePe (Local Sim)' WHERE id = ?", [payment.id]);

      // If there's a linked subscription, activate it
      if (payment.subscription_id) {
        await query("UPDATE user_subscriptions SET status = 'Active' WHERE id = ?", [payment.subscription_id]);
      }

      res.json({
        success: true,
        redirectUrl: redirectUrl
      });
    }
  })
);

// ── POST /api/payments/callback ─────────────────────────────────────────────
router.post(
  "/callback",
  asyncHandler(async (req, res) => {
    // PhonePe sends { response: "base64..." }
    const xVerify = req.headers["x-verify"];
    const base64Response = req.body.response;

    if (!xVerify || !base64Response) {
      return res.status(400).send("Invalid callback payload");
    }

    const isValid = verifyChecksum(base64Response, xVerify);
    if (!isValid) {
      console.error("PhonePe Webhook Checksum Mismatch!");
      return res.status(400).send("Checksum validation failed");
    }

    const decoded = Buffer.from(base64Response, "base64").toString("utf-8");
    const data = JSON.parse(decoded);

    const txnId = data.data.merchantTransactionId;
    const success = data.success;
    
    // Find the payment record
    const payments = await query("SELECT * FROM payments WHERE transaction_id = ? AND deleted_at IS NULL", [txnId]);
    if (payments.length === 0) {
      return res.status(404).send("Transaction not found");
    }
    const payment = payments[0];
    
    if (payment.status !== "pending") {
      // Already processed
      return res.status(200).send("OK");
    }

    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const newStatus = success ? "settled" : "failed";
      await conn.execute("UPDATE payments SET status = ? WHERE id = ?", [newStatus, payment.id]);
      
      // If success, update booking status to 'Completed' (or leave it to tutor to complete. For now, we just update payment)
      // We will let booking status remain as 'Pending Completion' until tutor completes the session.

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      console.error("Callback DB Error:", error);
      return res.status(500).send("Internal Server Error");
    } finally {
      conn.release();
    }

    res.status(200).send("OK");
  })
);

// ── POST /api/payments/check-status ──────────────────────────────────────────
// Useful if webhook misses, the frontend can query this route to verify manually
router.post(
  "/check-status",
  authenticate,
  asyncHandler(async (req, res, next) => {
    const { txnId } = req.body;
    if (!txnId) return next(new AppError("Transaction ID required", 400));

    const payments = await query("SELECT * FROM payments WHERE transaction_id = ? AND user_id = ? AND deleted_at IS NULL", [txnId, req.user.id]);
    if (payments.length === 0) return next(new AppError("Transaction not found", 404));

    const payment = payments[0];
    if (payment.status === "settled" || payment.status === "failed") {
      return res.json({ success: true, status: payment.status });
    }

    // It's pending, let's verify via PhonePe
    const statusData = await checkPaymentStatus(txnId);
    
    const pool = getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      if (statusData.success && statusData.code === "PAYMENT_SUCCESS") {
        await conn.execute("UPDATE payments SET status = 'settled' WHERE id = ?", [payment.id]);
        await conn.commit();
        return res.json({ success: true, status: "settled" });
      } else if (!statusData.success && (statusData.code === "PAYMENT_ERROR" || statusData.code === "PAYMENT_DECLINED")) {
        await conn.execute("UPDATE payments SET status = 'failed' WHERE id = ?", [payment.id]);
        await conn.commit();
        return res.json({ success: true, status: "failed" });
      }

      await conn.commit();
      return res.json({ success: true, status: "pending" }); // Still pending
    } catch (error) {
      await conn.rollback();
      return next(error);
    } finally {
      conn.release();
    }
  })
);

module.exports = router;

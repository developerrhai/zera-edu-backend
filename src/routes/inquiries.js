const express = require("express");
const { query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { generateUlid } = require("../utils/ulid");
const { body } = require("express-validator");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();

// ─── Input Validation Constraints ─────────────────────────────────────────────
const createInquiryRules = [
  body("subject").trim().notEmpty().withMessage("Subject is required").isLength({ max: 255 }).withMessage("Subject cannot exceed 255 characters"),
  body("message").trim().notEmpty().withMessage("Message is required").isLength({ max: 5000 }).withMessage("Message cannot exceed 5000 characters"),
];

const updateInquiryRules = [
  body("status").isIn(["pending", "in-progress", "resolved"]).withMessage("Invalid status value"),
  body("adminReply").optional({ checkFalsy: true }).trim().isLength({ max: 5000 }).withMessage("Reply cannot exceed 5000 characters"),
];

// ── POST /api/v1/inquiries (Submit Inquiry) ──────────────────────────────────
router.post(
  "/",
  authenticate,
  authorize(["student", "teacher"]),
  validate(createInquiryRules),
  asyncHandler(async (req, res, next) => {
    const { subject, message } = req.body;
    const publicId = generateUlid();

    await query(
      "INSERT INTO inquiries (public_id, submitted_by, user_role, subject, message) VALUES (?, ?, ?, ?, ?)",
      [publicId, req.user.id, req.user.role, subject, message]
    );

    // Fetch the newly inserted record ID for audit logging
    const inquiries = await query("SELECT id FROM inquiries WHERE public_id = ?", [publicId]);
    if (inquiries.length > 0) {
      await logAudit("inquiry", inquiries[0].id, "create", req.user.id, null, { subject, user_role: req.user.role });
    }

    return res.status(201).json({
      success: true,
      message: "Inquiry submitted successfully.",
      inquiry: {
        id: publicId,
        subject,
        message,
        status: "pending",
        createdAt: new Date(),
      }
    });
  })
);

// ── GET /api/v1/inquiries/my-inquiries (Get My Inquiries) ────────────────────
router.get(
  "/my-inquiries",
  authenticate,
  authorize(["student", "teacher"]),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT public_id AS id, subject, message, status, admin_reply AS adminReply, created_at AS createdAt, updated_at AS updatedAt
       FROM inquiries
       WHERE submitted_by = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    return res.json({
      success: true,
      inquiries: rows,
    });
  })
);

// ── GET /api/v1/inquiries (Get All Inquiries - Admin Only) ───────────────────
router.get(
  "/",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res) => {
    const { role, status, limit = 20, offset = 0 } = req.query;

    let sql = `
      SELECT i.public_id AS id, i.subject, i.message, i.status, i.admin_reply AS adminReply, 
             i.user_role AS userRole, i.created_at AS createdAt, i.updated_at AS updatedAt,
             u.name AS userName, u.email AS userEmail, u.public_id AS userPublicId
      FROM inquiries i
      JOIN users u ON i.submitted_by = u.id
      WHERE i.deleted_at IS NULL AND u.deleted_at IS NULL
    `;
    const params = [];

    if (role) {
      sql += " AND i.user_role = ?";
      params.push(role);
    }
    if (status) {
      sql += " AND i.status = ?";
      params.push(status);
    }

    // Clean limit and offset parameters
    let numericLimit = parseInt(limit, 10);
    let numericOffset = parseInt(offset, 10);
    if (isNaN(numericLimit) || numericLimit <= 0) numericLimit = 20;
    if (isNaN(numericOffset) || numericOffset < 0) numericOffset = 0;

    sql += " ORDER BY i.created_at DESC LIMIT ? OFFSET ?";
    params.push(numericLimit, numericOffset);

    const rows = await query(sql, params);

    return res.json({
      success: true,
      inquiries: rows,
    });
  })
);

// ── PUT /api/v1/inquiries/:id/status (Update Status & Reply - Admin Only) ─────
router.put(
  "/:id/status",
  authenticate,
  authorize(["admin"]),
  validate(updateInquiryRules),
  asyncHandler(async (req, res, next) => {
    const { status, adminReply } = req.body;
    const inquiryPublicId = req.params.id;

    const inquiries = await query("SELECT * FROM inquiries WHERE public_id = ? AND deleted_at IS NULL", [inquiryPublicId]);
    if (inquiries.length === 0) {
      return next(new AppError("Inquiry not found.", 404));
    }

    const inquiry = inquiries[0];

    await query(
      "UPDATE inquiries SET status = ?, admin_reply = ? WHERE id = ?",
      [status, adminReply || null, inquiry.id]
    );

    const [updated] = await query("SELECT * FROM inquiries WHERE id = ?", [inquiry.id]);

    // Log update action to audit logger
    await logAudit("inquiry", inquiry.id, "update", req.user.id, inquiry, updated);

    return res.json({
      success: true,
      message: "Inquiry status and reply updated successfully."
    });
  })
);

module.exports = router;

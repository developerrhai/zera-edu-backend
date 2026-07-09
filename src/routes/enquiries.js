const express = require("express");
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

const callbackRules = [
  body("studentName").trim().notEmpty().withMessage("Student name is required"),
  body("parentName").trim().notEmpty().withMessage("Parent name is required"),
  body("contactNumber").trim().notEmpty().withMessage("Contact number is required"),
  body("email").optional().isEmail().withMessage("Enter a valid email address").normalizeEmail(),
  body("address").trim().notEmpty().withMessage("Student address is required"),
  body("board").optional().trim(),
  body("standard").optional().trim(),
  body("schoolName").optional().trim(),
];

const contactRules = [
  body("fullName").trim().notEmpty().withMessage("Full name is required"),
  body("email").isEmail().withMessage("Enter a valid email address").normalizeEmail(),
  body("phoneNumber").optional().trim(),
  body("inquiryType").trim().notEmpty().withMessage("Inquiry type is required"),
  body("message").trim().notEmpty().withMessage("Message content is required"),
];

// Helper to map DB row to frontend enquiry shape
function mapEnquiry(row) {
  return {
    id: row.public_id,
    type: row.type,
    student_name: row.student_name,
    parent_name: row.parent_name,
    contact_number: row.contact_number,
    email: row.email,
    address: row.address,
    board: row.board,
    standard: row.standard,
    school_name: row.school_name,
    inquiry_type: row.inquiry_type,
    message: row.message,
    status: row.status,
    created_at: row.created_at,
  };
}

// ── POST /api/enquiries/callback ─────────────────────────────────────────────
router.post(
  "/callback",
  validate(callbackRules),
  asyncHandler(async (req, res) => {
    const {
      studentName,
      parentName,
      contactNumber,
      email,
      address,
      board,
      standard,
      schoolName,
    } = req.body;
    
    const publicId = generateUlid();

    const result = await query(
      `INSERT INTO enquiries
         (public_id, type, student_name, parent_name, contact_number, email, address, board, standard, school_name, status)
       VALUES (?, 'callback', ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      [publicId, studentName, parentName, contactNumber, email || null, address, board || null, standard || null, schoolName || null]
    );

    // Log registration
    await logAudit("enquiry", result.insertId, "create", null, null, { type: "callback", studentName });

    return res.status(201).json({
      success: true,
      message: "Lead callback request registered successfully. Our matching team will connect shortly.",
    });
  })
);

// ── POST /api/enquiries/contact ──────────────────────────────────────────────
router.post(
  "/contact",
  validate(contactRules),
  asyncHandler(async (req, res) => {
    const { fullName, email, phoneNumber, inquiryType, message } = req.body;
    const publicId = generateUlid();

    const result = await query(
      `INSERT INTO enquiries
         (public_id, type, student_name, email, contact_number, inquiry_type, message, status)
       VALUES (?, 'contact', ?, ?, ?, ?, ?, 'new')`,
      [publicId, fullName, email, phoneNumber || null, inquiryType, message]
    );

    // Log registration
    await logAudit("enquiry", result.insertId, "create", null, null, { type: "contact", fullName });

    return res.status(201).json({
      success: true,
      message: "Message successfully dispatched to our administrative team.",
    });
  })
);

// ── GET /api/enquiries (Admin only) ──────────────────────────────────────────
router.get(
  "/",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM enquiries WHERE deleted_at IS NULL ORDER BY created_at DESC");

    return res.json({
      success: true,
      enquiries: rows.map(mapEnquiry),
    });
  })
);

// ── PUT /api/enquiries/:id/status (Admin only) ────────────────────────────────
router.put(
  "/:id/status",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res, next) => {
    const enquiryPublicId = req.params.id;
    const { status } = req.body;

    if (!["new", "contacted", "resolved"].includes(status)) {
      return next(new AppError("Invalid enquiry status flag.", 400));
    }

    const enquiries = await query("SELECT * FROM enquiries WHERE public_id = ? AND deleted_at IS NULL", [enquiryPublicId]);
    if (enquiries.length === 0) {
      return next(new AppError("Enquiry record not found.", 404));
    }

    const enquiry = enquiries[0];

    await query("UPDATE enquiries SET status = ?, updated_by = ? WHERE id = ?", [status, req.user.id, enquiry.id]);
    
    // Log update audit
    await logAudit("enquiry", enquiry.id, "status_change", req.user.id, { status: enquiry.status }, { status });

    return res.json({
      success: true,
      message: "Enquiry status updated.",
    });
  })
);

module.exports = router;

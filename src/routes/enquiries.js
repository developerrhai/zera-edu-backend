const express = require("express");
const { query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const { body } = require("express-validator");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

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

    await query(
      `INSERT INTO enquiries
         (type, student_name, parent_name, contact_number, email, address, board, standard, school_name, status)
       VALUES ('callback', ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      [studentName, parentName, contactNumber, email || null, address, board || null, standard || null, schoolName || null]
    );

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

    await query(
      `INSERT INTO enquiries
         (type, student_name, email, contact_number, inquiry_type, message, status)
       VALUES ('contact', ?, ?, ?, ?, ?, 'new')`,
      [fullName, email, phoneNumber || null, inquiryType, message]
    );

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
    const rows = await query("SELECT * FROM enquiries ORDER BY created_at DESC");

    return res.json({
      success: true,
      enquiries: rows,
    });
  })
);

// ── PUT /api/enquiries/:id/status (Admin only) ────────────────────────────────
router.put(
  "/:id/status",
  authenticate,
  authorize(["admin"]),
  asyncHandler(async (req, res, next) => {
    const enquiryId = Number(req.params.id);
    const { status } = req.body;

    if (!["new", "contacted", "resolved"].includes(status)) {
      return next(new AppError("Invalid enquiry status flag.", 400));
    }

    const result = await query("UPDATE enquiries SET status = ? WHERE id = ?", [status, enquiryId]);
    if (result.affectedRows === 0) {
      return next(new AppError("Enquiry record not found.", 404));
    }

    return res.json({
      success: true,
      message: "Enquiry status updated.",
    });
  })
);

module.exports = router;

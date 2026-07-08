const express = require("express");
const { body } = require("express-validator");
const { query } = require("../config/db");
const authService = require("../services/authService");
const emailService = require("../services/emailService");
const validate = require("../middleware/validate");
const authenticate = require("../middleware/authenticate");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const router = express.Router();

// ─── Input Validation Constraints ─────────────────────────────────────────────
const registerRules = [
  body("email").isEmail().withMessage("Enter a valid email address").normalizeEmail(),
  body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("role").isIn(["student", "teacher"]).withMessage("Role must be student or teacher"),
];

const loginRules = [
  body("email").isEmail().withMessage("Enter a valid email address").normalizeEmail(),
  body("password").notEmpty().withMessage("Password is required"),
];

const forgotPasswordRules = [
  body("email").isEmail().withMessage("Enter a valid email address").normalizeEmail(),
];

const updateProfileRules = [
  body("name").optional().trim().notEmpty().withMessage("Name cannot be empty"),
  body("avatarUrl").optional().isURL().withMessage("Avatar must be a valid URL"),
];

// ── POST /api/auth/register ──────────────────────────────────────────────────
router.post(
  "/register",
  validate(registerRules),
  asyncHandler(async (req, res, next) => {
    const { email, password, name, role } = req.body;

    // Check if email already registered
    const exists = await query("SELECT id FROM users WHERE email = ?", [email]);
    if (exists.length > 0) {
      return next(new AppError("An account with this email address already exists.", 409));
    }

    // Hash password and commit user record
    const passwordHash = await authService.hashPassword(password);
    const result = await query(
      "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)",
      [email, passwordHash, name, role]
    );

    // If teacher role registered, dynamically provision profile record in pending status
    if (role === "teacher") {
      await query(
        "INSERT INTO teacher_profiles (user_id, subject, cost_per_hour, is_verified) VALUES (?, ?, ?, 0)",
        [result.insertId, "Specialized Subject", 500.00]
      );
      
      // Add in onboarding queue
      await query(
        "INSERT INTO onboarding_queue (user_id, specializations, cost_quote, credentials) VALUES (?, ?, ?, ?)",
        [result.insertId, "General Studies", 500.00, "Background pending verification"]
      );
    }

    const payload = { id: result.insertId, email, role };
    const accessToken = authService.generateAccessToken(payload);
    const refreshToken = authService.generateRefreshToken(payload);

    // Update refresh token in DB
    await query("UPDATE users SET refresh_token = ? WHERE id = ?", [refreshToken, result.insertId]);

    return res.status(201).json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: result.insertId,
        email,
        name,
        role,
      },
    });
  })
);

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post(
  "/login",
  validate(loginRules),
  asyncHandler(async (req, res, next) => {
    const { email, password } = req.body;

    // Load user record from DB
    const users = await query("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0) {
      return next(new AppError("Invalid email or password credentials.", 401));
    }

    const user = users[0];

    if (!user.is_active) {
      return next(new AppError("Your account credentials have been suspended.", 403));
    }

    // Validate password
    const valid = await authService.comparePassword(password, user.password_hash);
    if (!valid) {
      return next(new AppError("Invalid email or password credentials.", 401));
    }

    const payload = { id: user.id, email: user.email, role: user.role };
    const accessToken = authService.generateAccessToken(payload);
    const refreshToken = authService.generateRefreshToken(payload);

    // Update refresh token in DB
    await query("UPDATE users SET refresh_token = ? WHERE id = ?", [refreshToken, user.id]);

    return res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatarUrl: user.avatar_url,
      },
    });
  })
);

// ── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post(
  "/refresh",
  asyncHandler(async (req, res, next) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return next(new AppError("Refresh token is required.", 400));
    }

    // Verify token validity
    const decoded = authService.verifyRefreshToken(refreshToken);

    // Verify user exists and token matches
    const users = await query("SELECT refresh_token, is_active FROM users WHERE id = ?", [decoded.id]);
    if (users.length === 0) {
      return next(new AppError("Invalid refresh session.", 401));
    }

    const user = users[0];
    if (!user.is_active) {
      return next(new AppError("Account has been suspended.", 403));
    }

    if (user.refresh_token !== refreshToken) {
      return next(new AppError("Invalid session credentials token mismatch.", 401));
    }

    // Issue new access and refresh tokens (sliding session)
    const payload = { id: decoded.id, email: decoded.email, role: decoded.role };
    const newAccessToken = authService.generateAccessToken(payload);
    const newRefreshToken = authService.generateRefreshToken(payload);

    await query("UPDATE users SET refresh_token = ? WHERE id = ?", [newRefreshToken, decoded.id]);

    return res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  })
);

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
router.post(
  "/forgot-password",
  validate(forgotPasswordRules),
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    const users = await query("SELECT id, name FROM users WHERE email = ?", [email]);
    if (users.length === 0) {
      // Return 200 to prevent user enumeration security disclosure
      return res.json({
        success: true,
        message: "If the email is registered, a bypass key link has been transmitted.",
      });
    }

    const user = users[0];

    // Transmit email
    await emailService.sendMail({
      to: email,
      subject: "ZERA EDU — Bypass Key Security Request",
      html: `
        <h3>System Credential Bypass Request</h3>
        <p>Dear ${user.name},</p>
        <p>A password bypass request was registered for your profile. Use the link below to verify identity:</p>
        <p><a href="http://localhost:5000/api/auth/reset-password?id=${user.id}">Reset Security Access Key</a></p>
        <p>Thank you,<br>ZERA EDU Administration Core</p>
      `,
    });

    return res.json({
      success: true,
      message: "If the email is registered, a bypass key link has been transmitted.",
    });
  })
);

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const users = await query(
      "SELECT id, email, name, role, avatar_url, created_at FROM users WHERE id = ?",
      [req.user.id]
    );

    let profileDetails = {};
    if (req.user.role === "teacher") {
      const profile = await query("SELECT * FROM teacher_profiles WHERE user_id = ?", [req.user.id]);
      if (profile.length > 0) profileDetails = profile[0];
    }

    return res.json({
      success: true,
      user: {
        ...users[0],
        profile: req.user.role === "teacher" ? profileDetails : undefined,
      },
    });
  })
);

// ── PUT /api/auth/me ─────────────────────────────────────────────────────────
router.put(
  "/me",
  authenticate,
  validate(updateProfileRules),
  asyncHandler(async (req, res) => {
    const { name, avatarUrl } = req.body;

    if (name) {
      await query("UPDATE users SET name = ? WHERE id = ?", [name, req.user.id]);
    }
    if (avatarUrl !== undefined) {
      await query("UPDATE users SET avatar_url = ? WHERE id = ?", [avatarUrl, req.user.id]);
    }

    const [updatedUser] = await query("SELECT id, email, name, role, avatar_url FROM users WHERE id = ?", [req.user.id]);

    return res.json({
      success: true,
      user: updatedUser,
    });
  })
);

module.exports = router;

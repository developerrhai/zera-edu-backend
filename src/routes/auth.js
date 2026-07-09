const express = require("express");
const { body } = require("express-validator");
const { getPool, query } = require("../config/db");
const authService = require("../services/authService");
const emailService = require("../services/emailService");
const validate = require("../middleware/validate");
const authenticate = require("../middleware/authenticate");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { generateUlid } = require("../utils/ulid");
const { logAudit } = require("../utils/auditLogger");

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
    const exists = await query("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", [email]);
    if (exists.length > 0) {
      return next(new AppError("An account with this email address already exists.", 409));
    }

    // Hash password and commit user record
    const passwordHash = await authService.hashPassword(password);
    const userPublicId = generateUlid();
    const result = await query(
      "INSERT INTO users (public_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)",
      [userPublicId, email, passwordHash, name, role]
    );
    const userId = result.insertId;

    // Log the user creation to audit logs
    await logAudit("user", userId, "create", userId, null, { email, name, role });

    // If teacher role registered, dynamically provision profile record in pending status
    if (role === "teacher") {
      const profilePublicId = generateUlid();
      const [profileResult] = await query(
        "INSERT INTO teacher_profiles (public_id, user_id, subject, cost_per_hour, is_verified) VALUES (?, ?, ?, ?, 0)",
        [profilePublicId, userId, "Specialized Subject", 500.00]
      );
      
      // Add in onboarding queue
      const queuePublicId = generateUlid();
      await query(
        "INSERT INTO onboarding_queue (public_id, user_id, specializations, cost_quote, credentials) VALUES (?, ?, ?, ?, ?)",
        [queuePublicId, userId, "General Studies", 500.00, "Background pending verification"]
      );

      // Log teacher profile creation
      await logAudit("teacher_profile", profileResult.insertId, "create", userId, null, { subject: "Specialized Subject", cost: 500.00 });
    }

    const payload = { id: userId, email, role };
    const accessToken = authService.generateAccessToken(payload);
    const refreshToken = authService.generateRefreshToken(payload);

    // Update refresh token in DB
    await query("UPDATE users SET refresh_token = ? WHERE id = ?", [refreshToken, userId]);

    return res.status(201).json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: userPublicId,
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
    const users = await query("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL", [email]);
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

    // Log the user login to audit logs
    await logAudit("user", user.id, "login", user.id, null, { ip: req.ip });

    return res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: user.public_id,
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
    const users = await query("SELECT refresh_token, is_active FROM users WHERE id = ? AND deleted_at IS NULL", [decoded.id]);
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

    const users = await query("SELECT id, name, public_id FROM users WHERE email = ? AND deleted_at IS NULL", [email]);
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
        <p><a href="http://localhost:5000/api/auth/reset-password?id=${user.public_id}">Reset Security Access Key</a></p>
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
      "SELECT id, email, name, role, avatar_url, created_at, public_id FROM users WHERE id = ? AND deleted_at IS NULL",
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    const userRow = users[0];

    let profileDetails = {};
    if (req.user.role === "teacher") {
      const profile = await query("SELECT * FROM teacher_profiles WHERE user_id = ? AND deleted_at IS NULL", [req.user.id]);
      if (profile.length > 0) {
        const p = profile[0];
        profileDetails = {
          id: p.public_id,
          profileId: p.public_id,
          userId: userRow.public_id,
          subject: p.subject,
          board: p.board,
          standard: p.standard,
          timingGroup: p.timing_group,
          mapRadiusKm: p.map_radius_km,
          youtubeUrl: p.youtube_url,
          cost: Number(p.cost_per_hour),
          expYears: p.experience_years,
          stars: Math.round(p.rating),
          degree: p.degree,
          isVerified: !!p.is_verified
        };
      }
    }

    return res.json({
      success: true,
      user: {
        id: userRow.public_id,
        email: userRow.email,
        name: userRow.name,
        role: userRow.role,
        avatarUrl: userRow.avatar_url,
        createdAt: userRow.created_at,
        profile: req.user.role === "teacher" && profileDetails.id ? profileDetails : undefined,
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

    const oldUser = await query("SELECT * FROM users WHERE id = ?", [req.user.id]);

    if (name) {
      await query("UPDATE users SET name = ? WHERE id = ?", [name, req.user.id]);
    }
    if (avatarUrl !== undefined) {
      await query("UPDATE users SET avatar_url = ? WHERE id = ?", [avatarUrl, req.user.id]);
    }

    const [updatedUser] = await query("SELECT id, email, name, role, avatar_url, public_id FROM users WHERE id = ?", [req.user.id]);

    // Log update audit log
    await logAudit("user", req.user.id, "update", req.user.id, oldUser[0], updatedUser);

    return res.json({
      success: true,
      user: {
        id: updatedUser.public_id,
        email: updatedUser.email,
        name: updatedUser.name,
        role: updatedUser.role,
        avatarUrl: updatedUser.avatar_url,
      },
    });
  })
);

module.exports = router;

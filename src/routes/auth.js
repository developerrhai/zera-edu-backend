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

const verifyOtpRules = [
  body("email").isEmail().withMessage("Enter a valid email address").normalizeEmail(),
  body("otp").isLength({ min: 6, max: 6 }).withMessage("OTP must be exactly 6 digits"),
  body("otpToken").notEmpty().withMessage("OTP token is required"),
];

const resetPasswordRules = [
  body("email").isEmail().withMessage("Enter a valid email address").normalizeEmail(),
  body("resetToken").notEmpty().withMessage("Reset token is required"),
  body("newPassword").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
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
  asyncHandler(async (req, res, next) => {
    const { email } = req.body;

    const users = await query("SELECT id, name, last_otp_sent FROM users WHERE email = ? AND deleted_at IS NULL", [email]);
    if (users.length === 0) {
      return res.json({
        success: true,
        message: "OTP sent to your email",
        otpToken: jwt.sign({ email }, process.env.JWT_SECRET || "change_this_to_a_long_random_string", { expiresIn: "5m" })
      });
    }

    const user = users[0];

    // Rate limiting check: 60 seconds
    if (user.last_otp_sent) {
      const lastSent = new Date(user.last_otp_sent);
      const now = new Date();
      const diffMs = now - lastSent;
      if (diffMs < 60000) {
        const waitSec = Math.ceil((60000 - diffMs) / 1000);
        return next(new AppError(`Please wait ${waitSec} seconds before requesting a new OTP.`, 429));
      }
    }

    // Generate 6-digit OTP code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // valid for 5 minutes
    const now = new Date();

    // Store OTP state in database
    await query(
      "UPDATE users SET reset_otp = ?, reset_otp_expires = ?, last_otp_sent = ? WHERE id = ?",
      [otp, expiresAt, now, user.id]
    );

    // Generate short-lived JWT token containing email
    const otpToken = jwt.sign(
      { email },
      process.env.JWT_SECRET || "change_this_to_a_long_random_string",
      { expiresIn: "5m" }
    );

    // Send the email containing the code
    await emailService.sendMail({
      to: email,
      subject: "Your Password Reset OTP - Zera Edu",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #eee; border-radius: 8px;">
          <h2 style="color: #4f46e5; text-align: center;">Reset Your Password</h2>
          <p>Dear ${user.name},</p>
          <p>Please use the following One-Time Password (OTP) to reset your password. This OTP is valid for 5 minutes.</p>
          <div style="font-size: 32px; font-weight: bold; text-align: center; letter-spacing: 5px; color: #111827; padding: 15px; margin: 20px 0; background-color: #f3f4f6; border-radius: 6px;">
            ${otp}
          </div>
          <p style="font-size: 12px; color: #6b7280;">If you did not request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    return res.json({
      success: true,
      message: "OTP sent to your email",
      otpToken,
    });
  })
);

// ── POST /api/auth/verify-otp ────────────────────────────────────────────────
router.post(
  "/verify-otp",
  validate(verifyOtpRules),
  asyncHandler(async (req, res, next) => {
    const { email, otp, otpToken } = req.body;

    try {
      // Decode and verify the otpToken
      const decoded = jwt.verify(otpToken, process.env.JWT_SECRET || "change_this_to_a_long_random_string");
      if (decoded.email !== email) {
        return next(new AppError("Invalid OTP token", 400));
      }

      const users = await query("SELECT id, reset_otp, reset_otp_expires FROM users WHERE email = ? AND deleted_at IS NULL", [email]);
      if (users.length === 0) {
        return next(new AppError("User not found", 404));
      }

      const user = users[0];
      if (!user.reset_otp || user.reset_otp !== otp) {
        return next(new AppError("Invalid OTP code", 400));
      }

      const expiresAt = new Date(user.reset_otp_expires);
      if (expiresAt < new Date()) {
        return next(new AppError("OTP has expired. Please request a new one.", 400));
      }

      // Clear OTP details on verification success
      await query("UPDATE users SET reset_otp = NULL, reset_otp_expires = NULL WHERE id = ?", [user.id]);

      // Generate password reset token
      const resetToken = jwt.sign(
        { email, verified: true },
        process.env.JWT_SECRET || "change_this_to_a_long_random_string",
        { expiresIn: "10m" }
      );

      return res.json({
        success: true,
        message: "OTP verified successfully",
        resetToken,
      });
    } catch (err) {
      return next(new AppError("OTP has expired or is invalid. Please request a new one.", 400));
    }
  })
);

// ── POST /api/auth/reset-password-otp ────────────────────────────────────────
router.post(
  "/reset-password-otp",
  validate(resetPasswordRules),
  asyncHandler(async (req, res, next) => {
    const { email, resetToken, newPassword } = req.body;

    try {
      const decoded = jwt.verify(resetToken, process.env.JWT_SECRET || "change_this_to_a_long_random_string");
      if (decoded.email !== email || !decoded.verified) {
        return next(new AppError("Invalid reset session", 400));
      }

      const users = await query("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", [email]);
      if (users.length === 0) {
        return next(new AppError("User not found", 404));
      }

      const user = users[0];

      // Hash and update password
      const hash = await authService.hashPassword(newPassword);
      await query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, user.id]);

      // Log to audit logger
      await logAudit("user", user.id, "password_reset", user.id, null, { email });

      return res.json({
        success: true,
        message: "Password updated successfully"
      });
    } catch (err) {
      return next(new AppError("Reset session has expired. Please start over.", 400));
    }
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

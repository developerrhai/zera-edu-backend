const express = require("express");
const { query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// ── GET /api/referrals ─────────────────────────────────────────────────────────
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    // 1. Get the current user's referral code
    const users = await query(
      "SELECT referral_code FROM users WHERE id = ? AND deleted_at IS NULL",
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    const referralCode = users[0].referral_code;

    // 2. Get all users who were referred by this user
    const referredUsers = await query(
      "SELECT name, created_at, role, public_id FROM users WHERE referred_by = ? AND deleted_at IS NULL ORDER BY created_at DESC",
      [req.user.id]
    );

    return res.json({
      success: true,
      data: {
        referralCode,
        referredUsers: referredUsers.map(u => ({
          id: u.public_id,
          name: u.name,
          role: u.role,
          createdAt: u.created_at,
          status: "Registered"
        }))
      }
    });
  })
);

module.exports = router;

const express = require("express");
const { query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const { body } = require("express-validator");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const router = express.Router();

const slotRules = [
  body("day").trim().notEmpty().withMessage("Day is required"),
  body("timeWindow").trim().notEmpty().withMessage("Time window is required (e.g. 04:00 PM - 06:00 PM)"),
  body("location").isIn(["Online Virtual", "Offline Center"]).withMessage("Location must be Online Virtual or Offline Center"),
];

// Helper to check and retrieve the profile matching the authenticated teacher
async function getTeacherProfile(userId, next) {
  const profiles = await query("SELECT id FROM teacher_profiles WHERE user_id = ?", [userId]);
  if (profiles.length === 0) {
    throw new AppError("Teacher profile record missing for your account credentials.", 404);
  }
  return profiles[0].id;
}

// ── GET /api/slots ───────────────────────────────────────────────────────────
router.get(
  "/",
  authenticate,
  authorize(["teacher"]),
  asyncHandler(async (req, res, next) => {
    const profileId = await getTeacherProfile(req.user.id, next);
    const slots = await query("SELECT * FROM teacher_slots WHERE teacher_profile_id = ?", [profileId]);

    return res.json({
      success: true,
      slots,
    });
  })
);

// ── POST /api/slots ──────────────────────────────────────────────────────────
router.post(
  "/",
  authenticate,
  authorize(["teacher"]),
  validate(slotRules),
  asyncHandler(async (req, res, next) => {
    const profileId = await getTeacherProfile(req.user.id, next);
    const { day, timeWindow, location } = req.body;

    const result = await query(
      "INSERT INTO teacher_slots (teacher_profile_id, day, time_window, location, is_booked) VALUES (?, ?, ?, ?, 0)",
      [profileId, day, timeWindow, location]
    );

    // Clear filters search cache
    const teachersRouter = require("./teachers");
    if (teachersRouter.localCache) {
      teachersRouter.localCache.clear();
    }

    return res.status(201).json({
      success: true,
      slot: {
        id: result.insertId,
        teacher_profile_id: profileId,
        day,
        time_window: timeWindow,
        location,
        is_booked: 0,
      },
    });
  })
);

// ── DELETE /api/slots/:id ────────────────────────────────────────────────────
router.delete(
  "/:id",
  authenticate,
  authorize(["teacher"]),
  asyncHandler(async (req, res, next) => {
    const profileId = await getTeacherProfile(req.user.id, next);
    const slotId = Number(req.params.id);

    // Ensure slot exists and belongs to teacher
    const slots = await query("SELECT is_booked FROM teacher_slots WHERE id = ? AND teacher_profile_id = ?", [slotId, profileId]);
    if (slots.length === 0) {
      return next(new AppError("Slot not found or unauthorized deletion attempt.", 404));
    }

    if (slots[0].is_booked) {
      return next(new AppError("Cannot remove a slot that is already booked.", 400));
    }

    await query("DELETE FROM teacher_slots WHERE id = ?", [slotId]);

    // Clear filters search cache
    const teachersRouter = require("./teachers");
    if (teachersRouter.localCache) {
      teachersRouter.localCache.clear();
    }

    return res.json({
      success: true,
      message: "Availability slot purged.",
    });
  })
);

module.exports = router;

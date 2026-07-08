const express = require("express");
const { query } = require("../config/db");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const { body } = require("express-validator");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const logger = require("../utils/logger");

const router = express.Router();

// Cache storage stub (in-memory for robust caching out of the box)
const localCache = new Map();

// ── GET /api/teachers (Directory listing & searching) ──────────────────────────
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const {
      subject,
      standard,
      board,
      timingGroup,
      location,
      minCost,
      maxCost,
      minExp,
      limit = 20,
      offset = 0,
    } = req.query;

    // Create unique cache key for current filter criteria
    const cacheKey = JSON.stringify({
      subject, standard, board, timingGroup, location, minCost, maxCost, minExp, limit, offset
    });

    if (localCache.has(cacheKey)) {
      logger.debug("Cache hit for teacher directory filters: %s", cacheKey);
      return res.json(localCache.get(cacheKey));
    }

    let sql = `
      SELECT tp.*, u.name, u.email, u.avatar_url
      FROM teacher_profiles tp
      JOIN users u ON tp.user_id = u.id
      WHERE tp.is_verified = 1 AND u.is_active = 1
    `;
    const params = [];

    if (subject) {
      sql += " AND tp.subject LIKE ?";
      params.push(`%${subject}%`);
    }
    if (standard) {
      sql += " AND tp.standard = ?";
      params.push(standard);
    }
    if (board) {
      sql += " AND tp.board LIKE ?";
      params.push(`%${board}%`);
    }
    if (timingGroup) {
      sql += " AND tp.timing_group = ?";
      params.push(timingGroup);
    }
    if (minCost) {
      sql += " AND tp.cost_per_hour >= ?";
      params.push(Number(minCost));
    }
    if (maxCost) {
      sql += " AND tp.cost_per_hour <= ?";
      params.push(Number(maxCost));
    }
    if (minExp) {
      sql += " AND tp.experience_years >= ?";
      params.push(Number(minExp));
    }

    sql += " ORDER BY tp.rating DESC, u.name ASC LIMIT ? OFFSET ?";
    params.push(Number(limit), Number(offset));

    const rows = await query(sql, params);

    // Fetch available slots for each teacher to render on Discovery Grid
    const teachers = [];
    for (const row of rows) {
      const slots = await query(
        "SELECT id, day, time_window, location FROM teacher_slots WHERE teacher_profile_id = ? AND is_booked = 0",
        [row.id]
      );
      teachers.push({
        id: "T" + row.id, // match front-end "T1" formatting
        profileId: row.id,
        userId: row.user_id,
        name: row.name,
        subject: row.subject,
        board: row.board,
        standard: row.standard,
        timingGroup: row.timing_group,
        mapRadiusKm: row.map_radius_km,
        youtubeUrl: row.youtube_url,
        cost: Number(row.cost_per_hour),
        expYears: row.experience_years,
        stars: Math.round(row.rating),
        degree: row.degree,
        avatarUrl: row.avatar_url || "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80",
        slots,
      });
    }

    // Filter by location in Javascript if specified
    let filteredTeachers = teachers;
    if (location) {
      filteredTeachers = teachers.filter((t) =>
        t.slots.some((s) => s.location.toLowerCase() === location.toLowerCase())
      );
    }

    const payload = { success: true, teachers: filteredTeachers };
    localCache.set(cacheKey, payload);

    return res.json(payload);
  })
);

// ── GET /api/teachers/:id (Single profile detail) ─────────────────────────────
router.get(
  "/:id",
  asyncHandler(async (req, res, next) => {
    // Strip T identifier prefix if supplied by front-end
    const profileIdStr = req.params.id.replace("T", "");
    const profileId = Number(profileIdStr);

    const profiles = await query(
      `SELECT tp.*, u.name, u.email, u.avatar_url
       FROM teacher_profiles tp
       JOIN users u ON tp.user_id = u.id
       WHERE tp.id = ?`,
      [profileId]
    );

    if (profiles.length === 0) {
      return next(new AppError("Teacher profile not found.", 404));
    }

    const row = profiles[0];
    const slots = await query(
      "SELECT id, day, time_window, location FROM teacher_slots WHERE teacher_profile_id = ? AND is_booked = 0",
      [row.id]
    );

    return res.json({
      success: true,
      teacher: {
        id: "T" + row.id,
        profileId: row.id,
        userId: row.user_id,
        name: row.name,
        subject: row.subject,
        board: row.board,
        standard: row.standard,
        timingGroup: row.timing_group,
        mapRadiusKm: row.map_radius_km,
        youtubeUrl: row.youtube_url,
        cost: Number(row.cost_per_hour),
        expYears: row.experience_years,
        stars: Math.round(row.rating),
        degree: row.degree,
        avatarUrl: row.avatar_url,
        slots,
      },
    });
  })
);

// ── PUT /api/teachers/:id (Profile update - restricts to owner or admin) ─────
router.put(
  "/:id",
  authenticate,
  authorize(["teacher", "admin"]),
  asyncHandler(async (req, res, next) => {
    const profileIdStr = req.params.id.replace("T", "");
    const profileId = Number(profileIdStr);

    const profiles = await query("SELECT * FROM teacher_profiles WHERE id = ?", [profileId]);
    if (profiles.length === 0) {
      return next(new AppError("Profile not found.", 404));
    }

    const profile = profiles[0];

    // Ensure user edits their own profile
    if (req.user.role !== "admin" && profile.user_id !== req.user.id) {
      return next(new AppError("Unauthorized profile modification attempt.", 403));
    }

    const {
      subject,
      board,
      standard,
      timingGroup,
      mapRadiusKm,
      youtubeUrl,
      cost,
      expYears,
      degree,
    } = req.body;

    await query(
      `UPDATE teacher_profiles SET
         subject = COALESCE(?, subject),
         board = COALESCE(?, board),
         standard = COALESCE(?, standard),
         timing_group = COALESCE(?, timing_group),
         map_radius_km = COALESCE(?, map_radius_km),
         youtube_url = COALESCE(?, youtube_url),
         cost_per_hour = COALESCE(?, cost_per_hour),
         experience_years = COALESCE(?, experience_years),
         degree = COALESCE(?, degree)
       WHERE id = ?`,
      [
        subject || null,
        board || null,
        standard || null,
        timingGroup || null,
        mapRadiusKm ? Number(mapRadiusKm) : null,
        youtubeUrl || null,
        cost ? Number(cost) : null,
        expYears ? Number(expYears) : null,
        degree || null,
        profileId,
      ]
    );

    // Invalidate directory cache
    localCache.clear();

    const [updated] = await query("SELECT * FROM teacher_profiles WHERE id = ?", [profileId]);
    return res.json({
      success: true,
      profile: updated,
    });
  })
);

module.exports = router;


const express = require("express");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const asyncHandler = require("../utils/asyncHandler");
const notificationService = require("../services/notificationService");

const router = express.Router();

/**
 * @route   POST /api/notifications/register-token
 * @desc    Register a device token for push notifications
 * @access  Private (Any authenticated user)
 */
router.post(
  "/register-token",
  authenticate,
  asyncHandler(async (req, res) => {
    const { token, deviceType } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: "Token is required." });
    }
    
    await notificationService.registerToken(req.user.id, token, deviceType);
    
    res.json({
      success: true,
      message: "Device token registered successfully."
    });
  })
);

/**
 * @route   POST /api/notifications/send-single
 * @desc    Send notification to a single user
 * @access  Private (Admin only)
 */
router.post(
  "/send-single",
  authenticate,
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const { userId, title, body, data } = req.body;
    
    if (!userId || !title || !body) {
      return res.status(400).json({ success: false, message: "userId, title, and body are required." });
    }
    
    const result = await notificationService.sendToUser(userId, title, body, req.user.id, data || {});
    
    res.json({
      success: true,
      message: "Notification pushed.",
      result
    });
  })
);

/**
 * @route   POST /api/notifications/send-bulk
 * @desc    Send notification to all active students
 * @access  Private (Admin only)
 */
router.post(
  "/send-bulk",
  authenticate,
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const { title, body, data } = req.body;
    
    if (!title || !body) {
      return res.status(400).json({ success: false, message: "title and body are required." });
    }
    
    const result = await notificationService.sendBulkToStudents(title, body, req.user.id, data || {});
    
    res.json({
      success: true,
      message: "Bulk notification pushed.",
      result
    });
  })
);

/**
 * @route   POST /api/notifications/send-filtered
 * @desc    Send notification based on filters (e.g. specific userIds)
 * @access  Private (Admin only)
 */
router.post(
  "/send-filtered",
  authenticate,
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const { filters, title, body, data } = req.body;
    
    if (!filters || !title || !body) {
      return res.status(400).json({ success: false, message: "filters, title, and body are required." });
    }
    
    const result = await notificationService.sendFiltered(title, body, filters, req.user.id, data || {});
    
    res.json({
      success: true,
      message: "Filtered notification pushed.",
      result
    });
  })
);

/**
 * @route   GET /api/notifications/history
 * @desc    Get notification history
 * @access  Private (Admin only)
 */
router.get(
  "/history",
  authenticate,
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    
    const history = await notificationService.getHistory(limit, offset);
    
    res.json({
      success: true,
      data: history.data,
      total: history.total,
      limit,
      offset
    });
  })
);

module.exports = router;

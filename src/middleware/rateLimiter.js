const rateLimit = require("express-rate-limit");
const AppError = require("../utils/AppError");

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new AppError("Too many requests from this IP context. Please try again after 15 minutes.", 429));
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit authentication requests to 15 per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new AppError("Too many authentication attempts. Please slow down and try again in 15 minutes.", 429));
  },
});

module.exports = {
  globalLimiter,
  authLimiter,
};

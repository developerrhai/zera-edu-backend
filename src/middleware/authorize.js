const AppError = require("../utils/AppError");

/**
 * Middleware to restrict route execution to specific system roles.
 * @param {string[]} roles - Array of allowed roles (e.g. ['admin', 'teacher'])
 */
module.exports = (roles = []) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError("User identity unknown context.", 500));
    }

    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return next(
        new AppError(
          "Access Denied. You do not possess adequate clearance to perform this action.",
          403
        )
      );
    }

    return next();
  };
};

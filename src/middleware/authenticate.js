const { verifyAccessToken } = require("../services/authService");
const { query } = require("../config/db");
const AppError = require("../utils/AppError");

/**
 * Middleware to authenticate requests via JWT access token.
 */
module.exports = async (req, _res, next) => {
  try {
    let token = null;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return next(new AppError("Access denied. No credentials supplied.", 401));
    }

    // Verify token structure and validity
    const decoded = verifyAccessToken(token);

    // Verify user exists and is active in database
    const users = await query("SELECT id, email, name, role, is_active FROM users WHERE id = ?", [decoded.id]);
    if (users.length === 0) {
      return next(new AppError("Session holder no longer exists.", 401));
    }

    const user = users[0];
    if (!user.is_active) {
      return next(new AppError("Your account credentials have been suspended.", 403));
    }

    // Attach verified user properties to request context
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };

    return next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return next(new AppError("Session token has expired. Please refresh your credentials.", 401));
    }
    return next(new AppError("Invalid session credentials.", 401));
  }
};

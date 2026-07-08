/**
 * AppError class for operational error handling.
 * Extends default JS Error to include HTTP statusCode and isOperational flag.
 */
class AppError extends Error {
  /**
   * @param {string} message - Error description message
   * @param {number} statusCode - HTTP status code (e.g. 400, 401, 403, 404, 500)
   */
  constructor(message, statusCode) {
    super(message);

    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith("4") ? "fail" : "error";
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;

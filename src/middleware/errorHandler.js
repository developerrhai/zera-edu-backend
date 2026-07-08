const logger = require("../utils/logger");

/**
 * Handle database connection/query failures.
 */
function handleDBError(err) {
  logger.error("Database Error: %o", err);
  return {
    statusCode: 500,
    message: "A database error occurred. Please try again later.",
  };
}

/**
 * Handle unique constraint/duplicate entry errors.
 */
function handleDuplicateEntryError(err) {
  const match = err.message.match(/entry '([^']+)' for key/i);
  const val = match ? match[1] : "value";
  return {
    statusCode: 409,
    message: `Duplicate entry error: The resource containing '${val}' already exists.`,
  };
}

/**
 * Handle JWT validation/expired token errors.
 */
function handleJWTError() {
  return {
    statusCode: 401,
    message: "Invalid session credentials. Please sign in again.",
  };
}

function handleJWTExpiredError() {
  return {
    statusCode: 401,
    message: "Session token has expired. Please refresh your credentials.",
  };
}

/**
 * Global Error Handler Middleware
 */
module.exports = (err, req, res, _next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  let clientError = {
    statusCode: err.statusCode,
    message: err.message || "Internal server error",
  };

  // Map database/JWT specific errors to friendly client messages
  if (err.code === "ER_DUP_ENTRY") {
    clientError = handleDuplicateEntryError(err);
  } else if (err.code && err.code.startsWith("ER_")) {
    clientError = handleDBError(err);
  } else if (err.name === "JsonWebTokenError") {
    clientError = handleJWTError();
  } else if (err.name === "TokenExpiredError") {
    clientError = handleJWTExpiredError();
  }

  // Log all internal server errors or operational failures
  if (clientError.statusCode === 500) {
    logger.error(`[Server Error 500] URL: ${req.method} ${req.url} - Error: %o`, err);
  } else {
    logger.warn(`[Client Warn ${clientError.statusCode}] URL: ${req.method} ${req.url} - Message: ${clientError.message}`);
  }

  // Expose stack trace only in development
  const responsePayload = {
    success: false,
    error: clientError.message,
  };

  if (process.env.NODE_ENV === "development") {
    responsePayload.stack = err.stack;
    responsePayload.rawError = err;
  }

  return res.status(clientError.statusCode).json(responsePayload);
};

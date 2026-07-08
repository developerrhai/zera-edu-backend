const { validationResult } = require("express-validator");
const AppError = require("../utils/AppError");

/**
 * Validates request schema parameters.
 * If validation fails, passes express-validator issues to global error handler.
 */
module.exports = (validations) => {
  return async (req, res, next) => {
    // Run all validations in sequence
    for (let validation of validations) {
      await validation.run(req);
    }

    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }

    const firstError = errors.array()[0];
    const validationMessage = `${firstError.path}: ${firstError.msg}`;

    return res.status(400).json({
      success: false,
      error: validationMessage,
      details: errors.array(),
    });
  };
};

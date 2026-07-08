const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const AppError = require("../utils/AppError");

const JWT_SECRET = process.env.JWT_SECRET || "zera_secret_access_key_12345";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "zera_secret_refresh_key_67890";
const ACCESS_EXP = process.env.JWT_ACCESS_EXPIRATION || "15m";
const REFRESH_EXP = process.env.JWT_REFRESH_EXPIRATION || "7d";

/**
 * Generate Access Token
 * @param {object} payload - { id, email, role }
 */
function generateAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_EXP });
}

/**
 * Generate Refresh Token
 * @param {object} payload - { id, email, role }
 */
function generateRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_EXP });
}

/**
 * Verify Access Token
 * @param {string} token
 */
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    throw err;
  }
}

/**
 * Verify Refresh Token
 * @param {string} token
 */
function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch (err) {
    throw err;
  }
}

/**
 * Hash password
 * @param {string} password
 */
async function hashPassword(password) {
  return await bcrypt.hash(password, 12);
}

/**
 * Compare password with hash
 * @param {string} password
 * @param {string} hash
 */
async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashPassword,
  comparePassword,
};

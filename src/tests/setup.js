process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test_access_secret_key";
process.env.JWT_REFRESH_SECRET = "test_refresh_secret_key";
process.env.PORT = "5999";

// Silence logs during tests
const logger = require("../utils/logger");
logger.transports.forEach((t) => {
  t.silent = true;
});

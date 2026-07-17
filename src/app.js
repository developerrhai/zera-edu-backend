require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const path = require("path");

const { initDb } = require("./config/db");
const { globalLimiter } = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/errorHandler");
const logger = require("./utils/logger");

// ─── Route Declarations ──────────────────────────────────────────────────────
const authRouter = require("./routes/auth");
const teachersRouter = require("./routes/teachers");
const slotsRouter = require("./routes/slots");
const bookingsRouter = require("./routes/bookings");
const enquiriesRouter = require("./routes/enquiries");
const paymentsRouter = require("./routes/payments");
const adminRouter = require("./routes/admin");
const attendanceRouter = require("./routes/attendance");
const subscriptionsRouter = require("./routes/subscriptions");
const inquiriesRouter = require("./routes/inquiries");


const app = express();
const PORT = process.env.PORT || 5000;

// ─── Security & Performance Middleware ───────────────────────────────────────
app.use(helmet());
app.use(compression());

// CORS config supporting multiple whitelisted origins
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:5500,http://127.0.0.1:5500,https://zera-edu-frontend.vercel.app")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""));

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      const normalizedOrigin = origin.replace(/\/$/, "");
      if (allowedOrigins.indexOf(normalizedOrigin) === -1) {
        const msg = "CORS policy restriction. Origin unauthorized.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// Payload size limit constraints
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Rate limiting application
app.use("/api", globalLimiter);

// Custom Morgan transport formatting logs via Winston
const morganFormat = process.env.NODE_ENV === "production" ? "combined" : "dev";
app.use(
  morgan(morganFormat, {
    stream: {
      write: (message) => logger.info(message.trim()),
    },
  })
);

// Serve static directory if needed (e.g. upload folder if uploaded files implemented)
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "ZERA EDU Platform Core Backend API",
    time: new Date().toISOString(),
  });
});

// ─── API Routes Mounting ──────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/teachers", teachersRouter);
app.use("/api/slots", slotsRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/enquiries", enquiriesRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/attendance", attendanceRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/v1/inquiries", inquiriesRouter);


// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    error: `Resource not found at endpoint: ${req.method} ${req.url}`,
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Boot Server ──────────────────────────────────────────────────────────────
async function start() {
  try {
    // Connect to database and seed baseline records
    await initDb();

    app.listen(PORT, () => {
      console.log("─────────────────────────────────────────────────────────────");
      console.log(`  ZERA EDU Backend Running on port http://localhost:${PORT}`);
      console.log("─────────────────────────────────────────────────────────────");
      console.log(`  Health:      GET  http://localhost:${PORT}/api/health`);
      console.log(`  Auth:        POST http://localhost:${PORT}/api/auth/login`);
      console.log(`  Teachers:    GET  http://localhost:${PORT}/api/teachers`);
      console.log("─────────────────────────────────────────────────────────────");
    });
  } catch (err) {
    logger.error("[Boot Error] Failed to initialize server bootstrap process: %o", err);
    process.exit(1);
  }
}

// Export for integration testing
if (process.env.NODE_ENV !== "test") {
  start();
}

module.exports = app;

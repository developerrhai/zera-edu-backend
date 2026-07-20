const request = require("supertest");
const app = require("../app");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

jest.mock("../config/db", () => {
  const original = jest.requireActual("../config/db");
  return {
    ...original,
    query: jest.fn(),
  };
});

describe("Class Sessions OTP REST Endpoints", () => {
  let studentToken;
  let teacherToken;

  beforeAll(() => {
    studentToken = jwt.sign(
      { id: 10, email: "student@test.com", role: "student" },
      process.env.JWT_SECRET || "test_secret",
      { expiresIn: "1h" }
    );
    teacherToken = jwt.sign(
      { id: 20, email: "teacher@test.com", role: "teacher" },
      process.env.JWT_SECRET || "test_secret",
      { expiresIn: "1h" }
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/attendance/class-sessions/generate-checkin", () => {
    it("should generate a check-in OTP for an authorized student", async () => {
      // 1. Authenticate user lookup mock
      db.query.mockResolvedValueOnce([
        { id: 10, email: "student@test.com", name: "Test Student", role: "student", is_active: 1, public_id: "STUDENT10" }
      ]);
      // 2. Teacher existence check mock
      db.query.mockResolvedValueOnce([
        { id: 20, name: "Test Teacher" }
      ]);
      // 3. Invalidate previous scheduled sessions mock
      db.query.mockResolvedValueOnce({ affectedRows: 0 });
      // 4. In progress sessions check mock
      db.query.mockResolvedValueOnce([]);
      // 5. Duplicate completed lectures check mock
      db.query.mockResolvedValueOnce([]);
      // 6. Insertion check mock
      db.query.mockResolvedValueOnce({ insertId: 100 });

      const res = await request(app)
        .post("/api/attendance/class-sessions/generate-checkin")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ subject: "Mathematics", teacherId: "20", lectureNumber: 1 });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.otp).toHaveLength(6);
      expect(res.body.sessionId).toBeDefined();
    });
  });

  describe("POST /api/attendance/class-sessions/verify-checkin", () => {
    it("should allow a teacher to verify student check-in OTP", async () => {
      // 1. Authenticate user lookup mock (teacher)
      db.query.mockResolvedValueOnce([
        { id: 20, email: "teacher@test.com", name: "Test Teacher", role: "teacher", is_active: 1, public_id: "TEACHER20" }
      ]);
      // 2. Fetch session details mock
      // We need a hashed OTP to compare. Let's bcrypt hash "123456"
      const bcrypt = require("bcryptjs");
      const hashedOtp = await bcrypt.hash("123456", 10);
      db.query.mockResolvedValueOnce([
        {
          id: 100,
          public_id: "SESS100",
          student_id: 10,
          teacher_id: 20,
          status: "scheduled",
          checkin_otp_hash: hashedOtp,
          checkin_otp_expiry: new Date(Date.now() + 100000).toISOString(),
          checkin_blocked_until: null,
          checkin_failed_attempts: 0
        }
      ]);
      // 3. Update session status mock
      db.query.mockResolvedValueOnce({ affectedRows: 1 });

      const res = await request(app)
        .post("/api/attendance/class-sessions/verify-checkin")
        .set("Authorization", `Bearer ${teacherToken}`)
        .send({ sessionId: "SESS100", otp: "123456" });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe("in-progress");
    });
  });
});

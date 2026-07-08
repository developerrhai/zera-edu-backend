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

describe("Attendance Log REST Endpoints", () => {
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

  describe("GET /api/attendance", () => {
    it("should return attendance list for student user", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 10, email: "student@test.com", name: "Test Student", role: "student", is_active: 1 }
      ]);
      // 2. Attendance query execution
      db.query.mockResolvedValueOnce([
        {
          id: 1,
          student_id: 10,
          booking_id: 5,
          date: "2026-07-08",
          status: "Present",
          remarks: "All good",
          student_name: "Test Student",
          teacher_name: "Test Teacher",
        },
      ]);

      const res = await request(app)
        .get("/api/attendance")
        .set("Authorization", `Bearer ${studentToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.attendance).toHaveLength(1);
      expect(res.body.attendance[0].status).toBe("Present");
    });
  });

  describe("POST /api/attendance", () => {
    it("should log student attendance by authorized teacher", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 20, email: "teacher@test.com", name: "Test Teacher", role: "teacher", is_active: 1 }
      ]);
      // 2. Booking query validation
      db.query.mockResolvedValueOnce([{ student_id: 10, teacher_profile_id: 2 }]);
      // 3. Teacher profile check
      db.query.mockResolvedValueOnce([{ id: 2 }]);
      // 4. Insert execution response
      db.query.mockResolvedValueOnce({ insertId: 1 });
      // 5. Select newly inserted record
      db.query.mockResolvedValueOnce([
        {
          id: 1,
          student_id: 10,
          booking_id: 5,
          date: "2026-07-08",
          status: "Present",
          remarks: "Excellent",
          student_name: "Test Student",
          teacher_name: "Test Teacher",
        },
      ]);

      const res = await request(app)
        .post("/api/attendance")
        .set("Authorization", `Bearer ${teacherToken}`)
        .send({ bookingId: 5, date: "2026-07-08", status: "Present", remarks: "Excellent" });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.attendance.remarks).toBe("Excellent");
    });
  });
});

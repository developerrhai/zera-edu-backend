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

describe("Teacher Profiles REST Endpoints", () => {
  let adminToken;
  let teacherToken;
  let anotherTeacherToken;
  const jwtSecret = process.env.JWT_SECRET || "test_secret";

  beforeAll(() => {
    adminToken = jwt.sign(
      { id: 1, email: "admin@test.com", role: "admin" },
      jwtSecret,
      { expiresIn: "1h" }
    );
    teacherToken = jwt.sign(
      { id: 2, email: "teacher@test.com", role: "teacher" },
      jwtSecret,
      { expiresIn: "1h" }
    );
    anotherTeacherToken = jwt.sign(
      { id: 3, email: "other@test.com", role: "teacher" },
      jwtSecret,
      { expiresIn: "1h" }
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/teachers", () => {
    it("should return a list of verified active teachers", async () => {
      // Mock db.query return for teachers list
      db.query.mockResolvedValueOnce([
        {
          id: 1,
          public_id: "teach1ulid",
          user_id: 2,
          subject: "Mathematics",
          board: "CBSE",
          standard: "Class 10",
          timing_group: "Evening",
          map_radius_km: 5,
          youtube_url: "",
          cost_per_hour: 500,
          experience_years: 5,
          rating: 4.5,
          degree: "B.Ed",
          avatar_url: "",
          name: "Teacher One",
          email: "teacher@test.com",
          user_public_id: "user2ulid"
        }
      ]);

      // Mock db.query return for slots query
      db.query.mockResolvedValueOnce([
        {
          public_id: "slot1ulid",
          day: "Monday",
          time_window: "10am-12pm",
          location: "Online Virtual"
        }
      ]);

      const res = await request(app).get("/api/teachers");

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.teachers).toHaveLength(1);
      expect(res.body.teachers[0].name).toBe("Teacher One");
      expect(res.body.teachers[0].slots).toHaveLength(1);
    });
  });

  describe("GET /api/teachers/:id", () => {
    it("should return 404 if profile does not exist", async () => {
      db.query.mockResolvedValueOnce([]);

      const res = await request(app).get("/api/teachers/Tnonexistent");
      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("should return teacher profile details", async () => {
      db.query.mockResolvedValueOnce([
        {
          id: 1,
          public_id: "teach1ulid",
          user_id: 2,
          subject: "Mathematics",
          board: "CBSE",
          standard: "Class 10",
          timing_group: "Evening",
          map_radius_km: 5,
          youtube_url: "",
          cost_per_hour: 500,
          experience_years: 5,
          rating: 4.5,
          degree: "B.Ed",
          avatar_url: "",
          name: "Teacher One",
          email: "teacher@test.com",
          user_public_id: "user2ulid"
        }
      ]);

      db.query.mockResolvedValueOnce([
        {
          public_id: "slot1ulid",
          day: "Monday",
          time_window: "10am-12pm",
          location: "Online Virtual"
        }
      ]);

      const res = await request(app).get("/api/teachers/Tteach1ulid");

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.teacher.name).toBe("Teacher One");
      expect(res.body.teacher.slots).toHaveLength(1);
    });
  });

  describe("PUT /api/teachers/:id", () => {
    it("should reject unauthorized edit attempts from another teacher", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 3, role: "teacher", email: "other@test.com", is_active: 1 }
      ]);
      // 2. Fetch profile to check ownership
      db.query.mockResolvedValueOnce([
        { id: 1, public_id: "teach1ulid", user_id: 2 } // owned by user id 2
      ]);

      const res = await request(app)
        .put("/api/teachers/Tteach1ulid")
        .set("Authorization", `Bearer ${anotherTeacherToken}`)
        .send({ subject: "Physics" });

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("should allow editing of own profile", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 2, role: "teacher", email: "teacher@test.com", is_active: 1 }
      ]);
      // 2. Fetch profile to check ownership
      db.query.mockResolvedValueOnce([
        { id: 1, public_id: "teach1ulid", user_id: 2 }
      ]);
      // 3. Update query return
      db.query.mockResolvedValueOnce({ affectedRows: 1 });
      // 4. Fetch updated profile
      db.query.mockResolvedValueOnce([
        {
          id: 1,
          public_id: "teach1ulid",
          user_id: 2,
          subject: "Physics",
          board: "CBSE",
          standard: "Class 10",
          timing_group: "Evening",
          map_radius_km: 5,
          youtube_url: "",
          cost_per_hour: 600,
          experience_years: 5,
          rating: 4.5,
          degree: "B.Ed",
          avatar_url: ""
        }
      ]);
      // 5. Audit logger call return
      db.query.mockResolvedValueOnce({ affectedRows: 1 });

      const res = await request(app)
        .put("/api/teachers/Tteach1ulid")
        .set("Authorization", `Bearer ${teacherToken}`)
        .send({ subject: "Physics", cost: 600 });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.profile.subject).toBe("Physics");
    });
  });
});

const request = require("supertest");
const app = require("../app");
const db = require("../config/db");
const bcrypt = require("bcryptjs");

jest.mock("../config/db", () => {
  const original = jest.requireActual("../config/db");
  return {
    ...original,
    query: jest.fn(),
    initDb: jest.fn(),
  };
});

describe("Authentication Endpoint Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/auth/login", () => {
    it("should authenticate active user with correct credentials", async () => {
      const hashedPw = await bcrypt.hash("password123", 12);
      db.query.mockResolvedValueOnce([
        {
          id: 45,
          email: "student@zeraedu.com",
          password_hash: hashedPw,
          name: "Test Student",
          role: "student",
          is_active: 1,
        },
      ]);
      db.query.mockResolvedValueOnce([]); // refresh token update mock

      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "student@zeraedu.com", password: "password123" });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty("accessToken");
      expect(res.body).toHaveProperty("refreshToken");
      expect(res.body.user.email).toBe("student@zeraedu.com");
    });

    it("should return 401 for incorrect credentials", async () => {
      db.query.mockResolvedValueOnce([]); // no user found

      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "wrong@zeraedu.com", password: "password123" });

      expect(res.statusCode).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Invalid email or password");
    });
  });
});

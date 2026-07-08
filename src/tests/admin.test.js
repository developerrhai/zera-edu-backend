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

describe("Admin Dashboard REST Endpoints", () => {
  let adminToken;
  let nonAdminToken;

  beforeAll(() => {
    adminToken = jwt.sign(
      { id: 1, email: "admin@test.com", role: "admin" },
      process.env.JWT_SECRET || "test_secret",
      { expiresIn: "1h" }
    );
    nonAdminToken = jwt.sign(
      { id: 10, email: "student@test.com", role: "student" },
      process.env.JWT_SECRET || "test_secret",
      { expiresIn: "1h" }
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/admin/users", () => {
    it("should reject unauthorized requests without token", async () => {
      const res = await request(app).get("/api/admin/users");
      expect(res.statusCode).toBe(401);
    });

    it("should reject non-admin roles", async () => {
      // Auth middleware user check
      db.query.mockResolvedValueOnce([
        { id: 10, email: "student@test.com", role: "student", is_active: 1 }
      ]);
      const res = await request(app)
        .get("/api/admin/users")
        .set("Authorization", `Bearer ${nonAdminToken}`);
      expect(res.statusCode).toBe(403);
    });

    it("should return list of users for authenticated admin", async () => {
      // Auth check
      db.query.mockResolvedValueOnce([
        { id: 1, email: "admin@test.com", role: "admin", is_active: 1 }
      ]);
      // Users retrieval check
      db.query.mockResolvedValueOnce([
        { id: 1, email: "admin@test.com", name: "System Admin", role: "admin", is_active: 1, created_at: "2026-07-08" },
        { id: 10, email: "student@test.com", name: "Kabir Mehta", role: "student", is_active: 1, created_at: "2026-07-08" }
      ]);

      const res = await request(app)
        .get("/api/admin/users")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.users).toHaveLength(2);
      expect(res.body.users[0].name).toBe("System Admin");
    });
  });

  describe("PUT /api/admin/users/:id", () => {
    it("should update user role and status flag", async () => {
      // Auth check
      db.query.mockResolvedValueOnce([
        { id: 1, email: "admin@test.com", role: "admin", is_active: 1 }
      ]);
      // User existence check
      db.query.mockResolvedValueOnce([
        { id: 10, email: "student@test.com", name: "Kabir Mehta", role: "student", is_active: 1 }
      ]);
      // Update execution check
      db.query.mockResolvedValueOnce({ affectedRows: 1 });

      const res = await request(app)
        .put("/api/admin/users/10")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ role: "admin", isActive: false });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("state synced");
    });
  });

  describe("DELETE /api/admin/users/:id", () => {
    it("should deactivate user account successfully", async () => {
      // Auth check
      db.query.mockResolvedValueOnce([
        { id: 1, email: "admin@test.com", role: "admin", is_active: 1 }
      ]);
      // Update check
      db.query.mockResolvedValueOnce({ affectedRows: 1 });

      const res = await request(app)
        .delete("/api/admin/users/10")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("deactivated");
    });
  });

  describe("GET /api/admin/subscriptions/overview", () => {
    it("should retrieve lists of active user subscriptions", async () => {
      // Auth check
      db.query.mockResolvedValueOnce([
        { id: 1, email: "admin@test.com", role: "admin", is_active: 1 }
      ]);
      // Subscriptions select check
      db.query.mockResolvedValueOnce([
        {
          id: 1,
          user_id: 10,
          user_name: "Kabir Mehta",
          plan_name: "Academic Pro",
          plan_price: "2499.00",
          billing_cycle: "Month",
          start_date: "2026-07-08",
          end_date: "2026-08-08",
          status: "Active"
        }
      ]);

      const res = await request(app)
        .get("/api/admin/subscriptions/overview")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.subscribers).toHaveLength(1);
      expect(res.body.subscribers[0].userName).toBe("Kabir Mehta");
    });
  });
});

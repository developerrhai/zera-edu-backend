const request = require("supertest");
const app = require("../app");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

jest.mock("../config/db", () => {
  const original = jest.requireActual("../config/db");
  return {
    ...original,
    query: jest.fn(),
    getPool: jest.fn(() => ({
      getConnection: jest.fn(() => ({
        beginTransaction: jest.fn(),
        execute: jest.fn().mockResolvedValue([{ insertId: 1 }]),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      })),
    })),
  };
});

describe("Subscriptions REST Endpoints", () => {
  let studentToken;

  beforeAll(() => {
    studentToken = jwt.sign(
      { id: 10, email: "student@test.com", role: "student" },
      process.env.JWT_SECRET || "test_secret",
      { expiresIn: "1h" }
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/subscriptions/plans", () => {
    it("should retrieve list of configured subscription plans", async () => {
      db.query.mockResolvedValueOnce([
        {
          id: 1,
          name: "Standard Academic Hub",
          price: "1999.00",
          billing_cycle: "Monthly",
          features: "Up to 3 hours of online sessions per week, Standard matching priorities",
        },
      ]);

      const res = await request(app).get("/api/subscriptions/plans");

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.plans).toHaveLength(1);
      expect(res.body.plans[0].name).toBe("Standard Academic Hub");
    });
  });

  describe("POST /api/subscriptions/subscribe", () => {
    it("should successfully subscribe active student user to plan", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 10, email: "student@test.com", name: "Test Student", role: "student", is_active: 1 }
      ]);
      // 2. Plan existence checks
      db.query.mockResolvedValueOnce([
        {
          id: 1,
          name: "Standard Academic Hub",
          price: "1999.00",
          billing_cycle: "Monthly",
        },
      ]);
      // 3. Insert confirmation select
      db.query.mockResolvedValueOnce([
        {
          id: 1,
          plan_id: 1,
          plan_name: "Standard Academic Hub",
          plan_price: "1999.00",
          status: "Active",
          start_date: "2026-07-08",
          end_date: "2026-08-08",
        },
      ]);

      const res = await request(app)
        .post("/api/subscriptions/subscribe")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ planId: 1 });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.subscription.planName).toBe("Standard Academic Hub");
    });
  });
});

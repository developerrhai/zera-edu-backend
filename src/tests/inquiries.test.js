const request = require("supertest");
const app = require("../app");
const db = require("../config/db");
const jwt = require("jsonwebtoken");

jest.mock("../config/db", () => {
  const original = jest.requireActual("../config/db");
  return {
    ...original,
    query: jest.fn(),
    initDb: jest.fn(),
  };
});

const jwtSecret = process.env.JWT_SECRET || "change_this_to_a_long_random_string";
const studentToken = jwt.sign({ id: 10, role: "student", email: "kabir@zeraedu.com" }, jwtSecret);
const teacherToken = jwt.sign({ id: 2, role: "teacher", email: "ananya@zeraedu.com" }, jwtSecret);
const adminToken = jwt.sign({ id: 1, role: "admin", email: "admin@zeraedu.com" }, jwtSecret);

describe("Support Inquiries Endpoint Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/v1/inquiries", () => {
    it("should allow a student to submit a valid inquiry", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 10, email: "kabir@zeraedu.com", name: "Kabir Mehta", role: "student", is_active: 1, public_id: "ulid_stud" }
      ]);
      // 2. INSERT query
      db.query.mockResolvedValueOnce([]); 
      // 3. SELECT query for audit logger
      db.query.mockResolvedValueOnce([{ id: 101 }]); 

      const res = await request(app)
        .post("/api/v1/inquiries")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ subject: "Reschedule Request", message: "Can we move Friday slot to Saturday?" });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.inquiry.subject).toBe("Reschedule Request");
      expect(res.body.inquiry.status).toBe("pending");
    });

    it("should allow a teacher to submit a valid inquiry", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 2, email: "ananya@zeraedu.com", name: "Ananya Kulkarni", role: "teacher", is_active: 1, public_id: "ulid_teach" }
      ]);
      // 2. INSERT query
      db.query.mockResolvedValueOnce([]); 
      // 3. SELECT query for audit logger
      db.query.mockResolvedValueOnce([{ id: 102 }]); 

      const res = await request(app)
        .post("/api/v1/inquiries")
        .set("Authorization", `Bearer ${teacherToken}`)
        .send({ subject: "Billing Query", message: "Payout not credited." });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.inquiry.subject).toBe("Billing Query");
    });

    it("should return 400 if subject is empty", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 10, email: "kabir@zeraedu.com", name: "Kabir Mehta", role: "student", is_active: 1, public_id: "ulid_stud" }
      ]);

      const res = await request(app)
        .post("/api/v1/inquiries")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ subject: "", message: "Can we move Friday slot to Saturday?" });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Subject is required");
    });

    it("should return 403 Forbidden for admin attempting to submit an inquiry", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 1, email: "admin@zeraedu.com", name: "System Admin", role: "admin", is_active: 1, public_id: "ulid_admin" }
      ]);

      const res = await request(app)
        .post("/api/v1/inquiries")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ subject: "Admin Submits", message: "Testing" });

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  describe("GET /api/v1/inquiries/my-inquiries", () => {
    it("should return inquiries submitted by the logged-in student", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 10, email: "kabir@zeraedu.com", name: "Kabir Mehta", role: "student", is_active: 1, public_id: "ulid_stud" }
      ]);
      // 2. GET inquiries query
      const mockInquiries = [
        { id: "ulid1", subject: "Inquiry 1", message: "Msg 1", status: "pending", adminReply: null, createdAt: new Date() }
      ];
      db.query.mockResolvedValueOnce(mockInquiries);

      const res = await request(app)
        .get("/api/v1/inquiries/my-inquiries")
        .set("Authorization", `Bearer ${studentToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.inquiries).toHaveLength(1);
      expect(res.body.inquiries[0].subject).toBe("Inquiry 1");
    });
  });

  describe("GET /api/v1/inquiries", () => {
    it("should allow admin to list all inquiries with role/status filters", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 1, email: "admin@zeraedu.com", name: "System Admin", role: "admin", is_active: 1, public_id: "ulid_admin" }
      ]);
      // 2. GET inquiries query
      const mockInquiries = [
        { id: "ulid1", subject: "S1", message: "M1", status: "pending", userRole: "student", userName: "Kabir", createdAt: new Date() }
      ];
      db.query.mockResolvedValueOnce(mockInquiries);

      const res = await request(app)
        .get("/api/v1/inquiries?role=student&status=pending")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.inquiries).toHaveLength(1);
    });

    it("should reject non-admin users with 403 Forbidden", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 10, email: "kabir@zeraedu.com", name: "Kabir Mehta", role: "student", is_active: 1, public_id: "ulid_stud" }
      ]);

      const res = await request(app)
        .get("/api/v1/inquiries")
        .set("Authorization", `Bearer ${studentToken}`);

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  describe("PUT /api/v1/inquiries/:id/status", () => {
    it("should allow admin to update status and add reply", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 1, email: "admin@zeraedu.com", name: "System Admin", role: "admin", is_active: 1, public_id: "ulid_admin" }
      ]);
      // 2. SELECT check inquiry exists
      db.query.mockResolvedValueOnce([{ id: 101, public_id: "ulid1" }]); 
      // 3. UPDATE query
      db.query.mockResolvedValueOnce([]); 
      // 4. SELECT updated row for audit logger
      db.query.mockResolvedValueOnce([{ id: 101, status: "resolved", admin_reply: "Resolved." }]); 

      const res = await request(app)
        .put("/api/v1/inquiries/ulid1/status")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "resolved", adminReply: "Resolved." });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("updated successfully");
    });

    it("should return 404 if inquiry is not found", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 1, email: "admin@zeraedu.com", name: "System Admin", role: "admin", is_active: 1, public_id: "ulid_admin" }
      ]);
      // 2. inquiry not found SELECT
      db.query.mockResolvedValueOnce([]); 

      const res = await request(app)
        .put("/api/v1/inquiries/nonexistent/status")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "resolved", adminReply: "Resolved." });

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Inquiry not found");
    });

    it("should reject non-admin with 403 Forbidden", async () => {
      // 1. Auth middleware user verification
      db.query.mockResolvedValueOnce([
        { id: 10, email: "kabir@zeraedu.com", name: "Kabir Mehta", role: "student", is_active: 1, public_id: "ulid_stud" }
      ]);

      const res = await request(app)
        .put("/api/v1/inquiries/ulid1/status")
        .set("Authorization", `Bearer ${studentToken}`)
        .send({ status: "resolved", adminReply: "Resolved." });

      expect(res.statusCode).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });
});

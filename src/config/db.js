const mysql = require("mysql2/promise");
const path = require("path");
const bcrypt = require("bcryptjs");
const { generateUlid } = require("../utils/ulid");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

let pool = null;

/**
 * Returns singleton MySQL connection pool.
 */
function getPool() {
  if (pool) return pool;

  const url = process.env.DATABASE_URL;

  if (url) {
    pool = mysql.createPool(url + "?dateStrings=true");
  } else {
    pool = mysql.createPool({
      host:     process.env.DB_HOST     || "localhost",
      port:     Number(process.env.DB_PORT || 3306),
      user:     process.env.DB_USER     || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME     || "zera_edu_db",
      waitForConnections: true,
      connectionLimit:    10,
      queueLimit:         0,
      dateStrings:        true,
    });
  }

  return pool;
}

/**
 * Run parameterized query and return rows.
 */
async function query(sql, values = []) {
  const isLimitOffset = /limit\s+\?|offset\s+\?/i.test(sql);
  const [rows] = isLimitOffset
    ? await getPool().query(sql, values)
    : await getPool().execute(sql, values);
  return rows;
}

/**
 * Initialize all required tables and default admin seeding.
 */
async function initDb() {
  const conn = await getPool().getConnection();
  try {
    console.log("[DB] Resetting and initializing database tables to modernized schema...");

    // ─── Drop existing tables to clean build ──────────────────────────────────
    // Drop in reverse order of foreign key dependency
    await conn.execute("SET FOREIGN_KEY_CHECKS = 0;");
    await conn.execute("DROP TABLE IF EXISTS user_subscriptions;");
    await conn.execute("DROP TABLE IF EXISTS subscription_plans;");
    await conn.execute("DROP TABLE IF EXISTS attendance_records;");
    await conn.execute("DROP TABLE IF EXISTS payments;");
    await conn.execute("DROP TABLE IF EXISTS bookings;");
    await conn.execute("DROP TABLE IF EXISTS teacher_slots;");
    await conn.execute("DROP TABLE IF EXISTS teacher_profiles;");
    await conn.execute("DROP TABLE IF EXISTS onboarding_queue;");
    await conn.execute("DROP TABLE IF EXISTS users;");
    await conn.execute("DROP TABLE IF EXISTS audit_logs;");
    await conn.execute("DROP TABLE IF EXISTS enquiries;");
    await conn.execute("DROP TABLE IF EXISTS inquiries;");
    await conn.execute("SET FOREIGN_KEY_CHECKS = 1;");

    // 1. Audit Logs table (for tracking updates and status changes)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        entity_type VARCHAR(50) NOT NULL,
        entity_id VARCHAR(50) NOT NULL,
        action VARCHAR(20) NOT NULL,
        actor_id BIGINT DEFAULT NULL,
        old_value JSON DEFAULT NULL,
        new_value JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Users table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role ENUM('student', 'teacher', 'admin') NOT NULL DEFAULT 'student',
        refresh_token VARCHAR(500) DEFAULT NULL,
        avatar_url VARCHAR(500) DEFAULT '',
        is_active TINYINT(1) DEFAULT 1,
        
        -- Password Reset OTP columns
        reset_otp VARCHAR(6) DEFAULT NULL,
        reset_otp_expires DATETIME DEFAULT NULL,
        last_otp_sent DATETIME DEFAULT NULL,
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        KEY idx_users_public (public_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. Teacher Profiles table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS teacher_profiles (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        user_id BIGINT NOT NULL UNIQUE,
        subject VARCHAR(100) NOT NULL,
        board VARCHAR(100) DEFAULT '',
        standard VARCHAR(50) DEFAULT '',
        timing_group ENUM('Morning', 'Afternoon', 'Evening') DEFAULT 'Evening',
        map_radius_km INT DEFAULT 5,
        youtube_url VARCHAR(500) DEFAULT '',
        cost_per_hour DECIMAL(12,2) NOT NULL,
        experience_years INT DEFAULT 0,
        rating DECIMAL(2,1) DEFAULT 0.0,
        degree VARCHAR(255) DEFAULT '',
        is_verified TINYINT(1) DEFAULT 0,
        display_order INT DEFAULT 0,
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        KEY idx_teacher_public (public_id),
        -- Composite search index
        INDEX idx_teacher_search (subject, standard, board, timing_group)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. Teacher Slots table (Optimistic locking version added)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS teacher_slots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        teacher_profile_id BIGINT NOT NULL,
        day VARCHAR(20) NOT NULL,
        time_window VARCHAR(50) NOT NULL,
        location ENUM('Online Virtual', 'Offline Center') DEFAULT 'Online Virtual',
        is_booked TINYINT(1) DEFAULT 0,
        version INT DEFAULT 0, -- Version tracking for optimistic locking
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        FOREIGN KEY (teacher_profile_id) REFERENCES teacher_profiles(id) ON DELETE CASCADE,
        KEY idx_slots_public (public_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 5. Bookings table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bookings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        ref_code VARCHAR(20) NOT NULL UNIQUE,
        student_id BIGINT NOT NULL,
        teacher_profile_id BIGINT NOT NULL,
        slot_id BIGINT NOT NULL,
        slot_info VARCHAR(100) NOT NULL,
        location VARCHAR(50) NOT NULL,
        status ENUM('Pending Completion', 'Completed', 'Cancelled') DEFAULT 'Pending Completion',
        idempotency_key VARCHAR(64) UNIQUE,
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (teacher_profile_id) REFERENCES teacher_profiles(id) ON DELETE RESTRICT,
        FOREIGN KEY (slot_id) REFERENCES teacher_slots(id) ON DELETE RESTRICT,
        KEY idx_bookings_public (public_id),
        -- Composite queries optimization index
        INDEX idx_bookings_student_status (student_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 6. Enquiries table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS enquiries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        type ENUM('callback', 'contact') NOT NULL,
        student_name VARCHAR(255) DEFAULT '',
        parent_name VARCHAR(255) DEFAULT '',
        contact_number VARCHAR(20) DEFAULT '',
        email VARCHAR(255) DEFAULT '',
        address TEXT DEFAULT NULL,
        board VARCHAR(50) DEFAULT '',
        standard VARCHAR(50) DEFAULT '',
        school_name VARCHAR(255) DEFAULT '',
        inquiry_type VARCHAR(100) DEFAULT '',
        message TEXT DEFAULT NULL,
        status ENUM('new', 'contacted', 'resolved') DEFAULT 'new',
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        KEY idx_enquiries_public (public_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 7. Payments table (Decimals and Currency columns added)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        transaction_id VARCHAR(50) NOT NULL UNIQUE,
        user_id BIGINT NOT NULL,
        booking_id BIGINT DEFAULT NULL,
        amount DECIMAL(12,2) NOT NULL,
        currency CHAR(3) DEFAULT 'INR', -- Money tracking enhancement
        gateway_method VARCHAR(100) DEFAULT '',
        status ENUM('pending', 'settled', 'failed', 'refunded') DEFAULT 'pending',
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL,
        KEY idx_payments_public (public_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 8. Onboarding Queue table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_queue (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        user_id BIGINT NOT NULL,
        specializations VARCHAR(255) NOT NULL,
        cost_quote DECIMAL(12,2) NOT NULL,
        credentials TEXT DEFAULT NULL,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        reviewed_by BIGINT DEFAULT NULL,
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
        KEY idx_onboarding_public (public_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 9. Attendance Records table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        student_id BIGINT NOT NULL,
        booking_id BIGINT NOT NULL,
        date DATE NOT NULL,
        status ENUM('Present', 'Absent', 'Excused') NOT NULL DEFAULT 'Present',
        remarks VARCHAR(255) DEFAULT '',
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
        KEY idx_attendance_public (public_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 10. Subscription Plans table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(12,2) NOT NULL,
        billing_cycle VARCHAR(50) NOT NULL DEFAULT 'Monthly',
        features TEXT NOT NULL,
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        KEY idx_plans_public (public_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 11. User Subscriptions table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        user_id BIGINT NOT NULL,
        plan_id BIGINT NOT NULL,
        status ENUM('Active', 'Expired', 'Cancelled') NOT NULL DEFAULT 'Active',
        start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_date TIMESTAMP NOT NULL,
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
        KEY idx_user_subs_public (public_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 12. Inquiries / Support Tickets table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(26) NOT NULL UNIQUE,
        submitted_by BIGINT NOT NULL,
        user_role ENUM('student', 'teacher') NOT NULL,
        subject VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status ENUM('pending', 'in-progress', 'resolved') NOT NULL DEFAULT 'pending',
        admin_reply TEXT DEFAULT NULL,
        
        -- Universal Tracking columns
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_by BIGINT DEFAULT NULL,
        updated_by BIGINT DEFAULT NULL,
        deleted_by BIGINT DEFAULT NULL,
        deletion_reason VARCHAR(255) DEFAULT NULL,
        
        FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE CASCADE,
        KEY idx_inquiries_public (public_id),
        KEY idx_inquiries_role (user_role),
        KEY idx_inquiries_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // ─── Seed Default Admin User ─────────────────────────────────────────────
    console.log("[DB] Seeding default admin user...");
    const adminHashedPw = await bcrypt.hash("admin123", 12);
    await conn.execute(
      "INSERT INTO users (public_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)",
      [generateUlid(), "admin@zeraedu.com", adminHashedPw, "System Administrator", "admin"]
    );

    // ─── Seed Default Student Users ──────────────────────────────────────────
    console.log("[DB] Seeding default student users...");
    const studentHashedPw = await bcrypt.hash("student123", 12);
    
    const student1Public = generateUlid();
    const [resS1] = await conn.execute(
      "INSERT INTO users (public_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'student')",
      [student1Public, "kabir@zeraedu.com", studentHashedPw, "Kabir Mehta"]
    );
    const kabirId = resS1.insertId;

    const student2Public = generateUlid();
    const [resS2] = await conn.execute(
      "INSERT INTO users (public_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'student')",
      [student2Public, "rohan@zeraedu.com", studentHashedPw, "Rohan Sharma"]
    );
    const rohanId = resS2.insertId;

    const student3Public = generateUlid();
    const [resS3] = await conn.execute(
      "INSERT INTO users (public_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'student')",
      [student3Public, "priya@zeraedu.com", studentHashedPw, "Priya Deshmukh"]
    );
    const priyaId = resS3.insertId;

    // ─── Seed Default Teacher Users and Profiles ─────────────────────────────
    console.log("[DB] Seeding default teacher users and profiles...");
    const teacherHashedPw = await bcrypt.hash("teacher123", 12);
    
    // Teacher 1
    const [resU1] = await conn.execute(
      "INSERT INTO users (public_id, email, password_hash, name, role, avatar_url) VALUES (?, ?, ?, ?, 'teacher', ?)",
      [generateUlid(), "ananya@zeraedu.com", teacherHashedPw, "Prof. Ananya Kulkarni", "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80"]
    );
    const u1Id = resU1.insertId;
    const [resP1] = await conn.execute(
      `INSERT INTO teacher_profiles (public_id, user_id, subject, board, standard, timing_group, map_radius_km, youtube_url, cost_per_hour, experience_years, rating, degree, is_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [generateUlid(), u1Id, "Mathematics", "ICSE Framework", "Grade 12", "Evening", 5, "https://www.youtube.com/embed/dQw4w9WgXcQ", 650.00, 8, 5.0, "M.Sc. Mathematics (IIT Bombay)"]
    );
    const teacher1ProfileId = resP1.insertId;

    // Teacher 2
    const [resU2] = await conn.execute(
      "INSERT INTO users (public_id, email, password_hash, name, role, avatar_url) VALUES (?, ?, ?, ?, 'teacher', ?)",
      [generateUlid(), "rajesh@zeraedu.com", teacherHashedPw, "Dr. Rajesh Kapoor", "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=150&auto=format&fit=crop&q=80"]
    );
    const u2Id = resU2.insertId;
    const [resP2] = await conn.execute(
      `INSERT INTO teacher_profiles (public_id, user_id, subject, board, standard, timing_group, map_radius_km, youtube_url, cost_per_hour, experience_years, rating, degree, is_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [generateUlid(), u2Id, "Physics", "CBSE Framework", "Grade 10", "Morning", 3, "https://www.youtube.com/embed/dQw4w9WgXcQ", 800.00, 12, 4.0, "Ph.D. in High Energy Particle Physics"]
    );
    const teacher2ProfileId = resP2.insertId;

    // Teacher 3
    const [resU3] = await conn.execute(
      "INSERT INTO users (public_id, email, password_hash, name, role, avatar_url) VALUES (?, ?, ?, ?, 'teacher', ?)",
      [generateUlid(), "vikram@zeraedu.com", teacherHashedPw, "Dr. Vikram Malhotra", "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&auto=format&fit=crop&q=80"]
    );
    const u3Id = resU3.insertId;
    const [resP3] = await conn.execute(
      `INSERT INTO teacher_profiles (public_id, user_id, subject, board, standard, timing_group, map_radius_km, youtube_url, cost_per_hour, experience_years, rating, degree, is_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [generateUlid(), u3Id, "Chemistry", "CBSE Framework", "Grade 12", "Morning", 10, "https://www.youtube.com/embed/dQw4w9WgXcQ", 700.00, 15, 5.0, "Ph.D. in Organic Chemistry (NCL Pune)"]
    );
    const teacher3ProfileId = resP3.insertId;

    // ─── Seed Slots ──────────────────────────────────────────────────────────
    console.log("[DB] Seeding availability slots...");
    const slot1Public = generateUlid();
    const [resSl1] = await conn.execute(
      "INSERT INTO teacher_slots (public_id, teacher_profile_id, day, time_window, location) VALUES (?, ?, ?, ?, ?)",
      [slot1Public, teacher1ProfileId, "Monday", "04:00 PM - 06:00 PM", "Online Virtual"]
    );
    
    const slot2Public = generateUlid();
    const [resSl2] = await conn.execute(
      "INSERT INTO teacher_slots (public_id, teacher_profile_id, day, time_window, location) VALUES (?, ?, ?, ?, ?)",
      [slot2Public, teacher1ProfileId, "Wednesday", "05:00 PM - 07:00 PM", "Offline Center"]
    );

    const slot3Public = generateUlid();
    const [resSl3] = await conn.execute(
      "INSERT INTO teacher_slots (public_id, teacher_profile_id, day, time_window, location) VALUES (?, ?, ?, ?, ?)",
      [slot3Public, teacher2ProfileId, "Tuesday", "10:00 AM - 12:00 PM", "Online Virtual"]
    );

    const slot4Public = generateUlid();
    const [resSl4] = await conn.execute(
      "INSERT INTO teacher_slots (public_id, teacher_profile_id, day, time_window, location) VALUES (?, ?, ?, ?, ?)",
      [slot4Public, teacher3ProfileId, "Thursday", "09:00 AM - 11:00 AM", "Online Virtual"]
    );

    // ─── Seed Subscription Plans ──────────────────────────────────────────────
    console.log("[DB] Seeding subscription plans...");
    const plan1Public = generateUlid();
    const [resPl1] = await conn.execute(
      "INSERT INTO subscription_plans (public_id, name, price, billing_cycle, features) VALUES (?, ?, ?, ?, ?)",
      [plan1Public, "Standard Academic Hub", 1999.00, "Monthly", "Up to 3 hours of online sessions per week, Standard matching priorities, Email support vectors"]
    );
    const plan1Id = resPl1.insertId;

    const plan2Public = generateUlid();
    const [resPl2] = await conn.execute(
      "INSERT INTO subscription_plans (public_id, name, price, billing_cycle, features) VALUES (?, ?, ?, ?, ?)",
      [plan2Public, "Premium Unlimited Matrix", 3999.00, "Monthly", "Unlimited online & offline sessions, 24/7 dedicated support priority, Google Maps radius override access"]
    );
    const plan2Id = resPl2.insertId;

    // ─── Seed User Subscriptions ─────────────────────────────────────────────
    console.log("[DB] Seeding user subscriptions...");
    const start = new Date();
    const end = new Date();
    end.setDate(start.getDate() + 30);

    await conn.execute(
      "INSERT INTO user_subscriptions (public_id, user_id, plan_id, status, start_date, end_date) VALUES (?, ?, ?, 'Active', ?, ?)",
      [generateUlid(), kabirId, plan2Id, start, end]
    );
    await conn.execute(
      "INSERT INTO user_subscriptions (public_id, user_id, plan_id, status, start_date, end_date) VALUES (?, ?, ?, 'Active', ?, ?)",
      [generateUlid(), rohanId, plan1Id, start, end]
    );

    // ─── Seed Bookings, Attendance, Payments, and Enquiries ──────────────────
    console.log("[DB] Seeding student bookings, payments, and attendance...");

    // Booked Slot 1
    const bookedSlot1Public = generateUlid();
    const [resBSl1] = await conn.execute(
      "INSERT INTO teacher_slots (public_id, teacher_profile_id, day, time_window, location, is_booked) VALUES (?, ?, ?, ?, ?, 1)",
      [bookedSlot1Public, teacher1ProfileId, "Friday", "02:00 PM - 04:00 PM", "Online Virtual"]
    );
    const bookedSlot1Id = resBSl1.insertId;

    // Booking 1 (Pending Completion)
    const booking1Public = generateUlid();
    const [resB1] = await conn.execute(
      `INSERT INTO bookings (public_id, ref_code, student_id, teacher_profile_id, slot_id, slot_info, location, status)
       VALUES (?, 'ZERA-101', ?, ?, ?, ?, ?, 'Pending Completion')`,
      [booking1Public, kabirId, teacher1ProfileId, bookedSlot1Id, "Friday (02:00 PM - 04:00 PM)", "Online Virtual"]
    );
    const booking1Id = resB1.insertId;

    // Attendance records for Booking 1
    await conn.execute(
      `INSERT INTO attendance_records (public_id, student_id, booking_id, date, status, remarks)
       VALUES (?, ?, ?, CURDATE(), 'Present', 'Completed academic node connection.')`,
      [generateUlid(), kabirId, booking1Id]
    );

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await conn.execute(
      `INSERT INTO attendance_records (public_id, student_id, booking_id, date, status, remarks)
       VALUES (?, ?, ?, ?, 'Absent', 'Student was away.')`,
      [generateUlid(), kabirId, booking1Id, yesterday]
    );

    // Booked Slot 2
    const bookedSlot2Public = generateUlid();
    const [resBSl2] = await conn.execute(
      "INSERT INTO teacher_slots (public_id, teacher_profile_id, day, time_window, location, is_booked) VALUES (?, ?, ?, ?, ?, 1)",
      [bookedSlot2Public, teacher2ProfileId, "Wednesday", "10:00 AM - 12:00 PM", "Online Virtual"]
    );
    const bookedSlot2Id = resBSl2.insertId;

    // Booking 2 (Completed)
    const booking2Public = generateUlid();
    const [resB2] = await conn.execute(
      `INSERT INTO bookings (public_id, ref_code, student_id, teacher_profile_id, slot_id, slot_info, location, status)
       VALUES (?, 'ZERA-102', ?, ?, ?, ?, ?, 'Completed')`,
      [booking2Public, kabirId, teacher2ProfileId, bookedSlot2Id, "Wednesday (10:00 AM - 12:00 PM)", "Online Virtual"]
    );
    const booking2Id = resB2.insertId;

    // Booked Slot 3
    const bookedSlot3Public = generateUlid();
    const [resBSl3] = await conn.execute(
      "INSERT INTO teacher_slots (public_id, teacher_profile_id, day, time_window, location, is_booked) VALUES (?, ?, ?, ?, ?, 1)",
      [bookedSlot3Public, teacher3ProfileId, "Thursday", "09:00 AM - 11:00 AM", "Online Virtual"]
    );
    const bookedSlot3Id = resBSl3.insertId;

    // Booking 3 (Cancelled)
    const booking3Public = generateUlid();
    await conn.execute(
      `INSERT INTO bookings (public_id, ref_code, student_id, teacher_profile_id, slot_id, slot_info, location, status)
       VALUES (?, 'ZERA-103', ?, ?, ?, ?, ?, 'Cancelled')`,
      [booking3Public, rohanId, teacher3ProfileId, bookedSlot3Id, "Thursday (09:00 AM - 11:00 AM)", "Online Virtual"]
    );

    // Payments
    await conn.execute(
      `INSERT INTO payments (public_id, transaction_id, user_id, booking_id, amount, currency, gateway_method, status)
       VALUES (?, 'TXN_9921', ?, ?, 650.00, 'INR', 'UPI Razorpay API', 'settled')`,
      [generateUlid(), kabirId, booking1Id]
    );
    await conn.execute(
      `INSERT INTO payments (public_id, transaction_id, user_id, booking_id, amount, currency, gateway_method, status)
       VALUES (?, 'TXN_8812', ?, ?, 800.00, 'INR', 'UPI Razorpay API', 'settled')`,
      [generateUlid(), kabirId, booking2Id]
    );
    await conn.execute(
      `INSERT INTO payments (public_id, transaction_id, user_id, booking_id, amount, currency, gateway_method, status)
       VALUES (?, 'TXN_7761', ?, NULL, 3999.00, 'INR', 'Card Payment', 'settled')`,
      [generateUlid(), kabirId]
    );

    // Enquiries
    await conn.execute(
      `INSERT INTO enquiries (public_id, type, student_name, parent_name, contact_number, email, address, board, standard, status)
       VALUES (?, 'callback', 'Amit Sharma', 'Vijay Sharma', '9876543210', 'vijay@gmail.com', 'Aundh Road, Pune', 'CBSE', 'Class 11-12', 'new')`,
      [generateUlid()]
    );
    await conn.execute(
      `INSERT INTO enquiries (public_id, type, student_name, parent_name, contact_number, email, address, board, standard, status)
       VALUES (?, 'callback', 'Sunita Patel', 'Karan Patel', '9988776655', 'karan@patel.com', 'Wakad Main Road, Pune', 'ICSE', 'Class 9-10', 'contacted')`,
      [generateUlid()]
    );
    await conn.execute(
      `INSERT INTO enquiries (public_id, type, student_name, email, contact_number, inquiry_type, message, status)
       VALUES (?, 'contact', 'Ramesh Kulkarni', 'ramesh@gmail.com', '9890123456', 'Billing & Payments', 'I wanted to check what card networks are accepted for the Academic Pro plan.', 'resolved')`,
      [generateUlid()]
    );

    console.log("[DB] Modernized database tables successfully initialized and seeded.");
  } finally {
    conn.release();
  }
}

module.exports = { getPool, query, initDb };

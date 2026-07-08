const mysql = require("mysql2/promise");
const path = require("path");
const bcrypt = require("bcryptjs");

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
  const [rows] = await getPool().execute(sql, values);
  return rows;
}

/**
 * Initialize all required tables and default admin seeding.
 */
async function initDb() {
  const conn = await getPool().getConnection();
  try {
    console.log("[DB] Initializing database tables...");

    // 1. Users table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role ENUM('student', 'teacher', 'admin') NOT NULL DEFAULT 'student',
        refresh_token VARCHAR(500) DEFAULT NULL,
        avatar_url VARCHAR(500) DEFAULT '',
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Teacher Profiles table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS teacher_profiles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        subject VARCHAR(100) NOT NULL,
        board VARCHAR(100) DEFAULT '',
        standard VARCHAR(50) DEFAULT '',
        timing_group ENUM('Morning', 'Afternoon', 'Evening') DEFAULT 'Evening',
        map_radius_km INT DEFAULT 5,
        youtube_url VARCHAR(500) DEFAULT '',
        cost_per_hour DECIMAL(10,2) NOT NULL,
        experience_years INT DEFAULT 0,
        rating DECIMAL(2,1) DEFAULT 0.0,
        degree VARCHAR(255) DEFAULT '',
        is_verified TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. Teacher Slots table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS teacher_slots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        teacher_profile_id INT NOT NULL,
        day VARCHAR(20) NOT NULL,
        time_window VARCHAR(50) NOT NULL,
        location ENUM('Online Virtual', 'Offline Center') DEFAULT 'Online Virtual',
        is_booked TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_profile_id) REFERENCES teacher_profiles(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. Bookings table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bookings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ref_code VARCHAR(20) NOT NULL UNIQUE,
        student_id INT NOT NULL,
        teacher_profile_id INT NOT NULL,
        slot_id INT NOT NULL,
        slot_info VARCHAR(100) NOT NULL,
        location VARCHAR(50) NOT NULL,
        status ENUM('Pending Completion', 'Completed', 'Cancelled') DEFAULT 'Pending Completion',
        idempotency_key VARCHAR(64) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_profile_id) REFERENCES teacher_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY (slot_id) REFERENCES teacher_slots(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 5. Enquiries table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS enquiries (
        id INT AUTO_INCREMENT PRIMARY KEY,
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 6. Payments table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        transaction_id VARCHAR(50) NOT NULL UNIQUE,
        user_id INT NOT NULL,
        booking_id INT DEFAULT NULL,
        amount DECIMAL(10,2) NOT NULL,
        gateway_method VARCHAR(100) DEFAULT '',
        status ENUM('pending', 'settled', 'failed', 'refunded') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 7. Onboarding Queue table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS onboarding_queue (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        specializations VARCHAR(255) NOT NULL,
        cost_quote DECIMAL(10,2) NOT NULL,
        credentials TEXT DEFAULT NULL,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        reviewed_by INT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 8. Attendance Records table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        booking_id INT NOT NULL,
        date DATE NOT NULL,
        status ENUM('Present', 'Absent', 'Excused') NOT NULL DEFAULT 'Present',
        remarks VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 9. Subscription Plans table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        billing_cycle VARCHAR(50) NOT NULL DEFAULT 'Monthly',
        features TEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 10. User Subscriptions table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        plan_id INT NOT NULL,
        status ENUM('Active', 'Expired', 'Cancelled') NOT NULL DEFAULT 'Active',
        start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_date TIMESTAMP NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);


    // ─── Seed Default Admin User ─────────────────────────────────────────────
    const [adminExists] = await conn.execute("SELECT id FROM users WHERE email = 'admin@zeraedu.com'");
    if (adminExists.length === 0) {
      console.log("[DB] Seeding default admin user...");
      const hashedPw = await bcrypt.hash("admin123", 12);
      await conn.execute(
        "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)",
        ["admin@zeraedu.com", hashedPw, "System Administrator", "admin"]
      );
    }

    // ─── Seed Default Student Users ──────────────────────────────────────────
    const [student1Exists] = await conn.execute("SELECT id FROM users WHERE email = 'kabir@zeraedu.com'");
    let kabirId;
    if (student1Exists.length === 0) {
      console.log("[DB] Seeding default student user (Kabir Mehta)...");
      const hashedPw = await bcrypt.hash("student123", 12);
      const [res] = await conn.execute(
        "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)",
        ["kabir@zeraedu.com", hashedPw, "Kabir Mehta", "student"]
      );
      kabirId = res.insertId;
    } else {
      kabirId = student1Exists[0].id;
    }

    const [student2Exists] = await conn.execute("SELECT id FROM users WHERE email = 'rohan@zeraedu.com'");
    let rohanId;
    if (student2Exists.length === 0) {
      console.log("[DB] Seeding default student user (Rohan Sharma)...");
      const hashedPw = await bcrypt.hash("student123", 12);
      const [res] = await conn.execute(
        "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)",
        ["rohan@zeraedu.com", hashedPw, "Rohan Sharma", "student"]
      );
      rohanId = res.insertId;
    } else {
      rohanId = student2Exists[0].id;
    }

    const [student3Exists] = await conn.execute("SELECT id FROM users WHERE email = 'priya@zeraedu.com'");
    let priyaId;
    if (student3Exists.length === 0) {
      console.log("[DB] Seeding default student user (Priya Deshmukh)...");
      const hashedPw = await bcrypt.hash("student123", 12);
      const [res] = await conn.execute(
        "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)",
        ["priya@zeraedu.com", hashedPw, "Priya Deshmukh", "student"]
      );
      priyaId = res.insertId;
    } else {
      priyaId = student3Exists[0].id;
    }

    // ─── Seed Default Teacher Users ──────────────────────────────────────────
    const [teacher1Exists] = await conn.execute("SELECT id FROM users WHERE email = 'ananya@zeraedu.com'");
    let teacher1ProfileId, teacher2ProfileId, teacher3ProfileId;

    if (teacher1Exists.length === 0) {
      console.log("[DB] Seeding default teacher users and profiles...");
      const hashedPw1 = await bcrypt.hash("teacher123", 12);
      const hashedPw2 = await bcrypt.hash("teacher123", 12);
      const hashedPw3 = await bcrypt.hash("teacher123", 12);
      
      const [u1Result] = await conn.execute(
        "INSERT INTO users (email, password_hash, name, role, avatar_url) VALUES (?, ?, ?, ?, ?)",
        ["ananya@zeraedu.com", hashedPw1, "Prof. Ananya Kulkarni", "teacher", "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80"]
      );
      
      const [u2Result] = await conn.execute(
        "INSERT INTO users (email, password_hash, name, role, avatar_url) VALUES (?, ?, ?, ?, ?)",
        ["rajesh@zeraedu.com", hashedPw2, "Dr. Rajesh Kapoor", "teacher", "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=150&auto=format&fit=crop&q=80"]
      );

      const [u3Result] = await conn.execute(
        "INSERT INTO users (email, password_hash, name, role, avatar_url) VALUES (?, ?, ?, ?, ?)",
        ["vikram@zeraedu.com", hashedPw3, "Dr. Vikram Malhotra", "teacher", "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&auto=format&fit=crop&q=80"]
      );

      // Insert profiles
      const [p1Result] = await conn.execute(
        `INSERT INTO teacher_profiles (user_id, subject, board, standard, timing_group, map_radius_km, youtube_url, cost_per_hour, experience_years, rating, degree, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [u1Result.insertId, "Mathematics", "ICSE Framework", "Grade 12", "Evening", 5, "https://www.youtube.com/embed/dQw4w9WgXcQ", 650.00, 8, 5.0, "M.Sc. Mathematics (IIT Bombay)", 1]
      );
      teacher1ProfileId = p1Result.insertId;
 
      const [p2Result] = await conn.execute(
        `INSERT INTO teacher_profiles (user_id, subject, board, standard, timing_group, map_radius_km, youtube_url, cost_per_hour, experience_years, rating, degree, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [u2Result.insertId, "Physics", "CBSE Framework", "Grade 10", "Morning", 3, "https://www.youtube.com/embed/dQw4w9WgXcQ", 800.00, 12, 4.0, "Ph.D. in High Energy Particle Physics", 1]
      );
      teacher2ProfileId = p2Result.insertId;

      const [p3Result] = await conn.execute(
        `INSERT INTO teacher_profiles (user_id, subject, board, standard, timing_group, map_radius_km, youtube_url, cost_per_hour, experience_years, rating, degree, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [u3Result.insertId, "Chemistry", "CBSE Framework", "Grade 12", "Morning", 10, "https://www.youtube.com/embed/dQw4w9WgXcQ", 700.00, 15, 5.0, "Ph.D. in Organic Chemistry (NCL Pune)", 1]
      );
      teacher3ProfileId = p3Result.insertId;

      // Insert slots
      await conn.execute(
        "INSERT INTO teacher_slots (teacher_profile_id, day, time_window, location) VALUES (?, ?, ?, ?)",
        [teacher1ProfileId, "Monday", "04:00 PM - 06:00 PM", "Online Virtual"]
      );
      await conn.execute(
        "INSERT INTO teacher_slots (teacher_profile_id, day, time_window, location) VALUES (?, ?, ?, ?)",
        [teacher1ProfileId, "Wednesday", "05:00 PM - 07:00 PM", "Offline Center"]
      );
      await conn.execute(
        "INSERT INTO teacher_slots (teacher_profile_id, day, time_window, location) VALUES (?, ?, ?, ?)",
        [teacher2ProfileId, "Tuesday", "10:00 AM - 12:00 PM", "Online Virtual"]
      );
      await conn.execute(
        "INSERT INTO teacher_slots (teacher_profile_id, day, time_window, location) VALUES (?, ?, ?, ?)",
        [teacher3ProfileId, "Thursday", "09:00 AM - 11:00 AM", "Online Virtual"]
      );
    } else {
      const [profiles] = await conn.execute("SELECT id FROM teacher_profiles ORDER BY id ASC");
      teacher1ProfileId = profiles[0] ? profiles[0].id : null;
      teacher2ProfileId = profiles[1] ? profiles[1].id : null;
      teacher3ProfileId = profiles[2] ? profiles[2].id : null;
    }

    // ─── Seed Default Subscription Plans ──────────────────────────────────────
    const [plansExist] = await conn.execute("SELECT id FROM subscription_plans");
    let plan1Id, plan2Id;
    if (plansExist.length === 0) {
      console.log("[DB] Seeding default subscription plans...");
      const [res1] = await conn.execute(
        "INSERT INTO subscription_plans (name, price, billing_cycle, features) VALUES (?, ?, ?, ?)",
        ["Standard Academic Hub", 1999.00, "Monthly", "Up to 3 hours of online sessions per week, Standard matching priorities, Email support vectors"]
      );
      plan1Id = res1.insertId;
      const [res2] = await conn.execute(
        "INSERT INTO subscription_plans (name, price, billing_cycle, features) VALUES (?, ?, ?, ?)",
        ["Premium Unlimited Matrix", 3999.00, "Monthly", "Unlimited online & offline sessions, 24/7 dedicated support priority, Google Maps radius override access"]
      );
      plan2Id = res2.insertId;
    } else {
      plan1Id = plansExist[0].id;
      plan2Id = plansExist[1] ? plansExist[1].id : plansExist[0].id;
    }

    // ─── Seed User Subscriptions ──────────────────────────────────────────────
    const [userSubsExist] = await conn.execute("SELECT id FROM user_subscriptions");
    if (userSubsExist.length === 0) {
      console.log("[DB] Seeding user subscriptions...");
      const start = new Date();
      const end = new Date();
      end.setDate(start.getDate() + 30);
      
      await conn.execute(
        "INSERT INTO user_subscriptions (user_id, plan_id, status, start_date, end_date) VALUES (?, ?, 'Active', ?, ?)",
        [kabirId, plan2Id, start, end]
      );
      await conn.execute(
        "INSERT INTO user_subscriptions (user_id, plan_id, status, start_date, end_date) VALUES (?, ?, 'Active', ?, ?)",
        [rohanId, plan1Id, start, end]
      );
    }

    // ─── Seed Bookings, Attendance, Payments, and Enquiries ───────────────────
    const [bookingsExist] = await conn.execute("SELECT id FROM bookings");
    if (bookingsExist.length === 0 && teacher1ProfileId && teacher2ProfileId) {
      console.log("[DB] Seeding student bookings, payments, and attendance records...");
      
      // Slot 1
      const [slot1Result] = await conn.execute(
        "INSERT INTO teacher_slots (teacher_profile_id, day, time_window, location, is_booked) VALUES (?, ?, ?, ?, 1)",
        [teacher1ProfileId, "Friday", "02:00 PM - 04:00 PM", "Online Virtual"]
      );
      const slot1Id = slot1Result.insertId;

      // Booking 1 (Pending completion)
      const [b1Result] = await conn.execute(
        `INSERT INTO bookings (ref_code, student_id, teacher_profile_id, slot_id, slot_info, location, status)
         VALUES (?, ?, ?, ?, ?, ?, 'Pending Completion')`,
        ["ZERA-101", kabirId, teacher1ProfileId, slot1Id, "Friday (02:00 PM - 04:00 PM)", "Online Virtual"]
      );
      const booking1Id = b1Result.insertId;

      // Attendance 1 (Present)
      await conn.execute(
        `INSERT INTO attendance_records (student_id, booking_id, date, status, remarks)
         VALUES (?, ?, CURDATE(), 'Present', 'Completed academic node connection.')`,
        [kabirId, booking1Id]
      );

      // Attendance 2 (Absent for yesterday)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      await conn.execute(
        `INSERT INTO attendance_records (student_id, booking_id, date, status, remarks)
         VALUES (?, ?, ?, 'Absent', 'Student was away.')`,
        [kabirId, booking1Id, yesterday]
      );

      // Slot 2
      const [slot2Result] = await conn.execute(
        "INSERT INTO teacher_slots (teacher_profile_id, day, time_window, location, is_booked) VALUES (?, ?, ?, ?, 1)",
        [teacher2ProfileId, "Wednesday", "10:00 AM - 12:00 PM", "Online Virtual"]
      );
      const slot2Id = slot2Result.insertId;

      // Booking 2 (Completed)
      const [b2Result] = await conn.execute(
        `INSERT INTO bookings (ref_code, student_id, teacher_profile_id, slot_id, slot_info, location, status)
         VALUES (?, ?, ?, ?, ?, ?, 'Completed')`,
        ["ZERA-102", kabirId, teacher2ProfileId, slot2Id, "Wednesday (10:00 AM - 12:00 PM)", "Online Virtual"]
      );

      // Payments Seeding
      await conn.execute(
        `INSERT INTO payments (transaction_id, user_id, amount, gateway_method, status)
         VALUES ('TXN_9921', ?, 650.00, 'UPI Razorpay API', 'settled')`,
        [kabirId]
      );
      await conn.execute(
        `INSERT INTO payments (transaction_id, user_id, amount, gateway_method, status)
         VALUES ('TXN_8812', ?, 800.00, 'UPI Razorpay API', 'settled')`,
        [kabirId]
      );
      await conn.execute(
        `INSERT INTO payments (transaction_id, user_id, amount, gateway_method, status)
         VALUES ('TXN_7761', ?, 3999.00, 'Card Payment', 'settled')`,
        [kabirId]
      );

      // Slot 3
      if (teacher3ProfileId) {
        const [slot3Result] = await conn.execute(
          "INSERT INTO teacher_slots (teacher_profile_id, day, time_window, location, is_booked) VALUES (?, ?, ?, ?, 1)",
          [teacher3ProfileId, "Thursday", "09:00 AM - 11:00 AM", "Online Virtual"]
        );
        const slot3Id = slot3Result.insertId;

        // Booking 3 (Cancelled)
        await conn.execute(
          `INSERT INTO bookings (ref_code, student_id, teacher_profile_id, slot_id, slot_info, location, status)
           VALUES (?, ?, ?, ?, ?, ?, 'Cancelled')`,
          ["ZERA-103", rohanId, teacher3ProfileId, slot3Id, "Thursday (09:00 AM - 11:00 AM)", "Online Virtual"]
        );
      }
    }

    // ─── Seed Enquiries ───────────────────────────────────────────────────────
    const [enquiriesExist] = await conn.execute("SELECT id FROM enquiries");
    if (enquiriesExist.length === 0) {
      console.log("[DB] Seeding callback and contact enquiries...");
      await conn.execute(
        `INSERT INTO enquiries (type, student_name, parent_name, contact_number, email, address, board, standard, status)
         VALUES ('callback', 'Amit Sharma', 'Vijay Sharma', '9876543210', 'vijay@gmail.com', 'Aundh Road, Pune', 'CBSE', 'Class 11-12', 'new')`
      );
      await conn.execute(
        `INSERT INTO enquiries (type, student_name, parent_name, contact_number, email, address, board, standard, status)
         VALUES ('callback', 'Sunita Patel', 'Karan Patel', '9988776655', 'karan@patel.com', 'Wakad Main Road, Pune', 'ICSE', 'Class 9-10', 'contacted')`
      );
      await conn.execute(
        `INSERT INTO enquiries (type, student_name, email, contact_number, inquiry_type, message, status)
         VALUES ('contact', 'Ramesh Kulkarni', 'ramesh@gmail.com', '9890123456', 'Billing & Payments', 'I wanted to check what card networks are accepted for the Academic Pro plan.', 'resolved')`
      );
    }

    console.log("[DB] ✅ Database tables & seed values ready.");
  } finally {
    conn.release();
  }
}

module.exports = { getPool, query, initDb };

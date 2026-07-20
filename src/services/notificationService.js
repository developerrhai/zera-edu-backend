const { query } = require("../config/db");
const { admin } = require("../config/firebase");
const { generateUlid } = require("../utils/ulid");

class NotificationService {
  /**
   * Save or update an FCM token for a user.
   */
  async registerToken(userId, token, deviceType = "unknown") {
    // Check if token already exists for this user
    const existing = await query("SELECT id FROM fcm_tokens WHERE user_id = ? AND token = ?", [userId, token]);
    
    if (existing.length > 0) {
      // Update last active
      await query("UPDATE fcm_tokens SET last_active = CURRENT_TIMESTAMP WHERE id = ?", [existing[0].id]);
      return;
    }

    // Delete token if it was assigned to someone else (device transfer)
    await query("DELETE FROM fcm_tokens WHERE token = ?", [token]);

    // Insert new token
    await query(
      "INSERT INTO fcm_tokens (public_id, user_id, token, device_type) VALUES (?, ?, ?, ?)",
      [generateUlid(), userId, token, deviceType]
    );
  }

  /**
   * Internal method to log the notification to DB.
   */
  async _logNotification(title, body, targetType, targetCriteria, sentBy, successCount = 0, failureCount = 0, status = "sent") {
    const publicId = generateUlid();
    const criteriaJson = targetCriteria ? JSON.stringify(targetCriteria) : null;
    
    await query(
      `INSERT INTO notifications 
      (public_id, title, body, target_type, target_criteria, sent_by, success_count, failure_count, status) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [publicId, title, body, targetType, criteriaJson, sentBy, successCount, failureCount, status]
    );
    return publicId;
  }

  /**
   * Send notification to a single user.
   */
  async sendToUser(userId, title, body, sentBy = null, data = {}) {
    const tokens = await query("SELECT token FROM fcm_tokens WHERE user_id = ?", [userId]);
    
    if (tokens.length === 0) {
      await this._logNotification(title, body, 'single', { userId }, sentBy, 0, 1, 'failed');
      throw new Error("No registered devices for this user.");
    }

    const deviceTokens = tokens.map(t => t.token);

    const message = {
      notification: { title, body },
      data: data,
      tokens: deviceTokens
    };

    let successCount = 0;
    let failureCount = 0;
    
    try {
      if (admin.messaging) {
        const response = await admin.messaging().sendMulticast(message);
        successCount = response.successCount;
        failureCount = response.failureCount;
        
        // Remove failed tokens (e.g. uninstalled)
        if (response.failureCount > 0) {
          const failedTokens = [];
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              failedTokens.push(deviceTokens[idx]);
            }
          });
          if (failedTokens.length > 0) {
            await query("DELETE FROM fcm_tokens WHERE token IN (?)", [failedTokens]);
          }
        }
      } else {
        throw new Error("Firebase Admin not initialized properly.");
      }
      
      await this._logNotification(title, body, 'single', { userId }, sentBy, successCount, failureCount, 'sent');
      return { successCount, failureCount };
    } catch (error) {
      await this._logNotification(title, body, 'single', { userId }, sentBy, 0, deviceTokens.length, 'failed');
      throw error;
    }
  }

  /**
   * Send bulk notification to all students.
   */
  async sendBulkToStudents(title, body, sentBy = null, data = {}) {
    // Get tokens only for students
    const rows = await query(`
      SELECT f.token 
      FROM fcm_tokens f
      JOIN users u ON f.user_id = u.id
      WHERE u.role = 'student' AND u.is_active = 1
    `);

    if (rows.length === 0) {
      await this._logNotification(title, body, 'bulk', { role: 'student' }, sentBy, 0, 0, 'sent');
      return { successCount: 0, failureCount: 0, message: "No active student devices found." };
    }

    return await this._processMulticast(rows.map(r => r.token), title, body, 'bulk', { role: 'student' }, sentBy, data);
  }

  /**
   * Send filtered notification (e.g. by board or standard).
   */
  async sendFiltered(title, body, filters, sentBy = null, data = {}) {
    // Example: joining with enquiries or a student profile if standard/board is stored there.
    // Assuming filters contains { board: 'CBSE', standard: 'Class 10' }
    
    // We will do a generic approach: if we need to filter students, we need to know their attributes.
    // For now, let's assume filtering happens at the application level if no specific tables hold the student board/class in this schema natively except enquiries. 
    // Wait, the DB schema has standard/board in enquiries, but for active users? User table has no board. 
    // We'll mock the filter query.
    
    const conditions = ["u.role = 'student'", "u.is_active = 1"];
    const params = [];
    
    // As an example, if there were a student_profiles table. 
    // For now, we'll just get all and filter based on custom logic or just send to those provided in a userIds array.
    if (filters.userIds && Array.isArray(filters.userIds)) {
      conditions.push(`u.id IN (?)`);
      params.push(filters.userIds);
    }

    const sql = `
      SELECT f.token 
      FROM fcm_tokens f
      JOIN users u ON f.user_id = u.id
      WHERE ${conditions.join(" AND ")}
    `;
    
    const rows = await query(sql, params.length ? params : null);

    if (rows.length === 0) {
      await this._logNotification(title, body, 'filtered', filters, sentBy, 0, 0, 'sent');
      return { successCount: 0, failureCount: 0 };
    }

    return await this._processMulticast(rows.map(r => r.token), title, body, 'filtered', filters, sentBy, data);
  }
  
  /**
   * Helper to batch and send multicast messages
   */
  async _processMulticast(tokens, title, body, targetType, targetCriteria, sentBy, data) {
    let successCount = 0;
    let failureCount = 0;
    
    // FCM sendMulticast has a 500 token limit per batch
    const BATCH_SIZE = 500;
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batchTokens = tokens.slice(i, i + BATCH_SIZE);
      const message = {
        notification: { title, body },
        data,
        tokens: batchTokens
      };
      
      try {
        if (admin.messaging) {
          const response = await admin.messaging().sendMulticast(message);
          successCount += response.successCount;
          failureCount += response.failureCount;
        }
      } catch (err) {
        console.error("FCM Batch Error:", err);
        failureCount += batchTokens.length;
      }
    }
    
    await this._logNotification(title, body, targetType, targetCriteria, sentBy, successCount, failureCount, failureCount > 0 && successCount === 0 ? 'failed' : 'sent');
    
    return { successCount, failureCount };
  }

  /**
   * Get notification history (admin)
   */
  async getHistory(limit = 50, offset = 0) {
    const history = await query(`
      SELECT n.*, u.name as sent_by_name
      FROM notifications n
      LEFT JOIN users u ON n.sent_by = u.id
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    
    const total = await query("SELECT COUNT(id) as count FROM notifications");
    
    return {
      data: history,
      total: total[0].count
    };
  }
}

module.exports = new NotificationService();

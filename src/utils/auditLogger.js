const { query } = require("../config/db");

/**
 * Inserts a structured log entry into the database audit_logs table.
 * 
 * @param {string} entityType - The type of entity (e.g. 'booking', 'payment', 'user', 'slot')
 * @param {number|string} entityId - The internal numeric ID of the modified entity
 * @param {string} action - The action performed ('create', 'update', 'delete', 'status_change', 'login')
 * @param {number} actorId - The internal numeric ID of the user performing the action
 * @param {Object} [oldValue] - Previous state of the entity (JSON-serializable)
 * @param {Object} [newValue] - New state of the entity (JSON-serializable)
 */
async function logAudit(entityType, entityId, action, actorId, oldValue = null, newValue = null) {
  if (process.env.NODE_ENV === "test") return;
  try {
    await query(
      `INSERT INTO audit_logs (entity_type, entity_id, action, actor_id, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entityType,
        entityId ? String(entityId) : null,
        action,
        actorId || null,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
      ]
    );
  } catch (err) {
    // Log error to console but do not crash the request flow for auditing issues
    console.error("[Audit Log Error] Failed to write system audit record: ", err);
  }
}

module.exports = { logAudit };

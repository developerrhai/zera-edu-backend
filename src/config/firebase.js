const path = require("path");
const fs = require("fs");

let admin = null;
try {
  admin = require("firebase-admin");
} catch (err) {
  console.warn("[Firebase] firebase-admin module not found. It will be mocked.");
}

let initialized = false;

function initFirebase() {
  if (initialized) return;

  try {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.resolve(__dirname, "firebase-service-account.json");
    
    // Check if the service account file exists to avoid crashing
    if (admin && fs.existsSync(serviceAccountPath)) {
      const serviceAccount = require(serviceAccountPath);
      
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("[Firebase] Admin SDK initialized successfully.");
    } else {
      console.warn(`[Firebase] Service account key or module not found. Push notifications will be mocked/disabled until configured.`);
      
      // Ensure admin object exists for the mock
      if (!admin) admin = {};
      
      // Mock initialization to prevent crashes when we use 'admin.messaging()'
      admin.messaging = () => ({
        send: async (message) => {
          console.log("[Firebase Mock] send() called with:", message);
          return `projects/mock-project/messages/${Date.now()}`;
        },
        sendMulticast: async (message) => {
          console.log("[Firebase Mock] sendMulticast() called with:", message);
          return {
            responses: message.tokens.map(token => ({ success: true, messageId: `mock-${Date.now()}` })),
            successCount: message.tokens.length,
            failureCount: 0
          };
        }
      });
    }
    initialized = true;
  } catch (error) {
    console.error("[Firebase] Initialization error:", error);
  }
}

module.exports = {
  admin,
  initFirebase
};

/**
 * PhonePe Payment Gateway Service (New Standard Checkout API)
 * Uses Client ID, Client Secret, Client Version (OAuth-based)
 * Docs: https://developer.phonepe.com/payment-gateway
 * 
 * Production OAuth: https://api.phonepe.com/apis/identity-manager/v1/oauth/token
 * Sandbox OAuth:    https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token
 * 
 * Production Pay:   https://api.phonepe.com/apis/pg/checkout/v2/pay
 * Sandbox Pay:      https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay
 */
const crypto = require("crypto");

const CLIENT_ID = process.env.PHONEPE_MERCHANT_ID;       // Client ID
const CLIENT_SECRET = process.env.PHONEPE_SALT_KEY;       // Client Secret  
const CLIENT_VERSION = parseInt(process.env.PHONEPE_SALT_INDEX || "1", 10);
const PHONEPE_ENV = process.env.PHONEPE_ENV || "PROD";

// Separate base URLs for OAuth and Payment APIs
const AUTH_BASE = PHONEPE_ENV === "PROD"
    ? "https://api.phonepe.com/apis/identity-manager"
    : "https://api-preprod.phonepe.com/apis/pg-sandbox";

const PAY_BASE = PHONEPE_ENV === "PROD"
    ? "https://api.phonepe.com/apis/pg"
    : "https://api-preprod.phonepe.com/apis/pg-sandbox";

// In-memory OAuth token cache
let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get OAuth access token from PhonePe
 */
async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiry - 60000) {
        return cachedToken;
    }

    const authUrl = `${AUTH_BASE}/v1/oauth/token`;

    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        client_version: CLIENT_VERSION.toString(),
        grant_type: "client_credentials"
    });

    console.log("[PhonePe] Requesting OAuth token from:", authUrl);

    const response = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
    });

    const data = await response.json();

    if (data.access_token) {
        console.log("[PhonePe] OAuth token obtained successfully");
        cachedToken = data.access_token;
        tokenExpiry = Date.now() + ((data.expires_in || 900) * 1000);
        return cachedToken;
    }

    console.error("[PhonePe] OAuth Error:", JSON.stringify(data));
    throw new Error(data.message || data.error || "Failed to obtain PhonePe access token");
}

/**
 * Verify webhook checksum
 */
function verifyChecksum(base64Body, receivedChecksum) {
    const stringToHash = base64Body + CLIENT_SECRET;
    const sha256 = crypto.createHash("sha256").update(stringToHash).digest("hex");
    const expectedChecksum = `${sha256}###${CLIENT_VERSION}`;
    return expectedChecksum === receivedChecksum;
}

/**
 * Create a PhonePe Standard Checkout payment order
 * @param {Object} paymentData { transactionId, amount, userId, redirectUrl, callbackUrl, mobileNumber }
 * @returns {Promise<string>} checkout redirect URL
 */
async function createPaymentLink({ transactionId, amount, userId, redirectUrl, callbackUrl, mobileNumber }) {
    try {
        const token = await getAccessToken();

        // Standard Checkout Pay Request - amount in paisa
        const payload = {
            merchantOrderId: transactionId,
            amount: Math.round(amount * 100),
            expireAfter: 1200,
            metaInfo: {
                udf1: userId,
                udf2: mobileNumber || "9999999999"
            },
            paymentFlow: {
                type: "PG_CHECKOUT",
                merchantUrls: {
                    redirectUrl: redirectUrl,
                    callbackUrl: callbackUrl
                }
            }
        };

        console.log("[PhonePe] Creating order for:", transactionId, "amount:", amount);

        const response = await fetch(`${PAY_BASE}/checkout/v2/pay`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `O-Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        // Standard Checkout returns redirectUrl at top level
        if (data.redirectUrl) return data.redirectUrl;
        if (data.data && data.data.redirectUrl) return data.data.redirectUrl;
        if (data.data && data.data.instrumentResponse && data.data.instrumentResponse.redirectInfo) {
            return data.data.instrumentResponse.redirectInfo.url;
        }

        console.error("[PhonePe] Create Order Error:", JSON.stringify(data));
        throw new Error(data.message || data.error || "Failed to generate payment link");
    } catch (error) {
        console.error("[PhonePe] API Error:", error.message);
        throw error;
    }
}

/**
 * Check payment status via PhonePe API
 * @param {string} transactionId
 * @returns {Promise<Object>} status data
 */
async function checkPaymentStatus(transactionId) {
    try {
        const token = await getAccessToken();

        const response = await fetch(`${PAY_BASE}/checkout/v2/order/${CLIENT_ID}/${transactionId}/status`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `O-Bearer ${token}`
            }
        });

        return await response.json();
    } catch (error) {
        console.error("[PhonePe] Status Check Error:", error.message);
        return { success: false, code: "INTERNAL_ERROR" };
    }
}

module.exports = {
    MERCHANT_ID: CLIENT_ID,
    generateChecksum: () => "",
    verifyChecksum,
    createPaymentLink,
    checkPaymentStatus
};

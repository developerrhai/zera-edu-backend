const logger = require("../utils/logger");

/**
 * Handles sending system notifications and recovery emails.
 * Uses a mock logger output if SMTP host credentials are not defined.
 */
async function sendMail({ to, subject, html }) {
  const host = process.env.SMTP_HOST;

  if (!host) {
    logger.info(`[Email Mock Service] Transmitting email message:
                 To: ${to}
                 Subject: ${subject}
                 Body Outline: ${html.substring(0, 150)}...`);
    return { mockSent: true, messageId: "mock_uuid_" + Date.now() };
  }

  // Production configuration using Nodemailer (lazy loaded to prevent dependency bloat)
  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 2525),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const info = await transporter.sendMail({
      from: process.env.FROM_EMAIL || "noreply@zeraedu.com",
      to,
      subject,
      html,
    });

    logger.info(`[Email Service] Email sent successfully to ${to}. MessageId: ${info.messageId}`);
    return info;
  } catch (err) {
    logger.error(`[Email Service] Failed to send email to ${to}: ${err.message}`);
    throw err;
  }
}

module.exports = {
  sendMail,
};

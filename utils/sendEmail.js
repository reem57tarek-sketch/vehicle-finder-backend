
const nodemailer = require("nodemailer");

let transporter;

const createEmailService = async () => {
  const testAccount = await nodemailer.createTestAccount();

  transporter = nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });

  console.log("Test email account is ready");
};

const sendEmail = async ({ to, subject, text, html }) => {
  if (!transporter) {
    throw new Error("Email service is not initialized");
  }

  const info = await transporter.sendMail({
    from: '"Vehicle Finder" <test@vehicle-finder.com>',
    to,
    subject,
    text,
    html,
  });

  console.log(
    "Email preview:",
    nodemailer.getTestMessageUrl(info)
  );

  return info;
};

module.exports = {
  createEmailService,
  sendEmail,
};

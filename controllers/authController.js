const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const AppError = require("../utils/AppError");
function createAuthController(User, { sendEmail }, config) {

  const register = async (req, res, next) => {
    try {
      const { full_name, email, phone_number, password } = req.body;

      if (!full_name || !email || !password) {
        throw new AppError(400, "full_name, email, and password are required");
      }

      const normalizedEmail = email.trim().toLowerCase();

      const existingUser = await User.getUserByEmail(normalizedEmail);

      if (existingUser) {
        throw new AppError(409, "Email already registered");
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const verificationToken = crypto.randomBytes(32).toString("hex");

      const verificationTokenHash = crypto
        .createHash("sha256")
        .update(verificationToken)
        .digest("hex");

      const verificationTokenExpires = new Date(
        Date.now() + 15 * 60 * 1000
      );

      const user = await User.createUser({
        full_name: full_name.trim(),
        email: normalizedEmail,
        phone_number: phone_number || null,
        password_hash: passwordHash,
        verification_token_hash: verificationTokenHash,
        verification_token_expires: verificationTokenExpires,
      });

      const verificationLink =
        `${config.baseUrl}/api/auth/verify-email?token=${verificationToken}`;

      try {
        await sendEmail({
          to: normalizedEmail,
          subject: "Vehicle Finder - Verify Your Email",
          text: `Open this link to verify your email: ${verificationLink}`,
          html: `
            <h2>Welcome to Vehicle Finder!</h2>
            <p>Please click the link below to verify your email:</p>
            <a href="${verificationLink}">Verify Email</a>
            <p>This link expires in 15 minutes.</p>
          `,
        });
      } catch (emailError) {
        throw new AppError(503, "Account created, but verification email could not be sent. Use resend-verification to try again.", "VERIFICATION_EMAIL_FAILED", { cause: emailError });
      }

      return res.status(201).json({
        message:
          "Registration successful. Please check your email to verify your account.",
        user,
      });

    } catch (error) {
      return next(error);
    }
  };

  const login = async (req, res, next) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        throw new AppError(400, "Email and password are required");
      }

      const normalizedEmail = email.trim().toLowerCase();

      const user = await User.getUserByEmail(normalizedEmail);

      if (!user) {
        throw new AppError(401, "Invalid email or password");
      }

      const isPasswordCorrect = await bcrypt.compare(
        password,
        user.password_hash
      );

      if (!isPasswordCorrect) {
        throw new AppError(401, "Invalid email or password");
      }

      if (!user.is_email_verified) {
        throw new AppError(403, "Please verify your email before logging in");
      }

      const token = jwt.sign(
        {
          user_id: user.user_id,
          email: user.email,
        },
        config.jwtSecret,
        { expiresIn: "1h", algorithm: "HS256" }
      );

      return res.status(200).json({
        message: "Login successful",
        token: token,
        user: {
          user_id: user.user_id,
          full_name: user.full_name,
          email: user.email,
          phone_number: user.phone_number,
          is_email_verified: user.is_email_verified,
        },
      });

    } catch (error) {
      return next(error);
    }
  };

  const verifyEmail = async (req, res, next) => {
    try {
      const { token } = req.query;

      if (!token) {
        throw new AppError(400, "Verification token is required");
      }

      const tokenHash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      const user = await User.verifyEmail(tokenHash);

      if (!user) {
        throw new AppError(400, "Invalid or expired verification link");
      }

      return res.status(200).json({
        message: "Email verified successfully",
        user,
      });

    } catch (error) {
      return next(error);
    }
  };

  const forgotPassword = async (req, res, next) => {
    try {
      if (!config.resetUrl) {
        throw new AppError(503, "Password recovery is not configured. Set PASSWORD_RESET_URL to the frontend reset-password page.", "PASSWORD_RESET_NOT_CONFIGURED");
      }
      const { email } = req.body;

      if (!email) {
        throw new AppError(400, "Email is required");
      }

      const normalizedEmail = email.trim().toLowerCase();

      const user = await User.getUserForPasswordReset(normalizedEmail);

      if (!user) {
        return res.status(200).json({
          message: "If the account exists, a reset link will be sent",
        });
      }

      const resetToken = crypto.randomBytes(32).toString("hex");

      const resetTokenHash = crypto
        .createHash("sha256")
        .update(resetToken)
        .digest("hex");

      const resetTokenExpires = new Date(
        Date.now() + 15 * 60 * 1000
      );

      await User.saveResetToken(
        user.user_id,
        resetTokenHash,
        resetTokenExpires
      );

      const resetLink =
        `${config.resetUrl}?token=${resetToken}`;

      await sendEmail({
        to: user.email,
        subject: "Vehicle Finder - Reset Password",
        text: `Open this link to reset your password: ${resetLink}`,
        html: `
          <h2>Reset Your Password</h2>
          <p>Click the link below to reset your password:</p>
          <a href="${resetLink}">Reset Password</a>
          <p>This link expires in 15 minutes.</p>
        `,
      });

      return res.status(200).json({
        message: "If the account exists, a reset link will be sent",
      });

    } catch (error) {
      return next(error);
    }
  };

  const resetPassword = async (req, res, next) => {
    try {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        throw new AppError(400, "Token and new password are required");
      }

      if (newPassword.length < 8) {
        throw new AppError(400, "Password must be at least 8 characters");
      }

      const tokenHash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      const passwordHash = await bcrypt.hash(newPassword, 12);

      const user = await User.resetPassword(tokenHash, passwordHash);

      if (!user) {
        throw new AppError(400, "Invalid or expired reset link");
      }

      return res.status(200).json({
        message: "Password reset successfully",
      });

    } catch (error) {
      return next(error);
    }
  };

  const resendVerification = async (req, res) => {
    const message = "If the account needs verification, a verification link will be sent";
    const user = await User.getUserByEmail(req.body.email.trim().toLowerCase());
    if (user && !user.is_email_verified) {
      const token = crypto.randomBytes(32).toString("hex");
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      await User.saveVerificationToken(user.user_id, hash, new Date(Date.now() + 15 * 60 * 1000));
      const link = `${config.baseUrl}/api/auth/verify-email?token=${token}`;
      await sendEmail({ to: user.email, subject: "Vehicle Finder - Verify Your Email",
        text: `Open this link to verify your email: ${link}` });
    }
    res.json({ message });
  };

  return {
    resendVerification,
    register,
    login,
    verifyEmail,
    forgotPassword,
    resetPassword,
  };

}
module.exports = { createAuthController };

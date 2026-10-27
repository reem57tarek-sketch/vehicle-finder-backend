
const pool = require("../config/db");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { sendEmail } = require("../utils/sendEmail");
const jwt = require("jsonwebtoken");

const register = async (req, res) => {
  try {
    const { full_name, email, phone_number, password } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({
        message: "full_name, email, and password are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await pool.query(
      "SELECT user_id FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        message: "Email already registered",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Generate a secure verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");

    // Store the hash, not the original token
    const verificationTokenHash = crypto
      .createHash("sha256")
      .update(verificationToken)
      .digest("hex");

    // Token expires after 15 minutes
    const verificationTokenExpires = new Date(
      Date.now() + 15 * 60 * 1000
    );

    const result = await pool.query(
      `INSERT INTO users (
        full_name,
        email,
        phone_number,
        password_hash,
        verification_token_hash,
        verification_token_expires
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING user_id, full_name, email, phone_number,
      is_email_verified, created_at`,
      [
        full_name.trim(),
        normalizedEmail,
        phone_number || null,
        passwordHash,
        verificationTokenHash,
        verificationTokenExpires,
      ]
    );

    const verificationLink =
      `http://localhost:${process.env.PORT}/api/auth/verify-email?token=${verificationToken}`;

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
      console.error("Verification email error:", emailError.message);

      return res.status(500).json({
        message:
          "Account created, but verification email could not be sent. Please try again later.",
      });
    }

    return res.status(201).json({
      message: "Registration successful. Please check your email to verify your account.",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Register error:", error.message);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};



const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    const isPasswordCorrect = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!isPasswordCorrect) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    
   if (!user.is_email_verified) {
    return res.status(403).json({
        message: "Please verify your email before logging in"
    });
   }

   const token = jwt.sign(
  {
    user_id: user.user_id,
    email: user.email,
  },
  process.env.JWT_SECRET,
  { expiresIn: "1h" }
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
    console.error("Login error:", error.message);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};


const verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        message: "Verification token is required",
      });
    }

    const crypto = require("crypto");

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const result = await pool.query(
      `UPDATE users
       SET is_email_verified = true,
           verification_token_hash = NULL,
           verification_token_expires = NULL,
           updated_at = NOW()
       WHERE verification_token_hash = $1
         AND verification_token_expires > NOW()
       RETURNING user_id, full_name, email, is_email_verified`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        message: "Invalid or expired verification link",
      });
    }

    return res.status(200).json({
      message: "Email verified successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Verify email error:", error.message);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};



const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        message: "Email is required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await pool.query(
      "SELECT user_id, email FROM users WHERE email = $1",
      [normalizedEmail]
    );

    // Return the same message whether the account exists or not
    if (result.rows.length === 0) {
      return res.status(200).json({
        message: "If the account exists, a reset link will be sent",
      });
    }

    const user = result.rows[0];

    const resetToken = crypto.randomBytes(32).toString("hex");

    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    const resetTokenExpires = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query(
      `UPDATE users
       SET reset_token_hash = $1,
           reset_token_expires = $2,
           updated_at = NOW()
       WHERE user_id = $3`,
      [resetTokenHash, resetTokenExpires, user.user_id]
    );

    const resetLink =
      `http://localhost:${process.env.PORT}/reset-password?token=${resetToken}`;

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
    console.error("Forgot password error:", error.message);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};



const resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        message: "Token and new password are required",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters",
      });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const passwordHash = await bcrypt.hash(newPassword, 12);

    const result = await pool.query(
      `UPDATE users
       SET password_hash = $1,
           reset_token_hash = NULL,
           reset_token_expires = NULL,
           updated_at = NOW()
       WHERE reset_token_hash = $2
         AND reset_token_expires > NOW()
       RETURNING user_id`,
      [passwordHash, tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        message: "Invalid or expired reset link",
      });
    }

    return res.status(200).json({
      message: "Password reset successfully",
    });
  } catch (error) {
    console.error("Reset password error:", error.message);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};



module.exports = { register, 
                   login,
                   verifyEmail,
                   forgotPassword,
                   resetPassword,
             };


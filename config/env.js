function integer(env, key, fallback, max = 2147483647) {
  const raw = env[key] ?? fallback;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1 || Number(raw) > max) throw new Error(`${key} must be an integer between 1 and ${max}`);
  return Number(raw);
}
function httpUrl(value, key, production) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${key} must be a valid absolute URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (production && url.protocol !== 'https:')) throw new Error(`${key} must be an HTTP URL (HTTPS in production), without credentials, query or fragment`);
  return url.toString().replace(/\/$/, "");
}
function loadDatabaseConfig(env = process.env) {
  const mongoUri = env.MONGODB_URI;
  if (!mongoUri || !/^mongodb(?:\+srv)?:\/\//.test(mongoUri)) throw new Error("MONGODB_URI must be a MongoDB connection string");
  const mongoDbName = env.MONGODB_DB_NAME || "vehicle_finder";
  if (!/^[a-zA-Z0-9_-]+$/.test(mongoDbName)) throw new Error("MONGODB_DB_NAME must contain letters, digits, underscores or hyphens");
  return { mongoUri, mongoDbName, dbPoolMax: integer(env, "DB_POOL_MAX", 10, 100), dbTimeout: integer(env, "DB_TIMEOUT_MS", 5000, 60000) };
}
function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const port = integer(env, "PORT", 3000, 65535);
  if (!env.JWT_SECRET || Buffer.byteLength(env.JWT_SECRET) < 32) throw new Error("JWT_SECRET must contain at least 32 bytes");
  const database = loadDatabaseConfig(env);
  const publicUrl = env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  if (production && !publicUrl) throw new Error("PUBLIC_BASE_URL is required in production");
  const baseUrl = httpUrl(publicUrl || `http://localhost:${port}`, "PUBLIC_BASE_URL", production);
  const resetUrl = env.PASSWORD_RESET_URL ? httpUrl(env.PASSWORD_RESET_URL, "PASSWORD_RESET_URL", production) : undefined;
  const emailProvider = env.EMAIL_PROVIDER || (env.RESEND_API_KEY ? "resend" : env.SMTP_HOST ? "smtp" : "disabled");
  if (!["resend", "smtp", "disabled"].includes(emailProvider)) throw new Error("EMAIL_PROVIDER must be resend, smtp or disabled");
  if (production && emailProvider === "disabled") throw new Error("Configure a production email provider (resend or smtp)");
  if (emailProvider !== "disabled" && !env.EMAIL_FROM) throw new Error("EMAIL_FROM is required for email delivery");
  if (emailProvider === "resend" && !env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required");
  if (emailProvider === "smtp" && !(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD)) throw new Error("SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required");
  if (env.SMTP_SECURE !== undefined && !["true", "false"].includes(env.SMTP_SECURE)) throw new Error("SMTP_SECURE must be true or false");
  return {
    production, environment: env.NODE_ENV || "development",
    platform: env.RAILWAY_PROJECT_ID || env.RAILWAY_PUBLIC_DOMAIN ? "railway" :
      env.RENDER || env.RENDER_EXTERNAL_URL ? "render" : "standalone",
    port, host: "0.0.0.0", baseUrl, resetUrl: resetUrl || (production ? undefined : `${baseUrl}/reset-password`),
    jwtSecret: env.JWT_SECRET, emailProvider,
    smtpPort: integer(env, "SMTP_PORT", 587, 65535),
    ...database,
    corsOrigins: (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const url = httpUrl(s, "CORS_ORIGINS", production);
      if (new URL(url).origin !== url) throw new Error("CORS_ORIGINS entries must be origins without paths");
      return url;
    }),
  };
}
module.exports = { loadConfig, loadDatabaseConfig };

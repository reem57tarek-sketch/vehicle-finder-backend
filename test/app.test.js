const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { createApp } = require("../app");
const logger = require("../utils/logger");

const config = { jwtSecret: "test-secret-with-more-than-32-bytes", baseUrl: "https://api.example.com",
  resetUrl: "https://app.example.com/reset-password", corsOrigins: ["https://app.example.com"] };

async function fixture(t, overrides = {}) {
  const app = createApp({ config, database: { check: async () => ({ rows: [] }) },
    emailService: { sendEmail: async () => ({ id: "sent" }) }, userModel: {}, ...overrides });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    const raw = await response.text();
    return { status: response.status, headers: response.headers, body: raw ? JSON.parse(raw) : null };
  };
}
const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("missing reset frontend URL keeps the server online and rejects recovery before database writes", async (t) => {
  const request = await fixture(t, { config: { ...config, resetUrl: undefined } });
  assert.equal((await request("/")).status, 200);
  const response = await request("/api/auth/forgot-password", post({ email: "a@example.com" }));
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "PASSWORD_RESET_NOT_CONFIGURED");
});

test("health and database check work without email network startup", async (t) => {
  const request = await fixture(t);
  for (const path of ["/health", "/health/live", "/api/db-check"]) assert.equal((await request(path)).status, 200);
});

test("unavailable MongoDB/indexes reports readiness 503 but liveness stays up", async (t) => {
  const request = await fixture(t, { database: { check: async () => { throw Object.assign(new Error("database offline"), { name: "MongoServerSelectionError" }); } } });
  const response = await request("/health");
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "DATABASE_NOT_READY");
  assert.equal(response.headers.get("x-request-id"), response.body.requestId);
  assert.equal((await request("/health/live")).status, 200);
});

test("unknown routes and malformed/large JSON use consistent safe errors", async (t) => {
  const request = await fixture(t);
  assert.equal((await request("/missing?token=secret")).body.code, "NOT_FOUND");
  const captured = [];
  const originalWarn = logger.warn;
  logger.warn = (event, fields) => captured.push(logger.clean(fields));
  t.after(() => { logger.warn = originalWarn; });
  const malformed = await request("/api/auth/login", { ...post({}), body: '{"password":"must-never-appear",' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "INVALID_JSON");
  assert.ok(!JSON.stringify(captured).includes("must-never-appear"));
  assert.equal((await request("/api/auth/login", post({ password: "x".repeat(40000) }))).status, 413);
});

test("invalid types, absent bodies, short/overlong passwords and repeated tokens return 400", async (t) => {
  const request = await fixture(t);
  for (const body of [null, [], {}, { email: {}, password: "password123" }, { email: "not-an-email", password: "password123" }]) {
    assert.equal((await request("/api/auth/login", post(body))).status, 400);
  }
  for (const password of ["short", "أ".repeat(37)]) {
    assert.equal((await request("/api/auth/register", post({ full_name: "Test", email: "a@example.com", password }))).status, 400);
  }
  assert.equal((await request("/api/auth/register", { method: "POST" })).status, 400);
  assert.equal((await request("/api/auth/verify-email?token=a&token=b")).status, 400);
  assert.equal((await request("/api/auth/register", post({ full_name: "Bad\u0000Name", email: "a@example.com", password: "password123" }))).status, 400);
});

test("CORS preflight permits configured frontend and rejects others", async (t) => {
  const request = await fixture(t);
  const response = await request("/api/auth/login", { method: "OPTIONS", headers: { Origin: config.corsOrigins[0] } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), config.corsOrigins[0]);
  assert.equal((await request("/api/auth/login", { method: "OPTIONS", headers: { Origin: "https://other.example.com" } })).status, 403);
});

test("registration normalizes email, hashes password/token and sends public verification URL", async (t) => {
  let saved, mail;
  const request = await fixture(t, {
    userModel: { getUserByEmail: async () => undefined, createUser: async (data) => { saved = data; return { user_id: 1, email: data.email }; } },
    emailService: { sendEmail: async (data) => { mail = data; } },
  });
  const response = await request("/api/auth/register", post({ full_name: " Test ", email: " TEST@example.com ", password: "password123" }));
  assert.equal(response.status, 201);
  assert.equal(saved.email, "test@example.com");
  assert.equal(saved.full_name, "Test");
  assert.ok(await bcrypt.compare("password123", saved.password_hash));
  const token = new URL(mail.text.split(" ").at(-1)).searchParams.get("token");
  assert.equal(saved.verification_token_hash, require("crypto").createHash("sha256").update(token).digest("hex"));
  assert.ok(mail.text.includes("https://api.example.com/api/auth/verify-email"));
  assert.ok(!JSON.stringify(response.body).includes(saved.password_hash));
});

test("email failure preserves recoverable account and resend issues a new token", async (t) => {
  let sends = 0, updated;
  const request = await fixture(t, {
    userModel: { getUserByEmail: async () => sends ? { user_id: 1, email: "a@example.com", is_email_verified: false } : undefined,
      createUser: async () => ({ user_id: 1 }), saveVerificationToken: async (...args) => { updated = args; } },
    emailService: { sendEmail: async () => { if (++sends === 1) throw new Error("SMTP timeout"); } },
  });
  const response = await request("/api/auth/register", post({ full_name: "Test", email: "a@example.com", password: "password123" }));
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "VERIFICATION_EMAIL_FAILED");
  assert.equal((await request("/api/auth/resend-verification", post({ email: "a@example.com" }))).status, 200);
  assert.equal(updated[0], 1);
  assert.equal(updated[1].length, 64);
  assert.equal(sends, 2);
});

test("unique constraint races return 409; unexpected errors stay private", async (t) => {
  let code = 11000;
  const request = await fixture(t, { userModel: { getUserByEmail: async () => { throw Object.assign(new Error("private-database-detail"), { code }); } } });
  assert.equal((await request("/api/auth/login", post({ email: "a@example.com", password: "password123" }))).status, 409);
  code = "UNKNOWN_ERROR";
  const response = await request("/api/auth/login", post({ email: "a@example.com", password: "password123" }));
  assert.equal(response.status, 500);
  assert.equal(response.body.message, "Internal server error");
  assert.ok(!JSON.stringify(response.body).includes("private-database-detail"));
});

test("login and protected routes enforce JWT signature and algorithm", async (t) => {
  const user = { user_id: "1", email: "a@example.com", is_email_verified: true, password_hash: await bcrypt.hash("password123", 4) };
  const request = await fixture(t, { userModel: { getUserByEmail: async () => user, getUserById: async () => ({ user_id: "1" }) } });
  assert.equal((await request("/api/users/profile")).status, 401);
  assert.equal((await request("/api/auth/login", post({ email: user.email, password: "wrong" }))).status, 401);
  user.is_email_verified = false;
  assert.equal((await request("/api/auth/login", post({ email: user.email, password: "password123" }))).status, 403);
  user.is_email_verified = true;
  const login = await request("/api/auth/login", post({ email: user.email, password: "password123" }));
  assert.equal(login.status, 200);
  assert.equal(jwt.verify(login.body.token, config.jwtSecret).user_id, "1");
  assert.equal((await request("/api/users/profile", { headers: { Authorization: `Bearer ${login.body.token}` } })).status, 200);
  for (const token of [jwt.sign({ user_id: 1 }, config.jwtSecret, { algorithm: "HS384" }), jwt.sign({ user_id: 1 }, config.jwtSecret, { expiresIn: -1 }), "broken"]) {
    assert.equal((await request("/api/users/profile", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  }
});

test("password reset mail points to frontend and unknown accounts share success response", async (t) => {
  let found = false, mail, saved;
  const request = await fixture(t, { userModel: {
    getUserForPasswordReset: async () => found ? { user_id: 1, email: "a@example.com" } : undefined,
    saveResetToken: async (...args) => { saved = args; },
  }, emailService: { sendEmail: async (data) => { mail = data; } } });
  const unknown = await request("/api/auth/forgot-password", post({ email: "a@example.com" }));
  found = true;
  const known = await request("/api/auth/forgot-password", post({ email: "a@example.com" }));
  assert.deepEqual(known.body, unknown.body);
  assert.ok(mail.text.includes(`${config.resetUrl}?token=`));
  assert.equal(saved[1].length, 64);
});

test("profile and password errors handle deleted users, empty updates and stale credentials", async (t) => {
  let stored;
  const request = await fixture(t, { userModel: {
    getUserById: async () => undefined, updateUser: async () => undefined,
    getPasswordHash: async () => stored, updatePassword: async () => undefined,
  } });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign({ user_id: 1 }, config.jwtSecret, { expiresIn: "1h" })}` };
  const put = (path, body) => request(path, { method: "PUT", headers, body: JSON.stringify(body) });
  assert.equal((await request("/api/users/profile", { headers })).status, 404);
  assert.equal((await put("/api/users/profile", {})).status, 400);
  assert.equal((await put("/api/users/profile", { full_name: "Missing" })).status, 404);
  assert.equal((await put("/api/users/change-password", { currentPassword: "old", newPassword: "newpassword123" })).status, 404);
  stored = { password_hash: await bcrypt.hash("password123", 4) };
  assert.equal((await put("/api/users/change-password", { currentPassword: "wrong", newPassword: "newpassword123" })).status, 400);
  const stale = await put("/api/users/change-password", { currentPassword: "password123", newPassword: "newpassword123" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "PASSWORD_CHANGED");
});

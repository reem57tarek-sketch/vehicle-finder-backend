const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");
const { createDatabase } = require("../config/db");
const { createUserModel } = require("../models/User");
const { createApp } = require("../app");

test("MongoDB account lifecycle, uniqueness, token expiry and concurrent password changes", {
  skip: !process.env.TEST_MONGODB_URI,
}, async (t) => {
  const name = `vehicle_test_${crypto.randomBytes(8).toString("hex")}`;
  const config = { mongoUri: process.env.TEST_MONGODB_URI, mongoDbName: name, dbTimeout: 3000, dbPoolMax: 5,
    jwtSecret: "mongo-integration-test-secret-more-than-32-bytes", corsOrigins: [],
    baseUrl: "https://api.example.com", resetUrl: "https://app.example.com/reset-password" };
  const database = createDatabase(config);
  t.after(async () => {
    await database.close();
    const admin = new MongoClient(process.env.TEST_MONGODB_URI);
    try { await admin.db(name).dropDatabase(); } finally { await admin.close(); }
  });
  const sent = [];
  const server = createApp({ config, database, emailService: { sendEmail: async (mail) => sent.push(mail) } }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  async function request(path, body, method = "POST", token) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const emailToken = () => new URL(sent.at(-1).text.split(" ").at(-1)).searchParams.get("token");
  assert.equal((await request("/health", null, "GET")).status, 200);
  const credentials = { email: "mongo@example.com", password: "password123" };
  const registration = await request("/api/auth/register", { ...credentials, full_name: "Mongo User" });
  assert.equal(registration.status, 201);
  assert.match(registration.body.user.user_id, /^[a-f0-9]{24}$/);
  assert.ok(!JSON.stringify(registration.body).includes("password_hash"));
  assert.equal((await request("/api/auth/login", credentials)).status, 403);
  const verification = emailToken();
  assert.equal((await request(`/api/auth/verify-email?token=${verification}`, null, "GET")).status, 200);
  assert.equal((await request(`/api/auth/verify-email?token=${verification}`, null, "GET")).status, 400);
  const login = await request("/api/auth/login", credentials);
  assert.equal(login.status, 200);
  assert.equal((await request("/api/users/profile", null, "GET", login.body.token)).status, 200);
  assert.equal((await request("/api/users/profile", { full_name: "Updated" }, "PUT", login.body.token)).status, 200);
  await request("/api/auth/forgot-password", { email: credentials.email });
  const reset = emailToken();
  assert.equal((await request("/api/auth/reset-password", { token: reset, newPassword: "newpassword123" })).status, 200);
  assert.equal((await request("/api/auth/reset-password", { token: reset, newPassword: "reusedpassword123" })).status, 400);
  assert.equal((await request("/api/auth/login", credentials)).status, 401);
  const users = createUserModel(database);
  const id = registration.body.user.user_id;
  const oldHash = (await users.getPasswordHash(id)).password_hash;
  const changes = await Promise.all([users.updatePassword(id, "first-hash", oldHash), users.updatePassword(id, "second-hash", oldHash)]);
  assert.equal(changes.filter(Boolean).length, 1);
  await users.saveResetToken(id, "expired", new Date(Date.now() - 60000));
  assert.equal(await users.resetPassword("expired", "must-not-change"), undefined);
  assert.equal(await users.getUserById("invalid-id"), undefined);
  const collection = await database.users();
  await assert.rejects(collection.insertOne({ email: "MONGO@example.com" }), { code: 11000 });
  assert.equal((await request("/api/auth/register", { ...credentials, full_name: "Duplicate" })).status, 409);
});

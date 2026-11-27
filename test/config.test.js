const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, loadDatabaseConfig } = require("../config/env");
const { createEmailService } = require("../services/emailService");
const logger = require("../utils/logger");
const env = { MONGODB_URI: "mongodb://127.0.0.1:27017", JWT_SECRET: "test-secret-longer-than-thirty-two-bytes" };

test("MongoDB configuration validates URI, database name and timeouts", async () => {
  assert.equal(loadConfig(env).mongoDbName, "vehicle_finder");
  assert.equal(loadConfig({...env, MONGODB_DB_NAME:"custom"}).mongoDbName, "custom");
  for(const override of [{MONGODB_URI:"postgresql://host/db"},{MONGODB_URI:""},{MONGODB_DB_NAME:"bad/name"},{DB_TIMEOUT_MS:"bad"},{JWT_SECRET:"short"}]) assert.throws(()=>loadConfig({...env,...override}));
});

test("MongoDB connection credentials are redacted from nested log errors", () => {
  for (const uri of ["mongodb://alice:private-password@localhost:27017/db", "mongodb+srv://alice:private-password@cluster.example.com/db"]) {
    const output = JSON.stringify(logger.clean({ mongoUri: uri, error: new Error(`Connection failed: ${uri}`) }));
    assert.ok(!output.includes("private-password"));
    assert.ok(!output.includes("alice"));
  }
});

test("Resend delivery uses HTTPS and never calls network during service construction", async () => {
  let calls = 0;
  const service = createEmailService({ emailProvider: "resend" }, { RESEND_API_KEY: "test-key", EMAIL_FROM: "noreply@example.com" }, async (url, options) => {
    calls++;
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(options.body).to, ["a@example.com"]);
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ id: "message-1" }) };
  });
  assert.equal(calls, 0);
  assert.deepEqual(await service.sendEmail({ to: "a@example.com", subject: "test", text: "hello" }), { id: "message-1" });
  assert.equal(calls, 1);
});

test("provider rejection/timeouts and disabled delivery return recoverable errors", async () => {
  for (const impl of [async () => ({ ok: false, status: 429 }), async () => { throw new Error("timed out"); }]) {
    const service = createEmailService({ emailProvider: "resend" }, {}, impl);
    await assert.rejects(service.sendEmail({}), { status: 503, code: "EMAIL_DELIVERY_FAILED" });
  }
  const disabled = createEmailService({ emailProvider: "disabled" });
  await assert.rejects(disabled.sendEmail({}), { status: 503 });
});

test("logger redacts credentials, URLs, tokens, and nested error causes", () => {
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "a-private-test-secret";
  try {
    const error = new Error("Failed postgres://user:password@host/db token=sensitive-token a-private-test-secret",
      { cause: new Error("Bearer private-auth-value") });
    const logged = JSON.stringify(logger.clean({ password: "secret-input", Authorization: "Bearer value", body: { password: "input" }, error }));
    for (const secret of ["secret-input", "sensitive-token", "a-private-test-secret", "private-auth-value", "user:password"]) assert.ok(!logged.includes(secret));
    assert.ok(logged.includes("[REDACTED]"));
    assert.ok(logged.includes("config.test.js"));
  } finally {
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
  }
});

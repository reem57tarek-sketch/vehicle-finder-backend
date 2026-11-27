const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const logger = require("../utils/logger");
const { createEmailService } = require("../services/emailService");
const { createApp } = require("../app");

test("logging BigInt IDs and cyclic causes never throws during error handling", () => {
  const error = new Error("failure");
  error.code = 12n;
  error.cause = error;
  const result = logger.clean({ userId: 9007199254740993n, error });
  assert.equal(result.userId, "9007199254740993");
  assert.equal(result.error.code, "12");
  assert.equal(result.error.cause, "[Circular]");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("Resend failures release the HTTP body and malformed successes return 503", async () => {
  let cancelled = false;
  const service = createEmailService({ emailProvider: "resend" }, {}, async () => ({
    ok: false, status: 503, body: { async cancel() { cancelled = true; } },
  }));
  await assert.rejects(service.sendEmail({}), { status: 503, code: "EMAIL_DELIVERY_FAILED" });
  assert.equal(cancelled, true);
  const malformed = createEmailService({ emailProvider: "resend" }, {}, async () => ({ ok: true, json: async () => ({}) }));
  await assert.rejects(malformed.sendEmail({}), { status: 503 });
});

test("SMTP success and rejected recipients use the real Nodemailer transport", { timeout: 10000 }, async (t) => {
  let rejectRecipient = false;
  let delivered = "";
  const sockets = new Set();
  const smtp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 localhost Test SMTP\r\n");
    let buffer = "", inData = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (inData) {
          if (line === ".") { inData = false; socket.write("250 queued-test-message\r\n"); }
          else delivered += line + "\n";
        } else if (/^EHLO|^HELO/.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH /.test(line)) socket.write("235 authenticated\r\n");
        else if (/^RCPT /.test(line)) socket.write(rejectRecipient ? "550 recipient rejected\r\n" : "250 accepted\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 Send message\r\n"); }
        else if (line === "QUIT") socket.end("221 goodbye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); smtp.close(resolve); }));
  const service = createEmailService({ emailProvider: "smtp", smtpPort: smtp.address().port }, {
    SMTP_HOST: "127.0.0.1", SMTP_SECURE: "false", SMTP_USER: "local-test", SMTP_PASSWORD: "local-password",
    EMAIL_FROM: "noreply@example.com",
  });
  t.after(() => service.close());
  assert.ok((await service.sendEmail({ to: "test@example.com", subject: "Local test", text: "SMTP smoke test" })).id);
  assert.ok(delivered.includes("SMTP smoke test"));
  rejectRecipient = true;
  await assert.rejects(service.sendEmail({ to: "test@example.com", subject: "Rejected", text: "test" }), { status: 503, code: "EMAIL_DELIVERY_FAILED" });
});

test("database timeouts return 503 and protected-route errors log the correct endpoint", async (t) => {
  let failure;
  const config = { jwtSecret: "reliability-tests-secret-at-least-32-bytes", corsOrigins: [], baseUrl: "http://localhost:3000" };
  const app = createApp({ config, database: {}, emailService: {}, userModel: { getUserByEmail: async () => { throw failure; } } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const error of [Object.assign(new Error("operation timed out"), { name: "MongoOperationTimeoutError" }), Object.assign(new Error("network timeout"), { name: "MongoNetworkTimeoutError" }),
    Object.assign(new Error("server selection failed"), { name: "MongoServerSelectionError" }), Object.assign(new Error("socket reset"), { code: "ECONNRESET" })]) {
    failure = error;
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "test@example.com", password: "password123" }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "SERVICE_UNAVAILABLE");
  }
  const events = [];
  const original = logger.warn;
  logger.warn = (event, fields) => events.push(fields);
  t.after(() => { logger.warn = original; });
  for (const path of ["/api/users/profile", "/api/auth/profile"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 401);
    await response.json();
    assert.equal(events.at(-1).route, path);
  }
});

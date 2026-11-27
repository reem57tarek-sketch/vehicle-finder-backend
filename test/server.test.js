const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");

test("missing/invalid startup configuration exits with a structured error", () => {
  const child = spawnSync(process.execPath, ["server.js"], {
    env: { ...process.env, JWT_SECRET: "short" }, encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  assert.equal(child.status, 1);
  const log = JSON.parse(child.stderr.trim());
  assert.equal(log.event, "server.startup_failed");
  assert.ok(log.error.message.includes("JWT_SECRET"));
});

test("production server binds PORT without contacting email service and survives DB failure", async (t) => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port),
      MONGODB_URI: "mongodb://127.0.0.1:1", DB_TIMEOUT_MS: "1000",
      JWT_SECRET: "production-startup-test-secret-more-than-32-bytes",
      PUBLIC_BASE_URL: "https://api.example.com", PASSWORD_RESET_URL: "https://app.example.com/reset-password",
      CORS_ORIGINS: "", EMAIL_PROVIDER: "resend", EMAIL_FROM: "noreply@example.com", RESEND_API_KEY: "dummy-test-key",
    }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    let output = "";
    const deadline = setTimeout(() => reject(new Error("Server did not start within 5 seconds")), 5000);
    child.once("error", (error) => { clearTimeout(deadline); reject(error); });
    child.once("exit", (code) => { clearTimeout(deadline); if (!output.includes("server.started")) reject(new Error(`Server exited with ${code}`)); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("server.started")) { clearTimeout(deadline); resolve(); }
    });
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).code, "DATABASE_NOT_READY");
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    const exit = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exit, 0);
  }
});

test("an occupied port exits with failure and never logs server.started", async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const child = spawnSync(process.execPath, ["server.js"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(occupied.address().port),
      MONGODB_URI: "mongodb://127.0.0.1:1",
      JWT_SECRET: "occupied-port-test-secret-more-than-32-bytes",
      PUBLIC_BASE_URL: "https://api.example.com", PASSWORD_RESET_URL: "https://app.example.com/reset-password",
      CORS_ORIGINS: "", EMAIL_PROVIDER: "resend", EMAIL_FROM: "noreply@example.com", RESEND_API_KEY: "dummy-test-key",
    }, encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  assert.equal(child.status, 1);
  assert.ok(child.stderr.includes("server.listen_failed"));
  assert.ok(child.stderr.includes("EADDRINUSE"));
  assert.ok(!child.stdout.includes('"event":"server.started"'));
});

test("shutdown signals and fatal exceptions close the server with the correct exit code", async () => {
  for (const [trigger, code, event] of [
    ["process.emit('SIGTERM')", 0, "server.stopping"],
    ["setImmediate(() => { throw new Error('fatal-test'); })", 1, "process.uncaught_exception"],
    ["Promise.reject(new Error('rejection-test'))", 1, "process.unhandled_rejection"],
  ]) {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const child = spawnSync(process.execPath, ["-e", `const server = require('./server').start(); server.once('listening', () => { ${trigger}; });`], {
      env: { ...process.env, NODE_ENV: "production", PORT: String(port),
        MONGODB_URI: "mongodb://127.0.0.1:1",
        JWT_SECRET: "shutdown-test-secret-more-than-32-bytes", CORS_ORIGINS: "",
        PUBLIC_BASE_URL: "https://api.example.com", PASSWORD_RESET_URL: "https://app.example.com/reset-password",
        EMAIL_PROVIDER: "resend", EMAIL_FROM: "noreply@example.com", RESEND_API_KEY: "dummy-test-key",
      }, encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    assert.equal(child.status, code, child.stderr);
    assert.ok((child.stdout + child.stderr).includes(event));
    assert.ok(child.stdout.includes("server.stopping"));
  }
});

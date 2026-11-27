const { test } = require("node:test");
const assert = require("node:assert/strict");
const SwaggerParser = require("@apidevtools/swagger-parser");
const { createOpenApi } = require("../docs/openapi");
const { createApp } = require("../app");

const config = { baseUrl: "https://api.example.com", environment: "production", platform: "render", port: 10000,
  corsOrigins: [], jwtSecret: "private-docs-test-secret-must-not-be-published" };
const makeApp = () => createApp({ config, database: { check: async () => { throw new Error("database offline"); } }, emailService: {}, userModel: {} });

test("OpenAPI validates and covers every registered API operation with request/response examples", async () => {
  const spec = createOpenApi(config);
  await SwaggerParser.validate(structuredClone(spec));
  const app = makeApp();
  const controllers = new Proxy({}, { get: () => (req, res) => res.end() });
  const routers = [
    ["", app.router],
    ["/api/auth", require("../routes/authRoutes")(controllers)],
    ["/api/users", require("../routes/userRoutes")(controllers, (req, res, next) => next())],
  ];
  let operationCount = 0;
  for (const [prefix, router] of routers) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        const path = `${prefix}${layer.route.path}`;
        const operation = spec.paths[path]?.[method];
        assert.ok(operation, `${method.toUpperCase()} ${path} is undocumented`);
        assert.ok(operation.operationId);
        operationCount++;
        if (["post", "put"].includes(method)) {
          assert.ok(operation.requestBody?.content["application/json"].example, `${path} needs a request example`);
        }
        for (const [status, response] of Object.entries(operation.responses)) {
          assert.ok(response.description, `${path} response ${status} needs a description`);
          assert.ok(response.headers["X-Request-Id"]);
          assert.ok(response.content["application/json"].example, `${path} response ${status} needs an example`);
        }
      }
    }
  }
  assert.ok(operationCount >= 15);
  const ids = Object.values(spec.paths).flatMap((path) => Object.values(path).map((op) => op.operationId));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(spec.paths["/health"].get.responses["503"].content["application/json"].example.code, "DATABASE_NOT_READY");
  assert.equal(spec.paths["/api/auth/register"].post.responses["503"].content["application/json"].example.code, "VERIFICATION_EMAIL_FAILED");
  assert.equal(spec.paths["/api/users/profile"].put.security[0].bearerAuth.length, 0);
  assert.ok(!spec.paths["/api/auth/login"].post.security);
});

test("Swagger page, local assets and spec remain accessible without a database or email", async (t) => {
  const server = makeApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const redirect = await fetch(`${base}/api-docs`, { redirect: "manual" });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get("location"), "/api-docs/");
  const htmlResponse = await fetch(`${base}/api-docs/`);
  assert.equal(htmlResponse.status, 200);
  assert.ok(htmlResponse.headers.get("content-type").includes("text/html"));
  const html = await htmlResponse.text();
  assert.ok(html.includes("Vehicle Finder API Documentation"));
  for (const asset of ["swagger-ui.css", "swagger-ui-bundle.js", "swagger-ui-standalone-preset.js", "swagger-ui-init.js"]) {
    assert.ok(html.includes(asset));
    const assetResponse = await fetch(`${base}/api-docs/${asset}`);
    assert.equal(assetResponse.status, 200);
    assert.ok((await assetResponse.text()).length > 100);
  }
  const init = await (await fetch(`${base}/api-docs/swagger-ui-init.js`)).text();
  assert.ok(init.includes('"url": "/openapi.json"'));
  assert.ok(init.includes('"validatorUrl": null'));
  assert.ok(init.includes('"persistAuthorization": false'));
  // Run the actual served initializer to verify the browser config resolves to
  // our local spec even if an untrusted ?url= is added to the documentation URL.
  let browserOptions;
  const bundle = (options) => { browserOptions = options; return {}; };
  bundle.presets = { apis: {} };
  bundle.plugins = { DownloadUrl: {} };
  const browser = { window: { location: { origin: base, search: "?url=https://untrusted.example/spec" } },
    SwaggerUIBundle: bundle, SwaggerUIStandalonePreset: {} };
  require("node:vm").runInNewContext(init, browser);
  browser.window.onload();
  assert.equal(browserOptions.url, "/openapi.json");
  assert.equal(browserOptions.validatorUrl, null);
  const specResponse = await fetch(`${base}/openapi.json`);
  const spec = await specResponse.json();
  assert.equal(specResponse.status, 200);
  assert.equal(spec.servers[0].url, "/");
  assert.equal(spec.servers[1].url, config.baseUrl);
  assert.ok(!JSON.stringify(spec).includes(config.jwtSecret));
  const status = await (await fetch(`${base}/`)).json();
  assert.equal(status.status, "running");
  assert.equal(status.docs, "/api-docs/");
  assert.equal(status.openapi, "/openapi.json");
  assert.equal((await fetch(`${base}/health`)).status, 503);
});

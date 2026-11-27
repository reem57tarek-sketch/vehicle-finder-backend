const { version } = require("../package.json");

const requestId = "c6d9310f-1823-4279-9fc4-19dfd154dd14";
const tokenExample = "a".repeat(64);
const userExample = {
  user_id: "507f1f77bcf86cd799439011", full_name: "Mostafa Sayed", email: "mostafa@example.com",
  phone_number: "01012345678", is_email_verified: true, created_at: "2026-11-23T12:00:00.000Z",
};
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const headers = { "X-Request-Id": { description: "Use this ID to find the request in server logs.", schema: { type: "string", format: "uuid" } } };
const json = (schema, example) => ({ "application/json": { schema, ...(example === undefined ? {} : { example }) } });
const success = (description, schema, example) => ({ description, headers, content: json(schema, example) });
const error = (description, message, code = "REQUEST_FAILED") => success(description, ref("Error"), { message, code, requestId });
const messageSchema = { type: "object", required: ["message"], properties: { message: { type: "string" } } };
const message = (text) => success(text, messageSchema, { message: text });
const userResponse = (text, example = userExample) => success(text, {
  type: "object", required: ["message", "user"], properties: { message: { type: "string" }, user: ref("User") },
}, { message: text, user: example });
const requestBody = (schema, example) => ({ required: true, content: json(schema, example) });
const bodySchema = (properties, required = Object.keys(properties)) => ({ type: "object", ...(required.length ? { required } : {}), properties });
const email = { type: "string", format: "email", maxLength: 254, example: "mostafa@example.com", description: "Trimmed and converted to lowercase." };
const password = { type: "string", format: "password", minLength: 8, maxLength: 72, description: "At least 8 characters and at most 72 UTF-8 bytes (bcrypt limit). Whitespace is not trimmed.", example: "ExamplePass123!" };
const existingPassword = { type: "string", format: "password", minLength: 1, maxLength: 72, description: "Current password; at most 72 UTF-8 bytes.", example: "ExamplePass123!" };
const token = { type: "string", pattern: "^[a-fA-F0-9]{64}$", minLength: 64, maxLength: 64, example: tokenExample, description: "Replace with the token from the email link. Single-use; expires after 15 minutes." };
const fullName = { type: "string", minLength: 1, maxLength: 200, example: "Mostafa Sayed", description: "Must contain a non-whitespace character; trimmed before saving." };
const phone = { type: "string", minLength: 1, maxLength: 32, example: "01012345678" };
const bearer = [{ bearerAuth: [] }];
const validation = error("Invalid or missing fields", "Invalid email", "VALIDATION_ERROR");
const internal = error("Unexpected server error; locate its cause using requestId", "Internal server error", "INTERNAL_ERROR");
const unavailable = error("Database or another required service is unavailable", "A required service is temporarily unavailable", "SERVICE_UNAVAILABLE");
const authRequired = error("Missing, invalid, or expired Bearer token", "Invalid or expired token", "INVALID_TOKEN");

function operation(operationId, summary, tags, responses, extra = {}) {
  return { operationId, summary, tags, responses: { "500": internal, "503": unavailable, ...responses }, ...extra };
}
function writeOperation(operationId, summary, tags, schema, example, responses, extra = {}) {
  return operation(operationId, summary, tags, {
    "400": validation,
    "413": error("JSON body exceeds 32KB", "Request body exceeds the size limit", "BODY_TOO_LARGE"),
    "415": error("Unsupported content encoding or charset", "Unsupported request encoding", "UNSUPPORTED_ENCODING"),
    ...responses,
  }, { requestBody: requestBody(schema, example), ...extra });
}

function createOpenApi(config) {
  const statusExample = {
    status: "running", message: "Vehicle Finder server is running", service: "Vehicle Finder API", version,
    environment: config.environment || "development", platform: config.platform || "standalone",
    baseUrl: config.baseUrl, host: config.host || "0.0.0.0", port: config.port || 3000,
    runtime: "Node.js", framework: "Express", uptimeSeconds: 120,
    timestamp: "2026-11-23T12:00:00.000Z", health: "/health", docs: "/api-docs/", openapi: "/openapi.json",
  };
  const readiness = (id) => operation(id, "Check database readiness", ["Status"], {
    "200": success("MongoDB is connected and user indexes are ready", ref("Readiness"), { status: "ok", database: "connected" }),
    "503": error("MongoDB is unreachable or user indexes cannot be initialized", "MongoDB is unavailable or its indexes are not ready", "DATABASE_NOT_READY"),
  }, { description: "Use this endpoint as the deployment healthcheck. Does not verify email delivery." });
  // Readiness has a specific 503 response; keep it instead of the generic default.
  const paths = {
    "/": { get: operation("getServerStatus", "Show server status and runtime details", ["Status"], {
      "200": success("HTTP server is running", ref("ServerStatus"), statusExample),
    }, { description: "Reports the HTTP process and configured public URL. Use /health to check the database. The internal listening port can differ from the public HTTPS port." }) },
    "/health/live": { get: operation("getLiveness", "Check HTTP process liveness", ["Status"], {
      "200": success("HTTP process is running", bodySchema({ status: { type: "string", enum: ["ok"] } }), { status: "ok" }),
    }) },
    "/health": { get: readiness("getReadiness") },
    "/api/db-check": { get: readiness("checkDatabase") },
    "/api/auth/register": { post: writeOperation("register", "Register and send a verification email", ["Authentication"],
      bodySchema({ full_name: fullName, email, password, phone_number: phone }, ["full_name", "email", "password"]),
      { full_name: "Mostafa Sayed", email: "mostafa@example.com", phone_number: "01012345678", password: "ExamplePass123!" }, {
        "201": userResponse("Registration successful. Please check your email to verify your account.", { ...userExample, is_email_verified: false }),
        "409": error("Email already registered or concurrent registration conflict", "Email already registered"),
        "503": error("Account was saved, but email failed; fix delivery and call resend-verification", "Account created, but verification email could not be sent. Use resend-verification to try again.", "VERIFICATION_EMAIL_FAILED"),
      }, { description: "Verification is required before login. If delivery fails after account creation, retry using /api/auth/resend-verification rather than registering again." }) },
    "/api/auth/login": { post: writeOperation("login", "Log in and obtain a one-hour JWT", ["Authentication"],
      bodySchema({ email, password: existingPassword }), { email: "mostafa@example.com", password: "ExamplePass123!" }, {
        "200": success("Login successful", bodySchema({ message: { type: "string" }, token: { type: "string", description: "Signed JWT; expires in one hour." }, user: ref("User") }),
          { message: "Login successful", token: "REPLACE_WITH_JWT_FROM_LOGIN", user: (({ created_at, ...user }) => user)(userExample) }),
        "401": error("Incorrect email or password", "Invalid email or password"),
        "403": error("Email has not been verified", "Please verify your email before logging in"),
      }, { description: "Copy the returned token into the Authorize button (without the Bearer prefix). Protected requests will send Authorization: Bearer <token>." }) },
    "/api/auth/verify-email": { get: operation("verifyEmail", "Verify an email address", ["Authentication"], {
      "200": userResponse("Email verified successfully", { user_id: "507f1f77bcf86cd799439011", full_name: "Mostafa Sayed", email: "mostafa@example.com", is_email_verified: true }),
      "400": error("Missing, malformed, expired, or previously used token", "Invalid or expired verification link"),
    }, { parameters: [{ name: "token", in: "query", required: true, schema: token, example: tokenExample }] }) },
    "/api/auth/forgot-password": { post: writeOperation("forgotPassword", "Send a password-reset link", ["Authentication"],
      bodySchema({ email }), { email: "mostafa@example.com" }, {
        "200": message("If the account exists, a reset link will be sent"),
        "503": error("Email delivery or database temporarily unavailable", "Email delivery is temporarily unavailable. Please try again later.", "EMAIL_DELIVERY_FAILED"),
      }, { description: "Known and unknown emails share the same success response. The email link opens the configured frontend reset page. Tokens expire after 15 minutes." }) },
    "/api/auth/resend-verification": { post: writeOperation("resendVerification", "Send a new verification link", ["Authentication"],
      bodySchema({ email }), { email: "mostafa@example.com" }, {
        "200": message("If the account needs verification, a verification link will be sent"),
        "503": error("Email delivery or database temporarily unavailable", "Email delivery is temporarily unavailable. Please try again later.", "EMAIL_DELIVERY_FAILED"),
      }, { description: "For unverified accounts, replaces the previous token. Unknown and already verified accounts receive the same success message without an email." }) },
    "/api/auth/reset-password": { post: writeOperation("resetPassword", "Reset a password using the emailed token", ["Authentication"],
      bodySchema({ token, newPassword: password }), { token: tokenExample, newPassword: "NewExamplePass123!" }, {
        "200": message("Password reset successfully"),
        "400": error("Invalid body or invalid, expired, or previously used token", "Invalid or expired reset link"),
      }, { description: "A successful reset consumes the token. Existing JWTs remain valid until their original expiration." }) },
    "/api/auth/profile": { get: operation("getTokenProfile", "Inspect authenticated JWT claims", ["Users"], {
      "200": success("Access granted", bodySchema({ message: { type: "string" }, user: ref("TokenClaims") }),
        { message: "Access granted", user: { user_id: "507f1f77bcf86cd799439011", email: "mostafa@example.com", iat: 1795435200, exp: 1795438800 } }),
      "401": authRequired,
    }, { security: bearer, description: "Returns JWT claims. Use GET /api/users/profile for the current database profile." }) },
    "/api/users/profile": {
      get: operation("getUserProfile", "Get the current user's database profile", ["Users"], {
        "200": userResponse("Profile retrieved successfully"), "401": authRequired,
        "404": error("The authenticated user no longer exists", "User not found"),
      }, { security: bearer }),
      put: writeOperation("updateUserProfile", "Update your name or phone number", ["Users"],
        { ...bodySchema({ full_name: fullName, phone_number: phone }, []), minProperties: 1,
          anyOf: [{ required: ["full_name"] }, { required: ["phone_number"] }] },
        { full_name: "Mostafa Sayed", phone_number: "01012345678" }, {
          "200": userResponse("Profile updated successfully"), "401": authRequired,
          "404": error("The authenticated user no longer exists", "User not found"),
          "409": error("Another account already uses a unique profile value", "Email or another unique value is already registered", "DUPLICATE_RESOURCE"),
        }, { security: bearer, description: "Send at least one of full_name or phone_number. Neither field accepts null or whitespace-only strings." }),
    },
    "/api/users/change-password": { put: writeOperation("changePassword", "Change your password while logged in", ["Users"],
      bodySchema({ currentPassword: existingPassword, newPassword: password }),
      { currentPassword: "ExamplePass123!", newPassword: "NewExamplePass123!" }, {
        "200": message("Password changed successfully"), "401": authRequired,
        "409": error("Password was changed by another request; retry with the current password", "Password changed during this request. Please try again.", "PASSWORD_CHANGED"),
        "400": error("Invalid body or incorrect current password", "Current password is incorrect"),
        "404": error("The authenticated user no longer exists", "User not found"),
      }, { security: bearer, description: "Clears any pending password-reset token. Existing JWTs expire normally after one hour." }) },
    "/openapi.json": { get: { operationId: "getOpenApi", summary: "Download this OpenAPI document", tags: ["Documentation"],
      responses: { "200": success("OpenAPI 3 document", { type: "object", additionalProperties: true }, { openapi: "3.0.3", info: { title: "Vehicle Finder API", version }, paths: {} }) } } },
    "/api-docs/": { get: { operationId: "getSwaggerUi", summary: "Open the interactive Swagger UI", tags: ["Documentation"],
      responses: { "200": { description: "Interactive API documentation", headers, content: { "text/html": { schema: { type: "string" }, example: "<!DOCTYPE html><html>...Swagger UI...</html>" } } } } } },
  };
  return {
    openapi: "3.0.3",
    info: { title: "Vehicle Finder API", version, description: [
      "Interactive documentation for every API endpoint. Expand a route to see request fields, examples and success/error responses.",
      "Start by registering, open the verification link from your email, then log in. Paste the returned JWT into **Authorize** to call protected routes.",
      "Examples use fictitious data. Replace email tokens and JWT placeholders with real values from your own test account.",
      "Requests with a body use application/json (32KB maximum). Errors include message, code and requestId; use the ID to locate the server log. Invalid JSON returns 400 INVALID_JSON. Unknown routes return 404 NOT_FOUND. Password recovery returns 503 PASSWORD_RESET_NOT_CONFIGURED when PASSWORD_RESET_URL is missing in production.",
      "CORS preflight OPTIONS requests return 204 for configured origins; disallowed origins receive 403 CORS_ORIGIN_DENIED.",
    ].join("\n\n") },
    servers: [{ url: "/", description: "Current server (local, Railway or Render)" },
      ...(config.baseUrl ? [{ url: config.baseUrl, description: "Configured public backend URL" }] : [])],
    tags: [
      { name: "Status", description: "HTTP process status and database readiness" },
      { name: "Authentication", description: "Registration, login, email verification and password recovery" },
      { name: "Users", description: "Authenticated profile and password management" },
      { name: "Documentation", description: "Interactive documentation and its OpenAPI source" },
    ],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Paste the JWT returned by POST /api/auth/login, without the Bearer prefix." } },
      schemas: {
        Error: bodySchema({ message: { type: "string" }, code: { type: "string" }, requestId: { type: "string", format: "uuid" } }),
        User: bodySchema({
          user_id: { type: "string", pattern: "^[a-fA-F0-9]{24}$", description: "MongoDB ObjectId returned as a hexadecimal string.", example: "507f1f77bcf86cd799439011" },
          full_name: fullName, email, phone_number: { ...phone, nullable: true }, is_email_verified: { type: "boolean" },
          created_at: { type: "string", format: "date-time" },
        }, ["user_id", "full_name", "email", "is_email_verified"]),
        TokenClaims: bodySchema({ user_id: { type: "string", pattern: "^[a-fA-F0-9]{24}$" }, email,
          iat: { type: "integer", description: "Issued at (Unix seconds)" }, exp: { type: "integer", description: "Expires at (Unix seconds)" } }),
        Readiness: bodySchema({ status: { type: "string", enum: ["ok"] }, database: { type: "string", enum: ["connected"] } }),
        ServerStatus: bodySchema({
          status: { type: "string", enum: ["running"] }, message: { type: "string" }, service: { type: "string" }, version: { type: "string" },
          environment: { type: "string" }, platform: { type: "string", enum: ["standalone", "railway", "render"] },
          baseUrl: { type: "string", format: "uri" }, host: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 },
          runtime: { type: "string" }, framework: { type: "string" }, uptimeSeconds: { type: "integer", minimum: 0 }, timestamp: { type: "string", format: "date-time" },
          health: { type: "string" }, docs: { type: "string" }, openapi: { type: "string" },
        }),
      },
    },
  };
}

module.exports = { createOpenApi };

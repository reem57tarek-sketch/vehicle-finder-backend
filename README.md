# Vehicle Finder Backend

Express API using MongoDB, JWT authentication, email verification and password recovery. Use Node.js 24.

## Setup

Install dependencies with npm ci, copy .env.example to .env, then configure:

| Variable | Purpose |
| --- | --- |
| MONGODB_URI | MongoDB connection string, e.g. mongodb://127.0.0.1:27017 or the mongodb+srv:// URL supplied by Atlas |
| MONGODB_DB_NAME | Database name; defaults to vehicle_finder |
| JWT_SECRET | Random secret containing at least 32 bytes |
| NODE_ENV | production on the hosting service |
| PUBLIC_BASE_URL | Public HTTPS backend URL; hosting domain variables can supply it |
| PASSWORD_RESET_URL | Frontend HTTPS reset-password page; missing in production disables recovery only |
| CORS_ORIGINS | Comma-separated frontend origins |
| EMAIL_PROVIDER | resend or smtp; disabled is allowed only in development |
| EMAIL_FROM | Sender address on your verified email domain |
| RESEND_API_KEY | Required for the Resend HTTPS provider |
| DB_POOL_MAX | Maximum MongoDB connection pool size per server; defaults to 10 |
| DB_TIMEOUT_MS | Connection, server selection, socket and queue timeout in milliseconds; defaults to 5000 |

Run npm start or npm run dev. The server listens on 0.0.0.0 and the platform PORT, defaulting to 3000 locally. GET / shows runtime details and documentation links. /api-docs/ serves interactive Swagger with request/response examples and Bearer authorization; /openapi.json serves the specification.

## MongoDB

The official MongoDB driver stores users in the users collection. Public user_id fields are MongoDB ObjectId strings. Passwords and email/reset tokens are hashed as before. Verification and reset tokens expire after 15 minutes and are consumed atomically. Concurrent password changes check the previous hash to avoid overwriting newer credentials.

The app connects lazily, creates a case-insensitive unique email index plus token indexes, and checks readiness before serving database operations. No SQL or migration command runs during startup. The MongoDB account needs permission to read/write the selected database and create its indexes. Existing duplicate emails can prevent unique-index creation; resolve them before using that collection. Token indexes are ordinary lookup indexes, not TTL indexes: expiring a token never deletes its user.

MongoDB Atlas connections must use the provider's URI, permitted database user and network access configuration. Keep TLS enabled for Atlas; this application does not disable certificate verification. Configure DB_TIMEOUT_MS and DB_POOL_MAX for your service size. See [MongoDB connection options](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/).

### Online Atlas setup

The environment template selects Atlas and leaves the local MongoDB URI commented out. There is no automatic fallback to localhost. Supply your actual Atlas URI; an empty MONGODB_URI intentionally fails configuration validation instead of connecting to a different database.

1. Create or select a cluster in MongoDB Atlas.
2. Create a database user with read/write access to vehicle_finder (Atlas account login and database credentials are separate).
3. Add your development machine's public IP and your hosting service's outbound IP addresses to the project's network access list.
4. Open Connect > Drivers, select Node.js, and copy the connection string into MONGODB_URI in your private .env. Replace the credential placeholders; percent-encode special characters in the password.
5. Keep MONGODB_DB_NAME=vehicle_finder. Set the same variables in Railway or Render, then restart/redeploy.
6. Request GET /health. A 200 response confirms the connection and index setup. A running root page alone does not confirm Atlas connectivity.

For Atlas, the environment template uses DB_TIMEOUT_MS=30000 to allow initial server discovery and TLS connection setup. Set this value in your hosting environment as well; the application default remains 5000ms when the variable is omitted.

See [Atlas connection instructions](https://www.mongodb.com/docs/atlas/driver-connection/) and [network access configuration](https://www.mongodb.com/docs/atlas/security/ip-access-list/). Do not paste live credentials into chat or commit them to Git.

Existing PostgreSQL data is not copied or deleted by this change. Moving existing accounts requires a separate export/import that maps IDs to ObjectIds, preserves password hashes, normalizes emails and converts timestamps to BSON dates. Old JWTs refer to old IDs; users should log in again after any data transfer. DATABASE_URL and DB_HOST/DB_USER/DB_PASSWORD settings are no longer used. Do not point MONGODB_URI at PostgreSQL.

## Deployment

On Railway or Render, configure the environment variables above using a MongoDB service or Atlas. The included Dockerfile starts node server.js directly. The Render Blueprint expects MONGODB_URI and does not provision MongoDB.

Use npm start as the Start Command and remove any old Pre-deploy Command that runs db:migrate. Deployments use /health/live, which checks the HTTP process only. GET /health and /api/db-check ping MongoDB and ensure user indexes are ready; failures return 503 DATABASE_NOT_READY. The root page and Swagger remain available while MongoDB is unavailable.

Render native Node build command: npm ci --omit=dev. Start command: npm start. Set NODE_VERSION to 24 and NODE_ENV to production. Let the platform supply PORT.

## Email and password recovery

Resend sends through HTTPS and is suitable for Render free services, which block common SMTP ports. Alternatively configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and optionally SMTP_SECURE. Configure PASSWORD_RESET_URL to an existing frontend page that reads ?token=... and posts token and newPassword to /api/auth/reset-password. Without that URL in production, password recovery returns 503 PASSWORD_RESET_NOT_CONFIGURED while the server stays online.

If registration returns VERIFICATION_EMAIL_FAILED, the account was saved. Fix email delivery and POST the email to /api/auth/resend-verification rather than registering again. Existing JWTs expire after one hour and are not immediately revoked by password changes.

## Logs and checks

Logs are JSON lines with a top-level message for hosting viewers. Every response has X-Request-Id; errors include message, code and requestId. Locate request.failed events by ID for stacks and causes. Request bodies, authorization headers and mail contents are not logged. MongoDB connection URLs and environment secrets are redacted.

Run npm run check for syntax checks and API tests, npm run test:coverage for coverage, and npm audit for known dependency vulnerabilities. Set TEST_MONGODB_URI to a separate local test MongoDB instance to enable the database integration test. It uses a randomly named database and drops only that database afterward. Without TEST_MONGODB_URI, that integration test is skipped. It covers indexes, the account lifecycle, duplicate emails, token expiry and atomic password changes. SMTP tests use a local test server without external mail.

Never commit .env or live credentials. Previously committed secrets remain in Git history and must be rotated if exposed.

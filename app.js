const express = require("express");
const AppError = require("./utils/AppError");
const errorHandler = require("./middleware/errorHandler");
const requestLogger = require("./middleware/requestLogger");
const { createUserModel } = require("./models/User");
const { createAuthController } = require("./controllers/authController");
const { createUserController } = require("./controllers/userController");
const { version } = require("./package.json");
const swaggerUi = require("swagger-ui-express");
const { createOpenApi } = require("./docs/openapi");

function createApp({ config, database, emailService, userModel = createUserModel(database) }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestLogger);
  app.use((req, res, next) => {


    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin) {
      res.vary("Origin");
      if (config.corsOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
        res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
      } else if (req.method === "OPTIONS") {
        return next(new AppError(403, "Origin is not allowed", "CORS_ORIGIN_DENIED"));
      }
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  const openapi = createOpenApi(config);
  app.get("/openapi.json", (req, res) => res.json(openapi));
  const docsOptions = {
    customSiteTitle: "Vehicle Finder API Documentation",
    swaggerOptions: {
      url: "/openapi.json",
      validatorUrl: null,
      persistAuthorization: false,
      displayRequestDuration: true,
      docExpansion: "list",
    },
  };
  app.use("/api-docs", (req, res, next) => { req.logRoute = "/api-docs"; next(); },
    swaggerUi.serveFiles(null, docsOptions), swaggerUi.setup(null, docsOptions));
  app.get("/", (req, res) => res.json({
    status: "running",
    message: "Vehicle Finder server is running",
    service: "Vehicle Finder API",
    version,
    environment: config.environment || "development",
    platform: config.platform || "standalone",
    baseUrl: config.baseUrl,
    host: config.host || "0.0.0.0",
    port: config.port || req.socket.localPort,
    runtime: "Node.js",
    framework: "Express",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    health: "/health",
    docs: "/api-docs/",
    openapi: "/openapi.json",
  }));
  app.get("/health/live", (req, res) => res.json({ status: "ok" }));
  const readiness = async (req, res) => {
    try {
      await database.check();
    } catch (cause) {
      throw new AppError(503, "MongoDB is unavailable or its indexes are not ready", "DATABASE_NOT_READY", { cause });
    }
    res.json({ status: "ok", database: "connected" });
  };
  app.get("/health", readiness);
  app.get("/api/db-check", readiness);
  const authMiddleware = require("./middleware/authMiddleware")(config.jwtSecret);
  app.get("/api/auth/profile", authMiddleware, (req, res) => res.json({ message: "Access granted", user: req.user }));
  app.use("/api/auth", require("./routes/authRoutes")(createAuthController(userModel, emailService, config)));
  app.use("/api/users", require("./routes/userRoutes")(createUserController(userModel), authMiddleware));
  app.use((req, res, next) => next(new AppError(404, "Route not found", "NOT_FOUND")));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };

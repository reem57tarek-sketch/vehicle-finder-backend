require("dotenv").config({ quiet: true });
const logger = require("./utils/logger");
const { loadConfig } = require("./config/env");
const { createDatabase } = require("./config/db");
const { createEmailService } = require("./services/emailService");
const { createApp } = require("./app");

function start() {
  const config = loadConfig();
  const database = createDatabase(config);
  const emailService = createEmailService(config);
  const app = createApp({ config, database, emailService });
  const server = app.listen(config.port, config.host);
  server.once("listening", () => {
    logger.info("server.started", { port: config.port, host: config.host, environment: process.env.NODE_ENV || "development" });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  let stopping = false;
  function shutdown(reason, exitCode = 0) {
    if (stopping) return;
    stopping = true;
    logger.info("server.stopping", { reason });
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(async () => {
      try {
        emailService.close();
        await database.close();
      } catch (error) {
        logger.error("server.shutdown_failed", { error });
        exitCode = 1;
      }
      clearTimeout(deadline);
      process.exitCode = exitCode;
    });
  }
  server.on("error", (error) => {
    logger.error("server.listen_failed", { error });
    shutdown("listen_error", 1);
  });
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("uncaughtException", (error) => {
    logger.error("process.uncaught_exception", { error });
    shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (error) => {
    logger.error("process.unhandled_rejection", { error });
    shutdown("unhandledRejection", 1);
  });
  return server;
}
if (require.main === module) {
  try { start(); } catch (error) {
    logger.error("server.startup_failed", { error });
    process.exitCode = 1;
  }
}
module.exports = { start };

const AppError = require("../utils/AppError");
const logger = require("../utils/logger");
function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let status = error instanceof AppError ? error.status : 500;
  let code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
  let message = error instanceof AppError ? error.message : "Internal server error";
  if (error.type === "entity.parse.failed") [status, code, message] = [400, "INVALID_JSON", "Request body must be valid JSON"];
  if (error.type === "entity.too.large") [status, code, message] = [413, "BODY_TOO_LARGE", "Request body exceeds the size limit"];
  if (error.status === 415) [status, code, message] = [415, "UNSUPPORTED_ENCODING", "Unsupported request encoding"];
  if (error.code === 11000) [status, code, message] = [409, "DUPLICATE_RESOURCE", "Email or another unique value is already registered"];
  if (["MongoServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError", "MongoOperationTimeoutError", "MongoWaitQueueTimeoutError"].includes(error.name) || error.code === 50 || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(error.code)) {
    [status, code, message] = [503, "SERVICE_UNAVAILABLE", "A required service is temporarily unavailable"];
  }
  const loggedError = error.type === "entity.parse.failed" ? {
    name: error.name, message: "Malformed JSON request",
    stack: error.stack?.split("\n").filter((line) => /^\s+at /.test(line)).join("\n"),
  } : error;
  logger[status >= 500 ? "error" : "warn"]("request.failed", {
    requestId: req.id, method: req.method,
    route: req.logRoute || `${req.logBaseUrl || ""}${req.route?.path || "/unmatched"}`, status, code, error: loggedError,
  });
  res.status(status).json({ message, code, requestId: req.id });
}
module.exports = errorHandler;

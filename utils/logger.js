const sensitiveKey = /password|secret|token|authorization|cookie|api.?key|connectionstring|database_url|mongodb_uri|^body$|^headers$/i;
function redact(value) {
  if (typeof value !== "string") return value;
  let result = value.replace(/(?:mongodb(?:\+srv)?|postgres(?:ql)?|https?):\/\/[^\s"<>]+/gi, "[REDACTED_URL]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:password|token|secret|api_key)=)[^\s&]+/gi, "$1[REDACTED]");
  for (const [key, secret] of Object.entries(process.env)) {
    if (sensitiveKey.test(key) && secret && secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}
function clean(value, seen = new WeakSet()) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (value instanceof Error) return { name: value.name, message: redact(value.message), code: clean(value.code, seen),
      stack: redact(value.stack), cause: value.cause ? clean(value.cause, seen) : undefined };
    if (Array.isArray(value)) return value.map((item) => clean(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, sensitiveKey.test(key) ? "[REDACTED]" : clean(item, seen)]));
  }
  return redact(value);
}
function write(level, event, fields = {}) {
  const safeFields = clean(fields);
  // Hosting log viewers commonly display only the top-level message field.
  // Keep structured details while making failures visible in their text view.
  const message = safeFields.error?.message ? `${event}: ${safeFields.error.message}` : event;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeFields, message });
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}
module.exports = {
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields), clean,
};

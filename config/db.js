const { MongoClient } = require("mongodb");
const logger = require("../utils/logger");
function createDatabase(config) {
  const client = new MongoClient(config.mongoUri, {
    maxPoolSize: config.dbPoolMax, serverSelectionTimeoutMS: config.dbTimeout,
    connectTimeoutMS: config.dbTimeout, socketTimeoutMS: config.dbTimeout,
    waitQueueTimeoutMS: config.dbTimeout, appName: "vehicle-finder-backend",
  });
  const db = client.db(config.mongoDbName);
  let initialization;
  async function ready() {
    if (!initialization) initialization = (async () => {
      await client.connect();
      await db.collection("users").createIndexes([
        { key: { email: 1 }, name: "users_email_unique", unique: true, collation: { locale: "en", strength: 2 } },
        { key: { verification_token_hash: 1 }, name: "users_verification_token" },
        { key: { reset_token_hash: 1 }, name: "users_reset_token" },
      ]);
      logger.info("database.ready", { engine: "mongodb" });
    })().catch((error) => { initialization = undefined; throw error; });
    await initialization;
  }
  return { async users() { await ready(); return db.collection("users"); },
    async check() { await ready(); await db.command({ ping: 1 }); },
    async close() { await initialization?.catch(() => {}); await client.close(); },
  };
}
module.exports = { createDatabase };

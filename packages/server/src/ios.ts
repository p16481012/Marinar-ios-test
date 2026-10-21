// Embedded entry point: the native app owns the process and its lifecycle.
import "./config/ios-runtime.js";
import "./lib/compromised-certificate-authorities.js";
import { buildApp } from "./app.js";
import { getIosRuntimeConfig } from "./config/ios-runtime.js";
import { closeDB, flushDB } from "./db/connection.js";
import { logger } from "./lib/logger.js";

async function main() {
  const config = getIosRuntimeConfig();
  const app = await buildApp();
  try {
    // Initial seeds must be durable before the native shell opens the UI.
    await flushDB();
    await app.listen({ host: "127.0.0.1", port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  logger.info("Marinara iOS server is ready on device loopback");
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void app.close().catch((error) => logger.error(error, "iOS server close failed"));
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

try {
  await main();
} catch (error) {
  logger.error(error, "Marinara iOS startup failed");
  await closeDB();
  process.exitCode = 1;
  throw error;
}

import type { FastifyInstance } from "fastify";
import { APP_VERSION } from "@marinara-engine/shared";
import { getIosRuntimeConfig } from "../config/ios-runtime.js";
import { flushDB } from "../db/connection.js";
import { hasIosNativeToken } from "../middleware/ios-runtime.js";
import { flushLorebookActivationStats } from "../services/lorebook/activation-stats.js";

export async function iosRoutes(app: FastifyInstance) {
  app.get("/health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      ready: true,
      deploymentId: getIosRuntimeConfig().deploymentId,
      version: APP_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
    };
  });
  app.get("/capabilities", async () => ({
    runtime: "ios",
    remoteApiChat: true,
    fileStorage: true,
    localModels: false,
    localEmbeddings: false,
    nativeImageProcessing: false,
    pdfDocuments: false,
    serverExtensions: false,
    downloadedCapabilities: false,
    desktopLoginProviders: false,
    scriptTools: false,
    desktopShell: false,
    multiplayer: false,
    autonomousConversations: false,
    inAppSourceUpdates: false,
    continuousBackgroundGeneration: false,
  }));
  app.post("/flush", { bodyLimit: 1024 }, async (request, reply) => {
    if (!hasIosNativeToken(request)) {
      return reply.code(403).send({ error: "The native iOS lifecycle token is required" });
    }
    // The file-store controller flush uses force=true, throwOnError=true.
    // Never acknowledge a successful save when the underlying disk write failed.
    await flushLorebookActivationStats(app.db);
    await flushDB();
    return { ok: true };
  });
}

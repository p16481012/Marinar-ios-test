import type { FastifyInstance } from "fastify";
import { APP_VERSION } from "@marinara-engine/shared";
import { getIosRuntimeConfig } from "../config/ios-runtime.js";
import { flushDB } from "../db/connection.js";
import { hasIosNativeToken } from "../middleware/ios-runtime.js";
import { flushLorebookActivationStats } from "../services/lorebook/activation-stats.js";
import {
  cancelIosRestore,
  getIosBackupDownload,
  getIosBackupStatus,
  getIosRestoreStatus,
  initializeIosBackup,
  stageIosRestore,
  startIosBackup,
} from "../services/ios/backup.js";

export async function iosRoutes(app: FastifyInstance) {
  await initializeIosBackup(app);
  app.get("/health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const restore = await getIosRestoreStatus();
    if (restore.status === "applying") return reply.code(503).send({ ready: false });
    return {
      ready: true,
      deploymentId: getIosRuntimeConfig().deploymentId,
      version: APP_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      ...(restore.status === "applied" ? { restoreAppliedAt: restore.createdAt } : {}),
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
  app.get("/backup/status", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return getIosBackupStatus();
  });
  app.post("/backup/start", { bodyLimit: 1024 }, async (_request, reply) => {
    return reply.code(202).send(await startIosBackup(app));
  });
  app.get("/backup/download", async (_request, reply) => {
    const backup = getIosBackupDownload();
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${backup.filename}"`)
      .header("Content-Length", backup.bytes)
      .send(backup.stream);
  });
  app.get("/restore/status", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return getIosRestoreStatus();
  });
  app.delete("/restore/stage", async () => cancelIosRestore());
  app.post("/restore/stage", async (request, reply) => {
    if (request.headers["x-marinara-confirm-restore"] !== "1") {
      return reply.code(400).send({ error: "Confirm that a full restore will replace this app's current data" });
    }
    const file = await request.file({ limits: { fields: 0, files: 1, parts: 1, fileSize: 1024 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: "Select an iOS full backup ZIP" });
    const result = await stageIosRestore(app, file.file);
    return reply.code(202).send(result);
  });
}

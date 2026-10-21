import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { APP_VERSION } from "@marinara-engine/shared";
import core from "../../../../../ios-app/scripts/restore-core.cjs";
import { getIosRuntimeConfig } from "../../config/ios-runtime.js";
import { flushDB } from "../../db/connection.js";
import {
  encodeShardKey,
  FILE_BACKED_TABLES,
  getFileTableShardStrategy,
  STORAGE_VERSION,
} from "../../db/file-backed-store.js";
import { getFileTableConfig, isFileTable } from "../../db/file-schema.js";
import * as schema from "../../db/schema/index.js";
import { getEncryptionKeyForBackup } from "../../utils/crypto.js";
import { writeStoredZipArchive } from "../../routes/backup.routes.js";
import { flushLorebookActivationStats } from "../lorebook/activation-stats.js";
import { beginIosMaintenance, setIosRestorePending } from "./maintenance.js";
import { logger } from "../../lib/logger.js";
import { createDecipheriv } from "node:crypto";

type BackupStatus = {
  status: "idle" | "preparing" | "ready" | "failed";
  filename?: string;
  bytes?: number;
  downloadUrl?: string;
  createdAt?: string;
  error?: string;
};
let backupStatus: BackupStatus = { status: "idle" };
let backupFile: string | null = null;
let backupWork: Promise<void> | null = null;
let activeDownloads = 0;
let stageBusy = false;
const tables = new Map(
  Object.values(schema)
    .filter(isFileTable)
    .map((table) => [getFileTableConfig(table).name, table]),
);
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const configuration = () => {
  const config = getIosRuntimeConfig();
  return { dataDir: config.dataDir, envFile: config.envFile };
};

function rejectGeneration(app: FastifyInstance) {
  if ((app as unknown as { activeGenerations?: Map<string, unknown> }).activeGenerations?.size) {
    throw fail("Stop or finish the active generation before backing up or restoring", 409);
  }
}

export async function getIosRestoreStatus() {
  const journal = await core.readJournal(configuration());
  return {
    status: journal.status,
    restartRequired: journal.status === "staged",
    createdAt: journal.createdAt,
    message: journal.message,
    files: journal.files,
    bytes: journal.bytes,
  };
}

export async function initializeIosBackup(app: FastifyInstance) {
  setIosRestorePending((await getIosRestoreStatus()).status === "staged");
  const config = configuration();
  for (const [directory, ownedName] of [
    [join(dirname(config.envFile), "ios-backup"), /^(?:snapshot-|Marinar-iOS-full-)/u],
    [core.locations(config).root, /^incoming-/u],
  ] as const) {
    if (!(await core.exists(directory))) continue;
    if (!(await lstat(directory)).isDirectory()) throw fail("Backup staging directory must not be a link");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ownedName.test(entry.name))
        await rm(join(directory, entry.name), { recursive: entry.isDirectory(), force: true });
    }
  }
  app.addHook("onClose", async () => {
    await backupWork;
  });
}

export const getIosBackupStatus = () => ({ ...backupStatus });

/** Validate every table before publishing a snapshot that a loader might silently heal. */
async function validateStorage(stage: string) {
  const root = join(stage, "data/storage");
  const keyText = (await readFile(join(stage, "data/.encryption-key"), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/iu.test(keyText)) throw fail("Backup encryption key is invalid");
  const key = Buffer.from(keyText, "hex");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (
    manifest.version !== STORAGE_VERSION ||
    manifest.backend !== "file-native" ||
    !manifest.tables ||
    typeof manifest.tables !== "object" ||
    Array.isArray(manifest.tables) ||
    !manifest.shards ||
    typeof manifest.shards !== "object" ||
    Array.isArray(manifest.shards)
  )
    throw fail("Unsupported backup storage format");
  const counts = new Map<string, number>();
  const shards = new Map<string, number>();
  const ids = new Map<string, Set<unknown>>();
  const messageOwners = new Map<string, string>();
  const swipeOwners: Array<{ messageId: string; filename: string }> = [];
  async function visit(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), name + "/");
        continue;
      }
      if (!entry.isFile() || !name.endsWith(".json")) throw fail("Unexpected backup table file");
      const parts = name.split("/");
      if (parts.length !== 2) throw fail("Backup table files must use the current sharded storage layout");
      const tableName = parts[0]!;
      const table = tables.get(tableName);
      if (!table || !FILE_BACKED_TABLES.includes(tableName)) throw fail("Backup contains an unknown storage table");
      const columns = getFileTableConfig(table).columns;
      const primary = columns.find((column) => column.primary);
      const rows = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
      if (!Array.isArray(rows)) throw fail("Backup table must contain a row array");
      const strategy = getFileTableShardStrategy(tableName as Parameters<typeof getFileTableShardStrategy>[0]);
      const keys = ids.get(tableName) ?? new Set();
      ids.set(tableName, keys);
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw fail("Backup contains an invalid table row");
        for (const column of columns) {
          const value = row[column.key];
          if (column.isNotNull && (value === undefined || value === null))
            throw fail("Backup is missing a required table field");
          if (value === null || value === undefined) continue;
          if (column.key.endsWith("Encrypted") && value !== "") {
            if (typeof value !== "string" || !/^[a-f0-9]{24}:[a-f0-9]+:[a-f0-9]{32}$/iu.test(value))
              throw fail("Backup contains an invalid encrypted credential");
            try {
              const [iv, ciphertext, tag] = value.split(":") as [string, string, string];
              const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
              decipher.setAuthTag(Buffer.from(tag, "hex"));
              decipher.update(Buffer.from(ciphertext, "hex"));
              decipher.final();
            } catch {
              throw fail("Backup encryption key does not match its saved credentials");
            }
          }
          const expected = column.defaultValue;
          if (["string", "number", "boolean"].includes(typeof expected) && typeof value !== typeof expected)
            throw fail("Backup contains a field of the wrong type");
          const jsonColumn =
            (typeof expected === "string" && /^[\[{]/u.test(expected.trim())) ||
            (["characters", "character_card_versions"].includes(tableName) && column.key === "data");
          if (jsonColumn) {
            if (typeof value !== "string") throw fail("Backup contains invalid serialized JSON");
            const parsed = JSON.parse(value);
            if (!parsed || typeof parsed !== "object") throw fail("Backup contains invalid serialized JSON");
          }
        }
        if (primary) {
          const value = row[primary.key];
          if (typeof value !== "string" || !value || keys.has(value))
            throw fail("Backup contains missing or duplicate row identifiers");
          keys.add(value);
        }
        const ownerValue = row[strategy.column];
        if (ownerValue !== null && ownerValue !== undefined && typeof ownerValue !== "string")
          throw fail("Backup contains an invalid storage ownership field");
        const owner = ownerValue || "orphaned-rows";
        if (tableName === "messages") messageOwners.set(row.id, owner);
        if (strategy.kind === "message-parent") {
          swipeOwners.push({ messageId: row.messageId, filename: entry.name });
        } else if (entry.name !== encodeShardKey(owner) + ".json") {
          throw fail("Backup row does not match its storage shard");
        }
      }
      counts.set(tableName, (counts.get(tableName) ?? 0) + rows.length);
      shards.set(tableName, (shards.get(tableName) ?? 0) + 1);
    }
  }
  await visit(join(root, "tables"));
  for (const swipe of swipeOwners) {
    if (swipe.filename !== encodeShardKey(messageOwners.get(swipe.messageId) ?? "orphaned-rows") + ".json")
      throw fail("Backup message swipe does not match its parent storage shard");
  }
  for (const [table, count] of Object.entries(manifest.tables)) {
    if (
      !tables.has(table) ||
      !Number.isSafeInteger(count) ||
      (count as number) < 0 ||
      (counts.get(table) ?? 0) !== count
    )
      throw fail("Backup table counts do not match its storage manifest");
  }
  for (const [table, count] of counts)
    if (manifest.tables[table] !== count) throw fail("Backup contains unlisted storage rows");
  for (const table of FILE_BACKED_TABLES) {
    if (manifest.tables[table] !== (counts.get(table) ?? 0) || manifest.shards[table] !== (shards.get(table) ?? 0))
      throw fail("Backup storage manifest is incomplete or has inconsistent shard counts");
  }
  for (const table of Object.keys(manifest.shards))
    if (!FILE_BACKED_TABLES.includes(table)) throw fail("Backup storage manifest contains an unknown shard table");
}

async function copySnapshot(app: FastifyInstance, directory: string) {
  const config = configuration();
  const data = join(directory, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  let bytes = 0;
  const canonicalData = await realpath(config.dataDir);
  async function copyTree(source: string, prefix: string) {
    const sourceInfo = await lstat(source);
    const sourceRelative = relative(canonicalData, await realpath(source));
    if (
      !sourceInfo.isDirectory() ||
      sourceRelative === ".." ||
      sourceRelative.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) ||
      isAbsolute(sourceRelative)
    )
      throw fail("Backup source leaves the data directory or is a link");
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const relative = prefix + "/" + entry.name;
      if (entry.isDirectory()) {
        if (relative === "data/storage/.writer-lease") continue;
        await copyTree(join(source, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) throw fail("A backup source is a symbolic link or unsupported file");
      if (relative.startsWith("data/storage/") && !relative.endsWith(".json")) continue;
      if (!core.isDataPath(relative)) throw fail("A backup source has an unsupported path");
      const sourcePath = join(source, entry.name);
      const info = await stat(sourcePath);
      if (
        info.size > core.MAX_FILE_BYTES ||
        (bytes += info.size) > core.MAX_BYTES ||
        files.length >= core.MAX_FILES - 1
      )
        throw fail("Backup exceeds the iOS limit (1 GiB total, 256 MiB per file)", 413);
      const output = join(directory, ...relative.split("/"));
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await copyFile(sourcePath, output);
      files.push({ path: relative, ...(await core.hashFile(output)) });
    }
  }
  await flushLorebookActivationStats(app.db);
  await app.db.transaction(async (db) => {
    // Loading all known tables repairs bak-only shards before the durable copy.
    for (const table of tables.values()) await db.select().from(table as any);
    if (app.db._fileStore.getQuarantinedTables().length)
      throw fail("Repair quarantined storage before creating a full backup", 409);
    await flushDB();
    await copyTree(join(config.dataDir, "storage"), "data/storage");
    for (const name of core.ASSET_ROOTS)
      if (await core.exists(join(config.dataDir, name))) await copyTree(join(config.dataDir, name), "data/" + name);
    const keyFile = join(data, ".encryption-key");
    await writeFile(keyFile, getEncryptionKeyForBackup() + "\n", { mode: 0o600 });
    files.push({ path: "data/.encryption-key", ...(await core.hashFile(keyFile)) });
  });
  const manifest = {
    format: core.FORMAT,
    formatVersion: 1,
    storageVersion: STORAGE_VERSION,
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  core.validateManifest(manifest);
  await validateStorage(directory);
  await core.atomicJson(join(directory, "backup-manifest.json"), manifest);
  return manifest;
}

export async function startIosBackup(app: FastifyInstance) {
  rejectGeneration(app);
  const release = await beginIosMaintenance();
  if (activeDownloads > 0) {
    release();
    throw fail("Wait for the current backup download to finish before creating another backup", 409);
  }
  const config = configuration();
  backupStatus = { status: "preparing", createdAt: new Date().toISOString() };
  backupWork = (async () => {
    let temporary: string | null = null;
    let partialArchive: string | null = null;
    try {
      const parent = join(dirname(config.envFile), "ios-backup");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      temporary = await mkdtemp(join(parent, "snapshot-"));
      const manifest = await copySnapshot(app, temporary);
      const filename = `Marinar-iOS-full-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      const archive = join(parent, filename);
      partialArchive = archive;
      await writeStoredZipArchive(
        archive,
        [
          {
            entryName: "backup-manifest.json",
            filePath: join(temporary, "backup-manifest.json"),
            size: (await stat(join(temporary, "backup-manifest.json"))).size,
          },
          ...manifest.files.map((file) => ({
            entryName: file.path,
            filePath: join(temporary!, ...file.path.split("/")),
            size: file.size,
          })),
        ],
        { entryLimitBytes: core.MAX_FILE_BYTES },
      );
      const size = (await stat(archive)).size;
      if (size > core.MAX_BYTES) {
        await rm(archive, { force: true });
        throw fail("Backup ZIP exceeds 1 GiB", 413);
      }
      if (backupFile) await rm(backupFile, { force: true });
      backupFile = archive;
      partialArchive = null;
      backupStatus = {
        ...backupStatus,
        status: "ready",
        filename,
        bytes: size,
        downloadUrl: "/api/ios/backup/download",
      };
    } catch (error) {
      logger.error(error, "iOS full backup failed");
      backupStatus = {
        ...backupStatus,
        status: "failed",
        error: error instanceof Error ? error.message : "Full backup failed",
      };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (partialArchive) await rm(partialArchive, { force: true }).catch(() => {});
      release();
    }
  })();
  return getIosBackupStatus();
}

export function getIosBackupDownload() {
  if (backupStatus.status !== "ready" || !backupFile) throw fail("No completed iOS full backup is ready", 409);
  const stream = createReadStream(backupFile);
  activeDownloads++;
  stream.once("close", () => {
    activeDownloads--;
  });
  return { stream, filename: backupStatus.filename!, bytes: backupStatus.bytes! };
}

export async function stageIosRestore(app: FastifyInstance, incoming: AsyncIterable<Buffer>) {
  rejectGeneration(app);
  const release = await beginIosMaintenance();
  stageBusy = true;
  const config = configuration();
  const paths = core.locations(config);
  let temporary: string | null = null;
  try {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    temporary = await mkdtemp(join(paths.root, "incoming-"));
    const archive = join(temporary, "upload.zip");
    let uploaded = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        uploaded += chunk.length;
        callback(uploaded > core.MAX_BYTES ? fail("iOS full backup ZIP exceeds 1 GiB", 413) : null, chunk);
      },
    });
    await pipeline(incoming, limiter, createWriteStream(archive, { mode: 0o600 }));
    const entries = await core.readStoredZip(archive);
    const manifestEntry = entries.find((entry) => entry.name === "backup-manifest.json");
    if (!manifestEntry || manifestEntry.size > 8 * 1024 * 1024) throw fail("Select a Marinar iOS full backup ZIP");
    const stage = join(temporary, "validated");
    await mkdir(stage, { mode: 0o700 });
    await core.extractEntry(archive, manifestEntry, join(stage, manifestEntry.name));
    const manifest = JSON.parse(await readFile(join(stage, manifestEntry.name), "utf8"));
    core.validateManifest(manifest);
    const expected = new Map<string, { path: string; size: number; sha256: string }>(
      manifest.files.map((file: any) => [file.path, file]),
    );
    if (entries.length !== expected.size + 1) throw fail("Backup contains missing or unlisted files");
    for (const entry of entries) {
      if (entry === manifestEntry) continue;
      const item = expected.get(entry.name);
      if (!item || item.size !== entry.size) throw fail("Backup file does not match its manifest");
      const actual = await core.extractEntry(archive, entry, join(stage, ...entry.name.split("/")));
      if (actual.sha256 !== item.sha256) throw fail("Backup checksum validation failed");
    }
    const checked = await core.validateTree(stage);
    await validateStorage(stage);
    if (await core.exists(paths.rollback))
      throw fail("Previous restore recovery must finish before staging another restore", 409);
    await rm(paths.stage, { recursive: true, force: true });
    await rename(stage, paths.stage);
    await core.atomicJson(paths.journal, {
      status: "staged",
      restartRequired: true,
      createdAt: new Date().toISOString(),
      manifestHash: checked.manifestHash,
      ...checked.summary,
      message:
        "Backup checked. Completely close and reopen the app to replace its current data. You can cancel before restarting.",
    });
    setIosRestorePending(true);
    return getIosRestoreStatus();
  } catch (error) {
    if (error instanceof Error && !("statusCode" in error)) Object.assign(error, { statusCode: 400 });
    throw error;
  } finally {
    stageBusy = false;
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

export async function cancelIosRestore() {
  if (stageBusy) throw fail("Wait for backup validation to finish", 409);
  const config = configuration();
  const names = core.locations(config);
  const journal = await core.readJournal(config);
  if (journal.status === "applying") throw fail("Restore is being applied", 409);
  await core.atomicJson(names.journal, { status: "idle", restartRequired: false });
  await rm(names.stage, { recursive: true, force: true });
  setIosRestorePending(false);
  return { status: "idle", restartRequired: false };
}

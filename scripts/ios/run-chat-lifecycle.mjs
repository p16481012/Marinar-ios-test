#!/usr/bin/env node
// Host-side integration check of the actual iOS server entry point and file store.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockProvider } from "./mock-openai-provider.mjs";
import { runChatPhase } from "./verify-chat-lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const entry = resolve(root, option("--entry") ?? "packages/server/dist/ios.js");
const output = resolve(root, option("--output") ?? ".tmp/ios-chat-lifecycle");
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(join(output, "profile-"));
const installationId = randomUUID();
const stateFile = join(output, "chat-state.json");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const logs = [];
let running;

async function freePort() {
  const probe = createServer();
  await new Promise((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", done); });
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}

async function stopServer() {
  if (!running) return;
  const current = running;
  running = undefined;
  // Deliberately bypass all shutdown hooks after /api/ios/flush acknowledges the save.
  // This checks persistence across a hard app-process replacement, not just a cache reopen.
  if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGKILL");
  await Promise.race([current.exit, sleep(5_000).then(() => { throw new Error("Test server did not terminate"); })]);
  await writeFile(join(output, `server-${current.index}.log`), current.log.join(""));
}

async function startServer() {
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;
  const configPath = join(dataDir, "launch-config.json");
  const runtimeRoot = dirname(entry);
  await writeFile(configPath, JSON.stringify({
    dataDir, envFile: join(dataDir, ".env"), port, token,
    deploymentId: "development", installationId, runtimeRoot, clientRoot: join(runtimeRoot, "client"),
  }) + "\n", { mode: 0o600 });
  const env = {
    ...process.env, NODE_ENV: "production", MARINARA_IOS: "1", MARINARA_LITE: "1",
    MARINARA_IOS_TOKEN: token, MARINARA_IOS_INSTALLATION_ID: installationId,
    DATA_DIR: dataDir, FILE_STORAGE_DIR: join(dataDir, "storage"),
    MARINARA_ENV_FILE: join(dataDir, ".env"), HOST: "127.0.0.1", PORT: String(port),
    LOG_LEVEL: "warn", AUTO_CREATE_DEFAULT_CONNECTION: "false", NO_COLOR: "1",
  };
  const childArgs = basename(entry) === "bootstrap.cjs" ? [entry, configPath] : [entry];
  const child = spawn(process.execPath, childArgs, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const current = { child, baseUrl, token, index: logs.length + 1, log: [], exit: undefined };
  current.exit = new Promise((done) => { child.once("error", (error) => { current.error = error; done(); }); child.once("exit", done); });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    // Even failing startup checks must never leave the per-launch token in CI artifacts.
    current.log.push(chunk.toString().replaceAll(token, "[REDACTED_IOS_TOKEN]"));
  });
  logs.push(current);
  running = current;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (current.error) throw current.error;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`iOS server entry exited before readiness: ${current.log.join("").slice(-6000)}`);
    }
    try {
      const health = await fetch(`${baseUrl}/api/ios/health`, {
        headers: { "x-marinara-ios-token": token }, signal: AbortSignal.timeout(2_000),
      });
      if (health.ok && (await health.json()).ready === true) return current;
    } catch { /* Startup may still be opening the durable store and seeding defaults. */ }
    await sleep(200);
  }
  throw new Error(`iOS server readiness timed out: ${current.log.join("").slice(-6000)}`);
}

const mock = await startMockProvider();
const report = { platform: process.platform, node: process.version, entry, passed: false, physicalDeviceValidated: false };
try {
  console.log("Starting the iOS server entry with an isolated fixture profile.");
  const first = await startServer();
  const exercised = await runChatPhase({ phase: "exercise", baseUrl: first.baseUrl, providerUrl: mock.baseUrl, token: first.token, stateFile });
  assert.ok(exercised.checks.includes("native-flush-acknowledged"));
  await stopServer();
  console.log("Replacing the server process after the native flush acknowledgement.");
  const second = await startServer();
  assert.notEqual(first.token, second.token, "A new launch uses a new authentication token");
  const restored = await runChatPhase({ phase: "restore", baseUrl: second.baseUrl, providerUrl: mock.baseUrl, token: second.token, stateFile });
  report.checks = restored.checks;
  report.providerCalls = mock.calls.map(({ id, kind, streaming, completed, disconnected }) => ({ id, kind, streaming, completed, disconnected }));
  report.passed = true;
  console.log(`Passed ${report.checks.length} chat lifecycle checks using the actual server routes.`);
} catch (error) {
  report.error = String(error.stack ?? error);
  for (const item of logs) report.error = report.error.replaceAll(item.token, "[REDACTED_IOS_TOKEN]");
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await stopServer();
  await mock.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

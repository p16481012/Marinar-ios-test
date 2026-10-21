import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loopbackUrl } from "./verify-chat-lifecycle.mjs";

export function createTestApi(baseUrl, token) {
  const origin = loopbackUrl(baseUrl).origin;
  assert.match(token, /^[a-f0-9]{64}$/i);
  const headers = { origin, "x-marinara-csrf": "1", "x-marinara-ios-token": token };
  const request = (path, { body, method = body === undefined ? "GET" : "POST", ...options } = {}) => {
    const isMultipart = body instanceof FormData;
    return fetch(`${origin}${path}`, {
      method, signal: AbortSignal.timeout(120_000), ...options,
      headers: { ...headers, ...(body !== undefined && !isMultipart ? { "content-type": "application/json" } : {}), ...options.headers },
      ...(body === undefined ? {} : { body: isMultipart || typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    });
  };
  const json = async (path, body, method) => {
    const response = await request(path, { body, method });
    const text = await response.text();
    assert.ok(response.ok, `${path}: HTTP ${response.status}: ${text.slice(0, 2000)}`);
    return JSON.parse(text);
  };
  const upload = (filename, bytes, fields = {}, mime = "application/octet-stream") => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    form.append("file", new Blob([bytes], { type: mime }), filename);
    return form;
  };
  return { request, json, upload };
}

export async function createRuntimeHarness({ entry, output }) {
  entry = resolve(entry);
  output = resolve(output);
  await mkdir(output, { recursive: true });
  const processes = new Set();
  let sequence = 0;
  async function profile(name = "profile") {
    const root = await mkdtemp(join(output, `${name}-`));
    const value = { root, dataDir: join(root, "Documents/Marinar"), envFile: join(root, "Library/Application Support/marinar.env"), installationId: randomUUID() };
    await mkdir(value.dataDir, { recursive: true });
    await mkdir(dirname(value.envFile), { recursive: true });
    return value;
  }
  async function start(profile, options = {}) {
    const probe = createServer();
    await new Promise((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", done); });
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
    const token = randomBytes(32).toString("hex");
    const runtimeRoot = dirname(entry);
    const config = { ...profile, port, token, runtimeRoot, clientRoot: join(runtimeRoot, "client"), deploymentId: "development" };
    const configPath = join(dirname(profile.envFile), "launch-config.json");
    await writeFile(configPath, JSON.stringify(config) + "\n", { mode: 0o600 });
    const launchArgs = basename(entry) === "bootstrap.cjs" ? [entry, configPath] : [entry];
    const child = spawn(process.execPath, [...(options.preload ? ["--require", resolve(options.preload)] : []), ...launchArgs], {
      // A power loss can leave dataDir temporarily in the restore rollback folder.
      // Bootstrap must start outside that directory to recover the original profile.
      cwd: dirname(profile.envFile), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "production", MARINARA_IOS: "1", MARINARA_LITE: "1", NODE_PATH: "",
        MARINARA_IOS_TOKEN: token, MARINARA_IOS_INSTALLATION_ID: profile.installationId,
        DATA_DIR: profile.dataDir, FILE_STORAGE_DIR: join(profile.dataDir, "storage"), MARINARA_ENV_FILE: profile.envFile,
        HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "warn", AUTO_CREATE_DEFAULT_CONNECTION: "false", NO_COLOR: "1" },
    });
    const log = [];
    const run = { child, token, port, profile, baseUrl: `http://127.0.0.1:${port}`, index: ++sequence, log };
    run.api = createTestApi(run.baseUrl, token);
    run.exit = new Promise((done) => { child.once("exit", done); child.once("error", (error) => { run.error = error; done(); }); });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => log.push(chunk.toString().replaceAll(token, "[REDACTED_IOS_TOKEN]")));
    processes.add(run);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (run.error || child.exitCode !== null || child.signalCode !== null) {
        const error = new Error(`Embedded server exited before readiness: ${run.error ?? log.join("").slice(-5000)}`);
        if (options.expectFailure) { await stop(run); return { rejected: true, error: error.message }; }
        throw error;
      }
      try {
        const response = await run.api.request("/api/ios/health", { signal: AbortSignal.timeout(2000) });
        if (response.ok && (await response.json()).ready) return run;
      } catch { /* Server is still opening its store. */ }
      await delay(100);
    }
    throw new Error("Embedded server readiness timed out");
  }
  async function stop(run) {
    if (!processes.delete(run)) return;
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    let timer;
    try {
      await Promise.race([run.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Server process did not exit")), 5000); })]);
    } finally { clearTimeout(timer); }
    await writeFile(join(output, `transfer-server-${run.index}.log`), run.log.join(""));
  }
  return { profile, start, stop, close: async () => { for (const run of [...processes]) await stop(run); } };
}

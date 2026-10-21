import { isAbsolute, join } from "node:path";

// Captured before dotenv loads: a user configuration cannot turn the embedded
// app into a desktop server or change its native authentication secret.
export const isIosRuntime = process.env.MARINARA_IOS === "1";
const bootEnvironment = { ...process.env };

export function isIosUnsupportedProvider(provider: string): boolean {
  return isIosRuntime && ["claude_subscription", "grok_subscription", "openai_chatgpt"].includes(provider);
}

export function getIosRuntimeConfig() {
  if (!isIosRuntime) throw new Error("The iOS runtime is not enabled");
  const dataDir = bootEnvironment.DATA_DIR;
  const envFile = bootEnvironment.MARINARA_ENV_FILE;
  const token = bootEnvironment.MARINARA_IOS_TOKEN;
  const installationId = bootEnvironment.MARINARA_IOS_INSTALLATION_ID;
  const bootId = bootEnvironment.MARINARA_IOS_BOOT_ID || null;
  const port = Number(bootEnvironment.PORT ?? "7860");
  if (!dataDir || !isAbsolute(dataDir) || !envFile || !isAbsolute(envFile)) {
    throw new Error("The iOS app must supply absolute writable data and environment paths");
  }
  if (!token || !/^[a-f0-9]{64}$/iu.test(token)) {
    throw new Error("The iOS app must supply a 256-bit session secret");
  }
  if (!installationId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(installationId)) {
    throw new Error("The iOS app must supply its persistent installation UUID");
  }
  if (bootId && !/^[a-z0-9_.:-]{1,128}$/iu.test(bootId)) throw new Error("Invalid iOS OS boot identity");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid iOS loopback port");
  return {
    dataDir,
    envFile,
    token,
    installationId,
    bootId,
    port,
    deploymentId: bootEnvironment.MARINARA_IOS_DEPLOYMENT_ID ?? "development",
    assetRoot: bootEnvironment.MARINARA_IOS_ASSET_ROOT,
    presetPath: bootEnvironment.MARINARA_IOS_PRESET_PATH,
    clientRoot: bootEnvironment.MARINARA_IOS_CLIENT_ROOT,
  };
}

/** Keep native-owned paths and capabilities fixed even after an .env reload. */
export function enforceIosRuntimeEnvironment() {
  if (!isIosRuntime) return;
  const config = getIosRuntimeConfig();
  Object.assign(process.env, {
    MARINARA_IOS: "1",
    MARINARA_LITE: "1",
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(config.port),
    DATA_DIR: config.dataDir,
    FILE_STORAGE_DIR: join(config.dataDir, "storage"),
    MARINARA_ENV_FILE: config.envFile,
    MARINARA_IOS_TOKEN: config.token,
    MARINARA_IOS_INSTALLATION_ID: config.installationId,
    MARINARA_IOS_DEPLOYMENT_ID: config.deploymentId,
    UPDATES_APPLY_DISABLED: "true",
    UPDATES_APPLY_ENABLED: "false",
    SIDECAR_RUNTIME_INSTALL_ENABLED: "false",
    CUSTOM_TOOL_SCRIPT_ENABLED: "false",
    ENABLE_EXTERNAL_EXTENSIONS: "false",
    ENABLE_CUSTOM_AGENT_REPOS: "false",
    MULTIPLAYER_ENABLED: "false",
    MARINARA_ENV_WATCH: "0",
    AUTO_OPEN_BROWSER: "false",
  });
  if (config.bootId) process.env.MARINARA_IOS_BOOT_ID = config.bootId;
  else delete process.env.MARINARA_IOS_BOOT_ID;
  for (const key of ["SSL_CERT", "SSL_KEY", "MARINARA_RESTART_SUPERVISOR", "CSRF_TRUSTED_ORIGINS", "CORS_ORIGINS"]) {
    delete process.env[key];
  }
}

enforceIosRuntimeEnvironment();

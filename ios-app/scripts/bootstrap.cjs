// Node is started exactly once by the native app. Apply its configuration before
// importing any server module, including dotenv and the database writer lease.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const configPath = process.argv[2];
if (!configPath || !path.isAbsolute(configPath)) throw new Error('Native launch configuration is required');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
for (const key of ['dataDir', 'envFile', 'runtimeRoot', 'clientRoot']) {
  if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error(`Invalid native path: ${key}`);
}
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid loopback port');
if (!/^[a-f0-9]{64}$/i.test(config.token ?? '')) throw new Error('Invalid app session');
Object.assign(process.env, {
  MARINARA_IOS: '1', MARINARA_LITE: '1', NODE_ENV: 'production',
  HOST: '127.0.0.1', PORT: String(config.port),
  DATA_DIR: config.dataDir, MARINARA_ENV_FILE: config.envFile,
  MARINARA_IOS_TOKEN: config.token,
  MARINARA_IOS_INSTALLATION_ID: config.installationId ?? '',
  MARINARA_IOS_DEPLOYMENT_ID: config.deploymentId,
  MARINARA_IOS_ASSET_ROOT: path.join(config.runtimeRoot, 'assets'),
  MARINARA_IOS_PRESET_PATH: path.join(config.runtimeRoot, 'default-preset.json'),
  MARINARA_IOS_CLIENT_ROOT: config.clientRoot,
});
if (config.bootId) process.env.MARINARA_IOS_BOOT_ID = config.bootId;
else delete process.env.MARINARA_IOS_BOOT_ID;
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.dirname(config.envFile), { recursive: true });
process.chdir(config.dataDir);
import(pathToFileURL(path.join(config.runtimeRoot, 'server.mjs')).href).catch(error => {
  console.error('Embedded server startup failed:', error);
  process.exitCode = 1;
});

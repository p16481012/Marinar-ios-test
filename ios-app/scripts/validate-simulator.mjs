#!/usr/bin/env node
// Runs the actual embedded Node framework and WKWebView on an ARM64 iOS Simulator.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProvider, STREAM_PROMPT, STREAM_REPLY } from '../../scripts/ios/mock-openai-provider.mjs';
import { runChatPhase } from '../../scripts/ios/verify-chat-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const reportDir = path.resolve(option('--report-dir') ?? path.join(root, 'ios-app/build/validation'));
const derived = path.resolve(option('--derived-data') ?? path.join(root, 'ios-app/build/DerivedData'));
const bundleId = 'com.p16481012.marinar.ios.test';
const project = path.join(root, 'ios-app/Marinar.xcodeproj');
let deviceId = option('--device-id');
let ownedDevice = false;
let mock;
let container;
let launchNumber = 0;
const launchLogs = [];
const report = { formatVersion: 1, status: 'running', checks: [], coverage: {
  actualEmbeddedNode: false, actualWKWebView: false, nativeSendInteraction: false,
  externalProvider: false, physicalDevice: false, provider: 'local OpenAI-compatible fixture',
} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(reportDir, { recursive: true });

async function run(command, commandArgs, { log, allowFailure = false } = {}) {
  const output = [];
  const stream = log ? createWriteStream(path.join(reportDir, log)) : null;
  const child = spawn(command, commandArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (data) => {
    if (stream) stream.write(data);
    else output.push(data);
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (stream) await new Promise((resolve) => stream.end(resolve));
  const text = Buffer.concat(output).toString('utf8').trim();
  if (code !== 0 && !allowFailure) throw new Error(`${command} exited ${code}${log ? `; see ${log}` : `: ${text.slice(-2000)}`}`);
  return text;
}

async function launch() {
  // XCTest can reinstall the app while preserving its data under a new
  // container UUID. Resolve the current location before writing logs or
  // reading this process's launch configuration.
  container = await run('xcrun', ['simctl', 'get_app_container', deviceId, bundleId, 'data']);
  launchNumber += 1;
  // The simulator can remap /tmp and /var paths. Its real app-container path
  // avoids that ambiguity; copy the logs out before deleting our simulator.
  const logs = path.join(container, 'Library/Logs');
  await mkdir(logs, { recursive: true });
  const stdout = path.join(logs, `app-${launchNumber}-stdout.log`);
  const stderr = path.join(logs, `app-${launchNumber}-stderr.log`);
  launchLogs.push(stdout, stderr);
  await run('xcrun', ['simctl', 'launch', `--stdout=${stdout}`, `--stderr=${stderr}`, deviceId, bundleId]);
  const deadline = Date.now() + 300_000;
  let lastFailure = 'runtime preparation has not completed';
  while (Date.now() < deadline) {
    try {
      const config = JSON.parse(await readFile(path.join(container, 'Library/Application Support/launch-config.json'), 'utf8'));
      const response = await fetch(`http://127.0.0.1:${config.port}/api/ios/health`, {
        headers: { 'x-marinara-ios-token': config.token }, signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        const body = await response.json();
        assert.equal(body.ready, true);
        assert.equal(body.deploymentId, config.deploymentId);
        report.runtime = { deploymentId: body.deploymentId, version: body.version, nodeVersion: body.nodeVersion, platform: body.platform };
        return config;
      }
      lastFailure = `health HTTP ${response.status}`;
    } catch (error) { lastFailure = error.code ?? error.name; }
    await sleep(500);
  }
  throw new Error(`Native embedded server did not become ready: ${lastFailure}`);
}

async function stop() { await run('xcrun', ['simctl', 'terminate', deviceId, bundleId], { allowFailure: true }); }

async function preserveLaunchLogs() {
  // Copy before XCTest can migrate the data container, and again after the
  // final launch. A missing old path must not remove an already copied log.
  for (const file of launchLogs) await copyFile(file, path.join(reportDir, path.basename(file))).catch(() => {});
}

try {
  assert.equal(process.platform, 'darwin', 'This validation requires macOS and Xcode');
  assert.equal(process.arch, 'arm64', 'The pinned Node framework has an ARM64 simulator slice only');
  const launchHelp = await run('xcrun', ['simctl', 'help', 'launch']);
  await writeFile(path.join(reportDir, 'simctl-launch-help.txt'), launchHelp + '\n');
  assert.ok(launchHelp.includes('--stdout') && launchHelp.includes('--stderr'), 'Installed simctl lacks file output redirection');
  const { runtimes } = JSON.parse(await run('xcrun', ['simctl', 'list', 'runtimes', '-j']));
  if (!deviceId) {
    const runtime = runtimes.filter((item) => item.isAvailable && item.identifier.includes('.iOS-'))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    assert.ok(runtime, 'No available iOS Simulator runtime');
    const { devicetypes } = JSON.parse(await run('xcrun', ['simctl', 'list', 'devicetypes', '-j']));
    const type = devicetypes.find((item) => item.identifier.endsWith('.iPhone-16-Pro'))
      ?? devicetypes.filter((item) => item.name.startsWith('iPhone')).at(-1);
    assert.ok(type, 'No iPhone simulator device type');
    deviceId = await run('xcrun', ['simctl', 'create', `Marinar-validation-${Date.now()}`, type.identifier, runtime.identifier]);
    ownedDevice = true;
  }
  report.deviceId = deviceId;
  const { devices } = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', '-j']));
  const selected = Object.entries(devices).flatMap(([runtimeIdentifier, items]) =>
    items.map((device) => ({ ...device, runtimeIdentifier }))).find((device) => device.udid === deviceId);
  assert.ok(selected, 'Selected simulator is not listed by simctl');
  const selectedRuntime = runtimes.find((runtime) => runtime.identifier === selected.runtimeIdentifier);
  assert.ok(selectedRuntime, 'Cannot identify selected simulator runtime');
  report.simulator = { name: selected.name, deviceTypeIdentifier: selected.deviceTypeIdentifier,
    runtimeIdentifier: selected.runtimeIdentifier, runtimeVersion: selectedRuntime.version,
    runtimeBuildVersion: selectedRuntime.buildversion };
  await run('xcrun', ['simctl', 'boot', deviceId], { allowFailure: true });
  await run('xcrun', ['simctl', 'bootstatus', deviceId, '-b'], { log: 'simulator-boot.log' });
  console.log('Building the native app and UI test bundle.');
  const buildArgs = ['-project', project, '-scheme', 'Marinar', '-configuration', 'Debug',
    '-destination', `platform=iOS Simulator,id=${deviceId}`, '-derivedDataPath', derived,
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY='];
  await run('xcodebuild', ['build-for-testing', ...buildArgs], { log: 'simulator-build.log' });
  await run('xcrun', ['simctl', 'install', deviceId, path.join(derived, 'Build/Products/Debug-iphonesimulator/Marinar.app')]);
  let config = await launch();
  report.coverage.actualEmbeddedNode = true;
  report.checks.push('native-node-startup-and-authenticated-health');
  mock = await startMockProvider();
  const baseUrl = 'http://127.0.0.1:7860';
  const stateFile = path.join(reportDir, 'chat-state.json');
  console.log('Exercising streaming, stop, provider errors and persistent storage in embedded Node.');
  const exercised = await runChatPhase({ phase: 'exercise', baseUrl, providerUrl: mock.baseUrl, stateFile, token: config.token });
  report.checks.push(...exercised.checks);
  await stop();
  config = await launch();
  const restored = await runChatPhase({ phase: 'restore', baseUrl, providerUrl: mock.baseUrl, stateFile, token: config.token });
  report.checks = [...new Set([...report.checks, ...restored.checks])];
  const uiState = await runChatPhase({ phase: 'seed', baseUrl, providerUrl: mock.baseUrl, stateFile: path.join(reportDir, 'ui-seed.json'), token: config.token });
  const uiHeaders = { 'x-marinara-ios-token': config.token, 'x-marinara-csrf': '1', origin: baseUrl, 'content-type': 'application/json' };
  const preferenceResponse = await fetch(`${baseUrl}/api/app-settings/ui`, { headers: uiHeaders });
  assert.ok(preferenceResponse.ok, 'Cannot read test UI preferences');
  const preference = await preferenceResponse.json();
  const quietPreferences = { ...JSON.parse(preference.value || '{}'), hasCompletedOnboarding: true, language: 'en',
    sidebarOpen: false, rightPanelOpen: false, trackerPanelEnabled: false, chibiProfessorMariEnabled: false,
    chatHelpSeenModes: ['conversation', 'roleplay', 'game'], chatWindowIntroDismissed: true,
    seasonalThemesDisabled: true, __updatedAt: Date.now() };
  const savedPreferences = await fetch(`${baseUrl}/api/app-settings/ui`, {
    method: 'PUT', headers: uiHeaders, body: JSON.stringify({ value: JSON.stringify(quietPreferences) }),
  });
  assert.ok(savedPreferences.ok, 'Cannot save test UI preferences');
  const flushedPreferences = await fetch(`${baseUrl}/api/ios/flush`, { method: 'POST', headers: uiHeaders, body: '{}' });
  assert.ok(flushedPreferences.ok, 'Cannot flush test UI preferences');
  const persistence = await readFile(path.join(root, 'packages/client/src/lib/ui-persistence.ts'), 'utf8');
  const uiStateVersion = Number(persistence.match(/version:\s*(\d+)/)?.[1]);
  assert.ok(Number.isInteger(uiStateVersion), 'Cannot identify current UI preference format');
  await writeFile(path.join(container, 'Documents/ios-test-selection.json'), JSON.stringify({ chatId: uiState.chatId, uiStateVersion }));
  await stop();
  await preserveLaunchLogs();
  const callsBeforeUI = mock.calls.length;
  console.log('Sending through the real WKWebView composer and checking restoration after app relaunch.');
  await run('xcodebuild', ['test-without-building', ...buildArgs,
    '-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1',
    '-only-testing:MarinarUITests/MarinarUITests/testSendPersistsAfterProcessRelaunch',
    '-resultBundlePath', path.join(reportDir, 'MarinarUITests.xcresult')], { log: 'simulator-ui-tests.log' });
  assert.ok(mock.calls.slice(callsBeforeUI).some((call) => call.kind === 'stream' && call.completed
    && call.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes(STREAM_PROMPT))),
  'UI test did not send its typed prompt to the mock provider');
  report.coverage.actualWKWebView = true;
  report.coverage.nativeSendInteraction = true;
  report.checks.push('actual-wkwebview-native-keyboard-and-send');
  console.log('UI test passed. Verifying its saved messages through the embedded server after another process relaunch.');
  await stop();
  config = await launch();
  const response = await fetch(`${baseUrl}/api/chats/${uiState.chatId}/messages`, {
    headers: { 'x-marinara-ios-token': config.token }, signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, 'Cannot read the UI-created messages after relaunch');
  const messagesBody = await response.json();
  const messages = Array.isArray(messagesBody) ? messagesBody : messagesBody.messages;
  assert.ok(messages.some((item) => item.role === 'user' && item.content === STREAM_PROMPT));
  assert.ok(messages.some((item) => item.role === 'assistant' && item.content === STREAM_REPLY));
  report.checks.push('ui-messages-survive-app-process-relaunch');
  report.providerCalls = mock.calls.map(({ id, kind, streaming, completed, disconnected }) => ({ id, kind, streaming, completed, disconnected }));
  report.status = 'passed';
  console.log('Native simulator validation passed. No external AI service was used.');
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (deviceId && process.platform === 'darwin') {
    await run('xcrun', ['simctl', 'io', deviceId, 'screenshot', path.join(reportDir, `${report.status}-screen.png`)], { allowFailure: true }).catch(() => {});
  }
  if (container) {
    // Preserve only test diagnostics, not launch-config.json or its boot token.
    await run('xcrun', ['simctl', 'spawn', deviceId, 'log', 'show', '--last', '15m', '--style', 'compact', '--predicate', 'process == "Marinar"'], { log: 'simulator-app.log', allowFailure: true }).catch(() => {});
    await stop().catch(() => {});
    await preserveLaunchLogs();
  }
  if (mock) await mock.close();
  if (ownedDevice) {
    await run('xcrun', ['simctl', 'shutdown', deviceId], { allowFailure: true });
    await run('xcrun', ['simctl', 'delete', deviceId], { allowFailure: true });
  }
  await writeFile(path.join(reportDir, 'simulator-validation.json'), JSON.stringify(report, null, 2) + '\n');
}

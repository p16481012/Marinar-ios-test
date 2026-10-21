#!/usr/bin/env node
// Runs the actual embedded Node framework and WKWebView on an ARM64 iOS Simulator.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProvider, STREAM_PROMPT, STREAM_REPLY, RESTORE_PROMPT, RESTORE_REPLY } from '../../scripts/ios/mock-openai-provider.mjs';
import { runChatPhase } from '../../scripts/ios/verify-chat-lifecycle.mjs';
import { createTestApi } from '../../scripts/ios/runtime-test-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const reportDir = path.resolve(option('--report-dir') ?? path.join(root, 'ios-app/build/validation'));
const derived = path.resolve(option('--derived-data') ?? path.join(root, 'ios-app/build/DerivedData'));
const bundleId = 'com.p16481012.marinar.ios.test';
const project = path.join(root, 'ios-app/Marinar.xcodeproj');
let deviceId = option('--device-id');
const ownedDevices = new Set();
let mock;
let container;
let launchNumber = 0;
const launchLogs = [];
const report = { formatVersion: 1, status: 'running', checks: [], errors: [], uiTests: [], coverage: {
  actualEmbeddedNode: false, actualWKWebView: false, nativeSendInteraction: false,
  nativeBlobDownload: false, nativeShareSheet: false, systemFilePicker: false, nativeDialogs: false,
  nativeBackgroundFlush: false,
  nativeFullRestore: false, restoredWebCacheReset: false,
  externalProvider: false, physicalDevice: false, provider: 'local OpenAI-compatible fixture',
} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(reportDir, { recursive: true });

async function run(command, commandArgs, { log, allowFailure = false, env } = {}) {
  const output = [];
  const stream = log ? createWriteStream(path.join(reportDir, log)) : null;
  const child = spawn(command, commandArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) });
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
  if (code !== 0 && log && command === 'xcodebuild') {
    // Show only compiler/XCTest diagnostics here. Native runtime stdout and
    // launch configuration are deliberately excluded from console output.
    const lines = (await readFile(path.join(reportDir, log), 'utf8').catch(() => '')).trim().split('\n');
    const failures = lines.filter((line) => /error:|Test Case .*failed|Testing failed:/.test(line)).slice(-20);
    const summary = [...new Set([...failures, ...lines.slice(-60)])].slice(-80);
    console.error(`xcodebuild failure details (${log}):\n${summary.join('\n')}`);
  }
  if (code !== 0 && !allowFailure) throw new Error(`${command} exited ${code}${log ? `; see ${log}` : `: ${text.slice(-2000)}`}`);
  return text;
}

function recordFailure(phase, error) {
  const message = error instanceof Error ? error.message : String(error);
  report.errors.push({ phase, message });
  console.error(`${phase}: ${message}`);
}

async function collectCheck(phase, callback) {
  try { await callback(); return true; }
  catch (error) { recordFailure(phase, error); return false; }
}

async function runUITests(commandArgs, { phase, log, expectedTests }) {
  let commandError;
  try { await run('xcodebuild', commandArgs, { log }); }
  catch (error) { commandError = error; }
  const output = await readFile(path.join(reportDir, log), 'utf8').catch(() => '');
  const endings = [...output.matchAll(/^Test Case '-\[MarinarUITests\.MarinarUITests (test\w+)\]' (passed|failed) \(/gm)];
  const tests = Object.fromEntries(expectedTests.map((name) => {
    const outcomes = endings.filter((match) => match[1] === name).map((match) => match[2]);
    return [name, outcomes.includes('failed') ? 'failed' : outcomes.includes('passed') ? 'passed' : 'not-completed'];
  }));
  report.uiTests.push({ phase, log, tests, ...(commandError ? { commandError: commandError.message } : {}) });
  if (commandError) recordFailure(phase, commandError);
  for (const [name, status] of Object.entries(tests)) {
    if (status !== 'passed') recordFailure(`${phase}/${name}`, new Error(`XCTest ${status}; see ${log}`));
  }
  return new Set(Object.keys(tests).filter((name) => tests[name] === 'passed'));
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
  await run('xcrun', ['simctl', 'launch', `--stdout=${stdout}`, `--stderr=${stderr}`, deviceId, bundleId], {
    env: { SIMCTL_CHILD_MARINARA_TEST_DIAGNOSTICS: '1' },
  });
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
        report.runtime = { deploymentId: body.deploymentId, version: body.version, nodeVersion: body.nodeVersion, platform: body.platform,
          ...(body.restoreAppliedAt ? { restoreAppliedAt: body.restoreAppliedAt } : {}) };
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
  if (deviceId) {
    const current = await run('xcrun', ['simctl', 'get_app_container', deviceId, bundleId, 'data']).catch(() => undefined);
    if (current) await copyFile(path.join(current, 'Documents/ios-export-events.json'),
      path.join(reportDir, `${deviceId}-ios-export-events.json`)).catch(() => {});
  }
}

async function exportTestAttachments() {
  // Keep ordinary PNG/text attachments beside xcresult so failure evidence
  // can be inspected from Windows without Apple's xcresulttool.
  const help = await run('xcrun', ['xcresulttool', 'export', 'attachments', '--help'], { allowFailure: true });
  await writeFile(path.join(reportDir, 'xcresult-attachments-help.txt'), help + '\n');
  if (!help.includes('--path') || !help.includes('--output-path')) return;
  for (const entry of await readdir(reportDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.xcresult')) continue;
    const key = path.basename(entry.name, '.xcresult');
    await run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', path.join(reportDir, entry.name),
      '--output-path', path.join(reportDir, 'attachments', key)], { log: `${key}-attachments.log`, allowFailure: true });
  }
}

async function prepareUI(config, stateFile) {
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const uiState = await runChatPhase({ phase: 'seed', baseUrl, providerUrl: mock.baseUrl, stateFile, token: config.token });
  const headers = { 'x-marinara-ios-token': config.token, 'x-marinara-csrf': '1', origin: baseUrl, 'content-type': 'application/json' };
  const response = await fetch(`${baseUrl}/api/app-settings/ui`, { headers });
  assert.ok(response.ok, 'Cannot read test UI preferences');
  const preference = await response.json();
  const quiet = { ...JSON.parse(preference.value || '{}'), hasCompletedOnboarding: true, language: 'en',
    sidebarOpen: false, rightPanelOpen: false, trackerPanelEnabled: false, chibiProfessorMariEnabled: false,
    chatHelpSeenModes: ['conversation', 'roleplay', 'game'], chatWindowIntroDismissed: true,
    seasonalThemesDisabled: true, __updatedAt: Date.now() };
  const saved = await fetch(`${baseUrl}/api/app-settings/ui`, { method: 'PUT', headers, body: JSON.stringify({ value: JSON.stringify(quiet) }) });
  assert.ok(saved.ok, 'Cannot save test UI preferences');
  const flushed = await fetch(`${baseUrl}/api/ios/flush`, { method: 'POST', headers, body: '{}' });
  assert.ok(flushed.ok, 'Cannot flush test UI preferences');
  const persistence = await readFile(path.join(root, 'packages/client/src/lib/ui-persistence.ts'), 'utf8');
  const uiStateVersion = Number(persistence.match(/version:\s*(\d+)/)?.[1]);
  assert.ok(Number.isInteger(uiStateVersion), 'Cannot identify current UI preference format');
  await writeFile(path.join(container, 'Documents/ios-test-selection.json'), JSON.stringify({ chatId: uiState.chatId, uiStateVersion }));
  await writeFile(path.join(container, 'Documents/marinar-ios-import.json'), JSON.stringify({ fixture: 'restored-file-fixture', text: '실제 파일 선택 확인' }));
  return uiState;
}

async function prepareStreamedBackup(config) {
  // A real backup includes a 16 MiB asset. The fixture is never registered as
  // knowledge, so it cannot affect prompts. The native download reads its URL
  // directly instead of creating a JavaScript Blob for the archive.
  const directory = path.join(config.dataDir, 'knowledge-sources');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'ios-stream-fixture.txt'), Buffer.alloc(16 * 1024 * 1024, 65));
  await writeFile(path.join(container, 'Documents/ios-file-test-config.json'), JSON.stringify({ prepareBackup: true }));
}

async function hashFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { size, sha256: hash.digest('hex') };
}

async function verifyBlobDownload(withArchive = false) {
  container = await run('xcrun', ['simctl', 'get_app_container', deviceId, bundleId, 'data']);
  const results = JSON.parse(await readFile(path.join(container, 'Documents/ios-download-result.json'), 'utf8'));
  assert.equal(results.length, withArchive ? 2 : 1, 'Failed HTTP download was saved or expected download is missing');
  const result = results.find((item) => item.filename === 'marinar-ios-export.json');
  assert.ok(result, 'WKDownload did not save the blob fixture');
  const expected = Buffer.from('{"fixture":"marinar-ios","text":"파일 내보내기"}');
  assert.equal(result.filename, 'marinar-ios-export.json');
  assert.equal(result.size, expected.length);
  assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex'), 'WKDownload changed the exported bytes');
  if (!withArchive) return { blob: result };
  const expectedArchive = await hashFile(path.join(container, 'Documents/ios-streamed-source.zip'));
  const savedArchive = await hashFile(path.join(container, 'Documents/ios-streamed-download.zip'));
  assert.ok(savedArchive.size >= 16 * 1024 * 1024, 'Backup omitted the large fixture');
  assert.deepEqual(savedArchive, expectedArchive, 'WKDownload archive differs from the server file');
  const archive = results.find((item) => item.sha256 === expectedArchive.sha256);
  assert.ok(archive, 'The native streamed archive differs from the server backup');
  assert.equal(archive.size, expectedArchive.size);
  assert.ok(archive.filename.endsWith('.zip'));
  return { blob: result, streamedArchive: archive };
}

async function waitRestoreCache(restoreID, skipped) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path.join(container, 'Documents/ios-restore-cache-result.json'), 'utf8'));
      if (value.restoreID === restoreID && value.skipped === skipped) return value;
    } catch { /* Wait for the real WebView to finish hydrating. */ }
    await sleep(500);
  }
  throw new Error('The real WKWebView did not acknowledge the restore cache marker');
}

async function exerciseNativeFullRestore(config, uiState) {
  let api = createTestApi(`http://127.0.0.1:${config.port}`, config.token);
  const chatPath = `/api/chats/${uiState.chatId}`;
  const originalChat = await api.json(chatPath);
  const originalMessages = await api.json(`${chatPath}/messages`);
  const restoredOpacity = 47;
  const restoredWeather = 'Preserved backup weather';
  const preference = JSON.parse((await api.json('/api/app-settings/ui')).value || '{}');
  const preferenceTime = Date.now();
  await api.json('/api/app-settings/ui', { value: JSON.stringify({ ...preference,
    chatFontOpacity: restoredOpacity, __updatedAt: preferenceTime }) }, 'PUT');
  await api.json(`${chatPath}/game-state`, { weather: restoredWeather, manual: true }, 'PATCH');
  const restoredFolder = await api.json('/api/library-folders/presets', { name: 'Preserved backup folder' });
  await api.json('/api/ios/flush', {});
  await api.json('/api/ios/backup/start', {});
  const deadline = Date.now() + 180_000;
  let backup;
  while (Date.now() < deadline) {
    backup = await api.json('/api/ios/backup/status');
    assert.notEqual(backup.status, 'failed', backup.error ?? 'Full restore backup failed');
    if (backup.status === 'ready') break;
    await sleep(500);
  }
  assert.equal(backup?.status, 'ready', 'Full restore backup timed out');
  const download = await api.request(backup.downloadUrl);
  assert.ok(download.ok);
  const archive = await download.blob();
  await api.json(chatPath, { name: 'Changed after full backup' }, 'PATCH');
  await api.json('/api/ios/flush', {});
  const form = new FormData();
  form.append('file', archive, backup.filename);
  const stageResponse = await api.request('/api/ios/restore/stage', { body: form, headers: { 'x-marinara-confirm-restore': '1' } });
  assert.equal(stageResponse.status, 202);
  const staged = await stageResponse.json();
  assert.equal(staged.restartRequired, true);
  const blocked = await api.request(chatPath, { method: 'PATCH', body: { name: 'Must remain blocked' } });
  assert.equal(blocked.status, 409, 'Pending restore must block edits');
  // Seed browser-side mutations immediately before the restore reset script.
  // A future timestamp previously caused even an empty UI cache to overwrite
  // the restored profile, while the other queues can replay stale data.
  await writeFile(path.join(container, 'Documents/ios-restore-cache-fixture.json'), JSON.stringify({
    'marinara-engine-ui-updated-at': String(Date.now() + 86_400_000),
    'marinara:pending-game-state-patches:v1': JSON.stringify([[`${uiState.chatId}\u0000\u0000`, {
      chatId: uiState.chatId, target: {}, fields: { weather: 'Stale browser weather' }, revision: 1,
    }]]),
    'marinara-library-folders-v1': JSON.stringify([{ ...restoredFolder, scope: 'presets', name: 'Stale browser folder' }]),
  }));
  await stop();
  config = await launch();
  api = createTestApi(`http://127.0.0.1:${config.port}`, config.token);
  const health = await api.json('/api/ios/health');
  assert.equal(health.restoreAppliedAt, staged.createdAt);
  assert.equal((await api.json('/api/ios/restore/status')).status, 'applied');
  assert.equal((await api.json(chatPath)).name, originalChat.name);
  assert.deepEqual(await api.json(`${chatPath}/messages`), originalMessages);
  assert.equal((await api.json(`/api/connections/${uiState.connectionId}`)).id, uiState.connectionId);
  const cache = await waitRestoreCache(staged.createdAt, false);
  assert.deepEqual(cache.remainingKeys, []);
  assert.ok(cache.removedKeys.includes('marinara-engine-ui'), 'No stale browser UI snapshot was cleared');
  for (const key of ['marinara-engine-ui-updated-at', 'marinara:pending-game-state-patches:v1', 'marinara-library-folders-v1']) {
    assert.ok(cache.removedKeys.includes(key), `Restore did not clear stale browser data: ${key}`);
  }
  // Wait for the real settings hook to finish its undated-cache merge and
  // rewrite. This checks the server after hydration, not just script execution.
  const hydrationDeadline = Date.now() + 30_000;
  let hydratedPreferences;
  while (Date.now() < hydrationDeadline) {
    hydratedPreferences = JSON.parse((await api.json('/api/app-settings/ui')).value || '{}');
    if (hydratedPreferences.__updatedAt > preferenceTime) break;
    await sleep(300);
  }
  assert.ok(hydratedPreferences.__updatedAt > preferenceTime, 'Restored UI settings did not finish browser hydration');
  assert.equal(hydratedPreferences.chatFontOpacity, restoredOpacity, 'Stale UI cache overwrote restored settings');
  assert.equal((await api.json(`${chatPath}/game-state`)).weather, restoredWeather, 'Stale patch overwrote restored game state');
  assert.equal((await api.json('/api/library-folders/presets')).find((folder) => folder.id === restoredFolder.id)?.name,
    restoredFolder.name, 'Stale folder migration overwrote the restored library');
  const callsBefore = mock.calls.length;
  const generation = await api.request('/api/generate/', { body: { chatId: uiState.chatId,
    userMessage: RESTORE_PROMPT, streaming: true, submissionId: randomUUID(), skipPresenceDelay: true } });
  assert.ok(generation.ok);
  const events = (await generation.text()).split('\n').filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()));
  assert.ok(!events.some((event) => event.type === 'error'), 'Restored credentials could not generate a reply');
  assert.ok(events.some((event) => event.type === 'done'));
  assert.ok(mock.calls.slice(callsBefore).some((call) => call.completed && call.kind === 'restore'
    && JSON.stringify(call.messages).includes(STREAM_REPLY)), 'Restored request lost saved credentials or conversation context');
  const received = await api.json(`${chatPath}/messages`);
  assert.ok((Array.isArray(received) ? received : received.messages).some((message) => message.role === 'assistant' && message.content === RESTORE_REPLY));
  await api.json('/api/ios/flush', {});
  await stop();
  config = await launch();
  await waitRestoreCache(staged.createdAt, true);
  report.restore = { restoreAppliedAt: staged.createdAt, clearedKeys: cache.removedKeys, repeatedLaunchPreservedCache: true };
  report.coverage.nativeFullRestore = true;
  report.coverage.restoredWebCacheReset = true;
  report.checks.push('native-full-backup-stage-cold-start-restore', 'restored-connection-credential-and-history',
    'restore-browser-cache-reset-before-hydration', 'restore-clears-ui-timestamp-and-pending-mutations',
    'restore-server-settings-game-state-and-folders-survive-hydration', 'restore-cache-marker-preserves-next-launch');
  return config;
}

try {
  assert.equal(process.platform, 'darwin', 'This validation requires macOS and Xcode');
  assert.equal(process.arch, 'arm64', 'The pinned Node framework has an ARM64 simulator slice only');
  const launchHelp = await run('xcrun', ['simctl', 'help', 'launch']);
  await writeFile(path.join(reportDir, 'simctl-launch-help.txt'), launchHelp + '\n');
  assert.ok(launchHelp.includes('--stdout') && launchHelp.includes('--stderr'), 'Installed simctl lacks file output redirection');
  const { runtimes } = JSON.parse(await run('xcrun', ['simctl', 'list', 'runtimes', '-j']));
  const { devicetypes } = JSON.parse(await run('xcrun', ['simctl', 'list', 'devicetypes', '-j']));
  if (!deviceId) {
    const runtime = runtimes.filter((item) => item.isAvailable && item.identifier.includes('.iOS-'))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    assert.ok(runtime, 'No available iOS Simulator runtime');
    const type = devicetypes.find((item) => item.identifier.endsWith('.iPhone-16-Pro'))
      ?? devicetypes.filter((item) => item.name.startsWith('iPhone')).at(-1);
    assert.ok(type, 'No iPhone simulator device type');
    deviceId = await run('xcrun', ['simctl', 'create', `Marinar-validation-${Date.now()}`, type.identifier, runtime.identifier]);
    ownedDevices.add(deviceId);
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
  const uiState = await prepareUI(config, path.join(reportDir, 'ui-seed.json'));
  await prepareStreamedBackup(config);
  await stop();
  await preserveLaunchLogs();
  const callsBeforeUI = mock.calls.length;
  console.log('Sending through the real WKWebView composer and checking restoration after app relaunch.');
  const primaryTests = await runUITests(['test-without-building', ...buildArgs,
    '-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1',
    '-only-testing:MarinarUITests/MarinarUITests/testSendPersistsAfterProcessRelaunch',
    '-only-testing:MarinarUITests/MarinarUITests/testBlobDownloadShareAndFilePicker',
    '-resultBundlePath', path.join(reportDir, 'MarinarUITests.xcresult')], {
    phase: 'primary-ui', log: 'simulator-ui-tests.log',
    expectedTests: ['testSendPersistsAfterProcessRelaunch', 'testBlobDownloadShareAndFilePicker'],
  });
  await preserveLaunchLogs();
  // XCTest runs independent methods in one invocation. An export failure must
  // remain a failure while allowing a completed chat test to prove restoration.
  if (primaryTests.has('testBlobDownloadShareAndFilePicker')) await collectCheck('primary-file-integrity', async () => {
    report.download = await verifyBlobDownload(true);
    Object.assign(report.coverage, { nativeBlobDownload: true, nativeShareSheet: true, systemFilePicker: true, nativeDialogs: true });
    report.checks.push('blob-download-byte-integrity', 'streamed-16mib-backup-disk-integrity', 'http-download-error-rejected',
      'native-export-share-sheet', 'system-file-picker-cancel', 'system-file-picker-read-bytes', 'javascript-confirm-accept-and-cancel');
  });
  let chatVerified = false;
  if (primaryTests.has('testSendPersistsAfterProcessRelaunch')) chatVerified = await collectCheck('primary-chat-send', async () => {
    assert.ok(mock.calls.slice(callsBeforeUI).some((call) => call.kind === 'stream' && call.completed
      && call.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes(STREAM_PROMPT))),
    'UI test did not send its typed prompt to the mock provider');
    report.coverage.actualWKWebView = true;
    report.coverage.nativeSendInteraction = true;
    report.checks.push('actual-wkwebview-native-keyboard-and-send');
  });
  try {
    const relaunched = await collectCheck('primary-process-relaunch', async () => { await stop(); config = await launch(); });
    if (relaunched && chatVerified) {
      await collectCheck('primary-background-flush', async () => {
        const backgroundFlush = JSON.parse(await readFile(path.join(container, 'Documents/ios-background-flush-result.json'), 'utf8'));
        assert.equal(backgroundFlush.succeeded, true, 'Native background flush did not complete');
        assert.equal(backgroundFlush.status, 200);
        report.coverage.nativeBackgroundFlush = true;
        report.checks.push('native-background-flush-acknowledged');
      });
      const messagesRestored = await collectCheck('primary-chat-persistence', async () => {
        const response = await fetch(`${baseUrl}/api/chats/${uiState.chatId}/messages`, {
          headers: { 'x-marinara-ios-token': config.token }, signal: AbortSignal.timeout(30_000),
        });
        assert.ok(response.ok, 'Cannot read the UI-created messages after relaunch');
        const messagesBody = await response.json();
        const messages = Array.isArray(messagesBody) ? messagesBody : messagesBody.messages;
        assert.ok(messages.some((item) => item.role === 'user' && item.content === STREAM_PROMPT));
        assert.ok(messages.some((item) => item.role === 'assistant' && item.content === STREAM_REPLY));
        report.checks.push('ui-messages-survive-app-process-relaunch');
      });
      if (messagesRestored) await collectCheck('primary-full-restore', async () => {
        console.log('Restoring a real full backup through an app process restart and checking WebView cache hydration.');
        config = await exerciseNativeFullRestore(config, uiState);
      });
    }
  } finally {
    await run('xcrun', ['simctl', 'io', deviceId, 'screenshot', path.join(reportDir, 'primary-followup-screen.png')], { allowFailure: true }).catch(() => {});
    await run('xcrun', ['simctl', 'spawn', deviceId, 'log', 'show', '--last', '20m', '--style', 'compact', '--predicate', 'process == "Marinar"'], { log: 'primary-app.log', allowFailure: true }).catch(() => {});
    await stop().catch(() => {});
    await preserveLaunchLogs();
  }

  // Reuse the already built app/test bundle. The extra devices only exercise
  // viewport/keyboard and iPad popover behavior, not the entire API suite.
  report.screenVariants = [];
  const variants = [
    { key: 'compact-phone', type: devicetypes.find((item) => item.identifier.endsWith('.iPhone-SE-3rd-generation'))
      ?? devicetypes.find((item) => item.identifier.endsWith('.iPhone-13-mini')), files: false },
    { key: 'ipad', type: devicetypes.find((item) => item.identifier.endsWith('.iPad-mini-A17-Pro'))
      ?? devicetypes.find((item) => item.name.startsWith('iPad')), files: true },
  ];
  for (const variant of variants) {
    const errorsBefore = report.errors.length;
    const result = { key: variant.key, name: variant.type?.name, runtimeVersion: selectedRuntime.version, checks: [], status: 'running' };
    report.screenVariants.push(result);
    let variantDevice;
    try {
      assert.ok(variant.type, `Required ${variant.key} simulator type is unavailable`);
      console.log(`Checking ${variant.key} portrait/landscape keyboard${variant.files ? ', blob export and system picker' : ''} with the existing build.`);
      variantDevice = await run('xcrun', ['simctl', 'create', `Marinar-${variant.key}-${Date.now()}`, variant.type.identifier, selectedRuntime.identifier]);
      deviceId = variantDevice;
      ownedDevices.add(deviceId);
      result.deviceId = deviceId;
      await run('xcrun', ['simctl', 'boot', deviceId]);
      await run('xcrun', ['simctl', 'bootstatus', deviceId, '-b'], { log: `${variant.key}-boot.log` });
      await run('xcrun', ['simctl', 'install', deviceId, path.join(derived, 'Build/Products/Debug-iphonesimulator/Marinar.app')]);
      config = await launch();
      await prepareUI(config, path.join(reportDir, `${variant.key}-seed.json`));
      await stop();
      await preserveLaunchLogs();
      const argsForDevice = [...buildArgs];
      argsForDevice[argsForDevice.indexOf('-destination') + 1] = `platform=iOS Simulator,id=${deviceId}`;
      const tests = await runUITests(['test-without-building', ...argsForDevice,
        '-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1',
        '-only-testing:MarinarUITests/MarinarUITests/testComposerAcrossOrientations',
        ...(variant.files ? ['-only-testing:MarinarUITests/MarinarUITests/testBlobDownloadShareAndFilePicker'] : []),
        '-resultBundlePath', path.join(reportDir, `${variant.key}.xcresult`)], {
        phase: variant.key, log: `${variant.key}-ui-tests.log`,
        expectedTests: ['testComposerAcrossOrientations', ...(variant.files ? ['testBlobDownloadShareAndFilePicker'] : [])],
      });
      if (tests.has('testComposerAcrossOrientations')) result.checks.push('portrait-and-landscape-composer-keyboard');
      if (variant.files && tests.has('testBlobDownloadShareAndFilePicker')) await collectCheck(`${variant.key}-file-integrity`, async () => {
        result.download = await verifyBlobDownload();
        result.checks.push('blob-export-popover', 'system-file-picker-cancel', 'system-file-picker-read-bytes');
      });
    } catch (error) { recordFailure(variant.key, error); }
    finally {
      if (variantDevice) {
        await run('xcrun', ['simctl', 'io', variantDevice, 'screenshot', path.join(reportDir, `${variant.key}-screen.png`)], { allowFailure: true }).catch(() => {});
        await run('xcrun', ['simctl', 'spawn', variantDevice, 'log', 'show', '--last', '15m', '--style', 'compact', '--predicate', 'process == "Marinar"'], { log: `${variant.key}-app.log`, allowFailure: true }).catch(() => {});
        await stop().catch(() => {});
        await preserveLaunchLogs();
        await run('xcrun', ['simctl', 'shutdown', variantDevice], { allowFailure: true }).catch(() => {});
      }
      result.status = report.errors.length === errorsBefore ? 'passed' : 'failed';
    }
  }
  report.providerCalls = mock.calls.map(({ id, kind, streaming, completed, disconnected }) => ({ id, kind, streaming, completed, disconnected }));
  report.status = report.errors.length ? 'failed' : 'passed';
  if (report.errors.length) process.exitCode = 1;
  console.log(`Native simulator validation ${report.status} with ${report.errors.length} recorded errors. No external AI service was used.`);
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  recordFailure('validation', error);
  process.exitCode = 1;
} finally {
  if (process.platform === 'darwin') await exportTestAttachments().catch((error) => {
    console.warn(`Could not export XCTest attachments: ${error.message}`);
  });
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
  for (const owned of ownedDevices) {
    await run('xcrun', ['simctl', 'shutdown', owned], { allowFailure: true });
    await run('xcrun', ['simctl', 'delete', owned], { allowFailure: true });
  }
  await writeFile(path.join(reportDir, 'simulator-validation.json'), JSON.stringify(report, null, 2) + '\n');
}

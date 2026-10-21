#!/usr/bin/env node
// Real packaged React UI and HTTP routes. This is not a WKWebView or device proof.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { createRuntimeHarness } from "./runtime-test-harness.mjs";
import { readStoredZipEntries } from "./transfer-fixtures.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const output = resolve(option("--output", ".tmp/ios-backup-ui"));
const entry = resolve(option("--entry", "ios-app/Resources/runtime/bootstrap.cjs"));
const executablePath = option("--browser-path", process.env.PW_BROWSER_EXECUTABLE_PATH);
const channel = option("--browser-channel", process.env.PW_BROWSER_CHANNEL ?? "chrome");
const harness = await createRuntimeHarness({ entry, output });
const report = {
  status: "running",
  startedAt: new Date().toISOString(),
  entry,
  browser: executablePath ? { executablePath, headless: true } : { channel, headless: true },
  physicalDeviceValidated: false,
  nativeDownloadValidated: false,
  externalRequestsBlocked: [],
  pageErrors: [],
  consoleErrors: [],
  httpErrors: [],
  checks: [],
};
let browser, page;
const heldRequests = new Set();
async function holdRestoreUpload(run, bytes) {
  // A real multipart upload keeps maintenance active until its remaining body
  // arrives. This avoids racing UI actions against the 3-second write drain.
  const boundary = "marinar-ui-maintenance-upload";
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const firstBytes = Math.min(1024, bytes.length - 1);
  let request;
  const finished = new Promise((resolve, reject) => {
    request = httpRequest(
      `${run.baseUrl}/api/ios/restore/stage`,
      {
        method: "POST",
        headers: {
          origin: run.baseUrl,
          "x-marinara-csrf": "1",
          "x-marinara-ios-token": run.token,
          "x-marinara-confirm-restore": "1",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": prefix.length + bytes.length + suffix.length,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    heldRequests.add(request);
    request.write(prefix);
    request.write(bytes.subarray(0, firstBytes));
  });
  // Suppress an unhandled rejection if failure cleanup destroys the held socket.
  finished.catch(() => {});
  await expect
    .poll(async () => (await run.api.request("/api/ios/flush", { body: {} })).status, { timeout: 10_000 })
    .toBe(503);
  return {
    async finish(expectedStatus) {
      request.write(bytes.subarray(firstBytes));
      request.end(suffix);
      const status = await finished;
      heldRequests.delete(request);
      assert.equal(status, expectedStatus);
    },
  };
}
try {
  const profile = await harness.profile("browser");
  let run = await harness.start(profile);
  const ui = {
    hasCompletedOnboarding: true,
    language: "en",
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    trackerPanelEnabled: false,
    chibiProfessorMariEnabled: false,
    chatWindowIntroDismissed: true,
    seasonalThemesDisabled: true,
    convoNotificationSound: false,
    rpNotificationSound: false,
    gameNotificationSound: false,
    chatFontOpacity: 90,
    __updatedAt: Date.now(),
  };
  await run.api.json("/api/app-settings/ui", { value: JSON.stringify(ui) }, "PUT");
  const sentinel = await run.api.json("/api/chats/", {
    name: "Backup UI retained conversation",
    mode: "roleplay",
    characterIds: [],
  });
  await run.api.json("/api/ios/flush", {});
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel }),
    headless: true,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-default-browser-check",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    acceptDownloads: true,
    serviceWorkers: "block",
  });
  await context.addCookies([
    { name: "marinara_ios_session", value: run.token, url: run.baseUrl, httpOnly: true, sameSite: "Strict" },
  ]);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === run.baseUrl || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    report.externalRequestsBlocked.push(url.origin);
    return route.abort("blockedbyclient");
  });
  const persistenceSource = await readFile("packages/client/src/lib/ui-persistence.ts", "utf8");
  const uiVersion = Number(persistenceSource.match(/version:\s*(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(uiVersion) && uiVersion > 0);
  const version = (await run.api.json("/api/ios/health")).version;
  await context.addInitScript(
    ({ ui, chatId, uiVersion, version }) => {
      window.__MARINARA_IOS_APP__ = true;
      const saved = JSON.stringify({ state: ui, version: uiVersion });
      localStorage.setItem("marinara-engine-ui", saved);
      localStorage.setItem("marinara-engine-ui:host", saved);
      localStorage.setItem("marinara-active-chat-id", chatId);
      localStorage.setItem("marinara:whats-new:seen-version", version);
    },
    { ui, chatId: sentinel.id, uiVersion, version },
  );
  async function openApp() {
    page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") report.consoleErrors.push(msg.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        report.httpErrors.push({
          status: response.status(),
          method: response.request().method(),
          path: new URL(response.url()).pathname,
        });
    });
    await page.goto(run.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.locator('[data-tour="panel-settings"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('[data-tour="panel-settings"]').click();
  }
  await openApp();
  const savedOpacity = async () => JSON.parse((await run.api.json("/api/app-settings/ui")).value).chatFontOpacity;
  const putWasBusy = (response) =>
    response.status() === 503 &&
    response.request().method() === "PUT" &&
    new URL(response.url()).pathname === "/api/app-settings/ui";
  async function changeOpacity(value) {
    await page.locator("#settings-tab-appearance").click();
    await page.locator("#settings-panel-appearance").getByRole("button", { name: "Roleplay", exact: true }).click();
    const slider = page.locator('#settings-control-roleplay-message-opacity input[type="range"]');
    await slider.focus();
    await slider.press("Home");
    for (let index = 0; index < value / 5; index++) await slider.press("ArrowRight");
    await expect(slider).toHaveValue(String(value));
  }
  async function verifyPreferenceRetry(value) {
    const held = await holdRestoreUpload(run, Buffer.from("deliberately invalid ZIP"));
    const rejectedPreference = page.waitForResponse(putWasBusy, { timeout: 30_000 });
    await changeOpacity(value);
    await rejectedPreference;
    await held.finish(400);
    await expect.poll(savedOpacity, { timeout: 30_000 }).toBe(value);
  }
  await expect
    .poll(async () => JSON.parse((await run.api.json("/api/app-settings/ui")).value).__updatedAt, { timeout: 30_000 })
    .toBeGreaterThan(ui.__updatedAt);
  await changeOpacity(90);
  await verifyPreferenceRetry(25);
  report.checks.push("settings-change-retries-after-real-maintenance-503-without-another-edit");
  await page.locator("#settings-tab-advanced").click();
  const panel = page.getByTestId("ios-backup-settings");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Create full iOS backup", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Save backup to Files", exact: true })).toBeVisible({
    timeout: 120_000,
  });
  assert.equal((await run.api.json("/api/ios/backup/status")).status, "ready");
  report.checks.push("settings-navigation-create-real-backup-and-ready-status");
  await page.screenshot({ path: join(output, "backup-ready.png") });

  const downloaded = page.waitForEvent("download", { timeout: 30_000 });
  await panel.getByRole("button", { name: "Save backup to Files", exact: true }).click();
  const download = await downloaded;
  const backupFile = join(output, "browser-downloaded-backup.zip");
  await download.saveAs(backupFile);
  assert.equal(await download.failure(), null);
  const entries = readStoredZipEntries(await readFile(backupFile));
  assert.ok(entries.some(([name]) => name === "backup-manifest.json"));
  report.checks.push("real-chromium-backup-download-independent-zip-crc");

  async function chooseRestore(file) {
    await page.locator("#settings-tab-advanced").click();
    const picker = page.waitForEvent("filechooser");
    await panel.getByRole("button", { name: "Restore full iOS backup", exact: true }).click();
    await (await picker).setFiles(file);
    await page.getByRole("button", { name: "Validate and prepare restore", exact: true }).click();
  }
  await chooseRestore(backupFile);
  const pending = page.getByRole("dialog", { name: "Backup ready to restore", exact: true });
  await expect(pending).toBeVisible({ timeout: 120_000 });
  assert.equal((await run.api.json("/api/ios/restore/status")).status, "staged");
  assert.equal((await run.api.json(`/api/chats/${sentinel.id}`)).name, sentinel.name);
  await page.keyboard.press("Escape");
  await expect(pending).toBeVisible();
  await expect(pending.getByText(/Fully close Marinar from the app switcher/)).toBeVisible();
  report.checks.push("file-picker-confirm-real-stage-and-global-restart-dialog");
  await pending.getByRole("button", { name: "Cancel restore and keep current data", exact: true }).click();
  await expect(pending).toHaveCount(0, { timeout: 30_000 });
  assert.equal((await run.api.json("/api/ios/restore/status")).status, "idle");

  // Hold a second real upload so the user can edit while preparation is busy;
  // releasing it naturally moves the server from 503 maintenance to staged.
  const heldDuringStage = await holdRestoreUpload(run, await readFile(backupFile));
  const deferredPreference = page.waitForResponse(putWasBusy, { timeout: 30_000 });
  await changeOpacity(65);
  await deferredPreference;
  await heldDuringStage.finish(202);
  await expect(pending).toBeVisible({ timeout: 30_000 });
  assert.equal(await savedOpacity(), 25);
  await delay(5500);
  assert.equal(await savedOpacity(), 25, "A deferred edit must not overwrite settings while a full restore is pending");
  report.checks.push("pending-restore-holds-deferred-settings-without-overwriting-server");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "restore-pending-phone.png") });
  const cancel = pending.getByRole("button", { name: "Cancel restore and keep current data", exact: true });
  const rect = await cancel.boundingBox();
  assert.ok(
    rect && rect.width > 0 && rect.x >= 0 && rect.x + rect.width <= 390 && rect.y >= 0 && rect.y + rect.height <= 844,
    "Restore cancellation must be reachable on a narrow screen",
  );
  await cancel.click();
  await expect(pending).toHaveCount(0, { timeout: 30_000 });
  assert.equal((await run.api.json("/api/ios/restore/status")).status, "idle");
  assert.equal((await run.api.json(`/api/chats/${sentinel.id}`)).name, sentinel.name);
  await expect.poll(savedOpacity, { timeout: 30_000 }).toBe(65);
  report.checks.push("cancel-restore-persists-latest-deferred-settings-without-another-edit");
  report.checks.push("phone-dialog-cancel-keeps-data-and-releases-maintenance");

  await page.locator("#settings-tab-advanced").click();
  await expect(panel.getByRole("button", { name: "Restore full iOS backup", exact: true })).toBeEnabled();
  await chooseRestore({
    name: "invalid-backup.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("deliberately invalid ZIP"),
  });
  await expect(page.getByText("The backup operation could not finish", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(panel.getByRole("button", { name: "Restore full iOS backup", exact: true })).toBeEnabled();
  assert.equal((await run.api.json("/api/ios/restore/status")).status, "idle");
  report.checks.push("invalid-archive-shows-visible-error-with-retry-available");
  await page.screenshot({ path: join(output, "invalid-restore-phone.png") });

  // Apply the real archive through the same cold-start entry point as iOS. A
  // previous successful restore must not suppress retries in the next page.
  await chooseRestore(backupFile);
  await expect(pending).toBeVisible({ timeout: 120_000 });
  await page.close();
  await harness.stop(run);
  run = await harness.start(profile);
  assert.equal((await run.api.json("/api/ios/restore/status")).status, "applied");
  assert.equal((await run.api.json(`/api/chats/${sentinel.id}`)).name, sentinel.name);
  await context.addCookies([
    { name: "marinara_ios_session", value: run.token, url: run.baseUrl, httpOnly: true, sameSite: "Strict" },
  ]);
  await openApp();
  await expect.poll(savedOpacity, { timeout: 30_000 }).toBe(25);
  await page.locator("#settings-tab-appearance").click();
  await page.locator("#settings-panel-appearance").getByRole("button", { name: "Roleplay", exact: true }).click();
  await expect(page.locator('#settings-control-roleplay-message-opacity input[type="range"]')).toHaveValue("25");
  report.checks.push("browser-reopens-real-cold-restored-profile");
  await verifyPreferenceRetry(75);
  assert.equal((await run.api.json("/api/ios/restore/status")).status, "applied");
  report.checks.push("past-applied-restore-does-not-block-new-maintenance-retry");
  await page.screenshot({ path: join(output, "restored-settings-after-retry.png") });
  assert.deepEqual(report.pageErrors, [], "No React/runtime page exception is allowed");
  report.unexpectedHttpErrors = report.httpErrors.filter(
    ({ status, path, method }) =>
      !(
        // Deliberate malformed archive and maintenance refusals are observed as
        // actual HTTP errors, never replaced by mocked success.
        (status === 400 && method === "POST" && path === "/api/ios/restore/stage") ||
        ([409, 503].includes(status) && method === "PUT" && path === "/api/app-settings/ui")
      ),
  );
  assert.deepEqual(report.unexpectedHttpErrors, [], "Unexpected application HTTP errors must be investigated");
  report.status = "passed";
  console.log(`Backup React UI: ${report.checks.length} checks passed.`);
} catch (error) {
  report.status = "failed";
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(report.error);
  if (page) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
    await writeFile(
      join(output, "failure-page.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
} finally {
  for (const request of heldRequests) request.destroy();
  await browser?.close();
  await harness.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

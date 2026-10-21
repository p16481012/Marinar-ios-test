#!/usr/bin/env node
// Cold process replacement tests the same bootstrap used by the native app.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRuntimeHarness } from "./runtime-test-harness.mjs";
import { FIXTURE_KEY, startMockProvider } from "./mock-openai-provider.mjs";
import { assertTransferState, downloadFullBackup, exerciseTransfers, expectRejected, exportPortableProfile, importPortableProfile, verifyPortableAtomicity, verifyStoredCredential, verifyTransferBusy } from "./verify-transfer-lifecycle.mjs";
import { makeStoredZip, readStoredZipEntries } from "./transfer-fixtures.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const entry = resolve(value("--entry", "ios-app/Resources/runtime/bootstrap.cjs"));
const output = resolve(value("--output", ".tmp/ios-transfer-lifecycle"));
const skipFullRestore = args.includes("--skip-full-restore");
const harness = await createRuntimeHarness({ entry, output });
const provider = await startMockProvider();
const startedAt = new Date().toISOString();
const report = { startedAt, entry, physicalDeviceValidated: false, realProviderValidated: false, checks: [], status: "running" };
async function rawConnections(profile) {
  const folder = join(profile.dataDir, "storage/tables/api_connections");
  return (await Promise.all((await readdir(folder)).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(folder, name), "utf8"))))).flat();
}
try {
  const source = await harness.profile("source");
  const fixtureEnv = "IOS_BACKUP_FIXTURE=unicode-transfer-check\n";
  await writeFile(source.envFile, fixtureEnv);
  let run = await harness.start(source);
  const state = await exerciseTransfers({ api: run.api, providerUrl: provider.baseUrl });
  report.checks = state.checks;
  const originalKey = await readFile(join(source.dataDir, ".encryption-key"));
  assert.ok(originalKey.length >= 32);
  const storedConnections = await rawConnections(source);
  assert.ok(!JSON.stringify(storedConnections).includes(FIXTURE_KEY), "The stored API key must be encrypted");
  assert.ok(storedConnections.find((row) => row.id === state.connectionId)?.apiKeyEncrypted, `Connection ${state.connectionId} must be persisted; saved IDs: ${storedConnections.map((row) => row.id).join(", ")}`);
  state.checks.push("api-key-encrypted-in-data-directory");
  await harness.stop(run);
  run = await harness.start(source);
  await assertTransferState({ api: run.api, state });
  state.checks.push("imported-assets-and-relations-survive-cold-restart");
  const competing = await harness.start(source, { expectFailure: true });
  assert.equal(competing.rejected, true, "A second process must not acquire an active profile writer lease");
  assert.match(competing.error, /writer.lease/i, "The second writer must be rejected by storage ownership, not an unrelated startup error");
  await assertTransferState({ api: run.api, state });
  state.checks.push("live-profile-rejects-second-writer-without-data-loss");
  const { portable, zip } = await exportPortableProfile({ api: run.api, state });
  state.checks.push("portable-export-excludes-api-keys-and-encryption-key");
  await verifyPortableAtomicity({ api: run.api, state, portable });
  for (const escaped of [join(source.root, "outside-fixture.txt"), join(source.dataDir, "outside-fixture.txt"), join(output, "outside-fixture.txt")]) {
    await assert.rejects(access(escaped), { code: "ENOENT" }, "The traversal fixture must not create an escaped file");
  }
  await importPortableProfile({ api: run.api, zip, state, existing: true });
  await verifyStoredCredential({ api: run.api, state, providerUrl: provider.baseUrl });
  state.checks.push("portable-import-preserves-existing-endpoint-api-key");

  const target = await harness.profile("destination");
  const targetEnv = "IOS_DESTINATION_FIXTURE=preserve-until-full-restore\n";
  await writeFile(target.envFile, targetEnv);
  let destination = await harness.start(target);
  const portableState = structuredClone(state);
  portableState.messages = portable.data.fileStorage.tables.messages.filter((row) => row.chatId === state.chatId).map(({ id, role, content, characterId }) => ({ id, role, content, characterId }));
  await importPortableProfile({ api: destination.api, zip, state: portableState, existing: false });
  const freshConnection = (await destination.api.json("/api/backup/export-profile")).data.fileStorage.tables.api_connections.find((row) => row.id === state.connectionId);
  assert.equal(freshConnection.apiKeyEncrypted, "");
  // The raw restored table must also contain no key, independently of export sanitization.
  const freshRaw = await rawConnections(target);
  assert.ok(!JSON.stringify(freshRaw).includes(FIXTURE_KEY));
  const keyRow = freshRaw.find((row) => row.id === state.connectionId);
  assert.equal(keyRow.apiKeyEncrypted, "");
  state.checks.push("portable-new-install-restores-data-without-secrets");
  await harness.stop(destination);
  destination = await harness.start(target);
  await assertTransferState({ api: destination.api, state: portableState });
  state.checks.push("portable-import-survives-cold-restart");

  if (!skipFullRestore) {
    await verifyTransferBusy({ api: run.api, state });
    const backup = await downloadFullBackup(run.api);
    await writeFile(join(output, "fixture-full-backup.zip"), backup);
    state.checks.push("asynchronous-full-backup-download");
    const sentinel = await destination.api.json("/api/chats/", { name: "Destination chat must survive invalid imports", mode: "roleplay", characterIds: [] });
    await destination.api.json("/api/ios/flush", {});
    const assertSentinel = async () => assert.equal((await destination.api.json(`/api/chats/${sentinel.id}`)).name, sentinel.name);
    const restoreHeaders = { "x-marinara-confirm-restore": "1" };
    await expectRejected(await destination.api.request("/api/ios/restore/stage", { headers: restoreHeaders, body: destination.api.upload("broken.zip", Buffer.from("invalid backup")) }), "Malformed full backup");
    await assertSentinel();
    const entries = readStoredZipEntries(backup);
    const hostile = makeStoredZip([...entries, ["../../outside-fixture.txt", "must not escape"]]);
    await expectRejected(await destination.api.request("/api/ios/restore/stage", { headers: restoreHeaders, body: destination.api.upload("traversal.zip", hostile) }), "Full backup traversal");
    await assertSentinel();
    const tampered = entries.map(([name, bytes]) => [name, name === "data/.encryption-key" ? Buffer.from("1".repeat(bytes.length)) : bytes]);
    await expectRejected(await destination.api.request("/api/ios/restore/stage", { headers: restoreHeaders, body: destination.api.upload("wrong-hash.zip", makeStoredZip(tampered)) }), "Full backup checksum mismatch");
    await assertSentinel();
    const wrongKey = entries.map(([name, bytes]) => [name, name === "data/.encryption-key" ? Buffer.from("a".repeat(64) + "\n") : bytes]);
    const wrongManifest = JSON.parse(wrongKey.find(([name]) => name === "backup-manifest.json")[1].toString());
    const wrongKeyBytes = wrongKey.find(([name]) => name === "data/.encryption-key")[1];
    Object.assign(wrongManifest.files.find((file) => file.path === "data/.encryption-key"), { size: wrongKeyBytes.length, sha256: createHash("sha256").update(wrongKeyBytes).digest("hex") });
    wrongKey.find(([name]) => name === "backup-manifest.json")[1] = Buffer.from(JSON.stringify(wrongManifest));
    await expectRejected(await destination.api.request("/api/ios/restore/stage", { headers: restoreHeaders, body: destination.api.upload("wrong-key.zip", makeStoredZip(wrongKey)) }), "Mismatched encryption key with valid checksums");
    await assertSentinel();
    const misplaced = entries.map(([name, bytes]) => [name, bytes]);
    const shard = misplaced.find(([name]) => name.startsWith("data/storage/tables/characters/"));
    assert.ok(shard, "Fixture must include a file-native character shard");
    const oldPath = shard[0]; shard[0] = "data/storage/tables/characters/not-the-row-id.json";
    const misplacedManifest = JSON.parse(misplaced.find(([name]) => name === "backup-manifest.json")[1].toString());
    misplacedManifest.files.find((file) => file.path === oldPath).path = shard[0];
    misplaced.find(([name]) => name === "backup-manifest.json")[1] = Buffer.from(JSON.stringify(misplacedManifest));
    await expectRejected(await destination.api.request("/api/ios/restore/stage", { headers: restoreHeaders, body: destination.api.upload("misplaced-shard.zip", makeStoredZip(misplaced)) }), "Misplaced storage shard with valid checksums");
    await assertSentinel();
    state.checks.push("invalid-full-backups-preserve-current-data", "full-backup-checksum-and-encrypted-credential-validation", "full-backup-rejects-invalid-storage-shard-ownership");
    const stage = async () => {
      const response = await destination.api.request("/api/ios/restore/stage", { headers: restoreHeaders, body: destination.api.upload("backup.zip", backup) });
      assert.equal(response.status, 202, await (!response.ok ? response.text() : Promise.resolve("")));
      return response.json();
    };
    const staged = await stage();
    assert.equal(staged.status, "staged"); assert.equal(staged.restartRequired, true);
    await assertSentinel();
    const writeWhileStaged = await destination.api.request("/api/chats/", { body: { name: "Cannot write while restore is pending", mode: "roleplay" } });
    assert.equal(writeWhileStaged.status, 409);
    assert.equal((await writeWhileStaged.json()).code, "IOS_RESTORE_PENDING");
    const cancel = await destination.api.json("/api/ios/restore/stage", undefined, "DELETE");
    assert.equal((await destination.api.json("/api/ios/restore/status")).status, "idle", JSON.stringify(cancel));
    await assertSentinel();
    state.checks.push("staged-restore-is-deferred-and-cancellable");

    await stage();
    await harness.stop(destination);
    const restoreRoot = join(dirname(target.envFile), "ios-restore");
    await writeFile(join(restoreRoot, "staged/data/.encryption-key"), "corrupted after staging\n");
    destination = await harness.start(target);
    assert.equal((await destination.api.json("/api/ios/restore/status")).status, "failed");
    await assertSentinel();
    await assertTransferState({ api: destination.api, state: portableState });
    assert.equal(await readFile(target.envFile, "utf8"), targetEnv);
    state.checks.push("staged-file-corruption-keeps-original-profile");

    const preload = join(output, "interrupt-restore.cjs");
    for (const [point, crashTarget] of [["original-moved", join(restoreRoot, "rollback/data")], ["replacement-installed", target.dataDir]]) {
      await stage();
      await harness.stop(destination);
      const marker = join(output, `interrupted-${point}.json`);
      await writeFile(preload, `const fs = require('node:fs'); const original = fs.promises.rename; fs.promises.rename = async function (from, to) { const result = await original.call(this, from, to); if (to === ${JSON.stringify(crashTarget)}) { fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ point: ${JSON.stringify(point)}, renamed: true })); process.kill(process.pid, 'SIGKILL'); } return result; };\n`);
      const interrupted = await harness.start(target, { preload, expectFailure: true });
      assert.equal(interrupted.rejected, true, "The restore process must stop after the selected rename succeeds");
      assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { point, renamed: true }, "The fault must be injected after a real rename, not mistaken for an unrelated startup failure");
      destination = await harness.start(target);
      assert.equal((await destination.api.json("/api/ios/restore/status")).status, "rolled-back");
      await assertSentinel();
      await assertTransferState({ api: destination.api, state: portableState });
      assert.equal(await readFile(target.envFile, "utf8"), targetEnv);
      state.checks.push(`interrupted-restore-${point}-rolls-back-original-profile`);
    }

    await stage();
    await harness.stop(destination);
    destination = await harness.start(target);
    assert.equal((await destination.api.json("/api/ios/restore/status")).status, "applied");
    await assertTransferState({ api: destination.api, state });
    assert.equal((await destination.api.request(`/api/chats/${sentinel.id}`)).status, 404, "Full restore replaces, rather than merges, the destination");
    assert.deepEqual(await readFile(join(target.dataDir, ".encryption-key")), originalKey);
    assert.equal(await readFile(target.envFile, "utf8"), `ENCRYPTION_KEY=${originalKey.toString().trim()}\n`, "Only the validated encryption key is restored into the native environment");
    await verifyStoredCredential({ api: destination.api, state, providerUrl: provider.baseUrl });
    state.checks.push("full-restore-replaces-data-on-next-cold-launch", "full-restore-preserves-encryption-key-assets-and-relations", "full-restore-sanitizes-environment-settings", "full-restore-api-key-authenticates-without-reentry");
    await harness.stop(destination);
    destination = await harness.start(target);
    await assertTransferState({ api: destination.api, state });
    state.checks.push("restored-full-backup-survives-second-cold-launch");
  }
  report.status = "passed";
  report.fullRestoreTested = !skipFullRestore;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "state.json"), JSON.stringify(state, null, 2) + "\n");
  console.log(`Transfer lifecycle: ${report.checks.length} checks passed${skipFullRestore ? " (full restore not run)" : ""}.`);
} catch (error) {
  report.status = "failed";
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await harness.close();
  await provider.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

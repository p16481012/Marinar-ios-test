// The public HTTP routes are the contract; fixtures do not import server internals.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { embedCharacterCardPng } from "../../packages/client/src/lib/character-card-png.ts";
import { ABORT_PROMPT, FIXTURE_KEY, FIXTURE_MODEL, RESTORE_PROMPT, RESTORE_REPLY } from "./mock-openai-provider.mjs";
import { CHARACTER_CARD, CHARACTER_DESCRIPTION, CHARACTER_NAME, CHAT_LINES, LOREBOOK, LORE_CONTENT, MINIMAL_PNG, PRESET, makeCharacterPng, readCharacterPng, makeStoredZip } from "./transfer-fixtures.mjs";

const parse = (value) => typeof value === "string" ? JSON.parse(value) : value;
const messageSnapshot = (items) => items.map(({ id, role, content, characterId }) => ({ id, role, content, characterId }));
const sectionSnapshot = (items) => items.map(({ identifier, name, content, role, isMarker }) => ({ identifier, name, content, role, isMarker }));
export async function expectRejected(response, label) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { /* HTTP status still identifies a rejected malformed upload. */ }
  assert.ok((response.status >= 400 && response.status < 500) || (response.ok && (body?.success === false || body?.error)), `${label} must be rejected without an internal error; HTTP ${response.status}: ${text.slice(0, 500)}`);
  return { status: response.status, body };
}

export async function assertTransferState({ api, state }) {
  const character = await api.json(`/api/characters/${state.characterId}`);
  assert.equal(parse(character.data).name, CHARACTER_NAME);
  assert.equal(parse(character.data).description, CHARACTER_DESCRIPTION);
  assert.equal(character.avatarPath, state.avatarPath);
  const avatar = await api.request(character.avatarPath);
  assert.equal(avatar.status, 200);
  assert.equal(Buffer.from(await avatar.arrayBuffer()).toString("base64"), state.avatarBase64, "Original PNG avatar bytes must survive transfer");
  const lorebook = await api.json(`/api/lorebooks/${state.embeddedLorebookId}`);
  assert.ok(lorebook.characterId === state.characterId || parse(lorebook.characterIds ?? "[]").includes(state.characterId), "Embedded lorebook must retain its character relationship");
  assert.ok((await api.json(`/api/lorebooks/${state.embeddedLorebookId}/entries`)).some((entry) => entry.content === LORE_CONTENT));
  assert.ok((await api.json(`/api/lorebooks/${state.lorebookId}/entries`)).some((entry) => entry.content === LORE_CONTENT));
  const preset = await api.json(`/api/prompts/${state.presetId}/full`);
  assert.deepEqual(sectionSnapshot(preset.sections), state.sections);
  const chat = await api.json(`/api/chats/${state.chatId}`);
  assert.ok(parse(chat.characterIds).includes(state.characterId));
  assert.equal(chat.connectionId, state.connectionId);
  assert.equal(chat.promptPresetId, state.presetId);
  assert.deepEqual(messageSnapshot(await api.json(`/api/chats/${state.chatId}/messages`)), state.messages);
}

export async function verifyStoredCredential({ api, state, providerUrl }) {
  const stats = async () => (await fetch(`${new URL(providerUrl).origin}/__fixture__/stats`)).json();
  const before = (await stats()).calls.length;
  const response = await api.request("/api/generate/", { body: { chatId: state.chatId, userMessage: RESTORE_PROMPT, streaming: true, submissionId: randomUUID(), skipPresenceDelay: true } });
  assert.equal(response.status, 200);
  const events = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()));
  assert.deepEqual(events.filter((event) => event.type === "error"), [], "Restored credentials must work without being entered again");
  assert.equal(events.filter((event) => event.type === "token").map((event) => event.data).join(""), RESTORE_REPLY);
  assert.ok(events.some((event) => event.type === "message_saved" && event.data?.content === RESTORE_REPLY));
  const calls = (await stats()).calls.slice(before);
  assert.equal(calls.length, 1);
  assert.ok(JSON.stringify(calls[0].messages).includes(CHAT_LINES[2].mes), "Imported conversation history must reach the provider");
  state.messages = messageSnapshot(await api.json(`/api/chats/${state.chatId}/messages`));
  await api.json("/api/ios/flush", {});
}

export async function exerciseTransfers({ api, providerUrl }) {
  const checks = [];
  const connection = await api.json("/api/connections/", { name: "Transfer fixture API", provider: "custom", baseUrl: providerUrl, apiKey: FIXTURE_KEY, model: FIXTURE_MODEL, isDefault: true, maxContext: 8192, maxTokensOverride: 256 });
  const imported = await api.json("/api/import/st-character", api.upload("archive.png", makeCharacterPng(), { importEmbeddedLorebook: true }, "image/png"));
  assert.equal(imported.success, true, JSON.stringify(imported));
  assert.ok(imported.lorebook?.lorebookId);
  const character = await api.json(`/api/characters/${imported.characterId}`);
  assert.equal(parse(character.data).description, CHARACTER_DESCRIPTION);
  const avatarResponse = await api.request(character.avatarPath);
  assert.equal(avatarResponse.status, 200);
  const avatarBase64 = Buffer.from(await avatarResponse.arrayBuffer()).toString("base64");
  const png = await api.request(`/api/characters/${character.id}/export-png`);
  assert.equal(png.status, 200);
  const exportedCard = readCharacterPng(Buffer.from(await png.arrayBuffer()));
  assert.equal(exportedCard.data.description, CHARACTER_DESCRIPTION);
  const compatible = await api.json(`/api/characters/${character.id}/export?format=compatible`);
  const fromJson = await api.json("/api/import/st-character", { ...compatible, data: { ...compatible.data, name: "JSON roundtrip companion" } });
  assert.equal(fromJson.success, true);
  assert.equal(parse((await api.json(`/api/characters/${fromJson.characterId}`)).data).description, CHARACTER_DESCRIPTION);
  const native = await api.json(`/api/characters/${character.id}/export`);
  const fromNative = await api.json("/api/import/marinara", native);
  assert.equal(fromNative.success, true);
  assert.equal(parse((await api.json(`/api/characters/${fromNative.id}`)).data).description, CHARACTER_DESCRIPTION);
  checks.push("character-png-json-native-roundtrip", "embedded-lorebook-and-avatar-preserved");

  // Execute the production Bot Browser encoder, not the independent fixture
  // encoder above. Its PNG must retain the lorebook through the real importer.
  const frontendData = { ...structuredClone(CHARACTER_CARD.data), name: "Bot Browser PNG 한글 카드" };
  const frontendPng = Buffer.from(await embedCharacterCardPng(MINIMAL_PNG, frontendData).arrayBuffer());
  assert.deepEqual(readCharacterPng(frontendPng).data.character_book, frontendData.character_book,
    "The frontend PNG must contain its embedded lorebook and a valid metadata CRC");
  const frontendImport = await api.json("/api/import/st-character",
    api.upload("bot-browser-roundtrip.png", frontendPng, { importEmbeddedLorebook: true }, "image/png"));
  assert.equal(frontendImport.success, true, JSON.stringify(frontendImport));
  assert.ok(frontendImport.lorebook?.lorebookId, "The frontend PNG import must create its embedded lorebook");
  const frontendCharacter = parse((await api.json(`/api/characters/${frontendImport.characterId}`)).data);
  assert.equal(frontendCharacter.name, frontendData.name);
  assert.equal(frontendCharacter.description, frontendData.description);
  assert.equal(frontendCharacter.first_mes, frontendData.first_mes);
  const frontendLorebookId = frontendImport.lorebook.lorebookId;
  const frontendLorebook = await api.json(`/api/lorebooks/${frontendLorebookId}`);
  assert.ok(frontendLorebook.characterId === frontendImport.characterId
    || parse(frontendLorebook.characterIds ?? "[]").includes(frontendImport.characterId),
  "The imported frontend lorebook must be linked to its character");
  const frontendEntries = await api.json(`/api/lorebooks/${frontendLorebookId}/entries`);
  assert.deepEqual(frontendEntries.map((entry) => ({ content: entry.content, keys: parse(entry.keys),
    enabled: String(entry.enabled), order: entry.order })),
  frontendData.character_book.entries.map((entry) => ({ content: entry.content, keys: entry.keys,
    enabled: String(entry.enabled), order: entry.insertion_order })));
  checks.push("frontend-png-export-import-preserves-embedded-lorebook");

  const lore = await api.json("/api/import/st-lorebook", LOREBOOK);
  assert.equal(lore.success, true);
  const loreNative = await api.json(`/api/lorebooks/${lore.lorebookId}/export`);
  const loreClone = await api.json("/api/import/marinara", loreNative);
  assert.equal(loreClone.success, true);
  assert.ok((await api.json(`/api/lorebooks/${loreClone.id}/entries`)).some((item) => item.content === LORE_CONTENT));
  const loreCompatible = await api.json(`/api/lorebooks/${lore.lorebookId}/export?format=compatible`);
  assert.ok(Object.values(loreCompatible.entries).some((item) => item.content === LORE_CONTENT));
  checks.push("lorebook-compatible-native-roundtrip");

  const preset = await api.json("/api/import/st-preset", PRESET);
  assert.equal(preset.success, true);
  const fullPreset = await api.json(`/api/prompts/${preset.presetId}/full`);
  assert.ok(fullPreset.sections.some((section) => section.content?.includes("한글 지침")));
  const presetNative = await api.json(`/api/prompts/${preset.presetId}/export`);
  const presetClone = await api.json("/api/import/marinara", presetNative);
  assert.equal(presetClone.success, true);
  assert.deepEqual(sectionSnapshot((await api.json(`/api/prompts/${presetClone.id}/full`)).sections), sectionSnapshot(fullPreset.sections));
  checks.push("preset-content-and-section-order-roundtrip");

  const chat = await api.json("/api/import/st-chat", api.upload("archive.jsonl", CHAT_LINES.map((line) => JSON.stringify(line)).join("\n"), { mode: "roleplay" }));
  assert.equal(chat.success, true);
  await api.json(`/api/chats/${chat.chatId}`, { characterIds: [character.id], connectionId: connection.id, promptPresetId: preset.presetId }, "PATCH");
  const messages = await api.json(`/api/chats/${chat.chatId}/messages`);
  assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), CHAT_LINES.slice(1).map((line) => ({ role: line.is_user ? "user" : "assistant", content: line.mes })));
  const chatExport = await api.request(`/api/chats/${chat.chatId}/export?format=jsonl`);
  assert.equal(chatExport.status, 200);
  const chatText = await chatExport.text();
  const chatClone = await api.json("/api/import/st-chat", api.upload("roundtrip.jsonl", chatText));
  assert.equal(chatClone.success, true);
  assert.deepEqual((await api.json(`/api/chats/${chatClone.chatId}/messages`)).map(({ role, content }) => ({ role, content })), messages.map(({ role, content }) => ({ role, content })));
  checks.push("chat-jsonl-message-order-unicode-roundtrip");
  const state = { version: 1, checks, characterId: character.id, avatarPath: character.avatarPath, avatarBase64, embeddedLorebookId: imported.lorebook.lorebookId, lorebookId: lore.lorebookId, presetId: preset.presetId, sections: sectionSnapshot(fullPreset.sections), chatId: chat.chatId, connectionId: connection.id, messages: messageSnapshot(messages) };
  await assertTransferState({ api, state });

  const before = (await api.json("/api/characters/")).map((item) => item.id).sort();
  await expectRejected(await api.request("/api/import/st-character", { body: api.upload("broken.png", Buffer.from("not a PNG"), {}, "image/png") }), "Malformed character PNG");
  await expectRejected(await api.request("/api/import/marinara", { body: { type: "unknown_fixture", version: 1, data: {} } }), "Unknown native envelope");
  assert.deepEqual((await api.json("/api/characters/")).map((item) => item.id).sort(), before, "Malformed cards must not leave partial characters");
  checks.push("malformed-character-import-does-not-mutate-library");
  await api.json("/api/ios/flush", {});
  return state;
}

export async function exportPortableProfile({ api, state }) {
  const portable = await api.json("/api/backup/export-profile");
  assert.equal(portable.type, "marinara_profile");
  const connection = portable.data.fileStorage.tables.api_connections.find((row) => row.id === state.connectionId);
  assert.ok(connection);
  assert.equal(connection.apiKeyEncrypted, "");
  assert.equal(connection.managementTokenEncrypted, "");
  assert.ok(!portable.data.fileStorage.files.some((item) => item.path.includes(".encryption-key")));
  assert.ok(!JSON.stringify(portable).includes(FIXTURE_KEY), "Portable exports must not carry the API key");
  const zipResponse = await api.request("/api/backup/export-profile?format=zip");
  assert.equal(zipResponse.status, 200);
  const zip = Buffer.from(await zipResponse.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  return { portable, zip };
}

export async function verifyPortableAtomicity({ api, state, portable }) {
  // A valid early row plus an invalid later table must never partly update the library.
  const changed = structuredClone(portable.data.fileStorage.tables.characters.find((row) => row.id === state.characterId));
  const data = parse(changed.data); data.name = "THIS MUST NOT BE COMMITTED"; changed.data = JSON.stringify(data);
  const invalid = { type: "marinara_profile", version: 1, data: { fileStorage: { version: 1, tables: { characters: [changed], chats: [{ name: "Missing required identity" }] }, files: [] } } };
  await expectRejected(await api.request("/api/backup/import-profile", { body: invalid }), "Invalid profile table");
  await assertTransferState({ api, state });
  const traversal = makeStoredZip([["marinara-profile.json", JSON.stringify({ type: "marinara_profile", version: 1, data: { fileStorage: { version: 1, tables: {}, files: [{ path: "../../outside-fixture.txt", size: 15 }] } } })], ["../../outside-fixture.txt", "must not escape"]]);
  const response = await api.request("/api/backup/import-profile", { body: api.upload("traversal.zip", traversal) });
  // Portable import may skip unsupported assets; its security promise is that none is extracted.
  if (response.ok) assert.equal((await response.json()).imported.files, 0);
  else await expectRejected(response, "Traversal ZIP");
  await assertTransferState({ api, state });
  state.checks.push("invalid-profile-rejected-before-table-mutation", "profile-zip-path-traversal-not-extracted");
}

export async function importPortableProfile({ api, zip, state, existing }) {
  const before = await api.json("/api/chats/");
  const preview = await api.json("/api/backup/import-profile?preview=true", api.upload("profile.zip", zip));
  assert.equal(preview.success, true);
  assert.ok(preview.previewToken);
  assert.deepEqual(await api.json("/api/chats/"), before, "Preview must not write chats");
  const imported = await api.request("/api/backup/import-profile", { method: "POST", headers: { "x-profile-preview-token": preview.previewToken } });
  assert.equal(imported.status, 200, await (!imported.ok ? imported.text() : Promise.resolve("")));
  assert.equal((await imported.json()).success, true);
  const replay = await api.request("/api/backup/import-profile", { method: "POST", headers: { "x-profile-preview-token": preview.previewToken } });
  assert.equal(replay.status, 410, "Import confirmations must not be replayable");
  await assertTransferState({ api, state });
  state.checks.push(existing ? "portable-preview-confirm-replay-and-same-install-relations" : "portable-new-install-restores-data-without-secrets");
  await api.json("/api/ios/flush", {});
}

export async function downloadFullBackup(api) {
  const started = await api.request("/api/ios/backup/start", { body: {} });
  assert.equal(started.status, 202);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = await api.json("/api/ios/backup/status");
    assert.notEqual(status.status, "failed", JSON.stringify(status));
    if (status.status === "ready") {
      const result = await api.request("/api/ios/backup/download");
      assert.equal(result.status, 200);
      return Buffer.from(await result.arrayBuffer());
    }
    await delay(100);
  }
  throw new Error("Full backup did not become ready");
}

export async function verifyTransferBusy({ api, state }) {
  const chat = await api.json("/api/chats/", { name: "Transfer concurrency fixture", mode: "roleplay", characterIds: [state.characterId], connectionId: state.connectionId });
  const stream = await api.request("/api/generate/", { body: { chatId: chat.id, userMessage: ABORT_PROMPT, streaming: true, submissionId: randomUUID(), skipPresenceDelay: true } });
  assert.equal(stream.status, 200);
  const decoder = new TextDecoder(); let pending = "", checked = false;
  try {
    for await (const chunk of stream.body) {
      pending += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5));
        if (event.type !== "token" || checked) continue;
        checked = true;
        assert.equal((await api.json(`/api/generate/status/${chat.id}`)).active, true);
        const backup = await api.request("/api/ios/backup/start", { body: {}, signal: AbortSignal.timeout(7000) });
        assert.equal(backup.status, 409, "Backup must not snapshot an active streaming generation");
        await backup.text();
        const restore = await api.request("/api/ios/restore/stage", { headers: { "x-marinara-confirm-restore": "1" }, body: api.upload("busy.zip", Buffer.from("not reached while busy")), signal: AbortSignal.timeout(7000) });
        assert.equal(restore.status, 409, "Restore must refuse while generation is still writing");
        await restore.text();
        assert.equal((await api.json("/api/generate/abort", { chatId: chat.id })).aborted, true);
      }
    }
  } finally {
    if ((await api.json(`/api/generate/status/${chat.id}`)).active) await api.json("/api/generate/abort", { chatId: chat.id });
  }
  assert.equal(checked, true, "Busy checks must run during actual streamed output");
  state.checks.push("full-backup-and-restore-refuse-active-generation");
}

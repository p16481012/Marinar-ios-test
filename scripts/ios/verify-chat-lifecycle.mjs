#!/usr/bin/env node
// Exercises the real HTTP routes; usable against desktop Node or an iOS Simulator app.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ABORT_PROMPT, ERROR_PROMPT, FIXTURE_KEY, FIXTURE_MODEL, RESTORE_PROMPT,
  RESTORE_REPLY, STREAM_PROMPT, STREAM_REPLY,
} from "./mock-openai-provider.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export function loopbackUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:", "Fixture tests use local HTTP only");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Refusing to run fixture tests against a remote host");
  assert.ok(!url.username && !url.password, "Do not put credentials in fixture URLs");
  return url;
}

export async function runChatPhase({ phase, baseUrl, providerUrl, stateFile, token }) {
  const origin = loopbackUrl(baseUrl).origin;
  const provider = loopbackUrl(providerUrl);
  assert.match(token ?? "", /^[a-f0-9]{64}$/i, "MARINARA_IOS_TOKEN must be a 32-byte hex test token");
  assert.ok(["seed", "exercise", "restore"].includes(phase), "Phase must be seed, exercise, or restore");
  const headers = {
    "content-type": "application/json", origin,
    "x-marinara-csrf": "1", "x-marinara-ios-token": token,
  };
  const request = (path, body, options = {}) => fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000), ...options,
  });
  const json = async (path, body) => {
    const response = await request(path, body);
    const text = await response.text();
    assert.ok(response.ok, `${path}: HTTP ${response.status}: ${text.slice(0, 1500)}`);
    return JSON.parse(text);
  };
  const stats = async () => {
    const response = await fetch(`${provider.origin}/__fixture__/stats`, { signal: AbortSignal.timeout(5_000) });
    assert.ok(response.ok, "Fixture server must remain available");
    return response.json();
  };
  const persist = async (state) => {
    await mkdir(dirname(resolve(stateFile)), { recursive: true });
    await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
  };
  const waitIdle = async (chatId) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const status = await json(`/api/generate/status/${chatId}`);
      if (!status.active && !status.translating) return;
      await sleep(100);
    }
    throw new Error(`Generation did not release the chat: ${chatId}`);
  };
  const generate = async (chatId, userMessage, onEvent = async () => {}) => {
    const response = await request("/api/generate/", {
      chatId, userMessage, streaming: true, submissionId: randomUUID(), skipPresenceDelay: true,
    });
    assert.equal(response.status, 200, await (!response.ok ? response.text() : Promise.resolve("")));
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = [];
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5).trim());
        events.push(event);
        await onEvent(event);
      }
    }
    await waitIdle(chatId);
    return events;
  };
  const messages = (chatId) => json(`/api/chats/${chatId}/messages`);
  const snapshot = (items) => items.map(({ id, role, content, characterId }) => ({ id, role, content, characterId }));
  const assertReply = (events, expected) => {
    assert.deepEqual(events.filter((event) => event.type === "error"), [], "No hidden generation error is allowed");
    assert.ok(events.some((event) => event.type === "done"), "The stream must finish explicitly");
    const tokens = events.filter((event) => event.type === "token");
    assert.ok(tokens.length >= 2, "The app must receive multiple streamed text chunks");
    assert.equal(tokens.map((event) => event.data).join(""), expected);
    assert.ok(events.some((event) => event.type === "message_saved" && event.data?.role === "assistant" && event.data.content === expected), "The server must acknowledge saving the generated reply");
  };
  const newChat = (state, name) => json("/api/chats/", {
    name, mode: "roleplay", characterIds: [state.characterId], connectionId: state.connectionId,
  });

  if (phase === "restore") {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.phase, "exercise", "Run the exercise phase before restarting");
    assert.deepEqual(snapshot(await messages(state.chatId)), state.messages, "Saved message IDs, text, order, and roles must survive process replacement");
    assert.deepEqual(snapshot(await messages(state.abortChatId)), state.abortMessages, "The stopped conversation must also survive restarting");
    assert.deepEqual(snapshot(await messages(state.errorChatId)), state.errorMessages, "A failed provider request must not erase the saved user message");
    const chat = await json(`/api/chats/${state.chatId}`);
    assert.equal(chat.connectionId, state.connectionId);
    await json(`/api/characters/${state.characterId}`);
    await json(`/api/connections/${state.connectionId}`);
    const before = (await stats()).calls.length;
    assertReply(await generate(state.chatId, RESTORE_PROMPT), RESTORE_REPLY);
    const after = (await stats()).calls.slice(before);
    assert.equal(after.length, 1, "Restoring and continuing must make one authenticated provider request");
    assert.equal(after[0].kind, "restore");
    assert.match(JSON.stringify(after[0].messages), /blue lantern/);
    assert.ok(JSON.stringify(after[0].messages).includes(STREAM_REPLY), "The saved assistant reply must re-enter the next provider prompt");
    const restored = await messages(state.chatId);
    assert.equal(restored.filter((item) => item.role === "user").length, 2);
    assert.equal(restored.filter((item) => item.role === "assistant").length, 2);
    assert.equal((await json("/api/ios/flush", {})).ok, true);
    state.phase = "restore";
    state.restoredMessages = snapshot(restored);
    state.checks.push("process-restart-restoration", "restored-api-credentials", "restored-history-in-next-prompt");
    await persist(state);
    return state;
  }

  const connection = await json("/api/connections/", {
    name: "iOS loopback fixture", provider: "custom", baseUrl: provider.href.replace(/\/$/, ""),
    apiKey: FIXTURE_KEY, model: FIXTURE_MODEL, isDefault: true, maxContext: 8192, maxTokensOverride: 256,
  });
  const character = await json("/api/characters/", { data: {
    name: "iOS Test Companion", description: "A small test companion. Reply plainly and remember the conversation.", first_mes: "",
  } });
  const state = { version: 1, phase: "seed", connectionId: connection.id, characterId: character.id, checks: [] };
  assert.ok(state.connectionId && state.characterId, "Real connection and character routes must return IDs");
  const chat = await newChat(state, "iOS chat lifecycle fixture");
  state.chatId = chat.id;
  assert.ok(state.chatId);
  if (phase === "seed") {
    assert.equal((await json("/api/ios/flush", {})).ok, true);
    await persist(state);
    return state;
  }

  const noToken = await fetch(`${origin}/api/ios/flush`, {
    method: "POST", headers: { "content-type": "application/json", origin, "x-marinara-csrf": "1" },
    body: "{}", signal: AbortSignal.timeout(5_000),
  });
  assert.ok([401, 403].includes(noToken.status), "The native flush route must reject requests without its per-launch token");
  state.checks.push("native-route-token-required");
  const unauthenticated = await fetch(`${origin}/api/chats/`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(unauthenticated.status, 401, "Device-local sockets must not expose conversations without the app session");
  const badOrigin = await request("/api/chats/", undefined, { headers: { ...headers, origin: "https://example.invalid" } });
  assert.equal(badOrigin.status, 403, "An unrelated browser origin must not reuse the app token");
  const cookieOnly = await request("/api/ios/flush", {}, {
    headers: { "content-type": "application/json", origin, "x-marinara-csrf": "1", cookie: `marinara_ios_session=${token}` },
  });
  assert.equal(cookieOnly.status, 403, "The WebView session cookie alone must not authorize the native flush endpoint");
  const unsupported = await request("/api/sidecar/status");
  assert.equal(unsupported.status, 501, "Unsupported local runtimes must return an explicit unavailable status");
  const capabilities = await json("/api/ios/capabilities");
  assert.equal(capabilities.remoteApiChat, true);
  assert.equal(capabilities.fileStorage, true);
  assert.equal(capabilities.localModels, false);
  state.checks.push("session-and-origin-isolation", "unsupported-capabilities-explicit");

  const normal = await generate(state.chatId, STREAM_PROMPT);
  assertReply(normal, STREAM_REPLY);
  const saved = await messages(state.chatId);
  assert.equal(saved.filter((item) => item.role === "user").length, 1);
  assert.equal(saved.filter((item) => item.role === "assistant").length, 1);
  assert.equal(saved.find((item) => item.role === "user")?.content, STREAM_PROMPT);
  assert.equal(saved.find((item) => item.role === "assistant")?.content, STREAM_REPLY);
  state.messages = snapshot(saved);
  state.checks.push("remote-api-streaming", "saved-user-and-assistant-messages");

  state.abortChatId = (await newChat(state, "iOS stop fixture")).id;
  let abortSent = false;
  const stopped = await generate(state.abortChatId, ABORT_PROMPT, async (event) => {
    if (event.type !== "token" || abortSent) return;
    abortSent = true;
    assert.equal((await json(`/api/generate/status/${state.abortChatId}`)).active, true);
    assert.equal((await json("/api/generate/abort", { chatId: state.abortChatId })).aborted, true);
  });
  assert.ok(abortSent, "Explicit stop must be sent while real streaming is active");
  assert.ok(stopped.filter((event) => event.type === "token").length > 0);
  const abortCall = (await stats()).calls.findLast((call) => call.kind === "abort");
  assert.ok(abortCall && !abortCall.completed, "The provider must be stopped before completing its long response");
  state.abortMessages = snapshot(await messages(state.abortChatId));
  assert.equal(state.abortMessages.filter((item) => item.role === "user").length, 1);
  state.checks.push("explicit-stop-during-streaming", "generation-lock-released");

  state.errorChatId = (await newChat(state, "iOS provider failure fixture")).id;
  const failed = await generate(state.errorChatId, ERROR_PROMPT);
  assert.ok(failed.some((event) => event.type === "error" && String(event.data).includes("fixture failure")), "Provider failure must reach the client as a visible error event");
  state.errorMessages = snapshot(await messages(state.errorChatId));
  assert.equal(state.errorMessages.filter((item) => item.role === "user").length, 1);
  assert.equal(state.errorMessages.filter((item) => item.role === "assistant").length, 0, "Provider failures must not manufacture a successful reply");
  state.checks.push("provider-error-surfaced");

  assert.equal((await json("/api/ios/flush", {})).ok, true);
  state.phase = "exercise";
  state.checks.push("native-flush-acknowledged");
  await persist(state);
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const result = await runChatPhase({
    phase: option("--phase"), baseUrl: option("--base-url"), providerUrl: option("--provider-url"),
    stateFile: option("--state-file"), token: process.env.MARINARA_IOS_TOKEN,
  });
  console.log(JSON.stringify({ phase: result.phase, chatId: result.chatId, checks: result.checks }));
}

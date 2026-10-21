import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeHarness } from "./runtime-test-harness.mjs";
import { PROTOCOL_KEY, PROTOCOL_REPLY, startProtocolProviders } from "./mock-api-providers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const entry = resolve(root, option("--entry") ?? "ios-app/Resources/runtime/bootstrap.cjs");
const output = resolve(root, option("--output") ?? ".tmp/ios-provider-lifecycle");
await mkdir(output, { recursive: true });
const harness = await createRuntimeHarness({ entry, output });
const mock = await startProtocolProviders();
const report = { passed: false, physicalDeviceValidated: false, realProvidersValidated: false, checks: [] };

async function generate(api, chatId, userMessage) {
  const response = await api.request("/api/generate/", { body: { chatId, userMessage, streaming: true, submissionId: randomUUID(), skipPresenceDelay: true } });
  assert.equal(response.status, 200);
  const events = (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
  assert.deepEqual(events.filter(e => e.type === "error"), []);
  assert.ok(events.some(e => e.type === "done"));
  const tokens = events.filter(e => e.type === "token");
  assert.ok(tokens.length >= 2, "Adapter must emit multiple text chunks");
  assert.equal(tokens.map(e => e.data).join(""), PROTOCOL_REPLY);
  assert.ok(events.some(e => e.type === "message_saved" && e.data?.content === PROTOCOL_REPLY));
}

try {
  const profile = await harness.profile("providers");
  let run = await harness.start(profile);
  const character = await run.api.json("/api/characters/", { data: { name: "Protocol fixture", first_mes: "" } });
  const states = [];
  for (const [provider, model] of [["openai", "gpt-4o-mini"], ["anthropic", "claude-3-haiku-20240307"], ["google", "gemini-2.0-flash"]]) {
    const connection = await run.api.json("/api/connections/", { name: `Fixture ${provider}`, provider, model,
      baseUrl: mock.baseUrl + (provider === "google" ? "" : "/v1"), apiKey: PROTOCOL_KEY, maxTokensOverride: 256, maxContext: 8192 });
    const chat = await run.api.json("/api/chats/", { name: provider, mode: "roleplay", characterIds: [character.id], connectionId: connection.id });
    await generate(run.api, chat.id, `Remember protocol-${provider}.`);
    assert.equal(mock.calls.at(-1).provider, provider);
    const messages = await run.api.json(`/api/chats/${chat.id}/messages`);
    assert.equal(messages.filter(m => m.role === "assistant" && m.content === PROTOCOL_REPLY).length, 1);
    states.push({ provider, chatId: chat.id, messages });
    report.checks.push(`${provider}-authenticated-protocol`, `${provider}-utf8-stream-and-save`);
  }
  await run.api.json("/api/ios/flush", {});
  await harness.stop(run);
  run = await harness.start(profile);
  for (const state of states) {
    const actual = await run.api.json(`/api/chats/${state.chatId}/messages`);
    assert.deepEqual(actual.map(m => [m.id, m.role, m.content]), state.messages.map(m => [m.id, m.role, m.content]));
    await generate(run.api, state.chatId, "Continue after restarting.");
    const call = mock.calls.at(-1);
    assert.equal(call.provider, state.provider);
    assert.ok(JSON.stringify(call.body).includes(PROTOCOL_REPLY));
    assert.ok(JSON.stringify(call.body).includes(`protocol-${state.provider}`));
    report.checks.push(`${state.provider}-cold-launch-history`, `${state.provider}-restored-key-and-continuation`);
  }
  assert.deepEqual(mock.errors, []);
  assert.equal(mock.calls.length, 6);
  report.passed = true;
  console.log(`Passed ${report.checks.length} provider protocol checks (local mock APIs only).`);
} catch (error) {
  report.error = String(error.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await harness.close();
  await mock.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

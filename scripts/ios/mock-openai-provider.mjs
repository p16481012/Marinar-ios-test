#!/usr/bin/env node
// A loopback-only OpenAI-compatible fixture. It never calls a paid or external API.
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FIXTURE_MODEL = "ios-fixture";
export const FIXTURE_KEY = "ios-fixture-key-not-a-secret";
export const STREAM_PROMPT = "[IOS_STREAM_TEST] Hello. Please remember the blue lantern.";
export const STREAM_REPLY = "The blue lantern is remembered. 대화 저장을 확인했습니다.";
export const RESTORE_PROMPT = "[IOS_RESTORE_TEST] What did we remember before restarting?";
export const RESTORE_REPLY = "After restarting, I still remember the blue lantern.";
export const ABORT_PROMPT = "[IOS_ABORT_TEST] Please write a long response.";
export const ERROR_PROMPT = "[IOS_ERROR_TEST] Exercise the provider error path.";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const asJson = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

export async function startMockProvider({ port = 0 } = {}) {
  const calls = [];
  let nextId = 1;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (request.method === "GET" && pathname === "/__fixture__/stats") {
        return asJson(response, { calls });
      }
      if (request.method === "POST" && pathname === "/api/extra/abort") {
        return asJson(response, { success: true });
      }
      if (request.headers.authorization !== `Bearer ${FIXTURE_KEY}`) {
        return asJson(response, { error: { message: "Fixture authentication failed" } }, 401);
      }
      if (request.method === "GET" && pathname === "/v1/models") {
        return asJson(response, { object: "list", data: [{ id: FIXTURE_MODEL, object: "model", owned_by: "fixture" }] });
      }
      if (request.method !== "POST" || pathname !== "/v1/chat/completions") {
        return asJson(response, { error: { message: "Unsupported fixture route" } }, 404);
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) return asJson(response, { error: { message: "Fixture request too large" } }, 413);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.model !== FIXTURE_MODEL) {
        return asJson(response, { error: { message: "Unknown fixture model" } }, 400);
      }
      const messages = body.messages ?? [];
      const lastUser = messages.findLast((message) => message.role === "user");
      const prompt = JSON.stringify(lastUser?.content ?? messages.at(-1)?.content ?? "");
      const kind = prompt.includes("[IOS_ERROR_TEST]") ? "error"
        : prompt.includes("[IOS_ABORT_TEST]") ? "abort"
        : prompt.includes("[IOS_RESTORE_TEST]") ? "restore" : "stream";
      const call = { id: nextId++, kind, streaming: body.stream === true, messages, completed: false, disconnected: false };
      calls.push(call);
      response.on("close", () => { call.disconnected = !response.writableFinished; });
      if (kind === "error") {
        call.completed = true;
        return asJson(response, { error: { message: "Deliberate iOS fixture failure", type: "fixture_error" } }, 400);
      }
      const content = kind === "restore" ? RESTORE_REPLY : kind === "abort"
        ? "This interrupted response must stop. ".repeat(30) : STREAM_REPLY;
      if (!body.stream) {
        call.completed = true;
        return asJson(response, {
          id: `fixture-${call.id}`, object: "chat.completion", model: FIXTURE_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
        });
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.flushHeaders();
      const emit = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
        id: `fixture-${call.id}`, object: "chat.completion.chunk", model: FIXTURE_MODEL,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
      emit({ role: "assistant", content: "" });
      const pieces = content.match(/.{1,12}/gu) ?? [];
      for (const piece of pieces) {
        if (response.destroyed || response.writableEnded) return;
        emit({ content: piece });
        await sleep(kind === "abort" ? 250 : 60);
      }
      if (response.destroyed || response.writableEnded) return;
      emit({}, "stop");
      call.completed = true;
      response.end("data: [DONE]\n\n");
    } catch (error) {
      if (!response.headersSent) asJson(response, { error: { message: String(error.message) } }, 500);
      else response.destroy();
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, calls,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const mock = await startMockProvider({ port: Number(option("--port") ?? 0) });
  const stateFile = option("--state-file");
  if (stateFile) {
    await mkdir(dirname(resolve(stateFile)), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ baseUrl: mock.baseUrl }, null, 2) + "\n");
  }
  console.log(`Mock OpenAI provider ready: ${mock.baseUrl}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await mock.close(); process.exit(0); });
}

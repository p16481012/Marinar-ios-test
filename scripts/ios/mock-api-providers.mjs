import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export const PROTOCOL_KEY = "ios-protocol-fixture-not-a-real-key";
export const PROTOCOL_REPLY = "Hello, 안녕하세요. Saved locally.";
const parts = ["Hello, ", "안녕하세요. ", "Saved locally."];

// Local fixtures for the adapters in this source tree; never contacts a provider.
export async function startProtocolProviders() {
  const calls = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      const url = new URL(req.url, "http://127.0.0.1");
      const provider = url.pathname.includes(":streamGenerateContent") ? "google"
        : url.pathname.endsWith("/messages") ? "anthropic" : "openai";
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (provider === "google") {
        assert.equal(req.headers["x-goog-api-key"], PROTOCOL_KEY);
        assert.equal(url.searchParams.get("alt"), "sse");
        assert.ok(Array.isArray(body.contents));
      } else if (provider === "anthropic") {
        assert.equal(req.headers["x-api-key"], PROTOCOL_KEY);
        assert.ok(req.headers["anthropic-version"]);
        assert.equal(body.stream, true);
        assert.ok(Array.isArray(body.messages));
      } else {
        assert.ok(url.pathname.endsWith("/chat/completions"));
        assert.equal(req.headers.authorization, `Bearer ${PROTOCOL_KEY}`);
        assert.equal(body.stream, true);
        assert.ok(Array.isArray(body.messages));
      }
      calls.push({ provider, body });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = async (value) => {
        // Split even a Korean UTF-8 code point across network writes.
        const bytes = Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
        const korean = bytes.indexOf(Buffer.from("안"));
        const split = korean >= 0 ? korean + 1 : Math.floor(bytes.length / 2);
        res.write(bytes.subarray(0, split));
        await delay(15);
        res.write(bytes.subarray(split));
        await delay(15);
      };
      if (provider === "anthropic") {
        await send({ type: "message_start", message: { id: "fixture", role: "assistant", usage: { input_tokens: 12, output_tokens: 0 } } });
        await send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        for (const text of parts) await send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
        await send({ type: "content_block_stop", index: 0 });
        await send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } });
        await send({ type: "message_stop" });
      } else if (provider === "google") {
        for (const text of parts) await send({ candidates: [{ content: { role: "model", parts: [{ text }] } }] });
        await send({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9, totalTokenCount: 21 } });
      } else {
        for (const content of parts) await send({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: null }] });
        await send({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } });
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Protocol fixture rejected the request" } }));
    }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls, errors,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

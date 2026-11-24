const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const { createRequire } = require("module");
const { requestGpt } = require("../lib/pi-gpt");
const { jwt } = require("./helpers/pi-fixture");
const { estimateInputTokens } = require("../lib/token-count");

async function proxy(platform, callback) {
  const filename = path.resolve(platform, "proxy.js");
  const nativeRequire = createRequire(filename);
  let server;
  let generations = 0;
  const context = {
    require(name) {
      if (name === "http") return { createServer(handler) { server = http.createServer(handler); return server; } };
      if (name === "../lib/pi-model") return { requestPiModel(body, options) {
        generations++;
        return requestGpt(body, { ...options,
          loadAuth: async () => ({ kind: "codex", token: jwt("fixture-account"), accountId: "fixture-account" }),
          fetchImpl: async () => new Response('event: error\ndata: ' + JSON.stringify({ type: "error", error: {
            code: "context_length_exceeded", type: "invalid_request_error", message: "Your input exceeds the context window of this model."
          } }) + '\n\n', { headers: { "Content-Type": "text/event-stream" } })
        });
      } };
      if (name === "../lib/model-discovery") return { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5", owned_by: "openai", api: "openai-responses" }, { id: "gpt-5.4", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6.1-sol", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6-sol", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot", api: "anthropic-messages" }, { id: "claude-opus-5.5", owned_by: "github-copilot", api: "anthropic-messages" }] }) };
      if (name === "../lib/macos-service") return { createMacosService: () => ({}) };
      if (name === "../lib/project-memory-install") return { createProjectMemoryInstaller: () => ({}) };
      return nativeRequire(name);
    },
    __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0], context, { filename });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`, () => generations); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} count_tokens returns a JSON estimate without generation, replay or web search`, () => proxy(platform, async (url, calls) => {
    const body = { model: "anthropic/gpt-6.1-sol", stream: true, max_tokens: 64000,
      system: "system", tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "UTF-8: 中文 🦀" }] }] };
    const before = JSON.stringify(body);
    const response = await fetch(url + "/v1/messages/count_tokens?beta=true", { method: "POST", body: before });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-token-count-method"), "conservative-utf8-estimate");
    const result = await response.json();
    assert.deepEqual(Object.keys(result), ["input_tokens"]);
    assert.ok(Number.isSafeInteger(result.input_tokens) && result.input_tokens > 0);
    assert.equal(calls(), 0);
    assert.equal(JSON.stringify(body), before);
  }));

  test(`${platform} context-limit stream is invalid_request_error, never api_error or a fake success`, () => proxy(platform, async (url, calls) => {
    for (const stream of [true, false]) {
      const response = await fetch(url + "/v1/messages", { method: "POST",
        body: JSON.stringify({ model: "gpt-6.1-sol", stream, messages: [{ role: "user", content: "fixture" }] }) });
      if (stream) {
        const data = await response.text();
        const frames = data.split(/\r?\n\r?\n/).filter((part) => part.includes('event: error'));
        assert.equal(frames.length, 1);
        const failure = JSON.parse(frames[0].split('data: ')[1]);
        assert.equal(failure.error.type, "invalid_request_error");
        assert.match(failure.error.message, /^prompt is too long:/i);
        assert.match(failure.error.message, /context_length_exceeded/);
        assert.ok(!data.includes('event: message_stop'));
      } else {
        assert.equal(response.status, 400);
        const failure = await response.json();
        assert.equal(failure.error.type, "invalid_request_error");
        assert.match(failure.error.message, /^prompt is too long:/i);
      }
    }
    assert.equal(calls(), 2);
  }));
}

test("local token estimate includes instructions, tools, Unicode and all message blocks without mutating input", () => {
  const body = { system: "Policy", tools: [{ name: "tool", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
    messages: [{ role: "user", content: "中文" }, { role: "assistant", content: [{ type: "tool_use", id: "call", name: "tool", input: { query: "café" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "result" }] }] };
  const original = JSON.stringify(body);
  assert.ok(estimateInputTokens(body) >= Buffer.byteLength(original));
  assert.ok(estimateInputTokens({ ...body, system: "Policy".repeat(10) }) > estimateInputTokens(body));
  assert.equal(estimateInputTokens({ ...body, stream: true, max_tokens: 128000 }), estimateInputTokens(body));
  assert.equal(JSON.stringify(body), original);
});

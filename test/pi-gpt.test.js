"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { eventsFor, sse, payloadOf, jwt, text } = require("./helpers/pi-fixture");
const { requestGpt } = require("../lib/pi-gpt");
const { toPiContext } = require("../lib/anthropic-pi");
const auth = { kind: "api", token: "sk-offline" };
const request = (body, options = {}) => requestGpt({ model: "gpt-6.1-sol", messages: [{ role: "user", content: "hi" }], ...body }, {
  loadAuth: async () => auth, remember: false, fetchImpl: async () => sse(eventsFor()), ...options
});

test("actual Pi runtime handles API requests, UTF-8 fragments, unified streaming and uncached usage", async () => {
  const events = [];
  const stats = [];
  const result = await request({ max_tokens: 1, stream: true }, { onEvent: async (event) => events.push(event.type), onCacheUsage: (usage) => stats.push(usage),
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer sk-offline");
      assert.equal(payloadOf(options).max_output_tokens, 16);
      assert.equal(payloadOf(options).store, false);
      return sse(eventsFor(), true);
    } });
  assert.equal(result.content[0].text, "你好🙂");
  assert.deepEqual(result.usage, { input_tokens: 464, output_tokens: 12, cache_read_input_tokens: 1536 });
  assert.ok(events.includes("text_delta")); assert.equal(events.at(-1), "done");
  assert.equal(stats[0].total_input_tokens, 2000);
  assert.equal(stats[0].cache_hit_percent, 76.8);
});

test("Codex uses existing OAuth, SSE affinity, a leading system item and in-place system reminders", async () => {
  for (const kind of ["codex", "chatgpt"]) {
    await request({ system: "leading policy", messages: [{ role: "user", content: "hi" }, { role: "system", content: "later reminder" }], prompt_cache_key: "session-key" }, {
      loadAuth: async () => ({ kind, token: jwt("account-offline"), accountId: "account-offline" }),
      fetchImpl: async (url, options) => {
        const body = payloadOf(options);
        assert.equal(body.max_output_tokens, undefined);
        assert.equal(body.prompt_cache_key, "session-key");
        if (kind === "codex") {
          assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
          const headers = new Headers(options.headers);
          assert.equal(headers.get("chatgpt-account-id"), "account-offline");
          assert.equal(headers.get("session-id"), "session-key");
          assert.equal(body.instructions, undefined);
          assert.deepEqual(body.input.map((item) => item.role), ["developer", "user", "developer"]);
          assert.equal(body.input[0].content, "leading policy");
        }
        assert.ok(JSON.stringify(body.input).includes("later reminder"));
        return sse(eventsFor());
      }
    });
  }
});

test("Codex response.done terminal aliases complete normally and reach search observers", async () => {
  const events = eventsFor();
  events.at(-1).type = "response.done";
  const seen = [];
  const result = await request({}, { loadAuth: async () => ({ kind: "codex", token: jwt("done-alias"), accountId: "done-alias" }),
    onProviderEvent: (event) => seen.push(event.type), fetchImpl: async () => sse(events) });
  assert.equal(result.content[0].text, "你好🙂");
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(seen.at(-1), "response.completed");
});

test("Codex reasoning keeps the gateway mapping: no effort without a request, none when disabled", async () => {
  const cases = [[{}, { summary: "auto" }], [{ thinking: { type: "disabled" } }, undefined],
    [{ thinking: { type: "adaptive" } }, { summary: "auto", effort: "medium" }], [{ output_config: { effort: "high" } }, { summary: "auto", effort: "high" }]];
  for (const [body, expected] of cases) {
    await request({ model: "gpt-6-luna", ...body }, { loadAuth: async () => ({ kind: "codex", token: jwt("reasoning"), accountId: "reasoning" }),
      fetchImpl: async (_, options) => { assert.deepEqual(payloadOf(options).reasoning, expected, JSON.stringify(body)); return sse(eventsFor()); } });
  }
});

test("dynamic GPT IDs and every Sol effort work without a static model registry", async () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    await request({ output_config: { effort } }, { fetchImpl: async (_, options) => {
      assert.deepEqual(payloadOf(options).reasoning, { summary: "auto", effort }); return sse(eventsFor());
    } });
  }
  // Disabled thinking omits reasoning: Codex rejects effort "none" for some models.
  await request({ model: "gpt-future-unlisted", thinking: { type: "disabled" } }, { fetchImpl: async (_, options) => {
    assert.equal(payloadOf(options).model, "gpt-future-unlisted"); assert.equal(payloadOf(options).reasoning, undefined); return sse(eventsFor());
  } });
});

test("Anthropic tools, results, URLs/base64 and accompanying user text survive Pi conversion", async () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
  await request({ tools: [{ name: "read", input_schema: { type: "object" } }], messages: [
    { role: "user", content: [image, { type: "image", source: { type: "url", url: "https://example.test/image.png" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_one", name: "read", input: { n: 1 } }] },
    { role: "user", content: [{ type: "text", text: "follow-up" }, { type: "tool_result", tool_use_id: "call_one", content: [image, { type: "text", text: "result" }] }] }
  ] }, { fetchImpl: async (_, options) => {
    const body = payloadOf(options);
    assert.equal(body.input[0].content[0].image_url, "data:image/png;base64,AA==");
    assert.equal(body.input[0].content[1].image_url, "https://example.test/image.png");
    assert.equal(body.input[1].type, "function_call");
    assert.equal(body.input[2].type, "function_call_output");
    assert.equal(body.input[2].output, "result");
    assert.equal(body.input[3].role, "user");
    assert.equal(body.input[4].content[0].text, "follow-up");
    assert.equal(body.tools[0].name, "read");
    assert.equal(body.tools[0].strict, false, "client schemas must not be strict-normalized upstream");
    return sse(eventsFor());
  } });
});

test("Claude-only transcript blocks are dropped for GPT instead of rejecting the request", async () => {
  const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } };
  await request({ messages: [
    { role: "user", content: [pdf, { type: "text", text: "summarize" }] },
    { role: "assistant", content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] }, { type: "text", text: "found it" }] },
    { role: "assistant", content: [{ type: "compaction", content: "earlier summary" }] },
    { role: "user", content: [pdf] },
    { role: "user", content: "next" }
  ] }, { fetchImpl: async (_, options) => {
    const body = payloadOf(options);
    const serialized = JSON.stringify(body.input);
    for (const hidden of ["JVBERi0", "srvtoolu_1", "earlier summary"]) assert.ok(!serialized.includes(hidden), hidden);
    assert.deepEqual(body.input.map((item) => item.role), ["user", "assistant", "user"]);
    assert.equal(body.input[0].content[0].text, "summarize");
    assert.equal(body.input[1].content[0].text, "found it");
    assert.equal(body.input[2].content[0].text, "next");
    return sse(eventsFor());
  } });
});

test("foreign thinking signatures are not assigned target model provenance", () => {
  const { context } = toPiContext({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "untrusted" }, { type: "text", text: "answer" }] }] });
  assert.equal(context.messages[0].provider, "anthropic-client");
  assert.equal(context.messages[0].content[0].thinkingSignature, undefined);
});

test("public reasoning paragraphs and literal think tags survive without exposing opaque reasoning", async () => {
  const output = [{ type: "reasoning", id: "rs_1", encrypted_content: "private-opaque", summary: [{ type: "summary_text", text: "First" }, { type: "summary_text", text: "Second" }] }, text("<think>literal</think>")];
  const result = await request({}, { fetchImpl: async () => sse(eventsFor(output)) });
  assert.equal(result.content[0].thinking, "First\n\nSecond");
  assert.equal(result.content[1].text, "<think>literal</think>");
  assert.ok(!JSON.stringify(result).includes("private-opaque"));
});

test("complete text items without deltas still reach streaming clients", async () => {
  const delivered = [];
  await request({ stream: true }, { onEvent: (event) => { if (event.type === "text_delta") delivered.push(event.delta); },
    fetchImpl: async () => sse(eventsFor().filter((event) => event.type !== "response.output_text.delta")) });
  assert.equal(delivered.join(""), "你好🙂");
});

test("terminal output completes missing items without repeating streamed ones", async () => {
  const first = text("first");
  const second = { ...text("second"), id: "msg_second" };
  const tool = { type: "function_call", id: "fc_terminal", call_id: "call_terminal", name: "read", arguments: '{"line":2}' };
  const output = [first, second, tool];
  const completed = eventsFor([], { output }).at(-1);
  for (const prefix of [[], eventsFor([first]).slice(0, -1), eventsFor([first]).slice(0, 2)]) {
    const textDeltas = [];
    const toolIds = [];
    const result = await request({ stream: true }, {
      fetchImpl: async () => sse([...prefix, completed]),
      onEvent(event) {
        if (event.type === "text_delta") textDeltas.push(event.delta);
        if (event.type === "toolcall_end") toolIds.push(event.toolCall.id);
      }
    });
    assert.deepEqual(textDeltas, ["first", "second"]);
    assert.deepEqual(toolIds, ["call_terminal|fc_terminal"]);
    assert.deepEqual(result.content, [
      { type: "text", text: "first" }, { type: "text", text: "second" },
      { type: "tool_use", id: "call_terminal", name: "read", input: { line: 2 } }
    ]);
    assert.equal(result.stop_reason, "tool_use");
  }
});

test("native search hooks expose raw tools/sources even with empty terminal output", async () => {
  const search = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", sources: [{ type: "url", url: "https://example.test" }] } };
  const seen = [];
  await request({}, { loadAuth: async () => ({ kind: "copilot", token: "mock", baseUrl: "https://copilot.example", headers: { "Copilot-Integration-Id": "vscode-chat" } }),
    adjustPayload: (body) => { body.tools = [{ type: "web_search" }]; body.tool_choice = "required"; }, onProviderEvent: (event) => seen.push(event),
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://copilot.example/responses");
      assert.deepEqual(payloadOf(options).tools, [{ type: "web_search" }]);
      return sse(eventsFor([search, text()]));
    } });
  assert.ok(seen.some((event) => event.item?.action?.sources?.length));
});

for (const envelope of ["http", "event", "failed"]) {
  test(`context-limit ${envelope} errors retain compaction semantics`, async () => {
    const detail = { code: "context_length_exceeded", message: "too much input", type: "invalid_request_error" };
    await assert.rejects(request({}, { fetchImpl: async () => envelope === "http" ? new Response(JSON.stringify({ error: detail }), { status: 400 })
      : sse([envelope === "event" ? { type: "error", error: detail } : { type: "response.failed", response: { status: "failed", error: detail } }]) }),
    (error) => error.status === 400 && error.code === detail.code && /^prompt is too long:/.test(error.message));
  });
}

test("custom API endpoints, refusals and max-output truncation retain their public semantics", async () => {
  const previous = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://custom.example/v1";
  try {
    const refusal = { type: "message", id: "msg_refused", role: "assistant", content: [{ type: "refusal", refusal: "Cannot comply" }] };
    const result = await request({}, { fetchImpl: async (url) => {
      assert.equal(url, "https://custom.example/v1/responses");
      const events = eventsFor([refusal]);
      events.at(-1).type = "response.incomplete";
      events.at(-1).response.status = "incomplete";
      events.at(-1).response.incomplete_details = { reason: "max_output_tokens" };
      return sse(events);
    } });
    assert.equal(result.content[0].text, "Cannot comply");
    assert.equal(result.stop_reason, "max_tokens");
  } finally { if (previous === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous; }
});

test("a buffering gateway may delay headers beyond the post-header idle limit", async (t) => {
  // Load the lazy runtime before replacing timers.
  await request({});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  let notify;
  const fetching = new Promise((resolve) => { notify = resolve; });
  const pending = request({}, { fetchImpl: () => new Promise((resolve) => { release = () => resolve(sse(eventsFor())); notify(); }) });
  await fetching;
  t.mock.timers.tick(120000);
  release();
  assert.equal((await pending).stop_reason, "end_turn");
});

test("a stalled response body aborts after the post-header idle limit", async (t) => {
  await request({});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let notify;
  const received = new Promise((resolve) => { notify = resolve; });
  const pending = request({}, { fetchImpl: async () => {
    setImmediate(notify);
    return new Response(new ReadableStream({ pull() {} }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const rejected = assert.rejects(pending, (error) => error.status === 504 && /idle/.test(error.message));
  await received;
  t.mock.timers.tick(90001);
  await rejected;
});

test("missing terminal events fail instead of inventing success", async () => {
  await assert.rejects(request({}, { fetchImpl: async () => sse(eventsFor().slice(0, -1)) }), /stop reason|terminal/);
});

test("client abort is forwarded and no later stream events are delivered", async () => {
  const control = {};
  await assert.rejects(request({}, { control, onEvent: async (event) => { if (event.type === "text_delta") control.abort("client closed", 499); } }),
    (error) => error.status === 499 && error.message === "client closed");
});

test("upstream waits for slow downstream delivery instead of buffering the whole answer", async () => {
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  let seen = 0;
  const pending = request({}, { onProviderEvent: () => seen++, onEvent: async (event) => {
    if (event.type === "text_delta") { started(); await new Promise((resolve) => { release = resolve; }); }
  } });
  await waiting;
  const snapshot = seen;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen, snapshot);
  release(); await pending;
});

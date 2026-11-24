const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { forwardClaudeCount, getCopilotHeaders, discoverCopilotModels, listCopilotResponsesModels, loadCopilotResponsesAuth } = require("../lib/github-copilot");
const { requestClaude } = require("../lib/pi-claude");
const { claudeEvents, claudeSse } = require("./helpers/claude-fixture");

const auth = { token: "copilot-test-token", baseUrl: "https://api.business.githubcopilot.com" };
const loadAuth = async () => auth;
const request = (body, options = {}) => requestClaude({ model: "claude-sonnet-5.5", messages: [], ...body }, { loadAuth,
  fetchImpl: async () => claudeSse(), ...options });

test("Pi requests preserve native Claude history, request controls and Copilot headers", async () => {
  const signed = { type: "thinking", thinking: "", signature: "signed-history" };
  const redacted = { type: "redacted_thinking", data: "opaque-history" };
  const image = { type: "image", source: { type: "url", url: "https://fixture.test/image.png" } };
  const body = { stream: false, max_tokens: 100, stop_sequences: ["END"], output_config: { effort: "high" },
    system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral", ttl: "1h" } }], thinking: { type: "adaptive" },
    tools: [{ name: "read", input_schema: { type: "object" }, strict: true }], tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [{ role: "assistant", content: [signed, redacted, { type: "thinking", thinking: "GPT summary", signature: "" },
      { type: "tool_use", id: "toolu_1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [image] }] }] };
  await request(body, { url: "/v1/messages?beta=true", clientHeaders: { "anthropic-beta": "test-beta", "anthropic-version": "2023-06-01",
    authorization: "Bearer local-placeholder", "x-api-key": "local-placeholder", cookie: "private" },
    fetchImpl: async (url, options) => {
      assert.equal(url, auth.baseUrl + "/v1/messages?beta=true");
      assert.equal(options.redirect, "error");
      const headers = new Headers(options.headers);
      assert.equal(headers.get("authorization"), "Bearer copilot-test-token");
      assert.equal(headers.get("anthropic-beta"), "test-beta");
      assert.equal(headers.get("anthropic-version"), "2023-06-01");
      assert.equal(headers.get("x-initiator"), "agent");
      assert.equal(headers.get("copilot-vision-request"), "true");
      assert.equal(headers.get("copilot-integration-id"), "vscode-chat");
      assert.equal(headers.get("x-api-key"), null);
      assert.equal(headers.get("cookie"), null);
      const payload = JSON.parse(options.body);
      assert.equal(payload.stream, true);
      assert.equal(payload.max_tokens, body.max_tokens);
      assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
      assert.deepEqual(payload.stop_sequences, body.stop_sequences);
      assert.deepEqual(payload.output_config, body.output_config);
      assert.deepEqual(payload.tool_choice, body.tool_choice);
      assert.equal(payload.tools[0].strict, true);
      assert.equal(payload.tools[0].cache_control.ttl, "1h");
      assert.deepEqual(payload.system, body.system);
      assert.deepEqual(payload.messages[0].content, [signed, redacted, body.messages[0].content.at(-1)]);
      assert.ok(payload.messages.some((message) => message.content.some((block) => block.type === "image" && block.source.url === image.source.url)));
      return claudeSse();
    } });
  assert.equal(body.messages[0].content[2].signature, "");
});

test("actual Pi emits Claude text, signed/redacted thinking, tools and native extension metadata", async () => {
  const citation = { type: "char_location", cited_text: "事实", document_index: 0, document_title: "source", start_char_index: 0, end_char_index: 2 };
  const blocks = [{ type: "thinking", thinking: "summary", signature: "native-signed" },
    { type: "thinking", thinking: "", signature: "signature-only" }, { type: "redacted_thinking", data: "native-opaque" },
    { type: "text", text: "事实🙂", citations: [citation] }, { type: "tool_use", id: "toolu_read", name: "read", input: { n: 1 } },
    { type: "server_tool_use", id: "srvtoolu_1", name: "native_tool", input: { query: "hello" } }];
  const events = claudeEvents({ blocks, delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { input_tokens: 36, cache_read_input_tokens: 64, cache_creation_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 20 }, output_tokens: 1 } });
  const textStop = events.findIndex((event) => event.type === "content_block_stop" && event.index === 3);
  delete events.find((event) => event.type === "content_block_start" && event.index === 3).content_block.citations;
  events.splice(textStop, 0, { type: "content_block_delta", index: 3, delta: { type: "citations_delta", citation } });
  const seen = [], stats = [], starts = [];
  const result = await request({}, { onEvent: async (event) => seen.push(event.type), onCacheUsage: (value) => stats.push(value),
    onResponse: async (message, headers) => starts.push({ message, headers }),
    fetchImpl: async () => claudeSse(events, { "retry-after": "2", "x-private-header": "hidden" }) });
  assert.deepEqual(result.content, blocks);
  assert.equal(result.id, "msg_mock");
  assert.equal(result.stop_reason, "tool_use");
  assert.deepEqual(result.usage, { input_tokens: 36, cache_read_input_tokens: 64, output_tokens: 3,
    cache_creation_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 20 } });
  assert.equal(starts[0].headers["retry-after"], "2");
  assert.equal(starts[0].headers["x-private-header"], undefined);
  assert.ok(seen.includes("thinking_end") && seen.includes("toolcall_end") && seen.includes("native_block_delta"));
  assert.equal(stats[0].total_input_tokens, 120);
});

test("Claude responses do not occupy the shared GPT replay cache", async () => {
  const { createReplayReader } = require("../lib/responses-replay");
  const { getPromptCacheKey } = require("../lib/pi-options");
  const first = { model: "claude-sonnet-5.5", metadata: { session_id: "fixture-no-claude-replay" }, messages: [{ role: "user", content: "question" }] };
  const response = await request(first, { fetchImpl: async () => claudeSse(claudeEvents({ blocks: [{ type: "text", text: "answer" }] })) });
  const next = { ...first, messages: [...first.messages, { role: "assistant", content: response.content }, { role: "user", content: "next" }] };
  const find = createReplayReader({ ...next, prompt_cache_key: getPromptCacheKey(next) }, { ...auth, kind: "copilot-claude" });
  assert.equal(find(1), undefined);
});

test("Claude signed history round-trips even when the replay cache misses", async () => {
  const first = { metadata: { session_id: "fixture-signatures" }, messages: [{ role: "user", content: "question" }] };
  const blocks = [{ type: "thinking", thinking: "summary", signature: "verified-signature" }, { type: "text", text: "answer" }];
  const response = await request(first, { fetchImpl: async () => claudeSse(claudeEvents({ blocks })) });
  const messages = [...first.messages, { role: "assistant", content: response.content }, { role: "user", content: "next" }];
  for (const metadata of [first.metadata, { session_id: "other-session" }]) {
    await request({ metadata, messages }, { fetchImpl: async (_url, options) => {
      const history = JSON.parse(options.body).messages[1].content;
      assert.deepEqual(history, blocks);
      return claudeSse();
    } });
  }
  await assert.rejects(request({ messages: [{ role: "user", content: [{ type: "unknown_fixture_type" }] }] }, {
    fetchImpl: () => assert.fail("unsupported transcript must not reach upstream")
  }), { status: 400, message: /user block unknown_fixture_type/ });
});

test("native tools, pause-turn history and explicit cache boundaries round-trip through Pi", async () => {
  const cache = { type: "ephemeral", ttl: "1h" };
  const tool = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 1, allowed_domains: ["example.org"] };
  const blocks = [{ type: "server_tool_use", id: "srvtoolu_fetch", name: "web_fetch", input: { url: "https://example.org/" } },
    { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_fetch", content: { type: "web_fetch_tool_result_error", error_code: "unavailable" } }];
  const messages = [{ role: "user", content: [{ type: "text", text: "stable", cache_control: cache }, { type: "text", text: "variable" }] }];
  const system = [{ type: "text", text: "prefix", cache_control: cache }, { type: "text", text: "suffix" }];
  const body = { tools: [tool], messages, system };
  const response = await request(body, { fetchImpl: async () => claudeSse(claudeEvents({ blocks, delta: { stop_reason: "pause_turn" } })) });
  assert.equal(response.stop_reason, "pause_turn");
  await request({ ...body, messages: [...messages, { role: "assistant", content: response.content }] }, {
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.system[0], system[0]);
      assert.equal(payload.system[1].text, system[1].text);
      assert.deepEqual(payload.messages[0], messages[0]);
      assert.deepEqual(payload.messages[1].content, blocks);
      assert.deepEqual(payload.tools[0], { ...tool, cache_control: cache });
      assert.ok(!options.body.includes("pi-gateway-native-"));
      return claudeSse();
    }
  });
});

test("Opus restores cache-marked tool results after Pi flattens their content to strings", async (t) => {
  const cache_control = { type: "ephemeral", ttl: "1h" };
  const call = { type: "tool_use", id: "toolu_read", name: "Read", input: { path: "fixture.txt" } };
  const base = { type: "tool_result", tool_use_id: call.id };
  for (const [name, result] of [
    ["breakpoint on the result", { ...base, content: "first\nsecond", cache_control }],
    ["breakpoint inside the result", { ...base, is_error: true, content: [
      { type: "text", text: "first\nsecond" },
      { type: "text", text: "third", cache_control },
      { type: "text", text: "fourth" }
    ] }]
  ]) await t.test(name, async () => {
    const response = await request({ model: "claude-opus-5.5", messages: [
      { role: "user", content: "Read fixture.txt" },
      { role: "assistant", content: [call] },
      { role: "user", content: [result, { type: "text", text: "Continue." }] }
    ] }, { fetchImpl: async (_url, options) => {
      const { messages } = JSON.parse(options.body);
      assert.deepEqual(messages[1].content, [call]);
      assert.deepEqual(messages[2], { role: "user", content: [result] });
      assert.equal(messages[3].content[0].text, "Continue.");
      assert.ok(!options.body.includes("pi-gateway-native-"));
      return claudeSse(claudeEvents({ model: "claude-opus-5.5" }));
    } });
    assert.equal(response.stop_reason, "end_turn");
  });
});

test("native citations and tool input present at block start reach both output forms", async () => {
  const citation = { type: "char_location", cited_text: "fact", document_index: 0, start_char_index: 0, end_char_index: 4 };
  const blocks = [{ type: "text", text: "answer", citations: [citation] },
    { type: "tool_use", id: "toolu_start", name: "read", input: { first: true } }];
  const events = claudeEvents({ blocks, delta: { stop_reason: "tool_use", stop_sequence: null } });
  events.find((event) => event.type === "content_block_start" && event.index === 1).content_block.input = blocks[1].input;
  const seen = [];
  const result = await request({}, { onEvent: (event) => {
    if (event.type === "native_block_delta") seen.push(event.delta);
    if (event.type === "toolcall_end") seen.push(event.toolCall.arguments);
  }, fetchImpl: async () => claudeSse(events.filter((event) => event.delta?.type !== "input_json_delta")) });
  assert.deepEqual(result.content, blocks);
  assert.deepEqual(seen, [{ type: "citations_delta", citation }, blocks[1].input]);
});

test("native refusal, stop sequence and pause remain native terminal reasons", async () => {
  for (const stop_reason of ["refusal", "stop_sequence", "pause_turn", "max_tokens", "model_context_window_exceeded"]) {
    const delta = { stop_reason, stop_sequence: stop_reason === "stop_sequence" ? "END" : null,
      ...(stop_reason === "refusal" ? { stop_details: { type: "refusal", category: "general_harms" } } : {}) };
    const result = await request({}, { fetchImpl: async () => claudeSse(claudeEvents({ delta })) });
    for (const key of Object.keys(delta)) assert.deepEqual(result[key], delta[key]);
  }
});

test("read-only Claude token count forwards native JSON and errors without generation", async () => {
  const response = new PassThrough();
  response.writeHead = (status) => { response.statusCode = status; };
  let raw = "";
  response.on("data", (chunk) => { raw += chunk; });
  const expected = '{"type":"error","error":{"type":"invalid_request_error","message":"test"}}';
  await forwardClaudeCount({ model: "claude-opus-5.5" }, { url: "/v1/messages/count_tokens?beta=true", headers: {} }, response, {
    loadAuth, fetchImpl: async (url, options) => {
      assert.equal(url, auth.baseUrl + "/v1/messages/count_tokens?beta=true");
      assert.equal(JSON.parse(options.body).stream, undefined);
      return new Response(expected, { status: 400, headers: { "content-type": "application/json" } });
    } });
  assert.equal(response.statusCode, 400);
  assert.equal(raw, expected);
});

test("Copilot infers initiator and vision from Anthropic tool results", () => {
  assert.equal(getCopilotHeaders(auth, {}, { messages: [{ role: "user", content: "hello" }] })["X-Initiator"], "user");
  const image = { type: "image", source: {} };
  const headers = getCopilotHeaders(auth, {}, { messages: [{ role: "user", content: [{ type: "tool_result", content: [image] }] }] });
  assert.equal(headers["X-Initiator"], "agent");
  assert.equal(headers["Copilot-Vision-Request"], "true");
});

test("Copilot catalog respects picker, policy, tools and Anthropic endpoints", async () => {
  const data = [
    { id: "claude-ok", model_picker_enabled: true, supported_endpoints: ["/v1/messages"] },
    { id: "claude-disabled", model_picker_enabled: true, policy: { state: "disabled" } },
    { id: "claude-hidden", supported_endpoints: ["/v1/messages"], model_picker_enabled: false, policy: { state: "enabled" } },
    { id: "claude-no-tools", model_picker_enabled: true, capabilities: { supports: { tool_calls: false } } },
    { id: "claude-completions", model_picker_enabled: true, supported_endpoints: ["/chat/completions"] },
    { id: "gpt-6", model_picker_enabled: true }
  ];
  const models = await discoverCopilotModels({ loadAuth, fetchImpl: async () => new Response(JSON.stringify({ data })) });
  assert.deepEqual(models.map((m) => m.id), ["claude-ok"]);
  assert.equal(models[0].owned_by, "github-copilot");
  const fallbackFetch = async () => new Response(JSON.stringify({ data: [data[2]] }));
  assert.deepEqual(await discoverCopilotModels({ loadAuth, fetchImpl: fallbackFetch }), []);
  assert.equal((await discoverCopilotModels({ loadAuth: async () => ({ ...auth, baseUrl: "https://api.individual.githubcopilot.com" }), fetchImpl: fallbackFetch }))[0].id, "claude-hidden");
});

test("Claude thinking modes respect the catalog, explicit display and agent initiator", async () => {
  const model = "claude-adaptive-test";
  await discoverCopilotModels({ loadAuth, fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: model,
    model_picker_enabled: true, supported_endpoints: ["/v1/messages"], capabilities: { supports: { adaptive_thinking: true } } }] })) });
  for (const [selected, thinking, expected] of [
    [model, { type: "enabled", budget_tokens: 1024 }, { type: "adaptive", display: "summarized" }],
    [model, { type: "adaptive", display: "omitted" }, { type: "adaptive", display: "omitted" }],
    ["claude-legacy-test", { type: "enabled", budget_tokens: 1024 }, { type: "enabled", budget_tokens: 1024 }]
  ]) await request({ model: selected, thinking, messages: [{ role: "user", content: "hi" }] }, { agent: true,
    fetchImpl: async (_, options) => {
      assert.deepEqual(JSON.parse(options.body).thinking, expected);
      assert.equal(new Headers(options.headers).get("x-initiator"), "agent");
      return claudeSse();
    } });
});

test("Copilot retries only rejected disabled thinking and remembers the accepted model switch", async () => {
  for (const [model, text, expected] of [
    ["claude-between-test", 'Unsupported thinking "disabled". Use between_tools.', { type: "between_tools" }],
    ["claude-no-off-test", 'Unsupported thinking "disabled".', undefined]
  ]) {
    const body = { model, thinking: { type: "disabled" } };
    const sent = [];
    const fetchImpl = async (_, options) => {
      sent.push(JSON.parse(options.body).thinking);
      return sent.at(-1)?.type === "disabled" ? new Response(JSON.stringify({ type: "error", error: { message: text } }), { status: 400 }) : claudeSse();
    };
    await request(body, { fetchImpl });
    await request(body, { fetchImpl });
    assert.deepEqual(sent, [{ type: "disabled" }, expected, expected]);
    assert.deepEqual(body.thinking, { type: "disabled" });
  }
  const body = { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } };
  let calls = 0;
  await assert.rejects(request({ thinking: { type: "disabled" } }, { fetchImpl: async () => {
    calls++; return new Response(JSON.stringify(body), { status: 400, headers: { "retry-after": "2", "set-cookie": "private" } });
  } }), (error) => { assert.deepEqual(error.body, body); assert.equal(error.status, 400); assert.equal(error.responseHeaders["retry-after"], "2");
    assert.equal(error.responseHeaders["set-cookie"], undefined); return true; });
  assert.equal(calls, 1);
});

test("Claude rejects incomplete/error SSE and forwards cancellation to the upstream reader", async () => {
  await assert.rejects(request({}, { fetchImpl: async () => claudeSse(claudeEvents().slice(0, -1)) }), /message_stop/);
  await assert.rejects(request({}, { fetchImpl: async () => claudeSse([{ type: "error", error: { type: "overloaded_error", message: "overloaded" } }]) }),
    (error) => error.status === 502 && error.body?.error.type === "overloaded_error");
  const control = {};
  let signal, canceled = false;
  const pending = request({}, { control, onResponse: () => control.abort("client closed", 499), fetchImpl: async (_, options) => {
    signal = options.signal;
    const start = claudeEvents()[0];
    return new Response(new ReadableStream({ start(target) { target.enqueue(Buffer.from(`event: ${start.type}\ndata: ${JSON.stringify(start)}\n\n`)); },
      cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  } });
  await assert.rejects(pending, { status: 499, message: "client closed" });
  assert.equal(signal.aborted, true);
  assert.equal(canceled, true);
});

test("Copilot remembers /responses models for web search and builds Responses auth without Anthropic headers", async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches++;
    return new Response(JSON.stringify({ data: [
      { id: "claude-ok", model_picker_enabled: true, supported_endpoints: ["/v1/messages"] },
      { id: "gpt-6-luna", model_picker_enabled: true, supported_endpoints: ["/responses", "ws:/responses"] },
      { id: "gpt-6-off", model_picker_enabled: false, supported_endpoints: ["/responses"] }
    ] }));
  };
  await discoverCopilotModels({ loadAuth, fetchImpl });
  assert.deepEqual(await listCopilotResponsesModels({ loadAuth, fetchImpl }), ["gpt-6-luna"]);
  assert.equal(fetches, 1);
  const responsesAuth = await loadCopilotResponsesAuth({ loadAuth });
  assert.deepEqual([responsesAuth.kind, responsesAuth.token, responsesAuth.baseUrl], ["copilot", auth.token, auth.baseUrl]);
  assert.equal(responsesAuth.headers.Accept, "text/event-stream");
  assert.equal(responsesAuth.headers["X-Initiator"], "agent");
  assert.ok(responsesAuth.headers["Copilot-Integration-Id"]);
  for (const name of ["Authorization", "Content-Type", "anthropic-version", "anthropic-dangerous-direct-browser-access"]) assert.equal(responsesAuth.headers[name], undefined);
});

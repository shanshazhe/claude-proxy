const test = require("node:test");
const { getModelCapabilities, countTokens } = require("../lib/pi-capabilities");
const { setGatewayModels } = require("../lib/pi-registry");
setGatewayModels([
  ...["gpt-5.4", "gpt-6.1-sol"].map((id) => ({ id, api: "openai-responses", owned_by: "openai" })),
  { id: "claude-opus-5.5", api: "anthropic-messages", owned_by: "github-copilot" }
]);
const assert = require("node:assert/strict");
const { parseWebSearchRequest, runWebSearch, toAnthropicContent, toAnthropicMessage, toAnthropicEvents } = require("../lib/web-search");

const tool = (fields = {}) => ({ type: "web_search_20250305", name: "web_search", max_uses: 8, ...fields });
const request = (fields = {}, extra = {}) => ({ model: "gpt-5.4", messages: [{ role: "user", content: "Perform a web search for the query: q" }],
  tools: [tool(fields)], tool_choice: { type: "tool", name: "web_search" }, ...extra });
const call = (id, sources, extra = {}) => ({ type: "web_search_call", id, status: "completed", action: { type: "search", queries: ["node 24 lts"], sources }, ...extra });
const message = (text, annotations = []) => ({ type: "message", content: [{ type: "output_text", text, annotations }] });

test("only the CLI's single web_search_20250305 request is recognized, and unenforceable options fail first", () => {
  assert.equal(parseWebSearchRequest({ tools: [{ name: "Read", input_schema: {} }] }), null);
  assert.equal(parseWebSearchRequest({ messages: [] }), null);
  assert.deepEqual(parseWebSearchRequest(request()), { tool: { type: "web_search" }, maxUses: 8 });
  // The CLI sends auto through a gateway even though it asks for a forced call internally.
  for (const tool_choice of [undefined, { type: "auto" }, { type: "any" }]) assert.equal(parseWebSearchRequest(request({}, { tool_choice })).error, undefined);
  assert.deepEqual(parseWebSearchRequest(request({ allowed_domains: ["nodejs.org"], blocked_domains: [], search_profile: "fast" })),
    { tool: { type: "web_search", filters: { allowed_domains: ["nodejs.org"] }, search_context_size: "low" }, maxUses: 8 });
  for (const [body, pattern] of [
    [{ ...request(), tools: [tool(), { name: "Read", input_schema: {} }] }, /only tool/],
    [request({ type: "web_search_20260209" }), /Unsupported web search tool/],
    [request({}, { tool_choice: { type: "none" } }), /tool_choice none/],
    [request({}, { tool_choice: { type: "tool", name: "other" } }), /tool_choice tool/],
    [request({ blocked_domains: ["example.com"] }), /blocked_domains/],
    [request({ allowed_domains: ["https://nodejs.org/docs"] }), /plain domain names/],
    [request({ allowed_domains: ["*.nodejs.org"] }), /plain domain names/],
    [request({ user_location: { type: "approximate", city: "Hefei" } }), /Unsupported web search options: user_location/],
    [request({ max_uses: 0 }), /max_uses/]
  ]) assert.match(parseWebSearchRequest(body).error, pattern);
});

test("real calls become paired search blocks with deduplicated sources and citation titles", () => {
  const result = toAnthropicContent([
    call("ws_1", [{ type: "url", url: "https://nodejs.org/en/blog/release" }, { type: "url", url: "https://nodejs.org/en/blog/release#top" },
      { type: "api", name: "oai-weather" }, { type: "url", url: "javascript:alert(1)" }, { type: "url", url: "https://github.com/nodejs/node" }]),
    message("Node 24 entered LTS.", [{ type: "url_citation", url: "https://nodejs.org/en/blog/release?utm_source=openai", title: "Node.js releases" }])
  ]);
  assert.deepEqual(result.content, [
    { type: "server_tool_use", id: "srvtoolu_ws_1", name: "web_search", input: { query: "node 24 lts" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_ws_1", content: [
      { type: "web_search_result", url: "https://nodejs.org/en/blog/release", title: "Node.js releases" },
      { type: "web_search_result", url: "https://github.com/nodejs/node", title: "https://github.com/nodejs/node" }] },
    { type: "text", text: "Node 24 entered LTS." }
  ]);
  assert.deepEqual([result.searches, result.hits], [1, 2]);
});

test("zero hits, missing sources, failed calls and answers without a search are distinguished", () => {
  assert.deepEqual(toAnthropicContent([call("ws_1", [])]).content[1].content, []);
  for (const item of [call("ws_1", undefined), call("ws_1", [], { status: "failed" })]) {
    assert.deepEqual(toAnthropicContent([item]).content[1].content, { type: "web_search_tool_result_error", error_code: "unavailable" });
  }
  assert.throws(() => toAnthropicContent([message("https://example.com looks right")]), /without performing a web search/);
  const opened = toAnthropicContent([call("ws_1", []), { type: "web_search_call", id: "ws_2", status: "completed", action: { type: "open_page", url: "https://nodejs.org" } }]);
  assert.equal(opened.searches, 1);
  const unnamed = toAnthropicContent([{ ...call(undefined, []), action: { type: "search" } }]);
  assert.deepEqual(unnamed.content[0], { type: "server_tool_use", id: "srvtoolu_proxy_0", name: "web_search", input: {} });
});

test("JSON and SSE carry the same blocks, with input as JSON deltas and end_turn", () => {
  const result = { ...toAnthropicContent([call("ws_1", [{ type: "url", url: "https://nodejs.org/" }]), message("Summary.")]),
    usage: { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40 } };
  const json = toAnthropicMessage(result, "claude-opus-5.5");
  assert.equal(json.stop_reason, "end_turn");
  assert.deepEqual(json.usage, { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40, server_tool_use: { web_search_requests: 1 } });
  const events = toAnthropicEvents(json);
  assert.deepEqual(events.map(([name, data]) => `${name}:${data.index ?? ""}`), ["content_block_start:0", "content_block_delta:0", "content_block_stop:0",
    "content_block_start:1", "content_block_stop:1", "content_block_start:2", "content_block_delta:2", "content_block_stop:2", "message_delta:", "message_stop:"]);
  assert.deepEqual(events[0][1].content_block, { type: "server_tool_use", id: "srvtoolu_ws_1", name: "web_search", input: {} });
  assert.deepEqual(JSON.parse(events[1][1].delta.partial_json), json.content[0].input);
  assert.deepEqual(events[3][1].content_block, json.content[1]);
  assert.equal(events[6][1].delta.text, "Summary.");
  assert.equal(events.at(-2)[1].delta.stop_reason, "end_turn");
});

test("operation capabilities follow catalog metadata rather than model names", async () => {
  const resolve = (row) => getModelCapabilities("arbitrary-model", () => row);
  assert.deepEqual(resolve({ api: "anthropic-messages", owned_by: "github-copilot" }), { count: "native", search: "copilot-responses" });
  assert.deepEqual(resolve({ api: "openai-responses", owned_by: "openai" }), { count: "estimate", search: "responses" });
  assert.deepEqual(resolve({ api: "openai-responses", owned_by: "github-copilot" }), { count: "estimate", search: "copilot-responses" });
  assert.deepEqual(resolve({ api: "other", owned_by: "openai" }), { count: null, search: null });
  let output;
  let headers;
  await countTokens({ model: "arbitrary-model", messages: [] }, {}, {
    writeHead(status, value) { assert.equal(status, 200); headers = value; },
    end(value) { output = JSON.parse(value); }
  }, { count: "estimate" });
  assert.equal(headers["X-Token-Count-Method"], "conservative-utf8-estimate");
  assert.equal(typeof output.input_tokens, "number");
  await assert.rejects(runWebSearch({ model: "gpt-looking-but-unsupported" }, {}, {
    capabilities: { search: null }, requestGptImpl() { assert.fail("must not generate"); }
  }), /not supported/);
});

function fakeResponses(script) {
  const seen = [];
  const impl = async (body, options) => {
    const payload = { model: body.model, include: ["reasoning.encrypted_content"], tools: [{ type: "function", name: "never" }] };
    options.adjustPayload(payload, { kind: script.kind || "codex" });
    seen.push({ body, payload, options });
    for (const event of script.events) {
      await options.onProviderEvent(event);
      if (options.control.aborted) throw Object.assign(new Error("aborted"), { status: 502 });
    }
    return { usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 } };
  };
  return { impl, seen };
}
const added = (index, id) => ({ type: "response.output_item.added", output_index: index, item: { type: "web_search_call", id, status: "in_progress" } });
const done = (index, item) => ({ type: "response.output_item.done", output_index: index, item });

test("GPT searches keep their model and recover items when the completed output is empty", async () => {
  const { impl, seen } = fakeResponses({ events: [added(0, "ws_1"), done(0, call("ws_1", [{ type: "url", url: "https://nodejs.org/" }])),
    done(1, message("Summary.")), { type: "response.completed", response: { status: "completed", output: [] } }] });
  const body = request({ allowed_domains: ["nodejs.org"] }, { model: "gpt-6.1-sol", system: "search policy", max_tokens: 100 });
  const onReplayFailure = () => {};
  const result = await runWebSearch(body, parseWebSearchRequest(body), { requestGptImpl: impl, onReplayFailure });
  assert.equal(seen[0].options.onReplayFailure, onReplayFailure);
  assert.equal(seen[0].body.system, "search policy");
  assert.equal(seen[0].body.max_tokens, 100);
  assert.deepEqual(seen[0].body.messages, body.messages);
  assert.equal(seen[0].body.tools, undefined);
  assert.equal(seen[0].body.tool_choice, undefined);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 });
  assert.equal(seen[0].body.model, "gpt-6.1-sol");
  assert.equal(seen[0].options.remember, false);
  assert.deepEqual(seen[0].payload.tools, [{ type: "web_search", filters: { allowed_domains: ["nodejs.org"] } }]);
  assert.equal(seen[0].payload.tool_choice, "required");
  assert.equal(seen[0].payload.stream, true);
  assert.deepEqual(seen[0].payload.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
  // Codex rejects max_tool_calls: the limit is enforced on the stream instead.
  assert.equal(seen[0].payload.max_tool_calls, undefined);
  assert.deepEqual([result.model, result.authKind, result.searches, result.hits, result.capped], ["gpt-6.1-sol", "codex", 1, 1, false]);
  assert.equal(result.content.at(-1).text, "Summary.");
});

test("Claude sessions search through Copilot's newest Luna with the native call limit", async () => {
  const { impl, seen } = fakeResponses({ kind: "copilot", events: [added(0, "ws_1"), done(0, call("ws_1", [])),
    { type: "response.completed", response: { status: "completed", output: [call("ws_1", [])] } }] });
  const result = await runWebSearch({ model: "claude-opus-5.5", messages: [] }, parseWebSearchRequest(request()),
    { requestGptImpl: impl, listCopilotModels: async () => ["gpt-5.6-luna", "gpt-6-luna", "gpt-6.1-sol", "claude-opus-5.5"] });
  assert.equal(seen[0].body.model, "gpt-6-luna");
  assert.equal(typeof seen[0].options.loadAuth, "function");
  assert.equal(seen[0].payload.max_tool_calls, 8);
  await runWebSearch({ model: "catalog-responses-model", messages: [] }, parseWebSearchRequest(request()), {
    capabilities: getModelCapabilities("catalog-responses-model", () => ({ api: "openai-responses", owned_by: "github-copilot" })),
    requestGptImpl: impl, listCopilotModels: async () => ["gpt-6-luna"]
  });
  assert.equal(typeof seen[1].options.loadAuth, "function");
  assert.equal(seen[1].body.model, "gpt-6-luna");
  assert.deepEqual([result.model, result.authKind, result.hits], ["gpt-6-luna", "copilot", 0]);
  await assert.rejects(runWebSearch({ model: "claude-opus-5.5" }, parseWebSearchRequest(request()), { requestGptImpl: impl,
    listCopilotModels: async () => ["claude-opus-5.5"] }), /No Copilot GPT model/);
});

test("a search beyond max_uses aborts upstream and is reported as max_uses_exceeded", async () => {
  const control = { abort() { this.aborted = true; } };
  const { impl } = fakeResponses({ events: [added(0, "ws_1"), done(0, call("ws_1", [{ type: "url", url: "https://nodejs.org/" }])),
    added(1, "ws_2"), done(1, call("ws_2", [{ type: "url", url: "https://example.com/" }]))] });
  const result = await runWebSearch({ model: "gpt-5.4" }, parseWebSearchRequest(request({ max_uses: 1 })), { control, requestGptImpl: impl });
  assert.equal(control.aborted, true);
  assert.equal(result.capped, true);
  assert.deepEqual(result.content.map((block) => block.type), ["server_tool_use", "web_search_tool_result", "server_tool_use", "web_search_tool_result"]);
  assert.deepEqual(result.content[3].content, { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" });
  assert.equal(result.hits, 1);
  const failing = async () => { throw Object.assign(new Error("upstream down"), { status: 503 }); };
  await assert.rejects(runWebSearch({ model: "gpt-5.4" }, parseWebSearchRequest(request()), { requestGptImpl: failing }), /upstream down/);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parityGateway } = require("./helpers/parity-gateway");
const { claudeEvents, claudeSse } = require("./helpers/claude-fixture");
const { eventsFor, sse, payloadOf, jwt, text } = require("./helpers/pi-fixture");
const { isReplayCarrier } = require("../lib/responses-replay");
const { estimateInputTokens } = require("../lib/token-count");
const path = require("node:path");

const tool = { name: "Read", description: "Read a fixture file", input_schema: {
  type: "object", properties: { path: { type: "string" } }, required: ["path"]
} };
const fixtureUsage = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 40 };
const wireResult = ({ id, ...message }) => message; // Generated message IDs differ; tool IDs do not.

function toolResults(content) {
  return content.filter((block) => block.type === "tool_use").map((block) => ({
    type: "tool_result", tool_use_id: block.id, content: `contents of ${block.input.path}`
  }));
}

async function twoTurns(t, { old, route, auth, body, upstreamReply, upstreamPayload }) {
  const upstream = [];
  const send = await parityGateway(t, { old, route, auth, fetchImpl: async (url, options) => {
    const payload = upstreamPayload(options);
    const headers = new Headers(options.headers);
    upstream.push({ url, payload, authorization: headers.get("authorization"), account: headers.get("chatgpt-account-id") });
    assert.ok(upstream.length <= 2, "Only the two scripted upstream requests are allowed");
    return upstreamReply(upstream.length, payload);
  } });
  const first = await send({ ...body, stream: true });
  const second = await send({ ...body, stream: false, messages: [...body.messages,
    { role: "assistant", content: first.content }, { role: "user", content: toolResults(first.content) }
  ] });
  assert.equal(upstream.length, 2);
  return { first: wireResult(first), second: wireResult(second), upstream };
}

test("Claude parity: signed history, native tools, cache breakpoints and tool-result continuation", async (t) => {
  const model = "claude-sonnet-5.5";
  const route = { id: model, api: "anthropic-messages", owned_by: "github-copilot" };
  const auth = { token: "fixture-copilot", baseUrl: "https://copilot.fixture.invalid" };
  const cache_control = { type: "ephemeral", ttl: "1h" };
  const system = [{ type: "text", text: "Stable fixture policy", cache_control }, { type: "text", text: "Read the fixture." }];
  const nativeTool = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 1, allowed_domains: ["example.org"] };
  const blocks = [{ type: "thinking", thinking: "I need the fixture.", signature: "fixture-native-signature" },
    { type: "redacted_thinking", data: "fixture-native-redacted" },
    { type: "server_tool_use", id: "srvtoolu_fixture", name: "web_fetch", input: { url: "https://example.org/" } },
    { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_fixture", content: { type: "web_fetch_tool_result_error", error_code: "unavailable" } },
    { type: "text", text: "Reading now." }, { type: "tool_use", id: "toolu_fixture", name: "Read", input: { path: "fixture.txt" } }
  ];
  const final = [{ type: "text", text: "Finished. 完成。" }];
  const body = { model, max_tokens: 512, system, tools: [nativeTool, tool], thinking: { type: "adaptive" },
    metadata: { session_id: "parity-claude" }, messages: [{ role: "user", content: [{ type: "text", text: "Read fixture.txt", cache_control }] }] };
  const run = (old) => twoTurns(t, { old, route, auth, body, upstreamPayload: (options) => JSON.parse(options.body),
    upstreamReply(turn, payload) {
      const content = turn === 1 ? blocks : final;
      const stop_reason = turn === 1 ? "tool_use" : "end_turn";
      if (!payload.stream) return Response.json({ id: "msg_json", type: "message", role: "assistant", model,
        content, stop_reason, stop_sequence: null, usage: fixtureUsage });
      return claudeSse(claudeEvents({ model, blocks: content, usage: { ...fixtureUsage, output_tokens: 1 },
        finalUsage: { output_tokens: fixtureUsage.output_tokens }, delta: { stop_reason, stop_sequence: null } }));
    }
  });
  const old = await run(true);
  const current = await run(false);
  assert.deepEqual(current.first, { ...old.first, model: `anthropic/${model}` });
  assert.deepEqual(current.second, { ...old.second, model: `anthropic/${model}` });
  assert.deepEqual(current.first.content, blocks);
  assert.deepEqual(current.second.content, final);
  assert.deepEqual(current.second.usage, fixtureUsage);
  assert.equal(current.first.stop_reason, "tool_use");
  assert.equal(current.second.stop_reason, "end_turn");
  const project = ({ payload, url, authorization }) => ({ url, authorization,
    model: payload.model, max_tokens: payload.max_tokens, thinking: payload.thinking, system: payload.system,
    // Pi adds the eager tool-input streaming hint and normalizes optional schema fields.
    tools: payload.tools.map(({ eager_input_streaming, input_schema, ...definition }) => ({ ...definition,
      ...(input_schema ? { input_schema: { ...input_schema, required: input_schema.required || [] } } : {}) })),
    messages: payload.messages.map((message) => ({ ...message, content: message.content.map((block) => {
      // Anthropic accepts equivalent string and text-block results.
      if (block.type !== "tool_result") return block;
      const { is_error = false, content, ...rest } = block;
      return { ...rest, is_error, content: typeof content === "string" ? [{ type: "text", text: content }] : content };
    }) }))
  });
  assert.deepEqual(current.upstream.map(project), old.upstream.map(project));
  assert.equal(old.upstream[1].payload.stream, false);
  assert.equal(current.upstream[1].payload.stream, true); // Pi aggregates upstream SSE for JSON callers.
  assert.deepEqual(current.upstream[1].payload.messages[1].content, blocks);
  assert.deepEqual(current.upstream[0].payload.system[0], system[0]);
  assert.deepEqual(current.upstream[0].payload.tools[0], nativeTool);
});

test("Codex parity: public reasoning, parallel tools and byte-exact encrypted replay", async (t) => {
  const model = "gpt-6.1-sol";
  const route = { id: model, api: "openai-codex-responses", owned_by: "openai" };
  const auth = { kind: "codex", accountId: "parity-account", token: jwt("parity-account") };
  const native = [{ type: "reasoning", id: "rs_parity", encrypted_content: "fixture-opaque-reasoning",
    summary: [{ type: "summary_text", text: "Read both files." }] }, text("Checking both."),
    { type: "function_call", id: "fc_left", call_id: "call_left", name: "Read", arguments: '{ "path": "left.txt" }', status: "completed" },
    { type: "function_call", id: "fc_right", call_id: "call_right", name: "Read", arguments: '{\n  "path": "right.txt"\n}', status: "completed" }];
  const firstEvents = eventsFor(native);
  const functionEnds = firstEvents.filter((e) => e.type === "response.output_item.done" && e.item.type === "function_call");
  const terminal = firstEvents.pop();
  // Both calls are open before either completes. Completion order differs from native output order.
  const events = [...firstEvents.filter((e) => !functionEnds.includes(e)), ...functionEnds.reverse(), terminal];
  const body = { model: "anthropic/" + model, max_tokens: 512, metadata: { user_id: "parity-codex" },
    system: "Stable fixture policy", tools: [tool], thinking: { type: "adaptive" }, output_config: { effort: "high" },
    messages: [{ role: "user", content: "Read both fixtures." }] };
  const run = (old) => twoTurns(t, { old, route, auth, body, upstreamPayload: payloadOf,
    upstreamReply(turn) { return sse(turn === 1 ? events : eventsFor([text("Both files read. 完成。")]), true); }
  });
  const old = await run(true);
  const current = await run(false);
  // New: the client transcript also carries Codex replay state, so it survives a
  // proxy restart. It is an empty thinking block whose signature is the carrier.
  const carrier = current.first.content.at(-1);
  assert.equal(carrier.type, "thinking");
  assert.equal(carrier.thinking, "");
  assert.ok(isReplayCarrier(carrier.signature));
  current.first.content.pop();
  // Pi emits a paragraph separator at summary-part completion, even for the last part.
  // Allow that exact presentation difference without trimming signatures or other text.
  assert.equal(old.first.content[0].thinking, "Read both files.");
  assert.equal(current.first.content[0].thinking, "Read both files.\n\n");
  assert.deepEqual(current.first, { ...old.first, model: `anthropic/openai/${model}`, content: [
    { ...old.first.content[0], thinking: old.first.content[0].thinking + "\n\n" }, ...old.first.content.slice(1)
  ] });
  assert.deepEqual(current.second, { ...old.second, model: `anthropic/openai/${model}` });
  assert.equal(current.first.stop_reason, "tool_use");
  assert.deepEqual(current.first.content.filter((block) => block.type === "tool_use").map(({ id }) => id), ["call_right", "call_left"]);
  assert.ok(!JSON.stringify(current.first).includes(native[0].encrypted_content));
  assert.deepEqual(current.second.content, [{ type: "text", text: "Both files read. 完成。" }]);
  assert.deepEqual(current.second.usage, { input_tokens: 464, output_tokens: 12, cache_read_input_tokens: 1536 });
  // Both adapters explicitly disable strict schemas; a server default must not decide it.
  for (const { payload } of [...old.upstream, ...current.upstream]) assert.equal(payload.tools[0].strict, false);
  // Pi places the system prompt in a leading developer item instead of `instructions`
  // (stable prefix for prompt caching). Everything else, including replayed items, is unchanged.
  for (const [index, { payload }] of current.upstream.entries()) {
    assert.equal(old.upstream[index].payload.instructions, "Stable fixture policy");
    assert.equal(payload.instructions, undefined);
    assert.deepEqual(payload.input, [{ role: "developer", content: "Stable fixture policy" }, ...old.upstream[index].payload.input]);
  }
  const project = ({ payload, url, authorization, account }) => ({ url, authorization, account,
    model: payload.model, reasoning: payload.reasoning,
    tools: payload.tools,
    stream: payload.stream, store: payload.store, prompt_cache_key: payload.prompt_cache_key,
    parallel_tool_calls: payload.parallel_tool_calls, include: payload.include });
  assert.deepEqual(current.upstream.map(project), old.upstream.map(project));
  const second = current.upstream[1].payload;
  assert.deepEqual(second.input.slice(2, 2 + native.length), native);
  assert.deepEqual(second.input.slice(2 + native.length), [
    { type: "function_call_output", call_id: "call_right", output: "contents of right.txt" },
    { type: "function_call_output", call_id: "call_left", output: "contents of left.txt" }
  ]);
  assert.equal(second.prompt_cache_key, current.upstream[0].payload.prompt_cache_key);
});

test("GPT → Opus sends visible history and linked tool results, not GPT reasoning", async (t) => {
  const gpt = "gpt-6.2-sol";
  const opus = "claude-opus-5.5";
  const routes = [
    { id: gpt, api: "openai-codex-responses", owned_by: "openai" },
    { id: opus, api: "anthropic-messages", owned_by: "github-copilot" }
  ];
  const codex = { kind: "codex", accountId: "switch-account", token: jwt("switch-account") };
  const copilot = { token: "fixture-switch-copilot", baseUrl: "https://copilot.fixture.invalid" };
  const summary = "Public GPT reasoning about the fixture.";
  const encrypted = "fixture-switch-opaque-reasoning";
  const reply = "I found a file to inspect.";
  const upstream = [];
  const send = await parityGateway(t, { routes, loadAuth(model) {
    assert.ok([gpt, opus].includes(model));
    return model === gpt ? codex : copilot;
  }, fetchImpl: async (url, options) => {
    const payload = payloadOf(options);
    const authorization = new Headers(options.headers).get("authorization");
    upstream.push({ url, payload, authorization });
    if (upstream.length === 1) {
      assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(payload.model, gpt);
      return sse(eventsFor([
        { type: "reasoning", id: "rs_switch", encrypted_content: encrypted,
          summary: [{ type: "summary_text", text: summary }] },
        text(reply),
        { type: "function_call", id: "fc_switch", call_id: "call_switch", name: "Read",
          arguments: '{"path":"fixture.txt"}', status: "completed" }
      ]));
    }
    assert.equal(upstream.length, 2, "Only the scripted GPT and Opus requests are allowed");
    return claudeSse(claudeEvents({ model: opus }));
  } });
  const system = "Use only the supplied fixture history.";
  const question = "Read fixture.txt and note the finding.";
  const followUp = "Continue from that finding.";
  const body = { model: `anthropic/openai/${gpt}`, max_tokens: 256, system, tools: [tool],
    metadata: { user_id: "parity-model-switch" }, messages: [{ role: "user", content: question }],
    thinking: { type: "adaptive" } };
  const first = await send({ ...body, stream: true });
  assert.equal(first.stop_reason, "tool_use");
  assert.deepEqual(first.content.slice(0, 3), [
    { type: "thinking", thinking: `${summary}\n\n`, signature: "" },
    { type: "text", text: reply },
    { type: "tool_use", id: "call_switch", name: "Read", input: { path: "fixture.txt" } }
  ]);
  assert.equal(first.content.length, 4);
  assert.ok(isReplayCarrier(first.content[3].signature));
  const results = toolResults(first.content);
  const second = await send({ ...body, model: `anthropic/${opus}`, stream: false, messages: [...body.messages,
    { role: "assistant", content: first.content },
    { role: "user", content: [...results, { type: "text", text: followUp }] }
  ] });
  assert.equal(second.model, `anthropic/${opus}`);
  assert.deepEqual(second.content, [{ type: "text", text: "native reply" }]);
  assert.equal(upstream.length, 2);
  assert.equal(upstream[0].authorization, `Bearer ${codex.token}`);
  const { url, payload, authorization } = upstream[1];
  assert.equal(url, `${copilot.baseUrl}/v1/messages`);
  assert.equal(authorization, `Bearer ${copilot.token}`);
  assert.equal(payload.model, opus);
  assert.deepEqual(payload.system, [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(payload.messages, [
    { role: "user", content: [{ type: "text", text: question }] },
    { role: "assistant", content: first.content.slice(1, 3) },
    { role: "user", content: [{ ...results[0], is_error: false }] },
    { role: "user", content: [{ type: "text", text: followUp, cache_control: { type: "ephemeral" } }] }
  ]);
  assert.equal(payload.tools[0].name, tool.name);
  assert.deepEqual(payload.tools[0].input_schema, tool.input_schema);
  const raw = JSON.stringify(payload);
  for (const omitted of [summary, encrypted, "rs_switch", "fc_switch", "claude-proxy-responses-v1."]) assert.ok(!raw.includes(omitted), omitted);
  assert.equal(Object.hasOwn(payload, "prompt_cache_key"), false);
});

test("Opus → Codex keeps visible history and tool results without sending Claude-native blocks", async (t) => {
  const opus = "claude-opus-5.5";
  const gpt = "gpt-6.2-sol";
  const routes = [
    { id: opus, api: "anthropic-messages", owned_by: "github-copilot" },
    { id: gpt, api: "openai-codex-responses", owned_by: "openai" }
  ];
  const codex = { kind: "codex", accountId: "reverse-switch-account", token: jwt("reverse-switch-account") };
  const copilot = { token: "fixture-reverse-switch", baseUrl: "https://copilot.fixture.invalid" };
  const blocks = [
    { type: "thinking", thinking: "Private Claude reasoning.", signature: "fixture-claude-signature" },
    { type: "redacted_thinking", data: "fixture-claude-redacted" },
    { type: "server_tool_use", id: "srvtoolu_reverse", name: "web_search", input: { query: "fixture" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_reverse", content: [] },
    { type: "text", text: "I found a file to inspect." },
    { type: "tool_use", id: "toolu_reverse", name: "Read", input: { path: "fixture.txt" } }
  ];
  const upstream = [];
  const send = await parityGateway(t, { routes, loadAuth: (model) => model === opus ? copilot : codex,
    fetchImpl: async (url, options) => {
      upstream.push({ url, payload: payloadOf(options), headers: new Headers(options.headers) });
      assert.ok(upstream.length <= 2);
      return upstream.length === 1
        ? claudeSse(claudeEvents({ model: opus, blocks, delta: { stop_reason: "tool_use", stop_sequence: null } }))
        : sse(eventsFor([text("The fixture was read.")]));
    }
  });
  const system = "Use only the fixture history.";
  const question = "Read fixture.txt.";
  const followUp = "Report the result.";
  const body = { model: opus, max_tokens: 256, system, tools: [tool],
    metadata: { user_id: "parity-reverse-switch" }, messages: [{ role: "user", content: question }] };
  const first = await send({ ...body, stream: false });
  assert.equal(first.stop_reason, "tool_use");
  assert.deepEqual(first.content, blocks);
  const second = await send({ ...body, model: `anthropic/openai/${gpt}`, stream: true, messages: [...body.messages,
    { role: "assistant", content: first.content },
    { role: "user", content: [...toolResults(first.content), { type: "text", text: followUp }] }
  ] });
  assert.equal(second.model, `anthropic/openai/${gpt}`);
  assert.equal(second.stop_reason, "end_turn");
  assert.deepEqual(second.content, [{ type: "text", text: "The fixture was read." }]);
  assert.equal(upstream.length, 2);
  assert.equal(upstream[0].url, `${copilot.baseUrl}/v1/messages`);
  const { url, payload, headers } = upstream[1];
  assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(headers.get("chatgpt-account-id"), codex.accountId);
  assert.equal(payload.model, gpt);
  const [policy, user, assistant, call, output, next] = payload.input;
  assert.equal(payload.input.length, 6);
  assert.deepEqual(policy, { role: "developer", content: system });
  assert.deepEqual([user.role, assistant.role, next.role], ["user", "assistant", "user"]);
  assert.equal(user.content[0].text, question);
  assert.equal(assistant.content[0].text, blocks[4].text);
  assert.equal(call.type, "function_call");
  assert.equal(call.name, "Read");
  assert.deepEqual(JSON.parse(call.arguments), { path: "fixture.txt" });
  assert.deepEqual(output, { type: "function_call_output", call_id: call.call_id, output: "contents of fixture.txt" });
  assert.equal(next.content[0].text, followUp);
  const raw = JSON.stringify(payload.input);
  for (const omitted of [blocks[0].thinking, blocks[0].signature, blocks[1].data, blocks[2].id]) assert.ok(!raw.includes(omitted), omitted);
});

test("Codex reasoning resumes from the client transcript after a proxy restart", async (t) => {
  const model = "gpt-6.2-sol";
  const route = { id: model, api: "openai-codex-responses", owned_by: "openai" };
  const codex = (account) => ({ kind: "codex", accountId: account, token: jwt(account) });
  const native = [{ type: "reasoning", id: "rs_restart", encrypted_content: "fixture-restart-opaque", summary: [] },
    { type: "function_call", id: "fc_restart", call_id: "call_restart", name: "Read",
      arguments: '{ "path": "fixture.txt" }', status: "completed" }];
  const body = { model: `anthropic/${model}`, max_tokens: 256, system: "Stable fixture policy", tools: [tool],
    metadata: { user_id: "parity-restart" }, messages: [{ role: "user", content: "Read fixture.txt" },
      { role: "system", content: [{ type: "text", text: "Keep the answer concise." }] }] };
  // A restart loses the proxy's in-memory replay cache: load every module afresh.
  const restart = () => {
    for (const file of Object.keys(require.cache)) if (file.startsWith(path.join(__dirname, "..", "lib"))) delete require.cache[file];
  };
  const gateway = (auth, reply) => {
    const upstream = [];
    return parityGateway(t, { route, auth, fetchImpl: async (_url, options) => {
      upstream.push(payloadOf(options));
      return sse(reply);
    } }).then((send) => ({ send, upstream }));
  };
  restart();
  const before = await gateway(codex("restart-account"), eventsFor(native));
  const first = await before.send({ ...body, stream: true });
  // Encrypted-only reasoning has no visible summary; only the carrier records it.
  assert.deepEqual(first.content.slice(0, 1), [{ type: "tool_use", id: "call_restart", name: "Read", input: { path: "fixture.txt" } }]);
  assert.equal(first.content.length, 2);
  assert.ok(isReplayCarrier(first.content[1].signature));
  const history = [...body.messages, { role: "assistant", content: first.content },
    { role: "user", content: toolResults(first.content) }];
  const resumed = (messages) => ({ ...body, stream: false, messages });
  const flattened = structuredClone(history);
  flattened[1].content = history[1].content[0].text;
  const editedReminder = structuredClone(flattened);
  editedReminder[1].content += " Use bullet points.";
  const edited = structuredClone(history);
  edited[2].content[0].input.path = "other.txt";
  const corrupt = structuredClone(history);
  corrupt[2].content[1].signature = "claude-proxy-responses-v1.not-a-carrier";
  for (const [name, account, messages, restored] of [
    ["same account and history", "restart-account", history, true],
    ["same system reminder in string form", "restart-account", flattened, true],
    ["edited system reminder", "restart-account", editedReminder, false],
    ["another account", "other-account", flattened, false],
    ["edited history", "restart-account", edited, false],
    ["damaged carrier", "restart-account", corrupt, false]
  ]) {
    restart();
    const after = await gateway(codex(account), eventsFor([text("Done.")]));
    const reply = await after.send(resumed(messages));
    assert.deepEqual(reply.content.map(({ type }) => type), ["text"], name);
    const { input } = after.upstream[0];
    if (restored) {
      // Byte-exact native span, then the tool output linked to the same call.
      assert.deepEqual(input.slice(-3, -1), native, name);
      assert.deepEqual(input.at(-1), { type: "function_call_output", call_id: "call_restart", output: "contents of fixture.txt" }, name);
    } else {
      assert.ok(!input.some((item) => item.type === "reasoning"), name);
      assert.ok(!JSON.stringify(input).includes(native[0].encrypted_content), name);
    }
  }
});

test("token estimates ignore Codex replay carriers", () => {
  const carrier = "claude-proxy-responses-v1." + "A".repeat(4096);
  const body = { messages: [{ role: "assistant", content: [{ type: "text", text: "answer" },
    { type: "thinking", thinking: "", signature: carrier }] }] };
  const withoutCarrier = structuredClone(body);
  delete withoutCarrier.messages[0].content[1].signature;
  assert.equal(estimateInputTokens(body), estimateInputTokens(withoutCarrier));
});

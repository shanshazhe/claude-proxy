const test = require("node:test");
const assert = require("node:assert/strict");
const { requestGpt } = require("../lib/pi-gpt");
const { createReplayReader, rememberReplay } = require("../lib/responses-replay");
const { eventsFor, sse, payloadOf, text, jwt } = require("./helpers/pi-fixture");
const { parityGateway } = require("./helpers/parity-gateway");

const auth = { kind: "api", accountId: "replay-account", token: "sk-offline" };
const output = [
  { type: "reasoning", id: "rs_native", encrypted_content: "opaque-not-plaintext", summary: [] },
  { type: "function_call", id: "fc_original", call_id: "call_original", name: "read", arguments: '{ "path": "file", "n": 1 }', status: "completed" },
  { type: "function_call", id: "fc_second", call_id: "call_second", name: "read", arguments: '{ "n": 2 }', status: "completed" }
];
const request = (session) => ({ model: "gpt-6-sol", prompt_cache_key: session,
  messages: [{ role: "user", content: "read file" }] });
const continueWith = (body, answer) => ({ ...body, messages: [...body.messages, { role: "assistant", content: answer.content },
  { role: "user", content: answer.content.filter((block) => block.type === "tool_use").map((block) => ({ type: "tool_result", tool_use_id: block.id, content: "result" })) }] });
const options = (extra = {}) => ({ loadAuth: async () => auth, fetchImpl: async () => sse(eventsFor(output)), ...extra });

test("real Pi roundtrip preserves exact arguments, native IDs, encrypted reasoning and private usage diagnostics", async () => {
  const body = request("native-roundtrip");
  const answer = await requestGpt(body, options());
  assert.equal(answer.content[0].id, "call_original");
  assert.ok(!JSON.stringify(answer).includes("opaque-not-plaintext"));
  const stats = [];
  await requestGpt(continueWith(body, answer), options({ onCacheUsage: (usage) => stats.push(usage), fetchImpl: async (_, options) => {
    const input = payloadOf(options).input;
    assert.deepEqual(input.slice(1, 4), output);
    assert.equal(input[4].call_id, "call_original");
    assert.equal(input.filter((item) => item.type === "function_call_output").length, 2);
    assert.ok(!JSON.stringify(input).includes("No result provided"));
    return sse(eventsFor());
  } }));
  assert.equal(stats[0].replayed_assistant_turns, 1);
  assert.ok(!JSON.stringify(stats).includes("opaque-not-plaintext"));
});

test("replay is isolated by model, account, session and complete preceding history", async () => {
  const body = request("isolated");
  const answer = await requestGpt(body, options());
  const continued = continueWith(body, answer);
  for (const [next, credentials] of [
    [{ ...continued, model: "gpt-other" }, auth],
    [{ ...continued, model: `openai/${continued.model}` }, auth],
    [continued, { ...auth, accountId: "another-account" }],
    [{ ...continued, prompt_cache_key: "another-session" }, auth],
    [{ ...continued, system: "changed instructions" }, auth],
    [{ ...continued, tools: [{ name: "newTool", input_schema: { type: "object" } }] }, auth],
    [{ ...continued, messages: [{ role: "user", content: "different" }, ...continued.messages.slice(1)] }, auth]
  ]) await requestGpt(next, options({ loadAuth: async () => credentials, fetchImpl: async (_, options) => {
    assert.ok(!payloadOf(options).input.some((item) => item.type === "reasoning")); return sse(eventsFor());
  } }));
  await requestGpt(continued, options({ loadAuth: async () => ({ ...auth, token: "rotated" }), fetchImpl: async (_, options) => {
    assert.ok(payloadOf(options).input.some((item) => item.type === "reasoning")); return sse(eventsFor());
  } }));
});

test("Codex HTTP gateway logs exceptional replay misses without logging contents or ordinary misses", async (t) => {
  const route = { id: "gpt-6-sol", owned_by: "openai", api: "openai-codex-responses" };
  const lines = [];
  const native = [output[0], text("fixture answer")];
  const secret = "private-fixture-tool-result";
  const failures = [];
  let upstreamUnavailable = false;
  const send = await parityGateway(t, { route, auth: { kind: "codex", accountId: "fixture-cache-diagnostics", token: jwt("fixture-cache-diagnostics") },
    onLog: (line) => {
      if (line.includes("Prompt cache usage")) lines.push(line);
      if (line.includes("Codex replay failure")) failures.push(line);
    },
    fetchImpl: async () => upstreamUnavailable ? Response.json({ error: { message: "fixture temporarily unavailable" } }, { status: 503 })
      : sse(eventsFor(native)) });
  const base = { ...request("replay-http-diagnostics"), tools: [{ name: "read", input_schema: { type: "object" } }], messages: [
    { role: "user", content: "read file" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_fixture", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: secret }] }
  ] };
  const response = await send(base);
  assert.ok(response.content.some((block) => block.type === "thinking" && block.signature));
  const continued = { ...base, messages: [...base.messages, { role: "assistant", content: response.content }, { role: "user", content: "continue" }] };
  await send(continued);
  const changed = structuredClone(continued);
  changed.messages[2].content[0].content = [{ type: "text", text: secret }];
  await send(changed);
  assert.match(lines[1], /\breplayed_assistant_turns=1\b/);
  assert.doesNotMatch(lines[1], /\breplay_/);
  assert.match(lines[2], /\breplayed_assistant_turns=0\b/);
  assert.deepEqual(lines[2].match(/\breplay_\w+=\S+/g), ["replay_carrier_key_mismatch_turns=1"]);
  for (const field of ["cache_key_id", "prefix_id"]) {
    const value = new RegExp(`\\b${field}=\\w+`).exec(lines[1]);
    assert.ok(value && lines[2].includes(value[0]), field);
  }
  assert.deepEqual(failures, []);
  upstreamUnavailable = true;
  const ordinaryFailure = await send(continued, 503);
  assert.deepEqual(failures, []);
  const replayFailure = await send(changed, 503);
  assert.deepEqual(replayFailure, ordinaryFailure);
  assert.match(replayFailure.error.message, /fixture temporarily unavailable/);
  assert.equal(lines.length, 3, "failed requests do not emit token usage");
  assert.equal(failures.length, 1);
  assert.match(failures[0], /\[req-\d+\] Codex replay failure replay_carrier_key_mismatch_turns=1$/);
  assert.doesNotMatch([...lines, ...failures].join("\n"), /private-fixture|opaque-not-plaintext|claude-proxy-responses-v1\.|fixture-cache-diagnostics/);
});

test("Codex replay diagnostics distinguish invalid carriers and skipped native items", async () => {
  const auth = { kind: "codex", accountId: "fixture-other-diagnostics", token: jwt("fixture-other-diagnostics") };
  const body = { ...request("replay-unit-diagnostics"), tools: [{ name: "read", input_schema: { type: "object" } }] };
  const native = [output[0], text("fixture answer")];
  const run = (input, extra = {}) => requestGpt(input, options({ loadAuth: async () => auth,
    fetchImpl: async () => sse(eventsFor(native)), ...extra }));
  const answer = await run(body);
  const next = { ...body, messages: [...body.messages, { role: "assistant", content: answer.content }, { role: "user", content: "continue" }] };
  let stats;
  const observe = { remember: false, onCacheUsage: (usage) => { stats = usage; } };
  await run({ ...next, tools: [{ ...body.tools[0], description: "" }] }, observe);
  assert.equal(stats.replay_carrier_key_mismatch_turns, 1);
  const invalid = structuredClone(next);
  invalid.messages[1].content.find((block) => block.signature).signature = "claude-proxy-responses-v1.invalid";
  await run({ ...invalid, system: "different system" }, observe);
  assert.equal(stats.replay_invalid_carrier_turns, 1);
  const pi = { role: "assistant", model: body.model, api: "openai-codex-responses", provider: "openai-codex",
    content: [{ type: "text", text: "fixture answer" }], stopReason: "stop", usage: {}, timestamp: 0 };
  rememberReplay(body, auth, { status: "completed", output: native }, pi, next.messages[1]);
  await run(next, observe);
  assert.equal(stats.replayed_assistant_turns, 1);
  assert.equal(stats.replay_wire_skipped_turns, 1);
  let failureCounts;
  await assert.rejects(run({ ...invalid, system: "different system" }, {
    fetchImpl: async () => Response.json({ error: { message: "fixture unavailable" } }, { status: 503 }),
    onReplayFailure: async (counts) => {
      failureCounts = counts;
      throw new Error("fixture logger unavailable");
    }
  }), { status: 503, message: "fixture unavailable" });
  assert.deepEqual(failureCounts, { replay_invalid_carrier_turns: 1 });
});

test("out-of-order tool completion matches the delivered client view and restores original native order", async () => {
  const body = { ...request("out-of-order"), stream: true };
  const events = output.map((item, output_index) => ({ type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : {}) } }));
  events.push(...[0, 2, 1].map((index) => ({ type: "response.output_item.done", output_index: index, item: output[index] })),
    { type: "response.completed", response: { status: "completed", output: [] } });
  const delivered = [];
  await requestGpt(body, options({ fetchImpl: async () => sse(events), onEvent: async (event) => {
    if (event.type === "toolcall_end") delivered.push({ type: "tool_use", id: event.toolCall.id.split("|")[0], name: event.toolCall.name, input: event.toolCall.arguments });
  } }));
  assert.equal(delivered[0].id, "call_second");
  await requestGpt(continueWith(body, { content: delivered }), options({ fetchImpl: async (_, options) => {
    assert.deepEqual(payloadOf(options).input.slice(1, 4), output); return sse(eventsFor());
  } }));
});

test("message phase survives replay, edited answers and one-off completions safely miss", async () => {
  const body = request("text-phase");
  const native = { ...text("OK"), phase: "final_answer" };
  const answer = await requestGpt(body, options({ fetchImpl: async () => sse(eventsFor([native])) }));
  const next = { ...body, messages: [...body.messages, { role: "assistant", content: answer.content }, { role: "user", content: "next" }] };
  for (const edited of [false, true]) {
    const current = structuredClone(next);
    if (edited) current.messages[1].content[0].text = "edited";
    await requestGpt(current, options({ fetchImpl: async (_, options) => {
      const item = payloadOf(options).input[1];
      assert.equal(item.phase, edited ? undefined : "final_answer"); return sse(eventsFor());
    } }));
  }
  const once = request("one-off");
  await requestGpt(once, options({ remember: false, fetchImpl: async () => sse(eventsFor([native])) }));
  assert.equal(createReplayReader({ ...once, messages: [...once.messages, { role: "assistant", content: answer.content }] }, auth)(1), undefined);
});

test("replay entries are cloned, bounded, and oversized opaque metadata is not retained", () => {
  const body = request("bounded");
  const delivered = { role: "assistant", content: [{ type: "text", text: "OK" }] };
  const pi = { content: [{ type: "text", text: "OK" }] };
  const next = { ...body, messages: [...body.messages, delivered] };
  const native = { status: "completed", output: [text("OK")] };
  rememberReplay(body, auth, native, pi, delivered);
  const first = createReplayReader(next, auth)(1);
  first.native[0].id = "mutated";
  assert.notEqual(createReplayReader(next, auth)(1).native[0].id, "mutated");
  for (let index = 0; index < 513; index++) rememberReplay(request(`eviction-${index}`), auth, native, pi, delivered);
  assert.equal(createReplayReader(next, auth)(1), undefined);
  const oversized = request("oversized");
  rememberReplay(oversized, auth, native, { opaque: "x".repeat(16 * 1024 * 1024) }, delivered);
  assert.equal(createReplayReader({ ...oversized, messages: [...oversized.messages, delivered] }, auth)(1), undefined);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { requestGpt } = require("../lib/pi-gpt");
const { createReplayReader, rememberReplay } = require("../lib/responses-replay");
const { eventsFor, sse, payloadOf, text } = require("./helpers/pi-fixture");

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

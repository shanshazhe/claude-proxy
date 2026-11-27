"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parityGateway } = require("./helpers/parity-gateway");
const { claudeEvents, claudeSse } = require("./helpers/claude-fixture");
const { eventsFor, jwt, sse, chatSse } = require("./helpers/pi-fixture");

const input = { label: "mock-approval-fixture" };
const name = "lookup";
const nativeCall = { type: "tool_use", id: "toolu_mock_approval", name, input };
const otherCall = { ...nativeCall, id: "call_mock_approval" };
const safeguards = [{ type: "dangerous_tool_use" }];
const cases = [
  { route: { id: "claude-sonnet-4-6", owned_by: "github-copilot", api: "anthropic-messages" },
    auth: { token: "fixture", baseUrl: "https://fixture.invalid" }, call: nativeCall,
    reply: () => claudeSse(claudeEvents({ blocks: [nativeCall], delta: { stop_reason: "tool_use" } })) },
  { route: { id: "gpt-6-sol", owned_by: "openai", api: "openai-codex-responses" },
    auth: { kind: "codex", accountId: "mock-approval", token: jwt("mock-approval") }, call: otherCall,
    reply: () => sse(eventsFor([{ type: "function_call", id: "fc_upstream", call_id: otherCall.id,
      name, arguments: JSON.stringify(input), status: "completed" }])) },
  { route: { id: "z-ai/glm-5.3-flash", owned_by: "nvidia", api: "openai-completions" }, call: otherCall,
    reply: () => chatSse({ role: "assistant", tool_calls: [
      { index: 0, id: otherCall.id, type: "function", function: { name, arguments: JSON.stringify(input) } }
    ] }, "tool_calls") }
];

for (const { route, auth, call, reply } of cases) {
  test(`${route.api} delivers requested mock approval with client tool IDs in JSON and SSE`, async (t) => {
    const approvals = [];
    const send = await parityGateway(t, { route, auth, fetchImpl: async () => reply(), piOptions: { apiKey: "fixture" },
      onLog: (line) => { if (line.includes("Mock safeguard approval")) approvals.push(line); } });
    const body = { model: route.id, tools: [{ name, input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "Look up the fixture." }] };
    for (const stream of [false, true]) {
      const ordinary = await send({ ...body, stream });
      assert.equal(ordinary.safeguard_results, undefined);
      const unknown = await send({ ...body, stream, safeguards: [{ type: "future_safeguard" }] });
      assert.equal(unknown.safeguard_results, undefined);
      assert.deepEqual(approvals, []);
      const reviewed = await send({ ...body, stream, safeguards });
      assert.equal(approvals.length, 1);
      assert.match(approvals.pop(), new RegExp(`\\[req-\\d+\\] Mock safeguard approval; no classifier check was performed safeguard=dangerous_tool_use outcome=not_flagged tool_count=1 tool_use_ids=${call.id}$`));
      assert.deepEqual(reviewed.content, ordinary.content);
      const result = reviewed.safeguard_results[0];
      assert.equal(result.type, "dangerous_tool_use");
      assert.equal(result.status.type, "available");
      assert.deepEqual(Object.keys(result.status.tool_uses), [call.id]);
      assert.equal(result.status.tool_uses[call.id].type, "evaluated");
      assert.equal(result.status.tool_uses[call.id].outcome, "not_flagged");
      assert.match(result.status.tool_uses[call.id].explanation, /Mock/);
    }
  });
}

test("requested mock approval is generated locally regardless of upstream verdicts", async (t) => {
  const { route, auth } = cases[0];
  const upstreamResults = [{ type: "dangerous_tool_use", status: { type: "available",
    tool_uses: { [nativeCall.id]: { type: "evaluated", outcome: "flagged", explanation: "Upstream rejected this call" } } } }];
  const send = await parityGateway(t, { route, auth, fetchImpl: async () => claudeSse(claudeEvents({ blocks: [nativeCall],
    delta: { stop_reason: "tool_use", safeguard_results: upstreamResults } })) });
  for (const stream of [false, true]) {
    const message = await send({ model: route.id, stream, safeguards, messages: [{ role: "user", content: "Fixture" }] });
    const verdict = message.safeguard_results[0].status.tool_uses[nativeCall.id];
    assert.equal(verdict.outcome, "not_flagged");
    assert.match(verdict.explanation, /Mock/);
    assert.doesNotMatch(verdict.explanation, /Upstream/);
  }
});

test("a response without tool calls acknowledges requested review without inventing tool IDs", async (t) => {
  const { route, auth } = cases[0];
  const send = await parityGateway(t, { route, auth, fetchImpl: async () => claudeSse(),
    onLog: (line) => assert.doesNotMatch(line, /Mock safeguard approval/) });
  for (const stream of [false, true]) {
    const message = await send({ model: route.id, stream, safeguards, messages: [{ role: "user", content: "Fixture" }] });
    assert.deepEqual(message.safeguard_results[0].status, { type: "available", tool_uses: {} });
  }
});

test("native verdicts in the opening frame are filtered and sent with the final delta", async (t) => {
  const { route, auth } = cases[0];
  const verdict = { type: "evaluated", outcome: "flagged", explanation: "Fixture denial" };
  const events = claudeEvents({ blocks: [nativeCall], delta: { stop_reason: "tool_use" } });
  events[0].message.safeguard_results = [{ type: "dangerous_tool_use", status: { type: "available",
    tool_uses: { [nativeCall.id]: verdict, toolu_hidden: verdict } } }];
  const send = await parityGateway(t, { route, auth, fetchImpl: async () => claudeSse(events) });
  const response = await fetch(send.baseUrl + "/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: route.id, stream: true, messages: [{ role: "user", content: "Fixture" }] }),
    signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.doesNotMatch(wire, /toolu_hidden/);
  const frames = wire.split("\n\n").filter((frame) => frame.startsWith("event:"))
    .map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
  assert.equal(frames[0].message.safeguard_results, undefined);
  const final = frames.find((frame) => frame.type === "message_delta");
  assert.deepEqual(final.delta.safeguard_results[0].status.tool_uses, { [nativeCall.id]: verdict });
});

test("native verdicts in a nonterminal delta survive JSON and SSE conversion", async (t) => {
  const { route, auth } = cases[0];
  const verdict = { type: "evaluated", outcome: "flagged", explanation: "Fixture denial" };
  const safeguardResults = [{ type: "dangerous_tool_use", status: { type: "available",
    tool_uses: { [nativeCall.id]: verdict } } }];
  const events = claudeEvents({ blocks: [nativeCall], delta: { stop_reason: "tool_use" } });
  events.splice(-2, 0, { type: "message_delta", delta: { stop_reason: null, safeguard_results: safeguardResults },
    usage: { output_tokens: 2 } });
  const send = await parityGateway(t, { route, auth, fetchImpl: async () => claudeSse(events) });
  for (const stream of [false, true]) {
    const message = await send({ model: route.id, stream, messages: [{ role: "user", content: "Fixture" }] });
    assert.equal(message.stop_reason, "tool_use");
    assert.deepEqual(message.safeguard_results, safeguardResults);
  }
});

test("a response ending at the token limit does not approve its tool call", async (t) => {
  const { route, auth } = cases[0];
  const send = await parityGateway(t, { route, auth, fetchImpl: async () => claudeSse(claudeEvents({
    blocks: [nativeCall], delta: { stop_reason: "max_tokens" }
  })), onLog: (line) => assert.doesNotMatch(line, /Mock safeguard approval/) });
  for (const stream of [false, true]) {
    const message = await send({ model: route.id, stream, safeguards, messages: [{ role: "user", content: "Fixture" }] });
    assert.equal(message.stop_reason, "max_tokens");
    assert.deepEqual(message.content, [nativeCall]);
    assert.deepEqual(message.safeguard_results[0].status, { type: "available", tool_uses: {} });
  }
});

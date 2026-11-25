"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createModelDiscovery } = require("../lib/model-discovery");
const { toGatewayModels } = require("../lib/model-routing");
const { requestPiModel } = require("../lib/pi-model");
const { getModelCapabilities } = require("../lib/pi-capabilities");
const { getGatewayModel } = require("../lib/pi-registry");
const { parityGateway } = require("./helpers/parity-gateway");

const base = "https://integrate.api.nvidia.com/v1";
const key = "fixture-nvidia-key";
const glm = "z-ai/glm-5.3-flash";
const nemotron = "nvidia/nemotron-3.5-super-vl-120b-a12b";
const gpt = "gpt-test";
const rows = [
  { id: glm, owned_by: "z-ai" }, { id: nemotron }, { id: "nvidia/nemotron-3.5-bolt-e4b" },
  { id: "other/new", model_type: "vlm", context_window: 456789, supports_tools: false },
  { id: "other/chat", supported_endpoints: ["/v1/chat/completions"] },
  { id: "nvidia/embed-qa-4" }, { id: "other/image", model_type: "image" },
  { id: "other/responses-only", model_type: "llm", supported_endpoints: ["/v1/responses"] }, { id: "other/unknown" }
];

function fixture(extra = {}) {
  return {
    loadAuth: async () => ({ kind: "api", token: "fixture-openai-key" }),
    loadClaudeAuth: async () => { throw new Error("no Copilot fixture"); },
    env: { NVIDIA_API_KEY: key },
    store: { readAuth: () => ({}) },
    ...extra
  };
}

test("NVIDIA discovery adds live chat models, without affecting GPT-only discovery", async () => {
  let calls = 0;
  const options = fixture({ fetchImpl: async (url, { headers }) => {
    if (url === `${base}/models`) {
      calls++;
      assert.equal(headers.Authorization, `Bearer ${key}`);
      return Response.json({ data: rows });
    }
    assert.equal(headers.Authorization, "Bearer fixture-openai-key");
    return Response.json({ data: [{ id: gpt, context_window: 800000 }] });
  } });
  const discover = createModelDiscovery(options);
  const catalog = await discover({ waitForRefresh: true });
  assert.deepEqual(catalog.data.map((row) => row.id), [gpt, glm, nemotron, "nvidia/nemotron-3.5-bolt-e4b", "other/new", "other/chat"]);
  const advertised = toGatewayModels(catalog).data.find((row) => row.id === `anthropic/${glm}`);
  assert.equal(advertised.description, "NVIDIA Build");
  assert.ok(advertised.context_window > 0);
  assert.deepEqual(getModelCapabilities(advertised.id), { count: "estimate", search: null });
  assert.deepEqual(getGatewayModel("other/new").input, ["text", "image"]);
  assert.equal(getGatewayModel("other/new").supports_tools, false);
  const gptOnly = createModelDiscovery({ ...options, gptOnly: true });
  assert.deepEqual((await gptOnly({ waitForRefresh: true })).data.map((row) => row.id), [gpt]);
  assert.equal(getGatewayModel(advertised.id).api, "openai-completions");
  const noKey = createModelDiscovery({ ...options, env: {} });
  assert.deepEqual((await noKey({ waitForRefresh: true })).data.map((row) => row.id), [gpt]);
  assert.equal(calls, 1);
});

test("NVIDIA discovery uses the latest key and inference cycles through saved keys", async () => {
  const auth = {};
  const store = { readAuth: () => auth };
  let activeKey = key;
  let catalogCalls = 0;
  const discover = createModelDiscovery(fixture({ env: {}, store, fetchImpl: async (url, { headers }) => {
    if (url === `${base}/models`) {
      catalogCalls++;
      assert.equal(headers.Authorization, `Bearer ${activeKey}`);
      return Response.json({ data: [{ id: glm }] });
    }
    return Response.json({ data: [{ id: gpt }] });
  } }));
  const read = () => discover({ waitForRefresh: true });
  assert.deepEqual((await read()).data.map(({ id }) => id), [gpt]);
  const check = async (newest, expectedKeys) => {
    activeKey = newest;
    discover.invalidate("nvidia");
    const route = (await read()).data.find(({ id }) => id === glm);
    assert.ok(route);
    for (const expected of expectedKeys) {
      const body = { model: glm, messages: [{ role: "user", content: "hi" }] };
      const result = await requestPiModel(body, { route, store, env: {}, fetchImpl: async (_url, { headers }) => {
        assert.equal(new Headers(headers).get("authorization"), `Bearer ${expected}`);
        return chatSse({ role: "assistant", content: "saved key works" }, "stop");
      } });
      assert.equal(result.content[0].text, "saved key works");
    }
  };
  const second = "second-fixture-key";
  const third = "third-fixture-key";
  auth.nvidia = { keys: [{ id: "first", key }, { id: "second", key: second }] };
  await check(second, [key, second, key]);
  auth.nvidia.keys.push({ id: "third", key: third });
  await check(third, [key, second, third]);
  auth.nvidia.keys.splice(1);
  await check(key, [key, key]);
  delete auth.nvidia;
  discover.invalidate("nvidia");
  assert.equal(getGatewayModel(glm), undefined);
  assert.deepEqual((await read()).data.map(({ id }) => id), [gpt]);
  assert.equal(catalogCalls, 3);
});

test("NVIDIA publishes its new catalog before slow GPT discovery finishes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let nvidiaId = glm;
  let gptId = gpt;
  let releaseGpt;
  const gptRefresh = new Promise((resolve) => { releaseGpt = resolve; });
  const discover = createModelDiscovery(fixture({ fetchImpl: async (url) => {
    if (url === `${base}/models`) return Response.json({ data: [{ id: nvidiaId }] });
    if (gptId !== gpt) await gptRefresh;
    return Response.json({ data: [{ id: gptId }] });
  } }));
  const ids = (catalog) => toGatewayModels(catalog).data.map(({ id }) => id);
  const readFull = () => discover({ waitForRefresh: true });
  assert.deepEqual(ids(await readFull()), [`anthropic/openai/${gpt}`, `anthropic/${glm}`]);
  const discoverGpt = createModelDiscovery(fixture({ gptOnly: true,
    fetchImpl: async () => Response.json({ data: [{ id: "gpt-scoped" }] }) }));
  await discoverGpt({ waitForRefresh: true });

  nvidiaId = nemotron;
  gptId = "gpt-refreshed";
  discover.invalidate("nvidia");
  const ordinary = discover();
  const full = readFull();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(2200);
  assert.deepEqual(ids(await ordinary), [`anthropic/openai/${gpt}`, `anthropic/${nemotron}`]);
  assert.equal(getGatewayModel(glm), undefined);
  assert.equal(getGatewayModel(nemotron)?.owned_by, "nvidia");
  assert.equal(getGatewayModel("gpt-scoped")?.owned_by, "openai", "NVIDIA-only publication must leave the GPT registry alone");

  releaseGpt();
  assert.deepEqual(ids(await full), [`anthropic/openai/${gptId}`, `anthropic/${nemotron}`]);
});

test("an older NVIDIA refresh cannot publish after a credential change", async () => {
  let releaseOld;
  const blocked = new Promise((resolve) => { releaseOld = resolve; });
  let nvidiaCalls = 0;
  const discover = createModelDiscovery(fixture({ fetchImpl: async (url) => {
    if (url !== `${base}/models`) return Response.json({ data: [{ id: gpt }] });
    if (++nvidiaCalls === 1) {
      await blocked;
      return Response.json({ data: [{ id: glm }] });
    }
    return Response.json({ data: [{ id: nemotron }] });
  } }));
  const readFull = () => discover({ waitForRefresh: true });
  const old = readFull();
  assert.equal(nvidiaCalls, 1);
  discover.invalidate("nvidia");
  const latest = await readFull();
  assert.deepEqual(latest.data.map(({ id }) => id), [gpt, nemotron]);
  releaseOld();
  assert.strictEqual(await old, latest, "waiters must also receive the new key's catalog");
  assert.equal(getGatewayModel(glm), undefined);
  assert.equal(getGatewayModel(nemotron)?.owned_by, "nvidia");
  assert.strictEqual(await readFull(), latest);
});

function chatSse(delta, finish) {
  const chunk = (choices, usage) => ({ id: "chat_nvidia", object: "chat.completion.chunk", choices, ...(usage && { usage }) });
  const events = [chunk([{ index: 0, delta, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: finish }]), chunk([], { prompt_tokens: 100, completion_tokens: 10 })];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } });
}

for (const id of [glm, nemotron]) {
  test(`${id} streams a tool call and accepts its result via the gateway`, async (t) => {
    const previousKey = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = key;
    t.after(() => {
      if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = previousKey;
    });
    const route = { id, owned_by: "nvidia", api: "openai-completions" };
    const tools = [{ name: "lookup", description: "Lookup synthetic fixture", input_schema: {
      type: "object", properties: { id: { type: "string" }, note: { type: "string" } }, required: ["id"]
    } }];
    const seen = [];
    const send = await parityGateway(t, { route, fetchImpl: async (url, options) => {
      assert.equal(url, `${base}/chat/completions`);
      assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${key}`);
      const payload = JSON.parse(options.body);
      seen.push(payload);
      assert.equal(payload.model, id);
      assert.equal(payload.stream, true);
      assert.equal(payload.tools[0].function.name, tools[0].name);
      assert.deepEqual(payload.tools[0].function.parameters.required, ["id"]);
      return seen.length === 1
        ? chatSse({ role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: '{"id":"fixture"}' } }] }, "tool_calls")
        : chatSse({ role: "assistant", content: "fixture confirmed" }, "stop");
    } });
    const messages = [{ role: "user", content: "Find the fixture" }];
    const body = { model: `anthropic/${id}`, system: "Use only the fixture.", messages, tools };
    const first = await send({ ...body, stream: true });
    assert.equal(first.model, body.model);
    assert.equal(first.stop_reason, "tool_use");
    assert.deepEqual(first.content, [{ type: "tool_use", id: "call_fixture", name: "lookup", input: { id: "fixture" } }]);
    const second = await send({ ...body, messages: [...messages, { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: "fixture confirmed" }] }] });
    assert.equal(second.model, body.model);
    assert.equal(second.stop_reason, "end_turn");
    assert.deepEqual(second.content, [{ type: "text", text: "fixture confirmed" }]);
    const [assistant, result] = seen[1].messages.slice(-2);
    assert.equal(assistant.tool_calls[0].id, result.tool_call_id);
    assert.deepEqual(result, { role: "tool", tool_call_id: "call_fixture", content: "fixture confirmed" });
  });
}

test("NVIDIA preserves namespaced model IDs and sends an explicit tool_choice of none", async () => {
  const id = "openai/gpt-oss-120b";
  const route = { id, owned_by: "nvidia", api: "openai-completions" };
  await requestPiModel({ model: id, messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "lookup", input_schema: { type: "object" } }], tool_choice: { type: "none" } }, {
    route, apiKey: key, fetchImpl: async (_, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, id);
      assert.equal(payload.tools[0].function.name, "lookup");
      assert.equal(payload.tool_choice, "none");
      return chatSse({ role: "assistant", content: "text only" }, "stop");
    }
  });
});

test("NVIDIA models without tools get the useful tool history as plain text", async () => {
  const route = { id: glm, owned_by: "nvidia", api: "openai-completions", supports_tools: false };
  const tools = [{ name: "lookup", input_schema: { type: "object" } }];
  const messages = [{ role: "user", content: "before" }, { role: "assistant", content: [
    { type: "text", text: "Checking the fixture." },
    { type: "tool_use", id: "call_fixture", name: "lookup", input: { id: "fixture" } }
  ] }, { role: "user", content: [
    { type: "tool_result", tool_use_id: "call_fixture", content: "fixture confirmed" },
    { type: "text", text: "Continue normally." }
  ] }];
  await requestPiModel({ model: glm, tools, messages, tool_choice: { type: "none" } }, {
    route, apiKey: key, fetchImpl: async (_, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.tools, undefined);
      assert.equal(payload.tool_choice, undefined);
      assert.ok(payload.messages.every((message) => message.role !== "tool" && !message.tool_calls));
      const history = JSON.stringify(payload.messages);
      for (const part of ["Checking the fixture.", "Tool call: lookup", "Tool result: lookup", "fixture confirmed", "Continue normally."]) {
        assert.ok(history.includes(part), part);
      }
      return chatSse({ role: "assistant", content: "text only" }, "stop");
    }
  });
});

test("NVIDIA pacing shares a send schedule and honors RPM and burst settings", async (t) => {
  const { createNvidiaPacer } = require("../lib/nvidia-pacing");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pace = createNvidiaPacer({ env: {}, now: () => Date.now() });
  await pace();
  const sent = [];
  const second = pace().then(() => sent.push(Date.now()));
  const third = pace().then(() => sent.push(Date.now()));
  t.mock.timers.tick(600);
  await second;
  assert.deepEqual(sent, [600]);
  t.mock.timers.tick(600);
  await third;
  assert.deepEqual(sent, [600, 1200]);
  const burst = createNvidiaPacer({ env: { NVIDIA_GLOBAL_RPM: "40", NVIDIA_GLOBAL_BURST: "2" }, now: () => Date.now() });
  await Promise.all([burst(), burst()]);
  let thirdSent = false;
  const next = burst().then(() => { thirdSent = true; });
  t.mock.timers.tick(1499);
  await Promise.resolve();
  assert.equal(thirdSent, false);
  t.mock.timers.tick(1);
  await next;
  const disabled = createNvidiaPacer({ env: { NVIDIA_GLOBAL_RPM: "0" } });
  await Promise.all([disabled(), disabled()]);
});

test("NVIDIA pacing releases canceled waiters without charging their send slots", async (t) => {
  const { createNvidiaPacer } = require("../lib/nvidia-pacing");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pace = createNvidiaPacer({ env: {}, now: () => Date.now() });
  await pace();
  const controllers = Array.from({ length: 100 }, () => new AbortController());
  const canceled = controllers.map(({ signal }) => assert.rejects(pace(signal), { name: "AbortError" }));
  const live = pace();
  controllers.forEach((controller) => controller.abort());
  await Promise.all(canceled);
  t.mock.timers.tick(600);
  await live;
});

test("NVIDIA pacing does not release a backlog together after a delayed timer", async (t) => {
  const { createNvidiaPacer } = require("../lib/nvidia-pacing");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 10000;
  const pace = createNvidiaPacer({ env: {}, now: () => now });
  await pace();
  const sent = [];
  const second = pace().then(() => sent.push(now));
  const third = pace().then(() => sent.push(now));
  now += 2000;
  t.mock.timers.tick(1200);
  await second;
  assert.deepEqual(sent, [12000]);
  now += 600;
  t.mock.timers.tick(600);
  await third;
  assert.deepEqual(sent, [12000, 12600]);
});

test("NVIDIA 429 fails only its own request without retrying or changing the next request's turn", async () => {
  const route = { id: glm, owned_by: "nvidia", api: "openai-completions" };
  const body = { model: glm, messages: [{ role: "user", content: "hi" }] };
  const store = { readAuth: () => ({ nvidia: { keys: [
    { id: "first", key: "no-retry-first" }, { id: "second", key: "no-retry-second" }, { id: "third", key: "no-retry-third" }
  ] } }) };
  const attempted = [];
  let entered, release;
  const enteredOther = new Promise((resolve) => { entered = resolve; });
  const releaseOther = new Promise((resolve) => { release = resolve; });
  let otherSignal;
  const send = (fetchImpl) => requestPiModel(body, { route, store, env: {}, fetchImpl: async (_url, options) => {
    attempted.push([new Headers(options.headers).get("authorization"), JSON.parse(options.body).model]);
    return fetchImpl(options);
  } });
  const other = send(async ({ signal }) => {
    otherSignal = signal;
    entered();
    await releaseOther;
    return chatSse({ role: "assistant", content: "other request works" }, "stop");
  });
  await enteredOther;
  try {
    await assert.rejects(send(() => Response.json({ status: 429, title: "Too Many Requests" }, { status: 429 })),
      { status: 429 });
    assert.equal(otherSignal.aborted, false);
    assert.equal(attempted.length, 2);
  } finally { release(); }
  assert.equal((await other).content[0].text, "other request works");
  assert.equal((await send(() => chatSse({ role: "assistant", content: "next request works" }, "stop"))).content[0].text, "next request works");
  assert.deepEqual(attempted, ["first", "second", "third"].map((slot) => [`Bearer no-retry-${slot}`, glm]));
  assert.equal((await send(() => chatSse({ role: "assistant", content: "first key works again" }, "stop"))).content[0].text,
    "first key works again");
  assert.deepEqual(attempted.at(-1), ["Bearer no-retry-first", glm]);
  await send(() => chatSse({ role: "assistant", content: "limited key works again" }, "stop"));
  assert.deepEqual(attempted.at(-1), ["Bearer no-retry-second", glm]);
});

test("an NVIDIA stream that already sent text is never replayed on another key", async () => {
  const route = { id: glm, owned_by: "nvidia", api: "openai-completions" };
  const store = { readAuth: () => ({ nvidia: { keys: [
    { id: "backup", key: "stream-fallback-backup" }, { id: "primary", key: "stream-fallback-primary" }
  ] } }) };
  const deltas = [];
  let attempts = 0;
  await assert.rejects(requestPiModel({ model: glm, messages: [{ role: "user", content: "hi" }] }, {
    route, store, env: {}, onEvent: (event) => { if (event.type === "text_delta") deltas.push(event.delta); },
    fetchImpl: async () => {
      attempts++;
      const chunk = { id: "partial_nvidia", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
  }), /finish_reason/);
  assert.deepEqual(deltas, ["partial"]);
  assert.equal(attempts, 1);
});

test("NVIDIA forwards Pi's HTTP error details and maps a context-limit code for Claude Code", async () => {
  const route = { id: glm, owned_by: "nvidia", api: "openai-completions" };
  const body = { model: glm, messages: [{ role: "user", content: "hi" }] };
  for (const [status, detail, expected] of [
    [403, { message: "fixture access denied" }, { status: 403, message: "fixture access denied" }],
    [400, { code: "context_length_exceeded", message: "fixture is too large" },
      { status: 400, code: "context_length_exceeded", message: /^prompt is too long: fixture is too large/ }]
  ]) {
    await assert.rejects(requestPiModel(body, { route, apiKey: key, fetchImpl: async () => Response.json(detail, { status }) }), expected);
  }
});

test("NVIDIA requests require their own credential and preserve rate-limit status", async () => {
  const route = { id: glm, owned_by: "nvidia", api: "openai-completions" };
  const body = { model: glm, messages: [{ role: "user", content: "hi" }] };
  await assert.rejects(requestPiModel(body, { route, apiKey: "", fetchImpl: () => assert.fail("must not connect") }), { status: 401 });
  await assert.rejects(requestPiModel(body, { route, apiKey: key,
    fetchImpl: async () => Response.json({ error: { message: "fixture rate limit" } }, { status: 429 }) }),
  { status: 429, message: "fixture rate limit" });
});

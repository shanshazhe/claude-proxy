const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("stream");
const { isClaudeModel, forwardClaudeRequest, getCopilotHeaders, discoverCopilotModels, listCopilotResponsesModels, loadCopilotResponsesAuth } = require("../lib/github-copilot");
const { prepareClaudeCache } = require("../lib/anthropic-cache");
const { createProjectMemoryGateway, TOOL_NAME } = require("../lib/project-memory-gateway");

const auth = { token: "copilot-test-token", baseUrl: "https://api.business.githubcopilot.com" };
const loadAuth = async () => auth;
function clientResponse() {
  const response = new PassThrough();
  response.writeHead = (status, headers) => { response.statusCode = status; response.headers = headers; };
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.text = () => Buffer.concat(chunks).toString("utf8");
  return response;
}

test("Claude routing recognizes model IDs, not removed gateway paths", () => {
  for (const model of ["claude-sonnet-5.5", "claude-sonnet-5.5[1m]"]) assert.equal(isClaudeModel(model), true);
  for (const model of ["gpt-test", "anthropic/claude-sonnet-5.5", "claude-gateway/gpt-test", "claude-gateway/claude-sonnet-5.5"])
    assert.equal(isClaudeModel(model), false);
});

test("Copilot forwards native Anthropic SSE, tools, signatures and cache usage", async () => {
  const body = {
    model: "claude-sonnet-5.5", stream: true, max_tokens: 100,
    system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive" }, tools: [{ name: "read", input_schema: { type: "object" } }],
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "summary", signature: "test-signature" }] }]
  };
  const raw = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"test-signature"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"cache_read_input_tokens":1024}}\n\n';
  const response = clientResponse();
  await forwardClaudeRequest(body, { url: "/v1/messages?beta=true", headers: { "anthropic-beta": "test-beta", authorization: "Bearer local-placeholder", "x-api-key": "local-placeholder", cookie: "private" } }, response, {
    loadAuth, fetchImpl: async (url, options) => {
      assert.equal(url, auth.baseUrl + "/v1/messages?beta=true");
      assert.deepEqual(JSON.parse(options.body), prepareClaudeCache({ ...body, thinking: { type: "adaptive", display: "summarized" } }));
      assert.equal(options.headers.Authorization, "Bearer copilot-test-token");
      assert.equal(options.headers["anthropic-beta"], "test-beta");
      assert.equal(options.headers["X-Initiator"], "agent");
      assert.equal(options.headers["Copilot-Integration-Id"], "vscode-chat");
      assert.equal(options.headers["x-api-key"], undefined);
      assert.equal(options.headers.cookie, undefined);
      assert.equal(options.redirect, "error");
      return new Response(raw, { headers: { "content-type": "text/event-stream", "retry-after": "2" } });
    }
  });
  assert.equal(response.text(), raw);
  assert.equal(response.headers["X-Accel-Buffering"], "no");
  assert.equal(response.headers["retry-after"], "2");
});

test("Copilot consumes gateway memory calls in both response formats without local dispatch", async () => {
  for (const stream of [false, true]) {
    const call = { type: "tool_use", id: "memory_1", name: TOOL_NAME, input: { root: "/repo", changed_paths: [] } };
    const message = { type: "message", content: [{ type: "text", text: "Done." }, call], stop_reason: "tool_use" };
    const events = [
      { type: "content_block_start", index: 0, content_block: call },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" }
    ];
    let queued = 0;
    const responseHandler = createProjectMemoryGateway().createResponseHandler({ enqueue: () => { queued++; return true; } });
    const response = clientResponse();
    await forwardClaudeRequest({ model: "claude-sonnet-5.5", stream, messages: [] }, { url: "/v1/messages", headers: {} }, response, {
      loadAuth, responseHandler, fetchImpl: async () => new Response(stream
        ? events.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join("") : JSON.stringify(message),
      { headers: { "content-type": stream ? "text/event-stream" : "application/json" } })
    });
    assert.equal(queued, 1);
    assert.ok(!response.text().includes(TOOL_NAME));
    assert.ok(response.text().includes("Queued."));
    if (!stream) assert.equal(JSON.parse(response.text()).stop_reason, "end_turn");
  }
});

test("Copilot preserves HTTP/JSON errors and forwards token-count endpoint", async () => {
  const response = clientResponse();
  const raw = '{"type":"error","error":{"type":"invalid_request_error","message":"test"}}';
  await forwardClaudeRequest({ model: "claude-opus-5.5" }, { url: "/v1/messages/count_tokens", headers: {} }, response, {
    loadAuth, fetchImpl: async (url) => {
      assert.equal(url, auth.baseUrl + "/v1/messages/count_tokens");
      return new Response(raw, { status: 400, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.text(), raw);
});

test("Copilot infers initiator and vision from Anthropic tool results", () => {
  assert.equal(getCopilotHeaders(auth, {}, { messages: [{ role: "user", content: "hello" }] })["X-Initiator"], "user");
  const headers = getCopilotHeaders(auth, {}, { messages: [{ role: "user", content: [{ type: "tool_result", content: [{ type: "image", source: {} }] }] }] });
  assert.equal(headers["X-Initiator"], "agent");
  assert.equal(headers["Copilot-Vision-Request"], "true");
});

test("Copilot catalog respects picker, policy, tools and Anthropic endpoints", async () => {
  const data = [
    { id: "claude-ok", model_picker_enabled: true, supported_endpoints: ["/v1/messages"] },
    { id: "claude-disabled", model_picker_enabled: true, policy: { state: "disabled" } },
    { id: "claude-hidden", model_picker_enabled: false, policy: { state: "enabled" } },
    { id: "claude-no-tools", model_picker_enabled: true, capabilities: { supports: { tool_calls: false } } },
    { id: "claude-completions", model_picker_enabled: true, supported_endpoints: ["/chat/completions"] },
    { id: "gpt-6", model_picker_enabled: true }
  ];
  const fetchImpl = async () => new Response(JSON.stringify({ data }));
  const models = await discoverCopilotModels({ loadAuth, fetchImpl });
  assert.deepEqual(models.map((m) => m.id), ["claude-ok"]);
  assert.equal(models[0].owned_by, "github-copilot");
  const fallbackFetch = async () => new Response(JSON.stringify({ data: [data[2]] }));
  assert.deepEqual(await discoverCopilotModels({ loadAuth, fetchImpl: fallbackFetch }), []);
  assert.equal((await discoverCopilotModels({ loadAuth: async () => ({ ...auth, baseUrl: "https://api.individual.githubcopilot.com" }), fetchImpl: fallbackFetch }))[0].id, "claude-hidden");
});

test("known adaptive-only models normalize legacy thinking without mutating client body", async () => {
  await discoverCopilotModels({ loadAuth, fetchImpl: async () => new Response(JSON.stringify({ data: [{
    id: "claude-adaptive-test", model_picker_enabled: true, capabilities: { supports: { adaptive_thinking: true } }
  }] })) });
  const body = { model: "claude-adaptive-test", thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: "high" }, messages: [] };
  await forwardClaudeRequest(body, { url: "/v1/messages", headers: {} }, clientResponse(), {
    loadAuth, fetchImpl: async (_, options) => {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
      assert.equal(payload.output_config.effort, "high");
      return new Response("{}");
    }
  });
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 1024 });
});

test("Copilot keeps explicit thinking display and leaves other thinking modes untouched", async () => {
  for (const thinking of [{ type: "adaptive", display: "omitted" }, { type: "enabled", budget_tokens: 1024 }, { type: "disabled" }]) {
    await forwardClaudeRequest({ model: "claude-legacy-test", thinking, messages: [] }, { url: "/v1/messages", headers: {} }, clientResponse(), {
      loadAuth, fetchImpl: async (_, options) => {
        assert.deepEqual(JSON.parse(options.body).thinking, thinking);
        return new Response("{}");
      }
    });
  }
});

test("Copilot retries rejected disabled thinking with the model's off switch and remembers it", async () => {
  const cases = [
    ["claude-between-test", 'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.', { type: "between_tools" }],
    ["claude-no-off-test", '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.', undefined]
  ];
  for (const [model, message, expected] of cases) {
    const body = { model, stream: true, thinking: { type: "disabled" }, messages: [] };
    const sent = [];
    const fetchImpl = async (_, options) => {
      sent.push(JSON.parse(options.body).thinking);
      return sent.at(-1)?.type === "disabled"
        ? new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 400 })
        : new Response("{}");
    };
    const response = clientResponse();
    await forwardClaudeRequest(body, { url: "/v1/messages", headers: {} }, response, { loadAuth, fetchImpl });
    await forwardClaudeRequest(body, { url: "/v1/messages", headers: {} }, clientResponse(), { loadAuth, fetchImpl });
    assert.deepEqual(sent, [{ type: "disabled" }, expected, expected]);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.thinking, { type: "disabled" });
  }
  const response = clientResponse();
  let calls = 0;
  await forwardClaudeRequest({ model: "claude-other-error-test", thinking: { type: "disabled" }, messages: [] }, { url: "/v1/messages", headers: {} }, response, {
    loadAuth, fetchImpl: async () => { calls++; return new Response('{"type":"error","error":{"message":"prompt is too long"}}', { status: 400 }); }
  });
  assert.equal(calls, 1);
  assert.equal(response.statusCode, 400);
});

test("Copilot client disconnect aborts upstream without buffering the SSE response", async () => {
  const response = clientResponse();
  let signal;
  const operation = forwardClaudeRequest({ model: "claude-sonnet-5.5", stream: true }, { url: "/v1/messages", headers: {} }, response, {
    loadAuth, fetchImpl: async (_, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    }
  });
  await new Promise((resolve) => response.once("data", resolve));
  response.destroy();
  await assert.rejects(operation);
  assert.equal(signal.aborted, true);
  assert.ok(response.text().includes("event: ping"));
});

test("Copilot remembers /responses models for web search and builds Responses auth without Anthropic headers", async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches++;
    return new Response(JSON.stringify({ data: [
      { id: "claude-ok", model_picker_enabled: true, supported_endpoints: ["/v1/messages"] },
      { id: "gpt-6-luna", model_picker_enabled: true, supported_endpoints: ["/responses", "ws:/responses"] },
      { id: "gpt-6-off", model_picker_enabled: true, policy: { state: "disabled" }, supported_endpoints: ["/responses"] }
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

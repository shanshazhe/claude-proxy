const test = require("node:test");
const assert = require("node:assert/strict");
const { isResponsesModel, getPromptCacheKey, getResponsesReasoning, toResponsesBody, fromResponses, readEvents, requestResponses } = require("../lib/openai-responses");

const finalResponse = {
  id: "resp_test", status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "你好" }] }],
  usage: { input_tokens: 10, output_tokens: 2 }
};

test("prompt cache key remains stable as conversation grows and separates sessions", () => {
  const first = { metadata: { user_id: "session-a" }, messages: [{ role: "user", content: "hello" }] };
  const key = getPromptCacheKey(first);
  assert.equal(key, getPromptCacheKey({ ...first, messages: [...first.messages, { role: "assistant", content: "reply" }] }));
  assert.notEqual(key, getPromptCacheKey({ ...first, metadata: { user_id: "session-b" } }));
  assert.ok(!key.includes("session-a"));
  assert.equal(toResponsesBody({ model: "gpt-5", messages: [], prompt_cache_key: key }).prompt_cache_key, key);
  const previous = process.env.OPENAI_PROMPT_CACHE;
  process.env.OPENAI_PROMPT_CACHE = "0";
  try { assert.equal(getPromptCacheKey(first), undefined); }
  finally {
    if (previous === undefined) delete process.env.OPENAI_PROMPT_CACHE;
    else process.env.OPENAI_PROMPT_CACHE = previous;
  }
});

test("moving native cache annotations do not change a GPT fallback cache identity", () => {
  const first = { system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }] };
  const next = { system: [{ type: "text", text: "instructions" }], tools: [{ name: "read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "tool_result", content: "result" }] }] };
  assert.equal(getPromptCacheKey(first), getPromptCacheKey(next));
});

test("Responses requests reasoning summaries and respects disabled/non-reasoning models", () => {
  const reasoning = getResponsesReasoning({ model: "gpt-6.1-sol", thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  assert.deepEqual(reasoning, { summary: "auto", effort: "low" });
  assert.deepEqual(toResponsesBody({ model: "gpt-6.1-sol", messages: [], reasoning }).reasoning, reasoning);
  assert.deepEqual(getResponsesReasoning({ model: "gpt-6.1-sol" }), { summary: "auto" });
  assert.equal(getResponsesReasoning({ model: "gpt-6.1-sol", thinking: { type: "disabled" } }), undefined);
  assert.equal(getResponsesReasoning({ model: "gpt-4.1", thinking: { type: "adaptive" } }), undefined);
  const assembled = fromResponses({ ...finalResponse, output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "Public summary" }] }, ...finalResponse.output
  ] }, "gpt-6.1-sol");
  assert.equal(assembled.reasoning_content, "Public summary");
});

test("GPT-6.1 Sol preserves all five reasoning effort levels without changing legacy models", () => {
  for (const model of ["gpt-6.1-sol", "openai/gpt-6.1-sol"]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const reasoning = getResponsesReasoning({ model, thinking: { type: "adaptive" }, output_config: { effort } });
      assert.deepEqual(reasoning, { summary: "auto", effort }, `${model}: ${effort}`);
      for (const kind of ["api", "codex", "copilot"]) {
        assert.deepEqual(toResponsesBody({ model, messages: [], reasoning }, { kind }).reasoning, reasoning);
      }
    }
    assert.deepEqual(getResponsesReasoning({ model, thinking: { type: "adaptive" } }), { summary: "auto", effort: "medium" });
    assert.equal(getResponsesReasoning({ model, thinking: { type: "disabled" }, output_config: { effort: "max" } }), undefined);
  }
  for (const model of ["gpt-5", "openai/gpt-5", "gpt-6.1-sol-other"]) {
    for (const effort of ["xhigh", "max"]) {
      assert.deepEqual(getResponsesReasoning({ model, output_config: { effort } }), { summary: "auto", effort: "high" });
    }
  }
});

test("GPT-6.1 Sol sends xhigh and max unchanged in Responses requests", async () => {
  for (const effort of ["xhigh", "max"]) {
    const model = "gpt-6.1-sol";
    const reasoning = getResponsesReasoning({ model, output_config: { effort } });
    let requests = 0;
    await requestResponses({ model, messages: [], stream: false, reasoning }, {
      remember: false,
      loadAuth: async () => ({ kind: "api", token: "test-only" }),
      fetchImpl: async (url, options) => {
        requests++;
        assert.ok(url.endsWith("/responses"));
        assert.deepEqual(JSON.parse(options.body).reasoning, { summary: "auto", effort });
        return { ok: true, json: async () => finalResponse };
      }
    });
    assert.equal(requests, 1);
  }
});

test("GPT routes to Responses; NVIDIA GPT OSS does not", () => {
  for (const model of ["gpt-5", "gpt-4.1", "openai/gpt-5", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]) assert.equal(isResponsesModel(model), true);
  for (const model of ["openai/gpt-oss-120b", "gpt-oss-20b", "z-ai/glm-5.2", undefined]) assert.equal(isResponsesModel(model), false);
});

test("Codex keeps later system reminders in place so instructions stay cacheable", () => {
  const turn = (reminder) => toResponsesBody({ model: "gpt-6.1-sol", messages: [
    { role: "system", content: "instructions" },
    { role: "user", content: "hi" },
    { role: "system", content: "reminder 1" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "next" },
    { role: "system", content: reminder }
  ] }, { kind: "codex" });
  const first = turn("reminder 2");
  const second = turn("reminder 3");
  assert.equal(first.instructions, "instructions");
  assert.equal(second.instructions, first.instructions);
  assert.deepEqual(first.input.map((item) => item.role), ["user", "developer", "assistant", "user", "developer"]);
  assert.deepEqual(second.input.slice(0, -1), first.input.slice(0, -1));
});

test("convert messages, images, tools and tool results to Responses", () => {
  const body = toResponsesBody({
    model: "openai/gpt-5", max_tokens: 1, temperature: 0.5, stream: true,
    messages: [
      { role: "system", content: "instructions" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
      { role: "assistant", content: "checking", tool_calls: [{ id: "call_a", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_a", content: "result" }
    ],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
  });
  assert.equal(body.model, "gpt-5");
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 16);
  assert.equal(body.temperature, undefined);
  assert.equal(body.input[0].role, "developer");
  assert.equal(body.input[1].content[1].type, "input_image");
  assert.equal(body.input[2].content[0].type, "output_text");
  assert.equal(body.input[3].type, "function_call");
  assert.equal(body.input[4].call_id, "call_a");
  assert.equal(body.tools[0].strict, false);
  assert.equal(body.tools[0].function, undefined);
});

test("response conversion preserves usage, refusal, calls and truncation", () => {
  assert.equal(fromResponses(finalResponse, "gpt-5").usage.prompt_tokens, 10);
  const result = fromResponses({ ...finalResponse, output: [
    { type: "message", content: [{ type: "refusal", refusal: "No" }] },
    { type: "function_call", call_id: "call_a", name: "read", arguments: "{}" }
  ] }, "gpt-5");
  assert.equal(result.content, "No");
  assert.equal(result.finish_reason, "tool_calls");
  assert.equal(result.tool_calls[0].id, "call_a");
  assert.equal(fromResponses({ ...finalResponse, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "gpt-5").finish_reason, "length");
  assert.throws(() => fromResponses({ status: "failed", error: { message: "failed" } }, "gpt-5"), /failed/);
  assert.throws(() => fromResponses({ status: "incomplete", incomplete_details: { reason: "content_filter" } }, "gpt-5"), /content_filter/);
});

async function* packets(text) {
  const bytes = Buffer.from(text);
  for (const byte of bytes) yield Buffer.from([byte]);
}
const frames = (events) => events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");

test("SSE parser handles fragmented UTF-8 and CRLF", async () => {
  const event = { type: "response.output_text.delta", delta: "你好🙂" };
  const actual = [];
  for await (const value of readEvents(packets(frames([event])))) actual.push(value);
  assert.deepEqual(actual, [event]);
});

test("reasoning summary parts stream as separate paragraphs, matching the assembled view", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  try {
    const summary = (item_id, summary_index, delta) => ({ type: "response.reasoning_summary_text.delta", item_id, summary_index, delta });
    const call = { type: "function_call", call_id: "call_a", name: "read", arguments: "{}" };
    const events = [
      summary("rs_a", 0, "**Calc"), summary("rs_a", 0, "ulating**"), summary("rs_a", 1, "**Checking**"),
      summary("rs_b", 0, "**Second item**"),
      { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
      { type: "response.output_item.done", output_index: 2, item: call },
      summary("rs_c", 0, "**After tool**"),
      { type: "response.completed", response: { ...finalResponse, output: [call] } }
    ];
    const reasoning = [];
    await requestResponses({ model: "gpt-6-luna", messages: [], stream: true }, {
      onChunk: async (chunk) => {
        const text = chunk.choices[0].delta.reasoning_content;
        if (text !== undefined) reasoning.push(text);
      },
      fetchImpl: async () => ({ ok: true, body: packets(frames(events)) })
    });
    assert.deepEqual(reasoning, ["**Calc", "ulating**", "\n\n**Checking**", "\n\n**Second item**", "**After tool**"]);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  const assembled = fromResponses({ ...finalResponse, output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "**A**" }, { type: "summary_text", text: "**B**" }] }
  ] }, "gpt-6-luna");
  assert.equal(assembled.reasoning_content, "**A**\n\n**B**");
});

test("a gateway may hold response headers past the idle limit without timing out", async (t) => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Buffering TLS gateways release headers only once the whole response is done.
    let release;
    let fetchStarted;
    const started = new Promise((resolve) => { fetchStarted = resolve; });
    const pending = requestResponses({ model: "gpt-6-luna", messages: [], stream: true }, {
      onChunk: async () => {},
      fetchImpl: (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
        release = () => resolve({ ok: true, body: packets(frames([{ type: "response.completed", response: finalResponse }])) });
        fetchStarted();
      })
    });
    await started;
    t.mock.timers.tick(120000);
    release();
    assert.deepEqual(await pending, { streamed: true });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("request targets /responses with API key; streams text, parallel calls and terminal usage", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  try {
    const events = [
      { type: "response.output_text.delta", delta: "你好" },
      ...[0, 1].map((index) => ({ type: "response.output_item.done", output_index: index + 1,
        item: { type: "function_call", call_id: `call_${index}`, name: "read", arguments: `{"n":${index}}` } })),
      { type: "response.completed", response: { ...finalResponse, output: [
        ...finalResponse.output,
        ...[0, 1].map((index) => ({ type: "function_call", call_id: `call_${index}`, name: "read", arguments: `{"n":${index}}` }))
      ] } }
    ];
    const chunks = [];
    const cacheStats = [];
    await requestResponses({ model: "gpt-5", messages: [], stream: true, prompt_cache_key: "api-cache-key" }, {
      onChunk: async (chunk) => chunks.push(chunk),
      onCacheUsage: (usage) => cacheStats.push(usage),
      fetchImpl: async (url, options) => {
        assert.ok(url.endsWith("/v1/responses"));
        assert.equal(options.headers.Authorization, "Bearer test-only");
        assert.equal(options.headers["session-id"], undefined);
        assert.equal(options.headers["x-client-request-id"], undefined);
        assert.equal(JSON.parse(options.body).store, false);
        return { ok: true, body: packets(frames(events)) };
      }
    });
    assert.equal(chunks[0].choices[0].delta.content, "你好");
    assert.equal(chunks[1].choices[0].delta.tool_calls[0].id, "call_0");
    assert.equal(chunks[2].choices[0].delta.tool_calls[0].id, "call_1");
    assert.equal(chunks[3].choices[0].finish_reason, "tool_calls");
    assert.equal(chunks[3].usage.completion_tokens, 2);
    const result = await requestResponses({ model: "gpt-5", messages: [], stream: false, prompt_cache_key: "api-cache-key" }, {
      onCacheUsage: (usage) => cacheStats.push(usage),
      fetchImpl: async () => ({ ok: true, json: async () => finalResponse })
    });
    assert.equal(result.content, "你好");
    assert.equal(cacheStats.length, 2);
    assert.equal(cacheStats[0].auth_kind, "api");
    assert.equal(cacheStats[0].total_input_tokens, 10);
    assert.equal(cacheStats[0].cache_read_input_tokens, 0);
    assert.equal(cacheStats[0].uncached_input_tokens, 10);
    assert.equal(cacheStats[0].cache_hit_percent, 0);
    assert.equal(cacheStats[0].cache_key_id, cacheStats[1].cache_key_id);
    await assert.rejects(requestResponses({ model: "gpt-5", messages: [], stream: true }, {
      onChunk: async () => {}, fetchImpl: async () => ({ ok: true, body: packets(frames(events.slice(0, 1))) })
    }), /terminal/);
    await assert.rejects(requestResponses({ model: "gpt-5", messages: [], stream: false }, {
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{"error":{"message":"limited"}}' })
    }), (error) => error.status === 429 && error.message === "limited");
    await assert.rejects(requestResponses({ model: "gpt-5.4", messages: [], stream: false }, {
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"detail":"Model not supported with a ChatGPT account"}' })
    }), (error) => error.status === 400 && error.message === "Model not supported with a ChatGPT account");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("stream failure events keep the upstream reason and code", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  try {
    const fail = (event) => requestResponses({ model: "gpt-5", messages: [], stream: true }, {
      onChunk: async () => {}, fetchImpl: async () => ({ ok: true, body: packets(frames([event])) })
    });
    await assert.rejects(fail({ type: "error", error: { type: "server_error", code: "server_is_overloaded", message: "busy" } }),
      (error) => error.status === 502 && error.message === "busy (event=error, code=server_is_overloaded, type=server_error)");
    await assert.rejects(fail({ type: "response.failed", response: { status: "failed", error: { code: "rate_limit_exceeded" } } }),
      (error) => error.status === 502 && error.message === "OpenAI Responses failed (event=response.failed, code=rate_limit_exceeded)");
    await assert.rejects(fail({ type: "error", code: "invalid_prompt", message: "bad input" }),
      (error) => error.message === "bad input (event=error, code=invalid_prompt)");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("web search hooks rewrite the native body, see every event, and Copilot auth supplies its endpoint", async () => {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "in_progress" } },
    { type: "response.completed", response: { ...finalResponse, output: [] } }
  ];
  const seen = [];
  let request;
  const assembled = await requestResponses({ model: "gpt-6-luna", messages: [{ role: "user", content: "q" }], stream: false }, {
    remember: false,
    loadAuth: async () => ({ kind: "copilot", token: "test-only", baseUrl: "https://copilot.example", headers: { "Copilot-Integration-Id": "vscode-chat" } }),
    adjustPayload: (payload, auth) => { payload.stream = true; payload.tools = [{ type: "web_search" }]; payload.marker = auth.kind; },
    onEvent: (event) => seen.push(event.type),
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return { ok: true, body: packets(frames(events)) };
    }
  });
  assert.equal(request.url, "https://copilot.example/responses");
  assert.equal(request.headers.Authorization, "Bearer test-only");
  assert.equal(request.headers["Copilot-Integration-Id"], "vscode-chat");
  assert.deepEqual([request.body.stream, request.body.tools, request.body.marker], [true, [{ type: "web_search" }], "copilot"]);
  assert.deepEqual(seen, ["response.output_item.added", "response.completed"]);
  assert.equal(assembled.model, "gpt-6-luna");
});

test("context limit errors preserve reactive-compaction semantics for every provider envelope", async () => {
  const failure = { code: "context_length_exceeded", type: "invalid_request_error", message: "Your input exceeds the context window of this model." };
  const verify = (error) => error.status === 400 && error.code === failure.code && /^prompt is too long:/i.test(error.message);
  for (const event of [
    { type: "error", error: failure },
    { ...failure, type: "error" },
    { type: "response.failed", response: { status: "failed", error: failure } }
  ]) {
    await assert.rejects(requestResponses({ model: "gpt-6-sol", stream: true, messages: [] }, {
      loadAuth: async () => ({ kind: "api", token: "test" }),
      fetchImpl: async () => ({ ok: true, body: packets(frames([event])) })
    }), verify);
  }
  await assert.rejects(requestResponses({ model: "gpt-6-sol", stream: false, messages: [] }, {
    loadAuth: async () => ({ kind: "api", token: "test" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "failed", error: failure }) })
  }), verify);
  await assert.rejects(requestResponses({ model: "gpt-6-sol", stream: false, messages: [] }, {
    loadAuth: async () => ({ kind: "api", token: "test" }),
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: failure }) })
  }), verify);
});

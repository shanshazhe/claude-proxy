const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
async function gptResult(body, options, content, usage, stopReason = "end_turn") {
  const native = body.model.startsWith("claude-");
  const message = { id: "msg_fixture", type: "message", role: "assistant", model: native ? body.model : `anthropic/${body.model}`,
    content, stop_reason: stopReason, stop_sequence: null, usage };
  if (native) await options.onResponse?.({ ...message, content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } }, { "request-id": "native-fixture" });
  if (options.onEvent) {
    const partial = { ...(native ? { api: "anthropic-messages", provider: "github-copilot" } : {}),
      content: content.map((block) => block.type === "tool_use"
        ? { type: "toolCall", id: native ? block.id : `${block.id}|item_${block.id}`, name: block.name, arguments: block.input }
        : block.type === "thinking" ? { ...block, thinkingSignature: block.signature } : block) };
    await options.onEvent({ type: "start", partial });
    for (const [contentIndex, block] of partial.content.entries()) {
      if (block.type === "toolCall") {
        await options.onEvent({ type: "toolcall_start", contentIndex, partial });
        await options.onEvent({ type: "toolcall_delta", contentIndex, delta: '{"incomplete":', partial });
        await options.onEvent({ type: "toolcall_end", contentIndex, toolCall: block, partial });
      } else {
        const kind = block.type;
        await options.onEvent({ type: `${kind}_start`, contentIndex, partial });
        await options.onEvent({ type: `${kind}_delta`, contentIndex, delta: block[kind], partial });
        await options.onEvent({ type: `${kind}_end`, contentIndex, content: block[kind], partial });
      }
    }
    await options.onEvent({ type: "done", reason: stopReason === "tool_use" ? "toolUse" : "stop", message: partial });
  }
  return message;
}

for (const platform of ["mac", "windows"]) for (const model of ["gpt-5.4", "claude-sonnet-5.5"]) {
  test(`${platform} consumes ${model} memory calls at the response boundary in JSON and SSE`, { timeout: 5000 }, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    let route;
    let requests = 0;
    let mixed = false;
    let accepted = true;
    const enqueued = [];
    const mockGpt = async (body, options) => {
      const calls = [{ type: "tool_use", id: `memory_${requests++}`, name: "ProjectMemoryUpdate", input: { root: "/repo", changed_paths: [] } }];
      if (mixed) calls.push({ type: "tool_use", id: "read_1", name: "Read", input: {} });
      return gptResult(body, options, [{ type: "text", text: "Done." }, ...calls],
        { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 50 }, "tool_use");
    };
    const context = {
      require: (name) => name === "../lib/online-summary" ? { ...nativeRequire(name),
        createOnlineSummary: () => ({ getStatus: () => ({ projectMemory: true }), prepare: async (body) => ({ body, stats: {} }), cleanup: () => 0 }) }
        : name === "../lib/project-memory-maintainer" ? { createProjectMemoryMaintainer: () => ({ enqueue: (input) => {
          enqueued.push(input); return Object.assign(Promise.resolve(null), { accepted });
        } }) }
        : name === "../lib/pi-model" ? { requestPiModel: mockGpt }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5", owned_by: "openai", api: "openai-responses" }, { id: "gpt-5.4", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6.1-sol", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6-sol", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot", api: "anthropic-messages" }, { id: "claude-opus-5.5", owned_by: "github-copilot", api: "anthropic-messages" }] }) }
        : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) }
        : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) }
        : name === "http" ? { createServer: (handler) => { route = handler; return {}; } } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0], context, { filename });
    const send = async (stream) => {
      const request = new EventEmitter();
      Object.assign(request, { method: "POST", url: "/v1/messages", headers: {} });
      const response = new EventEmitter();
      let output = "";
      Object.assign(response, { setHeader() {}, writeHead(status, headers) { response.status = status; response.headers = headers; },
        write: (data) => { output += data; return true; } });
      const done = new Promise((resolve) => { response.end = (data) => {
        if (data) output += data;
        response.writableEnded = response.writableFinished = true;
        response.emit("finish"); resolve(output);
      }; });
      await route(request, response);
      request.emit("data", Buffer.from(JSON.stringify({ model, stream, tools: [{ name: "Edit", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "edit" }] })));
      request.emit("end");
      return done;
    };
    for (const stream of [false, true]) {
      for (const hasOtherTool of [false, true]) {
        mixed = hasOtherTool;
        const raw = await send(stream);
        assert.ok(!raw.includes("ProjectMemoryUpdate"));
        assert.ok(raw.includes("Queued."));
        assert.ok(raw.includes("Done."));
        const value = stream ? raw.split("\n\n").filter((entry) => entry.startsWith("event:"))
          .map((entry) => JSON.parse(entry.split("\ndata: ")[1])).find((entry) => entry.type === "message_delta") : JSON.parse(raw);
        assert.equal(stream ? value.delta.stop_reason : value.stop_reason, mixed ? "tool_use" : "end_turn");
        assert.equal(value.usage.cache_read_input_tokens, 50);
      }
      mixed = false;
      accepted = false;
      const failed = await send(stream);
      assert.ok(failed.includes("not queued"));
      assert.ok(!failed.includes("Queued."));
      accepted = true;
    }
    assert.equal(enqueued.length, requests);
    assert.equal(requests, 6);
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} GPT bridge routes independently and reports cached tokens`, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    let requests = 0;
    const mockGpt = async (body, options) => {
      if (body.model.startsWith("claude-")) {
        copilotRequests.push(body);
        assert.equal(options.url, "/v1/messages?beta=true");
        assert.deepEqual(Object.keys(options.clientHeaders), []);
        return gptResult(body, options, [{ type: "text", text: "native" }], { input_tokens: 1, output_tokens: 1 });
      }
      requests++;
      assert.equal(typeof options.onCacheUsage, "function");
      options.onCacheUsage({ total_input_tokens: 2000, cache_read_input_tokens: 1536 });
      const content = [{ type: "thinking", thinking: "Public reasoning summary", signature: "" },
        { type: "text", text: options.onEvent ? "hello <think>literal</think>" : "hello" }];
      if (options.onEvent) for (const index of [0, 1]) content.push({ type: "tool_use", id: `call_${index}`, name: "read", input: {} });
      return gptResult(body, options, content, { input_tokens: 464, output_tokens: 8, cache_read_input_tokens: 1536 },
        options.onEvent ? "tool_use" : "end_turn");
    };
    let route;
    const copilotRequests = [];
    const context = {
      require: (name) => name === "../lib/pi-model" ? { requestPiModel: mockGpt }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5.4", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot", api: "anthropic-messages" }] }) }
        : name === "http" ? { createServer: (handler) => { route = handler; return {}; } } : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) } : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval
    };
    const source = fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0];
    vm.runInNewContext(source + "\nthis.bridge = { requestPiModel, requestPiStream };", context, { filename });
    const body = { model: "gpt-5", messages: [], stream: false };
    const anthropic = await context.bridge.requestPiModel(body, { onCacheUsage() {} });
    assert.equal(anthropic.model, "anthropic/gpt-5");
    assert.equal(anthropic.content[0].type, "thinking");
    assert.equal(anthropic.content[0].thinking, "Public reasoning summary");
    assert.equal(anthropic.usage.input_tokens, 464);
    assert.equal(anthropic.usage.cache_read_input_tokens, 1536);

    const client = new EventEmitter();
    let output = "";
    client.write = (data) => { output += data; return true; };
    client.end = () => { client.writableEnded = true; client.emit("finish"); };
    await context.bridge.requestPiStream({ ...body, stream: true }, "gpt-5", "test", client, {});
    const events = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
    assert.ok(events.some((event) => event.type === "content_block_start" && event.content_block.type === "thinking"));
    assert.ok(events.some((event) => event.delta?.type === "thinking_delta"));
    assert.deepEqual(events.filter((event) => event.delta?.type === "signature_delta").map((event) => event.delta.signature), [""]);
    // GPT reasoning arrives only as summaries; literal tags in the answer stay text.
    assert.equal(events.filter((event) => event.content_block?.type === "thinking").length, 1);
    assert.equal(events.filter((event) => event.delta?.type === "text_delta").map((event) => event.delta.text).join(""),
      "hello <think>literal</think>");
    const calls = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].content_block.id, "call_0");
    assert.equal(calls[1].content_block.id, "call_1");
    const delta = events.find((event) => event.type === "message_delta");
    assert.equal(delta.usage.input_tokens, 464);
    assert.equal(delta.usage.cache_read_input_tokens, 1536);
    assert.equal(delta.delta.stop_reason, "tool_use");
    assert.equal(requests, 2);

    const listResponse = new EventEmitter();
    listResponse.setHeader = () => {};
    listResponse.writeHead = () => {};
    listResponse.end = (data) => { listResponse.body = data; };
    await route({ method: "GET", url: "/v1/models?limit=1000" }, listResponse);
    const models = JSON.parse(listResponse.body).data;
    assert.ok(models.length > 0);
    assert.ok(models.every((entry) => /^(?:claude-|anthropic\/gpt-)/.test(entry.id)));
    assert.ok(models.some((entry) => entry.display_name === "gpt-5.4"));

    for (const model of ["claude-sonnet-5.5", "claude-sonnet-5.5[1m]", "anthropic/claude-sonnet-5.5"]) {
      const request = new EventEmitter();
      request.method = "POST";
      request.url = "/v1/messages?beta=true";
      request.headers = {};
      const response = new EventEmitter();
      response.setHeader = () => {};
      response.writeHead = () => {};
      let output = "";
      response.write = (data) => { output += data; return true; };
      const done = new Promise((resolve) => { response.end = () => { response.writableEnded = true; response.emit("finish"); resolve(output); }; });
      await route(request, response);
      request.emit("data", Buffer.from(JSON.stringify({ model, stream: true, messages: [], thinking: { type: "adaptive" } })));
      request.emit("end");
      const events = (await done).split("\n\n").filter((frame) => frame.startsWith("event:"))
        .map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
      assert.equal(events[0].message.model, "claude-sonnet-5.5");
      assert.equal(events[0].message.id, "msg_fixture");
      assert.equal(events[0].message.usage.input_tokens, 7);
      assert.equal(copilotRequests.at(-1).thinking.type, "adaptive");
    }
    assert.equal(copilotRequests.length, 3);
    assert.equal(requests, 2);
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} passes prepared Anthropic history, images and request controls directly to Pi`, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    let route;
    let received;
    const context = {
      require: (name) => name === "../lib/pi-model" ? { requestPiModel: async (body) => {
        received = body;
        return { id: "msg_direct", type: "message", role: "assistant", model: "anthropic/gpt-5.4",
          content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      } }
        : name === "../lib/online-summary" ? { ...nativeRequire(name), createOnlineSummary: () => ({ getStatus: () => ({ projectMemory: false }),
          prepare: async (body) => ({ body, stats: {} }), cleanup: () => 0 }) }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5", owned_by: "openai", api: "openai-responses" }, { id: "gpt-5.4", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6.1-sol", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6-sol", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot", api: "anthropic-messages" }, { id: "claude-opus-5.5", owned_by: "github-copilot", api: "anthropic-messages" }] }) }
        : name === "http" ? { createServer: (handler) => { route = handler; return {}; } }
        : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) }
        : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval
    };
    const source = fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0];
    vm.runInNewContext(source, context, { filename });
    const body = { model: "gpt-5.4", stream: false, max_tokens: 512, temperature: 0.3, stop_sequences: ["stop"],
      system: [{ type: "text", text: "policy", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Bash", input_schema: { type: "object" } }], tool_choice: { type: "auto" },
      metadata: { user_id: "fixture-session" }, thinking: { type: "adaptive" }, messages: [
        { role: "user", content: "start" },
        { role: "assistant", content: [{ type: "thinking", thinking: "public", signature: "private-replay-key" },
          { type: "tool_use", id: "call_a", name: "Bash", input: { command: "ls" } }] },
        { role: "system", content: "later reminder" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", is_error: true, content: [
          { type: "text", text: "rejected" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] },
          { type: "text", text: "[Request interrupted by user for tool use]" }, { type: "text", text: "next request" }] }
      ] };
    const request = new EventEmitter();
    Object.assign(request, { method: "POST", url: "/v1/messages", headers: {} });
    const response = new EventEmitter();
    response.setHeader = response.writeHead = () => {};
    const done = new Promise((resolve) => { response.end = resolve; });
    await route(request, response);
    request.emit("data", Buffer.from(JSON.stringify(body)));
    request.emit("end");
    const result = JSON.parse(await done);
    assert.equal(result.id, "msg_direct");
    assert.deepEqual(JSON.parse(JSON.stringify(received)), body);
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} Pi events await backpressure and emit atomic parallel tools without private thinking`, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    const context = {
      require: (name) => name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5", owned_by: "openai", api: "openai-responses" }, { id: "gpt-5.4", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6.1-sol", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6-sol", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot", api: "anthropic-messages" }, { id: "claude-opus-5.5", owned_by: "github-copilot", api: "anthropic-messages" }] }) }
        : name === "http" ? { createServer: () => ({}) }
        : name === "../lib/macos-service" ? { createMacosService: () => ({}) }
        : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({}) } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL,
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0] +
      "\nthis.handler = createAnthropicStreamHandler;", context, { filename });
    const client = new EventEmitter();
    const events = [];
    let blockWrite = false;
    client.write = (frame) => {
      events.push(JSON.parse(frame.split("\ndata: ")[1]));
      return !blockWrite;
    };
    client.end = () => { client.writableEnded = true; client.emit("finish"); };
    const handler = context.handler(client);
    const partial = { content: [
      { type: "thinking", thinking: "public summary", thinkingSignature: "private encrypted content" },
      { type: "toolCall", id: "call_a|fc_a", name: "Read", arguments: { file: "a" } },
      { type: "toolCall", id: "call_b|fc_b", name: "Read", arguments: { file: "b", nested: { yes: true } } },
      { type: "text", text: "literal <think>answer</think>", textSignature: "private phase" },
      { type: "thinking", thinking: "redacted content", redacted: true, thinkingSignature: "private redacted" },
      { type: "thinking", thinking: "", thinkingSignature: "private encrypted only" }
    ] };
    const send = (type, contentIndex, extra = {}) => handler.applyPiEvent({ type, contentIndex, partial, ...extra });
    await send("thinking_start", 0);
    blockWrite = true;
    let delivered = false;
    const waiting = send("thinking_delta", 0, { delta: "public summary" }).then(() => { delivered = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivered, false, "the Pi callback must not resolve until the client drains");
    blockWrite = false;
    client.emit("drain");
    await waiting;
    await send("thinking_end", 0);
    await send("toolcall_start", 1);
    await send("toolcall_delta", 1, { delta: '{"file":' });
    await send("toolcall_start", 2);
    await send("toolcall_delta", 2, { delta: '{"file":"b"' });
    await send("text_start", 3);
    await send("text_delta", 3, { delta: partial.content[3].text });
    await send("text_end", 3);
    await send("toolcall_end", 2, { toolCall: partial.content[2] });
    await send("toolcall_delta", 1, { delta: '"a"}' });
    await send("toolcall_end", 1, { toolCall: partial.content[1] });
    await send("thinking_start", 4);
    await send("thinking_delta", 4, { delta: "redacted content" });
    await send("thinking_end", 4);
    await send("thinking_start", 5);
    await send("thinking_end", 5);
    const usage = { input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 100 };
    await handler.finish({ stop_reason: "max_tokens", usage });
    const count = events.length;
    await handler.finish({ stop_reason: "end_turn", usage: {} });
    assert.equal(events.length, count, "finish is idempotent");
    const starts = events.filter((event) => event.type === "content_block_start");
    assert.deepEqual(starts.map((event) => event.content_block.type), ["thinking", "text", "tool_use", "tool_use"]);
    assert.deepEqual(starts.map((event) => event.index), [0, 1, 2, 3]);
    assert.deepEqual(starts.slice(2).map((event) => event.content_block.id), ["call_b", "call_a"]);
    const inputs = events.filter((event) => event.delta?.type === "input_json_delta");
    assert.deepEqual(inputs.map((event) => JSON.parse(event.delta.partial_json)), [partial.content[2].arguments, partial.content[1].arguments]);
    for (const { index } of starts) {
      const block = events.filter((event) => event.index === index);
      assert.equal(block[0].type, "content_block_start");
      assert.equal(block.at(-1).type, "content_block_stop");
    }
    assert.ok(!JSON.stringify(events).includes("private"));
    assert.ok(!JSON.stringify(events).includes("redacted content"));
    assert.equal(events.find((event) => event.delta?.type === "text_delta").delta.text, partial.content[3].text);
    assert.deepEqual(events.at(-2).usage, usage);
    assert.equal(events.at(-2).delta.stop_reason, "max_tokens");
    assert.equal(events.at(-1).type, "message_stop");
    assert.equal(client.listenerCount("drain"), 0);
    assert.equal(client.listenerCount("error"), 0);
    assert.equal(client.listenerCount("close"), 0);
  });
}

for (const platform of ["mac", "windows"]) for (const model of ["gpt-5", "claude-sonnet-5.5"]) {
  test(`${platform} ${model} cancels JSON and SSE before or after upstream start, never after success`, { timeout: 5000 }, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    const warnings = [];
    let aborted = 0;
    let hang;
    let upstreamStarted;
    let upstreamAborted;
    let route;
    const mockPi = async (body, options) => {
      if (hang) {
        const pending = new Promise((resolve, reject) => {
          options.control.abort = (message, status) => {
            aborted++;
            assert.equal(status, 499);
            upstreamAborted();
            reject(Object.assign(new Error(message), { status }));
          };
        });
        if (hang === "after") await options.onResponse?.({ id: "msg_started", usage: { input_tokens: 1, output_tokens: 0 } }, {});
        upstreamStarted();
        await pending;
      }
      return gptResult(body, options, [{ type: "text", text: "hello" }], { input_tokens: 1, output_tokens: 1 });
    };
    const context = {
      require: (name) => name === "../lib/pi-model" ? { requestPiModel: mockPi }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5", owned_by: "openai", api: "openai-responses" }, { id: "gpt-5.4", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6.1-sol", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6-sol", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot", api: "anthropic-messages" }, { id: "claude-opus-5.5", owned_by: "github-copilot", api: "anthropic-messages" }] }) }
        : name === "http" ? { createServer: (handler) => { route = handler; return {}; } }
        : name === "../lib/macos-service" ? { createMacosService: () => ({}) }
        : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({}) } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, console: { log() {}, warn: (line) => warnings.push(line), error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0], context, { filename });
    const server = http.createServer(route);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1/messages`;
    const send = (stream, signal) => fetch(url, { method: "POST", signal,
      body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "test" }] }) }).then((res) => res.text());
    try {
      for (const stream of [false, true]) {
        const body = await send(stream);
        assert.ok(body.includes("hello"));
        if (stream) assert.ok(body.includes("message_stop"));
      }
      assert.equal(aborted, 0);
      assert.deepEqual(warnings.filter((line) => line.includes("client SSE closed")), []);
      for (const stream of [false, true]) for (const stage of ["before", "after"]) {
        hang = stage;
        const started = new Promise((resolve) => { upstreamStarted = resolve; });
        const stopped = new Promise((resolve) => { upstreamAborted = resolve; });
        const controller = new AbortController();
        const failed = assert.rejects(send(stream, controller.signal), { name: "AbortError" });
        await started;
        controller.abort();
        await failed;
        await stopped;
      }
      assert.equal(aborted, 4);
      assert.equal(warnings.filter((line) => line.includes("client SSE closed")).length, 2);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} answers the project memory follow-up locally and forwards everything else rewritten`, { timeout: 5000 }, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    const forwarded = [];
    const enqueued = [];
    const summaryOptions = [];
    let projectMemory = true;
    let route;
    const context = {
      require: (name) => name === "../lib/online-summary" ? { ...nativeRequire(name),
        createOnlineSummary: () => ({ getStatus: () => ({ projectMemory }), prepare: async (body, options) => { summaryOptions.push(options); return { body, stats: {} }; }, cleanup: () => 0 }) }
        : name === "../lib/project-memory-maintainer" ? { createProjectMemoryMaintainer: () => ({ enqueue: (input) => { enqueued.push(input); return new Promise(() => {}); } }) }
        : name === "../lib/pi-model" ? { requestPiModel: async (body, options) => {
          forwarded.push(body);
          return gptResult(body, options, [], { input_tokens: 1, output_tokens: 1 });
        } }
        : name === "../lib/pi-capabilities" ? { ...nativeRequire(name), countTokens: async (body, request, response) => {
          forwarded.push(body);
          response.end(JSON.stringify({ type: "message", model: body.model, content: [] }));
        } }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5", owned_by: "openai", api: "openai-responses" }, { id: "gpt-5.4", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6.1-sol", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6-sol", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot", api: "anthropic-messages" }, { id: "claude-opus-5.5", owned_by: "github-copilot", api: "anthropic-messages" }] }) }
        : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) }
        : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) }
        : name === "http" ? { createServer: (handler) => { route = handler; return {}; } } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval
    };
    const source = fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0];
    vm.runInNewContext(source + '\ngetConfiguredModel = () => "gpt-6.1-sol";', context, { filename });
    const send = async (payload, url = "/v1/messages?beta=true") => {
      const request = new EventEmitter();
      Object.assign(request, { method: "POST", url, headers: {} });
      const response = new EventEmitter();
      let output = "";
      Object.assign(response, { setHeader() {}, writeHead(status, headers) { response.status = status; response.headers = headers; },
        write: (data) => { output += data; return true; } });
      const done = new Promise((resolve) => { response.end = (data) => { if (data) output += data; response.writableEnded = true; response.emit("finish"); resolve(output); }; });
      await route(request, response);
      request.emit("data", Buffer.from(JSON.stringify(payload)));
      request.emit("end");
      return { body: await done, response };
    };
    const call = { type: "tool_use", id: "toolu_memory", name: "ProjectMemoryUpdate", input: { root: "/repo", changed_paths: ["a.js"] } };
    const result = { type: "tool_result", tool_use_id: "toolu_memory", content: "No such tool available: ProjectMemoryUpdate", is_error: true };
    const payload = (stream, reply = [result]) => ({ model: "claude-sonnet-5.5", stream, tools: [{ name: "Edit", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "edit" }, { role: "assistant", content: [{ type: "text", text: "Done. 完成" }, call] }, { role: "user", content: reply }] });

    const streamed = await send(payload(true));
    assert.equal(streamed.response.headers["Content-Type"], "text/event-stream");
    const events = streamed.body.split("\n\n").filter((frame) => frame.startsWith("event:")).map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
    assert.deepEqual(events.map((event) => event.type), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    assert.equal(events[2].delta.text, "Done. 完成");
    assert.equal(events[4].delta.stop_reason, "end_turn");
    assert.equal(events[4].usage.input_tokens, Math.ceil(Buffer.byteLength(JSON.stringify(payload(true))) / 4));
    const collected = JSON.parse((await send(payload(false))).body);
    assert.deepEqual([collected.content[0].text, collected.stop_reason, collected.role], ["Done. 完成", "end_turn", "assistant"]);
    assert.equal(JSON.stringify(enqueued), JSON.stringify([{ root: "/repo", changed_paths: ["a.js"] }]));
    assert.equal(forwarded.length, 0);
    for (const model of ["gpt-6.1-sol", "anthropic/gpt-6.1-sol[1m]", "sonnet"]) {
      for (const stream of [false, true]) {
        const reply = await send({ ...payload(stream), model });
        const start = stream && reply.body.split("\n\n").find((frame) => frame.startsWith("event: message_start\n"));
        const actual = stream ? JSON.parse(start.split("\ndata: ")[1]).message : JSON.parse(reply.body);
        assert.equal(actual.model, "anthropic/gpt-6.1-sol");
      }
    }
    assert.equal(forwarded.length, 0);

    await send(payload(true, [result, { type: "text", text: "and one more thing" }]));
    assert.equal(forwarded.length, 1);
    assert.equal(JSON.stringify(forwarded[0].messages[2].content[0]), JSON.stringify({ type: "tool_result", tool_use_id: "toolu_memory", content: "Queued.", is_error: false }));
    assert.equal(forwarded[0].tools.at(-1).name, "ProjectMemoryUpdate");
    assert.match(forwarded[0].system.at(-1).text, /ProjectMemoryUpdate/);
    assert.equal(enqueued.length, 1);

    // Token-count subpaths never enqueue or terminate locally, even while enabled.
    const countPayload = payload(false);
    countPayload.messages[1].content[1] = { ...call, id: "toolu_count" };
    countPayload.messages[2].content[0] = { ...result, tool_use_id: "toolu_count" };
    await send(countPayload, "/v1/messages/count_tokens");
    assert.equal(forwarded.length, 2);
    assert.equal(enqueued.length, 1);
    assert.equal(summaryOptions.at(-1).readOnly, true);

    for (const disabled of [null, false]) {
      projectMemory = disabled;
      await send(payload(true));
      const body = forwarded.at(-1);
      assert.equal(body.tools.length, 1);
      assert.equal(body.system, undefined);
      assert.equal(body.messages[2].content[0].content, "Queued.");
      assert.equal(enqueued.length, 1);
    }
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} answers built-in web search with search blocks and cancels it on disconnect`, { timeout: 5000 }, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    const searches = [];
    const forwarded = [];
    let hang = false;
    let aborted = 0;
    let route;
    const content = [{ type: "server_tool_use", id: "srvtoolu_ws_1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_ws_1", content: [{ type: "web_search_result", url: "https://nodejs.org/", title: "Node.js" }] },
      { type: "text", text: "Summary." }];
    const context = {
      require: (name) => name === "../lib/web-search" ? { ...nativeRequire(name), runWebSearch: async (body, search, options) => {
        searches.push({ body, search, copilot: (options.capabilities.search === "copilot-responses") });
        if (hang) {
          await new Promise((resolve, reject) => {
            options.control.abort = (message, status) => { aborted++; reject(Object.assign(new Error(message), { status })); };
          });
        }
        return { content, searches: 1, hits: 1, model: (options.capabilities.search === "copilot-responses") ? "gpt-6-luna" : body.model, authKind: (options.capabilities.search === "copilot-responses") ? "copilot" : "codex", capped: false, usage: null };
      } }
        : name === "../lib/pi-model" ? { requestPiModel: async () => { throw new Error("conversation upstream must not be called"); } }
        : name === "../lib/pi-capabilities" ? { ...nativeRequire(name), countTokens: async (body, request, response) => {
          forwarded.push(body);
          response.end(JSON.stringify({ type: "message", model: body.model, content: [] }));
        } }
        : name === "../lib/online-summary" ? { ...nativeRequire(name),
          createOnlineSummary: () => ({ getStatus: () => ({ projectMemory: false }), prepare: async (body) => ({ body, stats: {} }), cleanup: () => 0 }) }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5", owned_by: "openai", api: "openai-responses" }, { id: "gpt-5.4", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6.1-sol", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6-sol", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot", api: "anthropic-messages" }, { id: "claude-opus-5.5", owned_by: "github-copilot", api: "anthropic-messages" }] }) }
        : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) }
        : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) }
        : name === "http" ? { createServer: (handler) => { route = handler; return {}; } } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0], context, { filename });
    const send = async (payload, url = "/v1/messages?beta=true", { close = false } = {}) => {
      const request = new EventEmitter();
      Object.assign(request, { method: "POST", url, headers: {} });
      const response = new EventEmitter();
      let output = "";
      Object.assign(response, { setHeader() {}, writeHead(status, headers) { response.status = status; response.headers = headers; response.headersSent = true; },
        write: (data) => { output += data; if (close && data.includes("waiting for upstream")) setImmediate(() => { response.destroyed = true; response.emit("close"); }); return true; } });
      const done = new Promise((resolve) => {
        response.end = (data) => { if (data) output += data; response.writableEnded = true; response.writableFinished = true; response.emit("finish"); resolve(output); };
        if (close) response.once("close", () => setImmediate(() => resolve(output)));
      });
      await route(request, response);
      request.emit("data", Buffer.from(JSON.stringify(payload)));
      request.emit("end");
      return { body: await done, response };
    };
    const payload = (model, stream, tool = {}) => ({ model, stream, max_tokens: 1024, system: [{ type: "text", text: "Search once." }],
      messages: [{ role: "user", content: "Perform a web search for the query: q" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, ...tool }], tool_choice: { type: "auto" }, thinking: { type: "disabled" } });

    const streamed = await send(payload("claude-opus-5.5", true));
    assert.equal(streamed.response.headers["Content-Type"], "text/event-stream");
    const events = streamed.body.split("\n\n").filter((frame) => frame.startsWith("event:")).map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
    assert.deepEqual(events.map((event) => event.type), ["message_start", "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    assert.equal(events[0].message.model, "claude-opus-5.5");
    assert.deepEqual(events[4].content_block, content[1]);
    assert.equal(events[9].delta.stop_reason, "end_turn");
    assert.equal(searches[0].copilot, true);
    assert.equal(searches[0].body.tools[0].type, "web_search_20250305");
    assert.equal(searches[0].body.system[0].text, "Search once.");
    assert.equal(searches[0].body.tool_choice.type, "auto");
    assert.equal(searches[0].body.messages.at(-1).content, "Perform a web search for the query: q");
    assert.equal(forwarded.length, 0);

    const collected = JSON.parse((await send(payload("anthropic/gpt-6.1-sol[1m]", false))).body);
    assert.deepEqual(collected.content, content);
    assert.equal(collected.stop_reason, "end_turn");
    assert.equal(collected.model, "anthropic/gpt-6.1-sol");
    assert.deepEqual([searches[1].copilot, searches[1].body.model], [false, "gpt-6.1-sol"]);

    const gptStream = await send(payload("gpt-6.1-sol", true));
    const start = gptStream.body.split("\n\n").find((frame) => frame.startsWith("event: message_start\n"));
    assert.equal(JSON.parse(start.split("\ndata: ")[1]).message.model, "anthropic/gpt-6.1-sol");
    assert.equal(searches[2].body.model, "gpt-6.1-sol");

    const rejected = await send(payload("gpt-6.1-sol", true, { blocked_domains: ["example.com"] }));
    assert.equal(rejected.response.status, 400);
    assert.match(JSON.parse(rejected.body).error.message, /blocked_domains/);
    assert.equal(searches.length, 3);

    // Token counting keeps its native route and never runs a real search.
    await send(payload("claude-opus-5.5", false), "/v1/messages/count_tokens");
    assert.equal(forwarded.length, 1);
    assert.equal(searches.length, 3);

    hang = true;
    await send(payload("gpt-6.1-sol", true), "/v1/messages?beta=true", { close: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(aborted, 1);
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} common formatter preserves native signed, redacted, opaque and citation blocks`, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    const context = {
      require: (name) => name === "http" ? { createServer: () => ({}) }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5", owned_by: "openai", api: "openai-responses" }, { id: "gpt-5.4", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6.1-sol", owned_by: "openai", api: "openai-responses" }, { id: "gpt-6-sol", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot", api: "anthropic-messages" }, { id: "claude-opus-5.5", owned_by: "github-copilot", api: "anthropic-messages" }] }) }
        : name === "../lib/macos-service" ? { createMacosService: () => ({}) }
        : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({}) } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL,
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0] +
      "\nthis.handler = createAnthropicStreamHandler;", context, { filename });
    const client = new EventEmitter();
    const events = [];
    client.write = (frame) => { events.push(JSON.parse(frame.split("\ndata: ")[1])); return true; };
    client.end = () => { client.writableEnded = true; client.emit("finish"); };
    const handler = context.handler(client);
    const partial = { api: "anthropic-messages", provider: "github-copilot", content: [
      { type: "thinking", thinking: "native thought", thinkingSignature: "" },
      { type: "thinking", thinking: "", thinkingSignature: "empty-signed-block" },
      { type: "thinking", redacted: true, thinkingSignature: "opaque-redacted-data" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "toolu_native|preserve", name: "Read", arguments: { file: "a" } }
    ] };
    const send = (type, contentIndex, extra = {}) => handler.applyPiEvent({ type, contentIndex, partial, ...extra });
    await send("thinking_start", 0);
    await send("thinking_delta", 0, { delta: "native thought" });
    partial.content[0].thinkingSignature = "accumulated-native-signature";
    await send("thinking_end", 0);
    await send("thinking_start", 1);
    await send("thinking_end", 1);
    await send("thinking_start", 2);
    await send("thinking_end", 2);
    const serverTool = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} };
    await send("native_block_start", -4, { block: serverTool });
    await send("native_block_delta", -4, { delta: { type: "input_json_delta", partial_json: '{"query":"q"}' } });
    await send("native_block_stop", -4);
    const opaque = { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] };
    await send("native_block_start", -5, { block: opaque });
    await send("native_block_stop", -5);
    await send("text_start", 3);
    await send("text_delta", 3, { delta: "answer" });
    const citation = { type: "web_search_result_location", url: "https://example.com/", title: "source", cited_text: "answer" };
    await send("native_block_delta", 3, { delta: { type: "citations_delta", citation } });
    await send("text_end", 3);
    await send("toolcall_end", 4, { toolCall: partial.content[4] });
    const usage = { input_tokens: 9, output_tokens: 8, cache_read_input_tokens: 11, cache_creation_input_tokens: 12 };
    await handler.finish({ stop_reason: "stop_sequence", stop_sequence: "END", stop_details: { type: "native" }, usage });
    const starts = events.filter((event) => event.type === "content_block_start");
    assert.deepEqual(starts.map((event) => event.content_block.type),
      ["thinking", "thinking", "redacted_thinking", "server_tool_use", "web_search_tool_result", "text", "tool_use"]);
    assert.deepEqual(starts.map((event) => event.index), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(events.filter((event) => event.delta?.type === "signature_delta").map((event) => event.delta.signature),
      ["accumulated-native-signature", "empty-signed-block"]);
    assert.equal(starts[2].content_block.data, "opaque-redacted-data");
    assert.equal(starts[6].content_block.id, "toolu_native|preserve");
    assert.deepEqual(starts[4].content_block, opaque);
    assert.equal(events.find((event) => event.delta?.type === "citations_delta").index, 5);
    assert.deepEqual(events.find((event) => event.delta?.type === "citations_delta").delta.citation, citation);
    for (const { index } of starts) {
      const blockEvents = events.filter((event) => event.index === index);
      assert.equal(blockEvents[0].type, "content_block_start");
      assert.equal(blockEvents.at(-1).type, "content_block_stop");
    }
    assert.deepEqual(events.at(-2), { type: "message_delta", delta: {
      stop_reason: "stop_sequence", stop_sequence: "END", stop_details: { type: "native" }
    }, usage });
    assert.equal(events.at(-1).type, "message_stop");
  });
}

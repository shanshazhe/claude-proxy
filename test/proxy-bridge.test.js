const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const responses = require("../lib/openai-responses");

for (const platform of ["mac", "windows"]) {
  test(`${platform} consumes GPT memory calls at the response boundary in JSON and SSE`, { timeout: 5000 }, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    let route;
    let requests = 0;
    let mixed = false;
    let accepted = true;
    const enqueued = [];
    const mockResponses = async (body, options) => {
      const calls = [{ id: `memory_${requests++}`, function: { name: "ProjectMemoryUpdate", arguments: JSON.stringify({ root: "/repo", changed_paths: [] }) } }];
      if (mixed) calls.push({ id: "read_1", function: { name: "Read", arguments: "{}" } });
      const usage = { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 50 };
      if (!options.onChunk) return { model: body.model, content: "Done.", tool_calls: calls, finish_reason: "tool_calls", usage };
      await options.onChunk({ choices: [{ delta: { content: "Done." } }] });
      for (const [index, call] of calls.entries()) {
        await options.onChunk({ choices: [{ delta: { tool_calls: [{ ...call, index, function: { ...call.function, arguments: call.function.arguments.slice(0, 7) } }] } }] });
        await options.onChunk({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: call.function.arguments.slice(7) } }] } }] });
      }
      await options.onChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage });
      return { streamed: true };
    };
    const context = {
      require: (name) => name === "../lib/online-summary" ? { ...nativeRequire(name),
        createOnlineSummary: () => ({ getStatus: () => ({ projectMemory: true }), prepare: async (body) => ({ body, stats: {} }), cleanup: () => 0 }) }
        : name === "../lib/project-memory-maintainer" ? { createProjectMemoryMaintainer: () => ({ enqueue: (input) => {
          enqueued.push(input); return Object.assign(Promise.resolve(null), { accepted });
        } }) }
        : name === "../lib/openai-responses" ? { ...responses, requestResponses: mockResponses }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [] }) }
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
      request.emit("data", Buffer.from(JSON.stringify({ model: "gpt-5.4", stream, tools: [{ name: "Edit", input_schema: { type: "object" } }],
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
    const mockResponses = async (body, options) => {
      requests++;
      assert.equal(typeof options.onCacheUsage, "function");
      options.onCacheUsage({ total_input_tokens: 2000, cache_read_input_tokens: 1536 });
      const usage = { prompt_tokens: 2000, completion_tokens: 8, cached_tokens: 1536 };
      if (options.onChunk) {
        await options.onChunk({ choices: [{ delta: { reasoning_content: "Public reasoning summary" } }] });
        await options.onChunk({ choices: [{ delta: { content: "hello <think>literal</think>" } }] });
        for (const index of [0, 1]) {
          await options.onChunk({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, function: { name: "read", arguments: "{}" } }] } }] });
        }
        await options.onChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage });
        return { streamed: true };
      }
      return { model: body.model, reasoning_content: "Public reasoning summary", content: "hello", finish_reason: "stop", usage };
    };
    let route;
    const copilotRequests = [];
    const context = {
      require: (name) => name === "../lib/openai-responses" ? { ...responses, requestResponses: mockResponses }
        : name === "../lib/github-copilot" ? { ...nativeRequire(name), forwardClaudeRequest: async (body, request, response, options) => {
          assert.equal(typeof options.onCacheUsage, "function");
          options.onCacheUsage({ model: body.model, cache_read_input_tokens: 1024 });
          copilotRequests.push(body);
          response.end(JSON.stringify({ type: "message", model: body.model, content: [] }));
        } }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5.4", owned_by: "openai" }] }) }
        : name === "http" ? { createServer: (handler) => { route = handler; return {}; } } : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) } : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval
    };
    const source = fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0];
    vm.runInNewContext(source + "\nthis.bridge = { requestResponses, requestResponsesStream, convertOpenAIToAnthropic };", context, { filename });
    const body = { model: "gpt-5", messages: [], stream: false };
    const collected = await context.bridge.requestResponses(body, { onCacheUsage() {} });
    const anthropic = context.bridge.convertOpenAIToAnthropic(collected, "gpt-5");
    assert.equal(anthropic.model, "anthropic/gpt-5");
    assert.equal(anthropic.content[0].type, "thinking");
    assert.equal(anthropic.content[0].thinking, "Public reasoning summary");
    assert.equal(anthropic.usage.input_tokens, 464);
    assert.equal(anthropic.usage.cache_read_input_tokens, 1536);

    const client = new EventEmitter();
    let output = "";
    client.write = (data) => { output += data; return true; };
    client.end = () => { client.writableEnded = true; client.emit("finish"); };
    await context.bridge.requestResponsesStream({ ...body, stream: true }, "gpt-5", "gpt-5", "test", client, {});
    const events = output.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
    assert.ok(events.some((event) => event.type === "content_block_start" && event.content_block.type === "thinking"));
    assert.ok(events.some((event) => event.delta?.type === "thinking_delta"));
    assert.ok(events.some((event) => event.delta?.type === "signature_delta"));
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
      const done = new Promise((resolve) => { response.end = resolve; });
      await route(request, response);
      request.emit("data", Buffer.from(JSON.stringify({ model, stream: true, messages: [], thinking: { type: "adaptive" } })));
      request.emit("end");
      const result = JSON.parse(await done);
      assert.equal(result.model, "claude-sonnet-5.5");
      assert.equal(copilotRequests.at(-1).thinking.type, "adaptive");
    }
    assert.equal(copilotRequests.length, 3);
    assert.equal(requests, 2);
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} tool results directly follow their tool calls, before text sent alongside them`, () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    const context = {
      require: (name) => name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [] }) }
        : name === "http" ? { createServer: () => ({}) } : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) } : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval
    };
    const source = fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0];
    vm.runInNewContext(source + "\nthis.convert = convertAnthropicToOpenAI;", context, { filename });
    const { messages } = context.convert({ model: "gpt-5", messages: [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "rejected", is_error: true },
        { type: "text", text: "[Request interrupted by user for tool use]" }, { type: "text", text: "next request" }] }
    ] });
    assert.deepEqual(Array.from(messages, (message) => message.role), ["user", "assistant", "tool", "user"]);
    assert.equal(messages[2].tool_call_id, "call_a");
    assert.equal(messages[3].content, "[Request interrupted by user for tool use]\nnext request");
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} only real client disconnects warn and abort the upstream stream`, async () => {
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    const warnings = [];
    let aborted = 0;
    let hang = false;
    const mockResponses = async (body, options) => {
      if (hang) {
        await new Promise((resolve, reject) => {
          options.control.abort = (message, status) => { aborted++; reject(Object.assign(new Error(message), { status })); };
        });
      }
      await options.onChunk({ choices: [{ delta: { content: "hello" } }] });
      await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      return { streamed: true };
    };
    const context = {
      require: (name) => name === "../lib/openai-responses" ? { ...responses, requestResponses: mockResponses }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [] }) }
        : name === "http" ? { createServer: () => ({}) } : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) } : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) } : nativeRequire(name),
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, console: { log() {}, warn: (line) => warnings.push(line), error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval
    };
    const source = fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0];
    vm.runInNewContext(source + "\nthis.streamToClient = streamToClient;", context, { filename });
    const server = http.createServer((req, res) => context.streamToClient({ model: "gpt-5", messages: [] }, "gpt-5", "gpt-5", "test", res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const body = await (await fetch(url)).text();
      assert.ok(body.includes("message_stop"));
      await settle();
      assert.deepEqual(warnings.filter((line) => line.includes("client SSE closed")), []);

      hang = true;
      const controller = new AbortController();
      const response = await fetch(url, { signal: controller.signal });
      await response.body.getReader().read();
      controller.abort();
      await settle();
      assert.equal(warnings.filter((line) => line.includes("client SSE closed")).length, 1);
      assert.equal(aborted, 1);
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
        : name === "../lib/openai-responses" ? { ...responses, requestResponses: async () => { throw new Error("upstream must not be called"); } }
        : name === "../lib/github-copilot" ? { ...nativeRequire(name), forwardClaudeRequest: async (body, request, response) => {
          forwarded.push(body);
          response.end(JSON.stringify({ type: "message", model: body.model, content: [] }));
        } }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [] }) }
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
        searches.push({ body, search, copilot: options.copilot });
        if (hang) {
          await new Promise((resolve, reject) => {
            options.control.abort = (message, status) => { aborted++; reject(Object.assign(new Error(message), { status })); };
          });
        }
        return { content, searches: 1, hits: 1, model: options.copilot ? "gpt-6-luna" : body.model, authKind: options.copilot ? "copilot" : "codex", capped: false, usage: null };
      } }
        : name === "../lib/openai-responses" ? { ...responses, requestResponses: async () => { throw new Error("conversation upstream must not be called"); } }
        : name === "../lib/github-copilot" ? { ...nativeRequire(name), forwardClaudeRequest: async (body, request, response) => {
          forwarded.push(body);
          response.end(JSON.stringify({ type: "message", model: body.model, content: [] }));
        } }
        : name === "../lib/online-summary" ? { ...nativeRequire(name),
          createOnlineSummary: () => ({ getStatus: () => ({ projectMemory: false }), prepare: async (body) => ({ body, stats: {} }), cleanup: () => 0 }) }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [] }) }
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
    assert.equal(searches[0].body.tools, undefined);
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

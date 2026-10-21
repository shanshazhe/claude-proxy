const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const http = require("http");
const { createRequire } = require("module");
const { execFile } = require("child_process");
const { promisify } = require("util");
const responses = require("../lib/openai-responses");
const webSearch = require("../lib/web-search");

const skip = process.env.RUN_CLAUDE_CLI_TESTS !== "1";
const usage = { prompt_tokens: 20, completion_tokens: 2, cached_tokens: 10 };

// Runs the real proxy on a random loopback port and the installed CLI against it, with fake
// upstreams for the conversation and for built-in web search. No real upstream requests or auth files.
async function runCli({ requestResponses, searchResponses = async () => { throw new Error("unexpected web search"); }, envOverrides = {}, followUpPrompts = [] }, args) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-cli-test-"));
  fs.writeFileSync(path.join(directory, "fixture.txt"), "compaction-fixture-marker");
  const filename = path.resolve("mac/proxy.js");
  const nativeRequire = createRequire(filename);
  const urls = [];
  const store = { directory: path.join(directory, "store"), migrate() {}, readAuth: () => ({}),
    saveLogin() { throw new Error("unexpected credential write"); } };
  const observations = nativeRequire("../lib/online-summary");
  let server;
  const context = {
    require: (name) => name === "http" ? { createServer: (handler) => {
      server = http.createServer((request, response) => { urls.push(request.url); handler(request, response); });
      return server;
    } } : name === "../lib/credential-store" ? { defaultStore: store }
      : name === "../lib/claude-setup" ? { ...nativeRequire(name), getClaudeConfigRoot: () => directory,
        createClaudeSetup: (options) => nativeRequire(name).createClaudeSetup({ ...options, configRoot: directory, store, env: {} }) }
      : name === "../lib/online-summary" ? { ...observations,
        createOnlineSummary: (options) => observations.createOnlineSummary({ ...options, configFile: path.join(directory, "features.json"), archiveRoot: path.join(directory, "observations") }),
        createSummarySettings: (options) => observations.createSummarySettings({ ...options, configFile: path.join(directory, "features.json") }) }
      : name === "../lib/openai-responses" ? { ...responses, requestResponses }
      : name === "../lib/web-search" ? { ...webSearch, runWebSearch: (body, search, options) => webSearch.runWebSearch(body, search, { ...options, requestResponsesImpl: searchResponses }) }
        : name === "../lib/model-discovery" ? { createModelDiscovery: () => async () => ({ object: "list", data: [{ id: "gpt-5.4", owned_by: "openai" }] }) } : name === "../lib/macos-service" ? { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) } : name === "../lib/project-memory-install" ? { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) } : nativeRequire(name),
    __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0], context, { filename });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const env = {
      ...process.env,
      HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: directory,
      OPENAI_API_KEY: "test-only-gpt-key",
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: "test-only", ANTHROPIC_AUTH_TOKEN: "test-only",
      ANTHROPIC_MODEL: "gpt-4.1",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ...envOverrides
    };
    delete env.CLAUDECODE;
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE_CODE_USE_")) delete env[key];
    }
    const execute = async (promptArgs) => {
      const child = promisify(execFile)("claude", [
        "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        ...(followUpPrompts.length ? [] : ["--no-session-persistence"]),
        "--model", "anthropic/gpt-5.4", "--debug-file", path.join(directory, "debug.log"), "--output-format", "json", ...promptArgs
      ], { cwd: directory, env, timeout: 90000, maxBuffer: 1024 * 1024 });
      child.child.stdin.end();
      const { stdout } = await child;
      return JSON.parse(stdout);
    };
    const result = await execute(args);
    const followUps = [];
    for (const prompt of followUpPrompts) {
      followUps.push(await execute([...args.slice(0, args.indexOf("-p")), "--resume", result.session_id, "-p", prompt]));
    }
    // Print mode may defer interactive picker discovery. Exercise its exact URL.
    const models = await (await fetch(`${baseUrl}/v1/models?limit=1000`)).json();
    return { result, models, followUps };
  } catch (error) {
    const debugFile = path.join(directory, "debug.log");
    const debug = fs.existsSync(debugFile) ? fs.readFileSync(debugFile, "utf8").split("\n")
      .filter((line) => /compact|prompt is too long|invalid_request|retry|API error/i.test(line)).slice(-18).join("\n") : "";
    error.message += "\nCLI recovery diagnostics:\n" + debug;
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// Opt in when Claude Code is installed.
test("installed Claude CLI sends selected GPT and gateway serves discovery URL", { skip, timeout: 60000 }, async () => {
  const observed = [];
  const { result, models } = await runCli({ requestResponses: async (body, options) => {
    observed.push(body.model);
    assert.equal(body.model, "gpt-5.4");
    await options.onChunk({ choices: [{ delta: { content: "gateway-smoke-ok" } }] });
    await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
    return { streamed: true };
  } }, ["--bare", "--tools", "", "--system-prompt", "Reply only gateway-smoke-ok", "-p", "Test"]);
  assert.equal(result.is_error, false);
  assert.equal(result.result, "gateway-smoke-ok");
  assert.ok(observed.includes("gpt-5.4"));
  assert.ok(models.data.some((entry) => entry.id === "anthropic/gpt-5.4"));
});

// The built-in tool sends its own web_search_20250305 request (tool_choice auto on the wire); its links must reach
// the conversation. Not --bare: bare mode offers only Bash, Edit and Read.
test("installed Claude CLI gets real links from built-in WebSearch through the gateway", { skip, timeout: 60000 }, async () => {
  const conversation = [];
  const searches = [];
  const { result } = await runCli({
    requestResponses: async (body, options) => {
      conversation.push(body);
      if (conversation.length === 1) {
        assert.ok(body.tools.some((tool) => tool.function.name === "WebSearch"));
        await options.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_search",
          function: { name: "WebSearch", arguments: JSON.stringify({ query: "gateway fixture query" }) } }] } }] });
        await options.onChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage });
      } else {
        await options.onChunk({ choices: [{ delta: { content: "search-done" } }] });
        await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
      }
      return { streamed: true };
    },
    searchResponses: async (body, options) => {
      const payload = { model: body.model, include: [] };
      options.adjustPayload(payload, { kind: "codex" });
      searches.push({ body, payload });
      const call = { type: "web_search_call", id: "ws_fixture", status: "completed",
        action: { type: "search", queries: ["gateway fixture query"], sources: [{ type: "url", url: "https://fixture.example/result" }] } };
      options.onEvent({ type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_fixture", status: "in_progress" } });
      options.onEvent({ type: "response.output_item.done", output_index: 0, item: call });
      options.onEvent({ type: "response.output_item.done", output_index: 1, item: { type: "message", content: [{ type: "output_text", text: "Fixture summary.",
        annotations: [{ type: "url_citation", url: "https://fixture.example/result?utm_source=openai", title: "Fixture Result Title" }] }] } });
      options.onEvent({ type: "response.completed", response: { status: "completed", output: [] } });
      return { usage };
    }
  }, ["--tools", "WebSearch", "--allowedTools", "WebSearch", "-p", "Search the web for gateway fixture query"]);
  assert.equal(result.is_error, false);
  assert.equal(result.result, "search-done");
  assert.equal(searches.length, 1);
  assert.equal(searches[0].body.model, "gpt-5.4");
  assert.equal(searches[0].payload.tools[0].type, "web_search");
  assert.equal(searches[0].payload.tool_choice, "required");
  const output = conversation[1].messages.find((message) => message.role === "tool" && message.tool_call_id === "call_search").content;
  assert.match(output, /Fixture Result Title/);
  assert.match(output, /https:\/\/fixture\.example\/result/);
});

for (const mode of ["threshold", "context-error", "oversized-summary"]) {
  test(`installed CLI compacts and resumes (${mode}) through the proxy`, { skip, timeout: 100000 }, async () => {
    let ordinary = 0;
    let compactions = 0;
    let resumed = false;
    let rejectedSummaryBytes;
    const observed = [];
    const { upstreamError } = require("../lib/upstream-error");
    const tooLong = () => upstreamError({ code: "context_length_exceeded", type: "invalid_request_error",
      message: "Your input exceeds the context window of this model." });
    const { result } = await runCli({
      // Claude Code compacts an anthropic/gpt-* model at its threshold only when this window is declared.
      envOverrides: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: mode === "context-error" ? "95" : "10", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000" },
      requestResponses: async (body, options) => {
        const summary = body.messages.some((message) =>
          typeof message.content === "string" && message.content.includes("Your task is to create a detailed summary of the conversation so far"));
        observed.push({ messages: body.messages.length, bytes: Buffer.byteLength(JSON.stringify(body.messages)), summary });
        if (summary) {
          compactions++;
          if (mode === "oversized-summary") {
            const bytes = Buffer.byteLength(JSON.stringify(body.messages));
            rejectedSummaryBytes ??= bytes;
            if (bytes >= rejectedSummaryBytes) throw tooLong();
          }
          const content = "The user asks to read fixture.txt and finish. The file contains compaction-fixture-marker. Continue and answer compact-resumed-ok.";
          if (!body.stream) return { content, finish_reason: "stop", usage };
          await options.onChunk({ choices: [{ delta: { content } }] });
          await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
          return { streamed: true };
        }
        ordinary++;
        if (mode === "context-error" && ordinary >= 2 && compactions === 0) throw tooLong();
        if (ordinary === 1) {
          await options.onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_fixture", function: {
            name: "Read", arguments: JSON.stringify({ file_path: "fixture.txt" })
          } }] } }] });
          await options.onChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }],
            usage: mode === "context-error" ? usage : { prompt_tokens: 190000, completion_tokens: 10, cached_tokens: 180000 } });
        } else {
          resumed = compactions > 0;
          assert.ok(JSON.stringify(body.messages).includes("compaction-fixture-marker"), "resume must preserve the summary's known fact");
          if (!body.stream) return { content: "compact-resumed-ok", finish_reason: "stop", usage };
          await options.onChunk({ choices: [{ delta: { content: "compact-resumed-ok" } }] });
          await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
        }
        return { streamed: true };
      }
    }, ["--tools", "Read", "--allowedTools", "Read", "--max-turns", "8", "--system-prompt", "Use Read to inspect fixture.txt, then finish.", "-p", "Read fixture.txt then answer compact-resumed-ok."]);
    assert.equal(result.is_error, false, JSON.stringify(result));
    assert.equal(result.result, "compact-resumed-ok", JSON.stringify(observed));
    assert.ok(compactions >= (mode === "oversized-summary" ? 2 : 1), "CLI must issue its own compaction requests: " + JSON.stringify(observed));
    if (mode === "oversized-summary") {
      const summaries = observed.filter((row) => row.summary);
      assert.ok(summaries.some((row) => row.bytes < summaries[0].bytes),
        "retrying compact must actually shrink the summary input, not repeat the oversized request: " + JSON.stringify(observed));
    }
    assert.ok(resumed, "CLI must resume the conversation after compaction");
    assert.ok(observed.some((row, index) => index > 0 && !row.summary && observed[index - 1].summary && row.messages < observed[index - 1].messages),
      "client must replace history with the compacted summary before continuing");
  });
}

// lib/claude-launch.js reads the catalog at launch; ONE CLI process then switches models with set_model.
// A local Anthropic endpoint serves the catalog and stands in for the gateway, so every turn stays offline.
test("launcher applies a fixed GPT window across GPT/Claude switching; compaction runs on the next turn", { skip, timeout: 200000 }, async () => {
  const summaryMarker = "Your task is to create a detailed summary of the conversation so far";
  const catalog = { object: "list", data: [{ id: "anthropic/gpt-6.1-sol", context_window: 872000 },
    { id: "claude-opus-5.5", context_window: 1000000 }] };
  let inputTokens = 1000;
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.method === "GET" || request.url.includes("count_tokens")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(request.method === "GET" ? JSON.stringify(request.url.startsWith("/v1/models") ? catalog : {}) : '{"input_tokens":10}');
        return;
      }
      const parsed = JSON.parse(body);
      const summary = JSON.stringify([parsed.system, parsed.messages]).includes(summaryMarker);
      if (parsed.stream !== true) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "msg_validation", type: "message", role: "assistant", model: parsed.model,
          content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
        return;
      }
      requests.push({ model: parsed.model, summary });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", model: parsed.model, content: [],
        stop_reason: null, usage: { input_tokens: summary ? 1000 : inputTokens, output_tokens: 1 } } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: summary ? "Summary: fixture conversation." : "ok" } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      send("message_stop", {});
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directories = [];
  // Opus reports 900K used; only a switch back to the 872K GPT window must compact before GPT is called.
  const run = async (switchBack, settingsOnly = false) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-switch-test-"));
    directories.push(directory);
    // A stale 1M gateway spelling in the environment still launches GPT at its catalog window.
    const env = { ...process.env, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: directory,
      OPENAI_API_KEY: "test-only-gpt-key", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
    for (const key of Object.keys(env)) {
      if (key === "CLAUDECODE" || key === "CLAUDE_CODE_MAX_CONTEXT_TOKENS" || key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_")) delete env[key];
    }
    Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "test-only" });
    // Settings-only launch: the model comes solely from user settings, with no ANTHROPIC_MODEL or --model.
    if (settingsOnly) fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ model: "gpt-6.1-sol" }));
    else env.ANTHROPIC_MODEL = "anthropic/gpt-6.1-sol[1m]";
    const child = require("child_process").spawn(process.execPath, [path.resolve("lib/claude-launch.js"), "-p", "--input-format", "stream-json",
      "--output-format", "stream-json", "--verbose", "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--no-session-persistence", "--tools", ""], { cwd: directory, env });
    let buffer = "";
    let pending;
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf("\n")) >= 0;) {
        let event;
        try { event = JSON.parse(buffer.slice(0, index)); } catch { event = null; }
        buffer = buffer.slice(index + 1);
        if (event?.type === "result" || event?.type === "control_response") { const resolve = pending; pending = null; resolve?.(event); }
      }
    });
    const send = (message) => new Promise((resolve) => { pending = resolve; child.stdin.write(JSON.stringify(message) + "\n"); });
    const turn = async (content, tokens) => {
      inputTokens = tokens;
      const before = requests.length;
      const result = await send({ type: "user", message: { role: "user", content } });
      return { requests: requests.slice(before), windows: Object.fromEntries(Object.entries(result.modelUsage).map(([id, usage]) => [id, usage.contextWindow])) };
    };
    const setModel = async (model) => {
      const result = await send({ type: "control_request", request_id: model, request: { subtype: "set_model", model } });
      assert.equal(result.response.subtype, "success", JSON.stringify(result));
    };
    try {
      const turns = [await turn("turn-1", 1000)];
      if (settingsOnly) return turns;
      await setModel("claude-opus-5.5[1m]");
      turns.push(await turn("turn-2", 900000));
      if (switchBack) await setModel("gpt-6.1-sol");
      turns.push(await turn("turn-3", 1000));
      return turns;
    } finally { child.stdin.end(); }
  };
  try {
    const switched = await run(true);
    assert.deepEqual(switched[0].windows, { "anthropic/gpt-6.1-sol": 872000 });
    assert.deepEqual(switched[1].windows, { "anthropic/gpt-6.1-sol": 872000, "claude-opus-5.5[1m]": 1000000 });
    assert.deepEqual(switched[1].requests.map((row) => row.summary), [false], "900K fits Opus's declared 1M window");
    assert.ok(switched[2].requests.some((row) => row.summary), "900K exceeds GPT's 872K window: " + JSON.stringify(switched[2].requests));
    assert.deepEqual(switched[2].requests.at(-1), { model: "gpt-6.1-sol", summary: false });
    const fromSettings = await run(false, true);
    assert.deepEqual(fromSettings[0].windows, { "gpt-6.1-sol": 872000 }, "settings-only model must get the catalog window");
    const stayed = await run(false);
    assert.ok(stayed[2].requests.every((row) => !row.summary), "staying on Opus must not compact: " + JSON.stringify(stayed[2].requests));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const directory of directories) await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("installed CLI manual compact recovers from oversized summary input and resumes the saved fixture session", { skip, timeout: 120000 }, async () => {
  let summaries = 0;
  let rejectedBytes;
  let resumedWithFact = false;
  const { upstreamError } = require("../lib/upstream-error");
  const { result, followUps } = await runCli({
    followUpPrompts: ["/compact", "What fixture fact did we keep?"],
    requestResponses: async (body, options) => {
      const serialized = JSON.stringify(body.messages);
      const summary = serialized.includes("Your task is to create a detailed summary of the conversation so far");
      let content;
      if (summary) {
        summaries++;
        const bytes = Buffer.byteLength(serialized);
        rejectedBytes ??= bytes;
        if (bytes >= rejectedBytes) throw upstreamError({ code: "context_length_exceeded", type: "invalid_request_error",
          message: "Your input exceeds the context window of this model." });
        content = "The user asked to retain the fixture fact manual-compact-marker. That fact must be preserved for the next question.";
      } else {
        resumedWithFact ||= summaries > 0 && serialized.includes("manual-compact-marker");
        content = summaries > 0 ? "manual-compact-marker" : "Recorded fixture fact: manual-compact-marker.";
      }
      if (!body.stream) return { content, finish_reason: "stop", usage };
      await options.onChunk({ choices: [{ delta: { content } }] });
      await options.onChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
      return { streamed: true };
    }
  }, ["--bare", "--tools", "", "--system-prompt", "Remember synthetic fixture facts.", "-p", "Remember the fixture fact manual-compact-marker."]);
  assert.equal(result.is_error, false);
  assert.equal(followUps.length, 2);
  assert.equal(followUps[0].is_error, false);
  assert.equal(followUps[1].is_error, false);
  assert.equal(followUps[1].result, "manual-compact-marker");
  assert.ok(summaries >= 2, "manual compact must shrink a rejected summary request");
  assert.ok(resumedWithFact, "the saved session must retain its fact after manual compaction");
});

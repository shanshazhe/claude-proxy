const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { createRequire } = require("module");
const { createCredentialStore } = require("../lib/credential-store");
const { buildLaunch } = require("../lib/claude-launch");
const { claudeEvents, claudeSse } = require("./helpers/claude-fixture");

for (const platform of ["mac", "windows"]) {
  test(`${platform} isolated HTTP gateway covers both providers, protected setup and read-only startup`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-e2e-"));
    const store = createCredentialStore({ directory: path.join(root, "store") });
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot);
    const settingsFile = path.join(configRoot, "settings.json");
    const original = Buffer.from('﻿{"env":{"KEEP":"yes"},"statusLine":{"type":"command","command":"existing"}}\n');
    fs.writeFileSync(settingsFile, original);
    const filename = path.resolve(platform, "proxy.js");
    const nativeRequire = createRequire(filename);
    const reserve = http.createServer();
    await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    let server;
    let router;
    const serviceCalls = [];
    const memoryCalls = [];
    const hudCalls = [];
    const upstream = [];
    const discoveryOptions = [];
    const invalidations = [];
    let authOptions;
    const usage = { input_tokens: 100, output_tokens: 3, input_tokens_details: { cached_tokens: 64 } };
    const openaiFetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      upstream.push({ url, payload });
      const item = { type: "message", id: "msg_mock", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "mock reply", annotations: [] }] };
      const native = { id: "resp_mock", status: "completed", output: [item], usage };
      assert.equal(payload.stream, true, "Pi must stream upstream even for a JSON client");
      const events = [
        { type: "response.created", response: { id: "resp_mock", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
          part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "mock reply" },
        { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "mock reply" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: native }
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } });
    };
    const citation = { type: "web_search_result_location", url: "https://example.com/", title: "Source", cited_text: "native reply" };
    const nativeBlocks = [
      { type: "thinking", thinking: "native thought", signature: "native-signature" },
      { type: "thinking", thinking: "", signature: "empty-signature" },
      { type: "redacted_thinking", data: "native-redacted-data" },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
      { type: "text", text: "native reply" }
    ];
    let claudeFailure;
    const nativeError = { type: "error", error: { type: "overloaded_error", message: "native failure" } };
    const copilotFetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      upstream.push({ url, payload });
      if (claudeFailure === "http") return new Response(JSON.stringify(nativeError), {
        status: 429, headers: { "Content-Type": "application/json", "retry-after": "12", "x-should-retry": "true" }
      });
      if (new URL(url).pathname.endsWith("/count_tokens")) {
        return new Response(JSON.stringify({ input_tokens: 42 }), { headers: { "Content-Type": "application/json" } });
      }
      assert.equal(payload.stream, true, "Pi Claude must stream upstream even for a JSON client");
      const events = claudeEvents({ model: payload.model, blocks: nativeBlocks,
        delta: { stop_reason: "stop_sequence", stop_sequence: "END", stop_details: { type: "native" } } });
      events.splice(events.findIndex((event) => event.type === "content_block_stop" && event.index === 5), 0,
        { type: "content_block_delta", index: 5, delta: { type: "citations_delta", citation } });
      if (claudeFailure === "sse") return claudeSse([events[0], nativeError]);
      if (claudeFailure === "incomplete") events.pop();
      return claudeSse(events, { "anthropic-ratelimit-requests-remaining": "9" });
    };
    const { requestPiModel } = nativeRequire("../lib/pi-model");
    const copilot = nativeRequire("../lib/github-copilot");
    const setup = nativeRequire("../lib/claude-setup");
    const auth = nativeRequire("../lib/auth-server");
    const observations = nativeRequire("../lib/online-summary");
    const context = {
      require: (name) => {
        if (name === "http") return { createServer: (handler) => { server = http.createServer(handler); return server; } };
        if (name === "../lib/macos-service") return { createMacosService: (options) => {
          serviceCalls.push(options);
          return { getStatus: async () => ({ supported: platform === "mac", ready: true, instance: { pid: 42, installationId: "invalid-private-id" } }),
            configure: async () => ({ status: 200, body: { state: "already_registered" } }) };
        } };
        if (name === "../lib/project-memory-install") return { createProjectMemoryInstaller: (options) => {
          assert.equal(options.configRoot, configRoot);
          memoryCalls.push("factory");
          return { getStatus: async () => ({ enabled: false, installed: false, ready: true, state: "absent" }),
            configure: async (enabled) => { memoryCalls.push(enabled); observations.setFeatures({ projectMemory: enabled }, path.join(root, "features.json"));
              return { ok: true, changed: true, replaced: enabled, enabled, installed: enabled, ready: true, state: enabled ? "installed" : "absent" }; },
            autoEnable: async () => { memoryCalls.push("autoEnable"); return null; } };
        } };
        if (name === "../lib/project-memory-maintainer") return { createProjectMemoryMaintainer: (options) => {
          assert.equal(typeof options.complete, "function");
          return { enqueue: () => { throw new Error("Unexpected maintenance job in provider routing test"); } };
        } };
        if (name === "../lib/credential-store") return { defaultStore: store };
        if (name === "../lib/model-discovery") return { createModelDiscovery: ({ gptOnly = false } = {}) => Object.assign(async (options) => {
          discoveryOptions.push({ ...options, gptOnly });
          return { object: "list", data: gptOnly ? [{ id: "gpt-test", owned_by: "openai", api: "openai-responses", context_window: 872000 }]
            : [{ id: "gpt-test", owned_by: "openai", api: "openai-responses" }, { id: "claude-sonnet-test", owned_by: "github-copilot", api: "anthropic-messages" }] };
        }, { invalidate: () => invalidations.push(gptOnly) }) };
        if (name === "../lib/auth-server") return { createAuthRouter: (options) => { authOptions = options; router = auth.createAuthRouter(options); return router; } };
        if (name === "../lib/claude-setup") return { ...setup, getClaudeConfigRoot: () => configRoot,
          createClaudeSetup: (options) => setup.createClaudeSetup({ ...options, env: {}, configRoot,
            platform: platform === "windows" ? "win32" : "darwin",
            installer: nativeRequire("../lib/statusline-install").createStatuslineInstaller({ configRoot }),
            probe: async () => ({ cli: true, ...(platform === "windows"
              ? { claudeCommand: { file: "claude.exe", args: [] } }
              : { bash: "/bin/bash", jq: "test-jq" }) }),
            hudInstaller: { async install() {
                hudCalls.push("install");
                const latest = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
                fs.writeFileSync(settingsFile, JSON.stringify({ ...latest, enabledPlugins: { ...latest.enabledPlugins, "claude-hud@claude-hud": true } }));
                return { success: true, kind: "claude-hud", message: "Run /reload-plugins, then /hud." };
              } }
          }) };
        if (name === "../lib/online-summary") return { ...observations,
          createOnlineSummary: (options) => observations.createOnlineSummary({
            ...options, configFile: path.join(root, "features.json"), archiveRoot: path.join(root, "observations") }),
          createSummarySettings: (options) => observations.createSummarySettings({ ...options, configFile: path.join(root, "features.json") }) };
        if (name === "../lib/pi-model") return { requestPiModel: (body, options) => requestPiModel(body, {
          ...options, fetchImpl: body.model.startsWith("claude-") ? copilotFetch : openaiFetch,
          loadAuth: async () => body.model.startsWith("claude-")
            ? { token: "mock-only", baseUrl: "https://mock.example" } : { kind: "api", token: "mock-only" } }) };
        if (name === "../lib/pi-capabilities") return { ...nativeRequire(name), countTokens: (body, req, res) => copilot.forwardClaudeCount(body, req, res, {
          fetchImpl: copilotFetch, loadAuth: async () => ({ token: "mock-only", baseUrl: "https://mock.example" }) }) };
        return nativeRequire(name);
      },
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
      console: { log() {}, warn() {}, error() {} }
    };
    const source = fs.readFileSync(filename, "utf8").split("\nsyncClaudeSettings();")[0].replace("const PORT = 8082;", `const PORT = ${port};`);
    vm.runInNewContext(source + "\nsyncClaudeSettings();", context, { filename });
    assert.deepEqual(memoryCalls, ["factory"]);
    assert.equal(serviceCalls.length, 1);
    assert.equal(serviceCalls[0].proxyPath, filename);
    assert.equal(serviceCalls[0].port, port);
    assert.equal(typeof serviceCalls[0].onHandoff, "function");
    assert.deepEqual(fs.readFileSync(settingsFile), original);
    assert.equal(fs.existsSync(path.join(configRoot, "claude-proxy")), false);
    assert.equal(fs.existsSync(store.directory), false);
    assert.equal(fs.existsSync(path.join(root, "features.json")), false);
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    t.after(async () => { router.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await (await fetch(base + "/health")).json()).status, "ok");
    assert.equal((await fetch(base + "/features")).status, 200);
    const page = await fetch(base + "/login");
    const nonce = (await page.text()).match(/nonce="([a-zA-Z0-9_-]+)"/)[1];
    const headers = { "X-Auth-Nonce": nonce, Origin: base, "Content-Type": "application/json" };
    assert.equal((await fetch(base + "/api/auth/status", { headers })).status, 200);
    assert.deepEqual(fs.readFileSync(settingsFile), original);
    assert.deepEqual(memoryCalls, ["factory"]);
    assert.equal(fs.existsSync(path.join(configRoot, "skills")), false);
    const memory = await fetch(base + "/api/auth/project-memory/configure", { method: "POST", headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(memory.status, 200);
    const memoryResult = await memory.json();
    assert.equal(memoryResult.installed, true);
    assert.equal(memoryResult.replaced, true);
    assert.equal(memory.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(memoryCalls, ["factory", true]);
    const models = await (await fetch(base + "/v1/models?limit=1000")).json();
    assert.deepEqual(models.data.map((model) => model.id), ["anthropic/openai/gpt-test", "anthropic/claude-sonnet-test"]);
    assert.equal(discoveryOptions.at(-1)?.waitForRefresh, false);
    assert.equal(discoveryOptions.at(-1)?.gptOnly, false);
    for (const [value, expected] of [["true", true], ["false", false], ["invalid", false]]) {
      const refreshed = await (await fetch(base + "/v1/models?wait_for_refresh=" + value)).json();
      assert.deepEqual(refreshed, models);
      assert.equal(discoveryOptions.at(-1)?.waitForRefresh, expected);
      assert.equal(discoveryOptions.at(-1)?.gptOnly, false);
      const scoped = await (await fetch(base + "/v1/models?provider=gpt&wait_for_refresh=" + value)).json();
      assert.deepEqual(scoped.data.map((model) => model.id), ["anthropic/openai/gpt-test"]);
      assert.equal(scoped.data[0].context_window, 872000);
      assert.equal(discoveryOptions.at(-1)?.waitForRefresh, expected);
      assert.equal(discoveryOptions.at(-1)?.gptOnly, true);
    }
    assert.deepEqual(await (await fetch(base + "/v1/models")).json(), models, "GPT-only requests must not narrow the /model menu");
    authOptions.onCredentialsChanged();
    assert.deepEqual(invalidations.sort(), [false, true], "credential changes invalidate both independent caches");
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    for (const model of ["anthropic/openai/gpt-test", "anthropic/claude-sonnet-test"]) {
      for (const stream of [false, true]) {
        const result = await fetch(base + "/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream, max_tokens: 50, system: "instructions", messages: [{ role: "user", content: [{ type: "text", text: "look" }, image] }],
            tools: [{ name: "Edit", input_schema: { type: "object" } }] }) });
        assert.equal(result.status, 200);
        assert.equal(result.headers.get("content-type"), stream ? "text/event-stream" : "application/json");
        const text = await result.text();
        assert.match(text, /cache_read_input_tokens["\s:]+64/);
        assert.ok(text.includes(model.startsWith("anthropic/openai/") ? "mock reply" : "native reply"));
        if (stream) {
          assert.match(text, /message_stop/);
          const start = text.split("\n\n").find((frame) => frame.startsWith("event: message_start\n"));
          assert.equal(JSON.parse(start.split("\ndata: ")[1]).message.model, model);
        } else {
          assert.equal(JSON.parse(text).type, "message");
          assert.equal(JSON.parse(text).model, model);
          assert.equal(JSON.parse(text).usage.input_tokens, 36);
        }
        if (model.startsWith("claude-")) {
          assert.equal(result.headers.get("anthropic-ratelimit-requests-remaining"), "9");
          if (stream) {
            const events = text.split("\n\n").filter((frame) => frame.startsWith("event:"))
              .map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
            assert.equal(events[0].message.id, "msg_mock");
            assert.equal(events[0].message.usage.input_tokens, 36);
            assert.equal(events[0].message.usage.cache_read_input_tokens, 64);
            const starts = events.filter((event) => event.type === "content_block_start");
            assert.deepEqual(starts.map((event) => event.content_block.type), nativeBlocks.map((block) => block.type));
            assert.deepEqual(events.filter((event) => event.delta?.type === "signature_delta").map((event) => event.delta.signature),
              ["native-signature", "empty-signature"]);
            assert.equal(starts[2].content_block.data, "native-redacted-data");
            assert.equal(events.find((event) => event.delta?.type === "citations_delta").index, 5);
            assert.deepEqual(events.at(-2).delta,
              { stop_reason: "stop_sequence", stop_sequence: "END", stop_details: { type: "native" } });
          } else {
            const message = JSON.parse(text);
            assert.deepEqual(message.content, nativeBlocks.map((block) => block.type === "text" ? { ...block, citations: [citation] } : block));
            assert.equal(message.stop_reason, "stop_sequence");
            assert.equal(message.stop_sequence, "END");
            assert.deepEqual(message.stop_details, { type: "native" });
          }
        }
      }
    }
    assert.equal(upstream.length, 4);
    assert.deepEqual(upstream.map((request) => request.payload.model), ["gpt-test", "gpt-test", "claude-sonnet-test", "claude-sonnet-test"]);
    assert.equal(upstream[0].payload.input[1].content[1].type, "input_image");
    assert.equal(upstream[0].payload.tools[0].type, "function");
    assert.equal(upstream[2].payload.messages[0].content[1].type, "image");
    for (const request of upstream) assert.equal(request.payload.tools.at(-1).name, "ProjectMemoryUpdate");
    assert.equal(upstream[0].payload.input[0].role, "developer");
    assert.match(JSON.stringify(upstream[0].payload.input[0].content), /ProjectMemoryUpdate/);
    assert.match(upstream[2].payload.system.at(-1).text, /ProjectMemoryUpdate/);
    const tokenCount = await fetch(base + "/v1/messages/count_tokens?beta=true", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-test", messages: [{ role: "user", content: "count only" }] }) });
    assert.equal(tokenCount.status, 200);
    assert.deepEqual(await tokenCount.json(), { input_tokens: 42 });
    assert.equal(upstream.length, 5);
    assert.equal(new URL(upstream.at(-1).url).pathname, "/v1/messages/count_tokens");
    assert.equal(upstream.at(-1).payload.tools, undefined);
    for (const failure of ["http", "sse", "incomplete"]) {
      claudeFailure = failure;
      for (const stream of [false, true]) {
        const result = await fetch(base + "/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-test", stream, messages: [{ role: "user", content: "fail" }] }) });
        const text = await result.text();
        if (failure === "http" || !stream) {
          assert.equal(result.status, failure === "http" ? 429 : 502);
          assert.match(result.headers.get("content-type"), /application\/json/);
          if (failure !== "incomplete") assert.deepEqual(JSON.parse(text), nativeError);
          else assert.equal(JSON.parse(text).type, "error");
          if (failure === "http") {
            assert.equal(result.headers.get("retry-after"), "12");
            assert.equal(result.headers.get("x-should-retry"), "true");
            assert.ok(!text.includes("message_start"));
          }
        } else {
          assert.equal(result.status, 200);
          const events = text.split("\n\n").filter((frame) => frame.startsWith("event:"))
            .map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
          assert.equal(events[0].type, "message_start");
          assert.equal(events.at(-1).type, "error");
          if (failure === "sse") assert.deepEqual(events.at(-1), nativeError);
          assert.ok(!events.some((event) => ["message_stop", "message_delta"].includes(event.type)), "a failed stream must not finish as success");
        }
      }
    }
    claudeFailure = undefined;
    for (const stream of [false, true]) {
      const launched = buildLaunch(models, ["--model", "gpt-test"], {});
      assert.deepEqual(launched.args, ["--model", "anthropic/openai/gpt-test"]);
      const result = await fetch(base + "/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream, messages: [{ role: "user", content: "hello" }] }) });
      assert.equal(result.status, 200);
      const text = await result.text();
      const start = stream && text.split("\n\n").find((frame) => frame.startsWith("event: message_start\n"));
      const message = stream ? JSON.parse(start.split("\ndata: ")[1]).message : JSON.parse(text);
      assert.equal(message.model, launched.args[1]);
      assert.equal(upstream.at(-1).payload.model, "gpt-test");
    }
    const disabledMemory = await fetch(base + "/api/auth/project-memory/configure", { method: "POST", headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(disabledMemory.status, 200);
    const disabledResult = await disabledMemory.json();
    assert.equal(disabledResult.enabled, false);
    assert.equal(disabledResult.replaced, false);
    assert.deepEqual(memoryCalls, ["factory", true, false]);
    const count = upstream.length;
    for (const model of ["unknown-model", "anthropic/unsupported", "gpt-oss-20b", "claude-gateway/gpt-test", "claude-gateway/claude-sonnet-test"]) {
      const result = await fetch(base + "/v1/messages", { method: "POST", body: JSON.stringify({ model, messages: [] }) });
      assert.equal(result.status, 400);
    }
    assert.equal(upstream.length, count);
    store.saveLogin("openai", { type: "api_key", key: "mock-only" });
    const configured = await fetch(base + "/api/auth/claude/configure", { method: "POST", headers, body: "{}" });
    assert.equal(configured.status, 200);
    const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(saved.env.KEEP, "yes");
    assert.equal(saved.env.ANTHROPIC_MODEL, undefined);
    assert.equal(saved.env.ANTHROPIC_BASE_URL, "http://localhost:8082");
    assert.equal(saved.statusLine.command, "existing");
    const backups = path.join(configRoot, "claude-proxy", "settings-backups");
    assert.deepEqual(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0])), original);
    const state = await (await fetch(base + "/api/auth/status", { headers })).json();
    assert.equal(state.statusline.ready, true);
    assert.equal(state.statusline.kind, platform === "windows" ? "claude-hud" : "statusline");
    assert.deepEqual(hudCalls, []);
    assert.equal(state.macosService.instance, undefined);
    const serviceResult = await fetch(base + "/api/auth/macos/service/configure", { method: "POST", headers, body: "{}" });
    assert.equal(serviceResult.status, 200);
    assert.equal((await serviceResult.json()).state, "already_registered");
    assert.equal(serviceResult.headers.get("access-control-allow-origin"), null);
    const statusline = await fetch(base + "/api/auth/statusline/configure", { method: "POST", headers, body: "{}" });
    assert.equal(statusline.status, 200);
    assert.equal((await statusline.json()).success, true);
    const latest = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.deepEqual(latest.env, saved.env);
    if (platform === "windows") {
      assert.equal(latest.statusLine.command, "existing");
      assert.equal(latest.enabledPlugins["claude-hud@claude-hud"], true);
      assert.deepEqual(hudCalls, ["install"]);
    } else {
      assert.notEqual(latest.statusLine.command, "existing");
      assert.deepEqual(hudCalls, []);
    }
  });
}

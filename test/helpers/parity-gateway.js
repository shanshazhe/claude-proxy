"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const { createRequire, isBuiltin } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const baseline = "3154dc1cbcf71756d5054747ac102b7bc48086a8";
const baselineSources = new Map();
const entry = "windows/proxy.js";
const productionRequire = createRequire(path.join(root, entry));

function readSource(file, old) {
  if (!old) return fs.readFileSync(path.join(root, file), "utf8");
  if (!baselineSources.has(file)) {
    try {
      baselineSources.set(file, execFileSync("git", ["show", `${baseline}:${file}`], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
      }));
    } catch (cause) {
      throw new Error(`Parity tests require baseline ${baseline} and its source blobs in the local Git history (${file}).`, { cause });
    }
  }
  return baselineSources.get(file);
}

async function parityGateway(t, { old, route, routes = [route], auth, loadAuth = async () => auth, fetchImpl }) {
  let server;
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-parity-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const noNetwork = () => assert.fail("Unexpected network call outside the injected upstream");
  const sandbox = vm.createContext({ Buffer, URL, Response, TextDecoder, TextEncoder, AbortController, AbortSignal,
    structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, fetch: noNetwork,
    process: { env: {}, platform: process.platform }, console: { log() {}, warn() {}, error() {} } });
  const stubs = new Map([
    ["lib/model-discovery.js", { createModelDiscovery: () => async () => ({ data: routes }) }],
    ["lib/online-summary.js", { createOnlineSummary: () => ({ prepare: async (body) => ({ body, stats: {} }), getStatus: () => ({}) }), createSummarySettings: () => ({}) }],
    ["lib/summary-model.js", { createSummaryModel: () => ({}) }],
    ["lib/credential-store.js", { defaultStore: {} }],
    ["lib/auth-server.js", { createAuthRouter: () => async () => false }],
    ["lib/claude-setup.js", { createClaudeSetup: () => ({}), getClaudeConfigRoot: () => fixtureRoot }],
    ["lib/macos-service.js", { createMacosService: () => ({}) }],
    ["lib/project-memory-install.js", { createProjectMemoryInstaller: () => ({}) }],
    ["lib/claude-launcher-install.js", { createClaudeLauncherInstaller: () => ({}) }],
    ["lib/coding-discipline-install.js", { createCodingDisciplineInstaller: () => ({}) }],
    ["lib/project-memory-maintainer.js", { createProjectMemoryMaintainer: () => ({}) }],
    ["lib/pi-auth.js", { loadPiAuth: async () => auth }],
    ["lib/copilot-auth.js", { loadCopilotAuth: async () => auth, COPILOT_HEADERS: {} }]
  ]);
  const cache = new Map();
  function load(file) {
    if (stubs.has(file)) return stubs.get(file);
    if (cache.has(file)) return cache.get(file).exports;
    const filename = path.join(root, file);
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = (name) => {
      if (file === entry && name === "http") return { createServer(handler) { server = http.createServer(handler); return server; } };
      if (isBuiltin(name)) return require(name);
      assert.ok(name.startsWith("."), `Unexpected dependency ${name}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
      assert.match(resolved, /^lib\//);
      const dependency = path.posix.extname(resolved) ? resolved : `${resolved}.js`;
      if (!old && dependency === "lib/pi-model.js") {
        const { requestPiModel } = productionRequire(name);
        return { requestPiModel: (body, options) => requestPiModel(body, { ...options, loadAuth: () => loadAuth(body.model), fetchImpl }) };
      }
      const actual = load(dependency);
      if (old && file === entry && dependency === "lib/openai-responses.js") {
        return { ...actual, requestResponses: (body, options) => actual.requestResponses(body, { ...options, fetchImpl }) };
      }
      if (old && file === entry && dependency === "lib/github-copilot.js") {
        return { ...actual, forwardClaudeRequest: (body, req, res, options) => actual.forwardClaudeRequest(body, req, res, { ...options, fetchImpl }) };
      }
      return actual;
    };
    let source = readSource(file, old);
    if (file === entry) {
      const parts = source.split(/\r?\nsyncClaudeSettings\(\);/);
      assert.equal(parts.length, 2, "Gateway test boundary moved");
      source = parts[0];
    }
    vm.compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], {
      filename, parsingContext: sandbox
    })(module.exports, localRequire, module, filename, path.dirname(filename));
    return module.exports;
  }
  load(entry);
  assert.ok(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return async (body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(response.headers.get("content-type"), body.stream ? /^text\/event-stream/ : /^application\/json/);
    return body.stream ? assembleSse(text) : JSON.parse(text);
  };
}

function assembleSse(text) {
  const events = text.split(/\r?\n\r?\n/).filter((frame) => frame.startsWith("event:")).map((frame) => {
    const [name, data] = frame.split(/\r?\n/);
    const event = JSON.parse(data.replace(/^data: /, ""));
    assert.equal(name, `event: ${event.type}`);
    return event;
  });
  assert.equal(events[0]?.type, "message_start", text);
  assert.equal(events.at(-1)?.type, "message_stop", text);
  assert.equal(events.at(-2)?.type, "message_delta", text);
  const message = events[0].message;
  assert.deepEqual(message.content, []);
  let open = null;
  let json = "";
  for (const event of events.slice(1, -2)) {
    if (event.type === "content_block_start") {
      assert.equal(open, null, "previous block must close before starting another");
      assert.equal(event.index, message.content.length);
      open = event.index;
      json = "";
      message.content.push(event.content_block);
    } else {
      assert.notEqual(open, null);
      assert.equal(event.index, open);
      const block = message.content[open];
      if (event.type === "content_block_stop") {
        if (json) block.input = JSON.parse(json);
        open = null;
      } else {
        assert.equal(event.type, "content_block_delta");
        const { delta } = event;
        switch (delta.type) {
          case "text_delta": assert.equal(block.type, "text"); block.text += delta.text; break;
          case "thinking_delta": assert.equal(block.type, "thinking"); block.thinking += delta.thinking; break;
          case "signature_delta": assert.equal(block.type, "thinking"); block.signature = (block.signature || "") + delta.signature; break;
          case "input_json_delta": assert.ok(["tool_use", "server_tool_use"].includes(block.type)); json += delta.partial_json; break;
          default: assert.fail(`Unexpected delta ${delta.type}`);
        }
      }
    }
  }
  assert.equal(open, null);
  const final = events.at(-2);
  return { ...message, ...final.delta, usage: { ...message.usage, ...final.usage } };
}

module.exports = { parityGateway };

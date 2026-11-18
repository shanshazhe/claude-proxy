const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAuthRouter, MAX_AUTH_BODY_BYTES } = require("../lib/auth-server");
const { createCredentialStore } = require("../lib/credential-store");
const { createModelDiscovery } = require("../lib/model-discovery");
const { createDeviceLogin } = require("../lib/device-login");
const { createClaudeSetup } = require("../lib/claude-setup");

function request(port, route, { method = "GET", headers = {}, body, hostname = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: route, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-http-"));
  const store = createCredentialStore({ directory });
  let router;
  const server = http.createServer(async (req, res) => {
    if (await router(req, res)) return;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end("model API");
  });
  await new Promise((resolve) => server.listen(0, "::", resolve));
  const port = server.address().port;
  const { setupFactory, ...routerOptions } = options;
  router = createAuthRouter({ port, store, env: { OPENAI_API_KEY: "private-env-secret" }, setup: setupFactory?.(store), ...routerOptions });
  t.after(async () => {
    router.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const page = await request(port, "/login");
  assert.equal(page.status, 200);
  const nonce = page.text.match(/nonce="([a-zA-Z0-9_-]+)"/)[1];
  const headers = { "X-Auth-Nonce": nonce, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` };
  const api = (route, options = {}) => request(port, route, { ...options, headers: { ...headers, ...options.headers } });
  return { port, router, page, nonce, store, api };
}

test("local page and APIs have no wildcard CORS, no-cache and nonce CSP, including OPTIONS", async (t) => {
  const { port, page, nonce, api } = await fixture(t);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.ok(page.headers["content-security-policy"].includes(`script-src 'nonce-${nonce}'`));
  assert.ok(!page.text.includes("__AUTH_NONCE__"));
  assert.ok(page.text.includes('<html lang="en">'));
  for (const label of ["Local Account Settings", "Login ChatGPT", "Login Copilot", "Configure Claude CLI"]) {
    assert.ok(page.text.includes(label));
  }
  assert.doesNotMatch(page.text, /[㐀-鿿]/);
  assert.equal(page.headers["access-control-allow-origin"], undefined);
  for (const route of ["/login", "/api/auth/status", "/api/auth/copilot/start", "/api/auth/chatgpt/start", "/api/auth/unknown"]) {
    const response = await request(port, route, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(response.status, 405);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
  assert.equal((await api("/api/auth/status")).status, 200);
  assert.equal((await request(port, "/v1/models")).headers["access-control-allow-origin"], "*");
});

test("Host, loopback, nonce, Origin and JSON guards reject cross-site requests", async (t) => {
  const { port, api, router, nonce } = await fixture(t);
  for (const host of ["evil.example", `evil.example:${port}`, `localhost:${port + 1}`, "localhost", `127.0.0.2:${port}`, `localhost:${port}@evil.example`]) {
    const rejected = await request(port, "/login", { headers: { Host: host } });
    assert.equal(rejected.status, 403);
    assert.ok(!JSON.stringify(rejected).includes(nonce));
  }
  for (const origin of ["https://evil.example", "null", "", `http://localhost:${port}`, `https://127.0.0.1:${port}`]) {
    assert.equal((await api("/api/auth/chatgpt/start", { method: "POST", body: '{"keys":"no"}', headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await request(port, "/api/auth/status")).status, 403);
  assert.equal((await api("/api/auth/status", { headers: { "X-Auth-Nonce": "wrong" } })).status, 403);
  assert.equal((await api("/api/auth/chatgpt/start", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } })).status, 403);
  // Remote connection guard cannot be bypassed by a legitimate Host.
  let status;
  const responseHeaders = {};
  const res = { setHeader(name, value) { responseHeaders[name] = value; }, writeHead(code) { status = code; }, end() {} };
  await router({ url: "/login", method: "GET", headers: { host: `localhost:${port}` }, socket: { remoteAddress: "192.0.2.1" } }, res);
  assert.equal(status, 403);
  assert.ok(!JSON.stringify(responseHeaders).includes(nonce));
  assert.ok(responseHeaders["Content-Security-Policy"].includes("default-src 'none'"));
  assert.equal((await request(port, "/api/auth/chatgpt/start", { method: "POST", body: '{"keys":"not-saved"}',
    headers: { "X-Auth-Nonce": nonce, "Content-Type": "application/json" } })).status, 403);
});

test("localhost IPv4 and IPv6 page access works with explicit loopback Hosts", async (t) => {
  const { port } = await fixture(t);
  for (const hostname of ["localhost", "127.0.0.1", "::1"]) {
    assert.equal((await request(port, "/login", { hostname })).status, 200);
  }
});
test("device start and flow polling use snapshots without invalidating catalogs before success", async (t) => {
  const flows = new Map();
  const started = [];
  let invalidateCount = 0;
  const login = { start: async (provider) => {
    started.push(provider);
    const flow = { id: provider, provider, status: "pending", userCode: "USER-CODE", verificationUrl: "https://github.com/login/device" };
    flows.set(provider, flow);
    return flow;
  }, get: (id) => flows.get(id), close() {} };
  const { api } = await fixture(t, { login, onCredentialsChanged: () => invalidateCount++ });
  for (const provider of ["chatgpt", "copilot"]) {
    const startedFlow = await api(`/api/auth/${provider}/start`, { method: "POST", body: "{}" });
    assert.equal(startedFlow.status, 200);
    assert.equal(JSON.parse(startedFlow.text).provider, provider);
    assert.equal((await api(`/api/auth/flow/${provider}`)).text, startedFlow.text);
  }
  assert.deepEqual(started, ["chatgpt", "copilot"]);
  assert.equal((await api("/api/auth/flow/missing")).status, 404);
  assert.equal(invalidateCount, 0); // Starting is not a successful login.
});

test("real HTTP device completion persists login, hides secrets and invalidates a cached catalog", async (t) => {
  let service;
  let store;
  const discover = createModelDiscovery({
    loadClaudeAuth: async () => { throw new Error("no auth"); },
    loadAuth: async () => {
      if (!store.readAuth()["openai-codex"]) throw new Error("no auth");
      return { kind: "codex", token: "mock", accountId: "account" };
    },
    fetchImpl: async () => new Response(JSON.stringify({ models: [{ slug: "gpt-test", visibility: "list" }] }))
  });
  const result = await fixture(t, { login: {
    start: (provider) => service.start(provider), get: (id) => service.get(id), close: () => service?.close()
  }, onCredentialsChanged: discover.invalidate });
  store = result.store;
  const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;
  service = createDeviceLogin({ store, onCredentialsChanged: discover.invalidate, fetchImpl: async (url) => {
    if (url.endsWith("/usercode")) return new Response(JSON.stringify({ device_auth_id: "private-device", user_code: "USER-CODE", interval: 1 }));
    if (url.endsWith("/deviceauth/token")) return new Response(JSON.stringify({ authorization_code: "private-code", code_verifier: "private-verifier" }));
    return new Response(JSON.stringify({ access_token: access, refresh_token: "private-refresh", expires_in: 3600 }));
  } });
  assert.deepEqual((await discover()).data, []);
  const start = await result.api("/api/auth/chatgpt/start", { method: "POST", body: "{}" });
  const id = JSON.parse(start.text).id;
  let flow;
  for (let attempt = 0; attempt < 20; attempt++) {
    flow = await result.api(`/api/auth/flow/${id}`);
    if (JSON.parse(flow.text).status === "complete") break;
  }
  assert.equal(JSON.parse(flow.text).status, "complete");
  assert.ok(store.readAuth()["openai-codex"].loginVersion);
  assert.equal((await discover()).data[0].id, "gpt-test");
  for (const secret of [access, "private-device", "private-code", "private-verifier", "private-refresh"]) {
    assert.ok(!start.text.includes(secret));
    assert.ok(!flow.text.includes(secret));
    assert.ok(!(await result.api("/api/auth/status")).text.includes(secret));
  }
});

test("Project Code Memory configure route enforces guards, validates bodies, sanitizes status and maps errors", async (t) => {
  const calls = [];
  let failure;
  const service = { getStatus: async () => ({ enabled: false, installed: false, ready: true, state: "absent", reason: "unsafe-reason", notice: "unsafe-value", secret: "/private" }), configure: async (enabled) => { calls.push(enabled); if (failure) throw failure; return { ok: true, changed: true, replaced: enabled ? "yes" : true, enabled, installed: enabled, ready: true, state: enabled ? "installed" : "absent", secret: "/private" }; } };
  const { api, port, router, nonce } = await fixture(t, { projectMemory: service });
  const route = "/api/auth/project-memory/configure";
  let remoteStatus;
  await router({ url: route, method: "POST", headers: { host: `localhost:${port}`, "x-auth-nonce": nonce }, socket: { remoteAddress: "192.0.2.1" } }, { setHeader() {}, writeHead(code) { remoteStatus = code; }, end() {} });
  assert.equal(remoteStatus, 403);
  const status = JSON.parse((await api("/api/auth/status")).text);
  assert.deepEqual(Object.keys(status.projectMemory).sort(), ["enabled", "installed", "notice", "ready", "reason", "state"]);
  assert.equal(status.projectMemory.enabled, false); assert.ok(!(await api("/api/auth/status")).text.includes("/private"));
  for (const headers of [{ "X-Auth-Nonce": "wrong" }, { Origin: "https://evil.example" }, { "Content-Type": "text/plain" }, { Host: "evil.example" }]) assert.equal((await api(route, { method: "POST", body: '{"enabled":true}', headers })).status, 403);
  assert.equal((await api(route, { method: "OPTIONS" })).status, 405);
  assert.equal((await api(route)).status, 404);
  assert.equal((await request(port, route, { method: "POST", body: '{"enabled":true}' })).status, 403);
  for (const body of ["{}", '{"enabled":"yes"}', '{"enabled":true,"extra":1}', "null", "[]", "1", "\"text\"", "", "{bad}"]) assert.equal((await api(route, { method: "POST", body })).status, 400);
  assert.deepEqual(calls, []);
  for (const enabled of [true, false]) {
    const result = await api(route, { method: "POST", body: JSON.stringify({ enabled }) });
    assert.equal(result.status, 200); assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(result.text).enabled, enabled); assert.equal(JSON.parse(result.text).changed, true);
    assert.equal(JSON.parse(result.text).replaced, !enabled);
    assert.equal(typeof JSON.parse(result.text).replaced, "boolean");
    assert.ok(!result.text.includes("/private"));
  }
  assert.deepEqual(calls, [true, false]);
  failure = Object.assign(new Error("secret raw output"), { code: "PROJECT_MEMORY_CONFLICT" });
  let conflict = await api(route, { method: "POST", body: '{"enabled":true}' });
  assert.equal(conflict.status, 409); assert.match(conflict.text, /skill folder changed during installation/); assert.ok(!conflict.text.includes("secret"));
  conflict = await api(route, { method: "POST", body: '{"enabled":false}' });
  assert.equal(conflict.status, 409); assert.match(conflict.text, /Gateway maintenance is off/);
  failure = Object.assign(new Error("secret raw output"), { code: "EIO" });
  const failed = await api(route, { method: "POST", body: '{"enabled":true}' });
  assert.equal(failed.status, 503); assert.match(failed.text, /Python 3.9\+/); assert.ok(!failed.text.includes("secret"));
  assert.equal((await api(route, { method: "POST", body: " ".repeat(MAX_AUTH_BODY_BYTES + 1) })).status, 413);
  assert.equal((await api("/api/auth/project-memory/install", { method: "POST", body: "{}" })).status, 404);
});

test("Project Code Memory installs independently of damaged settings and absent proxy credentials", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcm-http-independent-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "settings.json"), "{damaged settings");
  const projectMemory = require("../lib/project-memory-install").createProjectMemoryInstaller({ configRoot: root,
    featureFile: path.join(root, "gateway-features.json"), probe: async () => ({ cli: true, python: true }) });
  const { api } = await fixture(t, { env: {}, projectMemory, setupFactory: (store) => createClaudeSetup({ configRoot: root, store, env: {},
    probe: async () => ({ cli: true }) }) });
  const status = JSON.parse((await api("/api/auth/status")).text);
  assert.equal(status.claudeCli.ready, false);
  assert.equal(status.chatgpt.configured, false);
  assert.equal(status.projectMemory.ready, true);
  const response = await api("/api/auth/project-memory/configure", { method: "POST", body: '{"enabled":true}' });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).installed, true);
  assert.equal(JSON.parse(response.text).enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "gateway-features.json"), "utf8")).projectMemory, true);
  assert.equal(fs.readFileSync(path.join(root, "settings.json"), "utf8"), "{damaged settings");
});

test("a conflicting Project Code Memory skill remains selectable and reports the safe backup location", async (t) => {
  const projectMemory = {
    getStatus: async () => ({ enabled: false, installed: false, ready: true, state: "conflict", reason: "/private/project/skill" }),
    configure: async (enabled) => ({ ok: true, changed: true, replaced: true, enabled, installed: enabled, ready: true, state: "installed" })
  };
  const { api } = await fixture(t, { projectMemory });
  const statusResponse = await api("/api/auth/status");
  const status = JSON.parse(statusResponse.text).projectMemory;
  assert.deepEqual([status.ready, status.state], [true, "conflict"]);
  assert.match(status.reason, /Turning this on backs up .*claude-proxy\/skill-backups\//i);
  assert.match(status.reason, /then installs the query-only skill/i);
  assert.ok(!statusResponse.text.includes("/private/project/skill"));
  assert.ok(!statusResponse.text.includes("/Users/"));

  const configured = await api("/api/auth/project-memory/configure", { method: "POST", body: '{"enabled":true}' });
  const result = JSON.parse(configured.text);
  assert.equal(configured.status, 200);
  assert.equal(result.enabled, true);
  assert.equal(result.replaced, true);
  assert.equal(typeof result.replaced, "boolean");
});

test("real Project Code Memory conflicts require dependencies and return a private backup result", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcm-http-replace-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "skills/project-code-memory");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "SKILL.md"), "user skill");
  let ready = false;
  let clock = 0;
  const projectMemory = require("../lib/project-memory-install").createProjectMemoryInstaller({ configRoot: root,
    featureFile: path.join(root, "gateway-features.json"), now: () => clock, probe: async () => ({ cli: true, python: ready }) });
  const { api } = await fixture(t, { projectMemory });
  let status = JSON.parse((await api("/api/auth/status")).text).projectMemory;
  assert.deepEqual([status.ready, status.state], [false, "unavailable"]);
  ready = true; clock = 3000;
  status = JSON.parse((await api("/api/auth/status")).text).projectMemory;
  assert.deepEqual([status.ready, status.state], [true, "conflict"]);
  const response = await api("/api/auth/project-memory/configure", { method: "POST", body: '{"enabled":true}' });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).replaced, true);
  assert.equal(JSON.parse(response.text).installed, true);
  assert.ok(!response.text.includes(root));
  const backups = path.join(root, "claude-proxy/skill-backups");
  const [backup] = fs.readdirSync(backups);
  assert.equal(fs.readFileSync(path.join(backups, backup, "SKILL.md"), "utf8"), "user skill");
});

test("Project Code Memory fixed errors and unavailable status do not leak raw data", async (t) => {
  for (const code of ["PROJECT_MEMORY_CONFLICT", "PROJECT_MEMORY_UNAVAILABLE", "EIO"]) {
    const { api } = await fixture(t, { projectMemory: { getStatus: async () => ({ state: "secret_code", ready: true, installed: true, reason: "private reason" }),
      configure: async () => { throw Object.assign(new Error("private output"), { code }); } } });
    const status = JSON.parse((await api("/api/auth/status")).text).projectMemory;
    assert.equal(status.state, "unavailable"); assert.equal(status.ready, false);
    assert.ok(!JSON.stringify(status).includes("private"));
    const result = await api("/api/auth/project-memory/configure", { method: "POST", body: '{"enabled":true}' });
    assert.equal(result.status, code === "PROJECT_MEMORY_CONFLICT" ? 409 : 503);
    assert.ok(!result.text.includes("private"));
  }
});

test("Project Code Memory status failure is isolated and installer errors are sanitized", async (t) => {
  const { api } = await fixture(t, { projectMemory: { getStatus: async () => { throw new Error("private fs"); }, configure: async () => { throw Object.assign(new Error("private output"), { code: "PROJECT_MEMORY_CONFLICT" }); } } });
  const status = JSON.parse((await api("/api/auth/status")).text);
  assert.equal(status.projectMemory.state, "unavailable");
  const result = await api("/api/auth/project-memory/configure", { method: "POST", body: '{"enabled":true}' });
  assert.equal(result.status, 409); assert.ok(!result.text.includes("private"));
});

test("Coding Discipline API applies local guards, safe status, and fixed failure mapping", async (t) => {
  let installs = 0;
  const service = { getStatus: async () => ({ installed: false, ready: true, state: "absent", reason: "unsafe-reason", notice: "unsafe-value", secret: "/private" }), install: async () => { installs++; return { ok: true, changed: true, installed: true, ready: true, state: "installed", secret: "/private" }; } };
  const { api, port, router, nonce } = await fixture(t, { codingDiscipline: service });
  const route = "/api/auth/coding-discipline/install";
  let remoteStatus;
  await router({ url: route, method: "POST", headers: { host: `localhost:${port}`, "x-auth-nonce": nonce },
    socket: { remoteAddress: "192.0.2.1" } }, { setHeader() {}, writeHead(code) { remoteStatus = code; }, end() {} });
  assert.equal(remoteStatus, 403);
  const statusText = (await api("/api/auth/status")).text;
  assert.deepEqual(Object.keys(JSON.parse(statusText).codingDiscipline).sort(), ["installed", "notice", "ready", "reason", "state"]);
  assert.ok(!statusText.includes("/private") && !statusText.includes("unsafe-"));
  for (const headers of [{ "X-Auth-Nonce": "wrong" }, { Origin: "https://evil.example" }, { "Content-Type": "text/plain" }]) assert.equal((await api(route, { method: "POST", body: "{}", headers })).status, 403);
  assert.equal((await api(route, { method: "OPTIONS" })).status, 405);
  assert.equal((await request(port, route, { method: "POST", body: "{}" })).status, 403);
  for (const body of [JSON.stringify({ unexpected: true }), "null", "[]", "1", "\"text\"", "", "{bad}"]) {
    assert.equal((await api(route, { method: "POST", body })).status, 400);
  }
  assert.equal((await api(route, { method: "POST", body: " ".repeat(MAX_AUTH_BODY_BYTES + 1) })).status, 413);
  assert.equal((await api(route, { method: "POST", body: "{}", headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await api(route)).status, 404);
  assert.equal(installs, 0);
  const result = await api(route, { method: "POST", body: "{}" });
  assert.equal(result.status, 200); assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(JSON.parse(result.text).changed, true); assert.equal(JSON.parse(result.text).installed, true);
  assert.ok(!result.text.includes("/private")); assert.equal(installs, 1);
});

test("Coding Discipline status failures are isolated and installer errors map to fixed responses", async (t) => {
  for (const code of ["CODING_DISCIPLINE_CONFLICT", "CODING_DISCIPLINE_UNAVAILABLE", "EIO"]) {
    const { api } = await fixture(t, { projectMemory: { getStatus: async () => ({ state: "absent", ready: true, installed: false }) },
      codingDiscipline: { getStatus: async () => ({ state: "secret_code", ready: true, installed: true, reason: "private reason" }),
        install: async () => { throw Object.assign(new Error("private output"), { code }); } } });
    const status = JSON.parse((await api("/api/auth/status")).text);
    assert.equal(status.codingDiscipline.state, "unavailable"); assert.equal(status.codingDiscipline.ready, false);
    assert.equal(status.projectMemory.ready, true);
    assert.ok(!JSON.stringify(status.codingDiscipline).includes("private"));
    const result = await api("/api/auth/coding-discipline/install", { method: "POST", body: "{}" });
    assert.equal(result.status, code === "CODING_DISCIPLINE_CONFLICT" ? 409 : 503);
    assert.ok(!result.text.includes("private"));
  }
  const thrown = await fixture(t, { codingDiscipline: { getStatus: async () => { throw new Error("private fs"); } } });
  assert.equal(JSON.parse((await thrown.api("/api/auth/status")).text).codingDiscipline.state, "unavailable");
  const missing = await fixture(t);
  assert.equal(JSON.parse((await missing.api("/api/auth/status")).text).codingDiscipline.state, "unavailable");
  assert.equal((await missing.api("/api/auth/coding-discipline/install", { method: "POST", body: "{}" })).status, 503);
});

test("setup endpoints share loopback/Host/nonce/Origin/JSON/OPTIONS and bounded empty-object guards", async (t) => {
  let writes = 0;
  const { api, port, router, nonce } = await fixture(t, { setup: {
    getStatus: async () => ({ claudeCli: { ready: true }, statusline: { ready: true } }),
    configureCli: async () => { writes++; return { success: true }; },
    configureStatusline: async () => { writes++; return { success: true }; }
  }, macosService: { configure: async () => { writes++; return { status: 200, body: { state: "already_registered" } }; } } });
  const routes = ["/api/auth/claude/configure", "/api/auth/statusline/configure", "/api/auth/macos/service/configure"];
  for (const [index, route] of routes.entries()) {
    for (const headers of [{ "X-Auth-Nonce": "wrong" }, { Host: `evil.example:${port}` }, { Origin: "https://evil.example" }, { "Content-Type": "text/plain" }]) {
      assert.equal((await api(route, { method: "POST", body: "{}", headers })).status, 403);
    }
    assert.equal((await request(port, route, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await api(route, { method: "OPTIONS" })).status, 405);
    assert.equal((await api(route, { method: "GET" })).status, 404);
    for (const body of ["[]", "null", "invalid", '{"path":"private-path"}', '{"__proto__":{}}']) {
      const result = await api(route, { method: "POST", body });
      assert.equal(result.status, 400);
      assert.ok(!result.text.includes("private-path"));
    }
    assert.equal((await api(route, { method: "POST", body: "x".repeat(MAX_AUTH_BODY_BYTES + 1) })).status, 413);
    let remoteCode;
    await router({ url: route, method: "POST", headers: { host: `localhost:${port}`, "x-auth-nonce": nonce }, socket: { remoteAddress: "192.0.2.1" } }, {
      setHeader() {}, writeHead(code) { remoteCode = code; }, end() {}
    });
    assert.equal(remoteCode, 403);
    assert.equal(writes, index);
    const result = await api(route, { method: "POST", body: "{}" });
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(writes, 3);
});

test("HTTP setup rejects absent credentials, returns safe status and concurrently preserves both updates", async (t) => {
  let configRoot;
  let catalogs = 0;
  const { api, store } = await fixture(t, { env: {}, setupFactory: (store) => {
    configRoot = path.join(store.directory, "cli");
    return createClaudeSetup({ configRoot, store, env: {}, platform: "linux", probe: async () => ({ cli: true, bash: "/bin/bash", jq: "test-jq", node: process.execPath }),
      getAvailableModels: async () => { catalogs++; return { data: [{ id: "gpt-test" }] }; },
      installer: { validateBundle() {}, deploy: () => ({ command: "local-statusline" }), cleanup() {}, isConfigured: (value) => value?.command === "local-statusline" } });
  } });
  const status = await api("/api/auth/status");
  assert.equal(JSON.parse(status.text).claudeCli.ready, false);
  assert.equal(catalogs, 0);
  assert.equal((await api("/api/auth/claude/configure", { method: "POST", body: "{}" })).status, 400);
  assert.equal(fs.existsSync(configRoot), false);
  store.saveLogin("openai", { type: "api_key", key: "private-upstream-key" });
  assert.equal(JSON.parse((await api("/api/auth/status")).text).claudeCli.ready, true);
  const results = await Promise.all(["claude", "statusline"].map((name) => api(`/api/auth/${name}/configure`, { method: "POST", body: "{}" })));
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.text).success, true);
    assert.ok(!result.text.includes("private-upstream-key"));
    assert.ok(!result.text.includes("sk-placeholder"));
  }
  const saved = JSON.parse(fs.readFileSync(path.join(configRoot, "settings.json"), "utf8"));
  assert.equal(saved.env.ANTHROPIC_MODEL, "anthropic/gpt-test");
  assert.equal(saved.statusLine.command, "local-statusline");
});

test("setup errors hide raw command output, settings values and invalid conflict fields", async (t) => {
  const { api } = await fixture(t, { setup: { configureCli() { throw Object.assign(new Error("private-command-output"), {
    setupCode: "conflict", fields: ["apiKeyHelper", "private-helper-value"]
  }); }, configureStatusline() { throw new Error("private-settings-content"); } } });
  const cli = await api("/api/auth/claude/configure", { method: "POST", body: "{}" });
  assert.equal(cli.status, 409);
  assert.deepEqual(JSON.parse(cli.text).fields, ["apiKeyHelper"]);
  assert.ok(!cli.text.includes("private-"));
  const statusline = await api("/api/auth/statusline/configure", { method: "POST", body: "{}" });
  assert.equal(statusline.status, 503);
  assert.ok(!statusline.text.includes("private-"));
});

test("macOS service status is allowlisted and configure activates only after response finish", async (t) => {
  let activated = 0;
  let cancelled = 0;
  const service = {
    async getStatus() { return { supported: true, ready: true, registered: false, running: false, state: "ready", reason: "Safe", secret: "private", instance: { pid: 12, installationId: "a".repeat(64), secret: "hidden" }, operation: { id: "op-1", phase: "pending", internal: "hidden" } }; },
    async configure() { return { status: 202, body: { accepted: true, operationId: "op-1", state: "pending", message: "Working", secret: "hidden" }, activate() { activated += 1; }, cancel() { cancelled += 1; } }; }
  };
  const { api } = await fixture(t, { macosService: service });
  const status = await api("/api/auth/status");
  assert.deepEqual(JSON.parse(status.text).macosService, { supported: true, ready: true, registered: false, running: false, state: "ready", reason: "Safe", instance: { pid: 12, installationId: "a".repeat(64) }, operation: { id: "op-1", phase: "pending" } });
  assert.equal(status.text.includes("private"), false);
  assert.equal((await api("/api/auth/macos/service/configure", { method: "POST", body: '{"extra":true}' })).status, 400);
  const accepted = await api("/api/auth/macos/service/configure", { method: "POST", body: "{}" });
  assert.equal(accepted.status, 202);
  assert.doesNotMatch(accepted.text, /hidden/);
  assert.equal(activated, 1);
  assert.equal(cancelled, 0);
  const missing = await fixture(t, {});
  assert.equal(JSON.parse((await missing.api("/api/auth/status")).text).macosService.supported, false);
  assert.equal((await missing.api("/api/auth/macos/service/configure", { method: "POST", body: "{}" })).status, 503);
});

test("macOS handoff is cancelled when the client disconnects during helper preparation", async (t) => {
  let prepared;
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  let activated = 0;
  let cancelled = 0;
  const { port, nonce } = await fixture(t, { macosService: { configure: () => new Promise((resolve) => { prepared = resolve; announce(); }) } });
  const req = http.request({ hostname: "127.0.0.1", port, path: "/api/auth/macos/service/configure", method: "POST", headers: {
    "X-Auth-Nonce": nonce, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json"
  } });
  const disconnected = new Promise((resolve) => req.once("error", resolve));
  req.end("{}");
  await started;
  req.destroy(new Error("synthetic disconnect"));
  await disconnected;
  await new Promise((resolve) => setTimeout(resolve, 10));
  prepared({ status: 202, body: { accepted: true, operationId: "op-aborted", state: "pending" }, activate() { activated++; }, cancel() { cancelled++; } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(activated, 0);
  assert.equal(cancelled, 1);
});

test("non-mac service registration and raw subprocess failures produce fixed safe errors", async (t) => {
  const { createMacosService } = require("../lib/macos-service");
  const other = await fixture(t, { macosService: createMacosService({ platform: "win32", env: {} }) });
  assert.equal(JSON.parse((await other.api("/api/auth/status")).text).macosService.supported, false);
  assert.equal((await other.api("/api/auth/macos/service/configure", { method: "POST", body: "{}" })).status, 400);
  const broken = await fixture(t, { macosService: { configure() { throw new Error("private-subprocess-secret"); } } });
  const result = await broken.api("/api/auth/macos/service/configure", { method: "POST", body: "{}" });
  assert.equal(result.status, 503);
  assert.doesNotMatch(result.text, /private-subprocess/);
});

test("bounded bodies, malformed JSON and corrupt stores produce fixed safe errors", async (t) => {
  const { api, store } = await fixture(t);
  for (const body of ["private-invalid-json", "null", "[]"]) {
    const result = await api("/api/auth/chatgpt/start", { method: "POST", body });
    assert.equal(result.status, 400);
    assert.ok(!result.text.includes(body));
  }
  assert.equal((await api("/api/auth/chatgpt/start", { method: "POST", body: "x".repeat(MAX_AUTH_BODY_BYTES + 1) })).status, 413);
  fs.writeFileSync(store.authFile, "private-store-contents");
  const result = await api("/api/auth/status");
  assert.equal(result.status, 503);
  assert.ok(!result.text.includes("private-store-contents"));
});

test("Online Summary prompt saves and resets through the guarded route with fixed errors", async (t) => {
  const patches = [];
  let current = { enabled: true, model: null, defaultModel: "gpt-6-luna", models: ["gpt-6-luna"], threshold: 16384, thresholds: [16384],
    prompt: "Built-in prompt.", customPrompt: false, secret: "/private" };
  const summarySettings = {
    getStatus: async () => current,
    configure: async (patch) => {
      patches.push(patch);
      if (patch.summaryPrompt === "") throw Object.assign(new Error("raw detail"), { status: 400, code: "INVALID_SUMMARY_PROMPT" });
      current = { ...current, prompt: patch.summaryPrompt || "Built-in prompt.", customPrompt: Boolean(patch.summaryPrompt) };
      return current;
    }
  };
  const { api } = await fixture(t, { summarySettings });
  const route = "/api/auth/online-summary/configure";
  const status = JSON.parse((await api("/api/auth/status")).text).onlineSummary;
  assert.equal(status.prompt, "Built-in prompt.");
  assert.equal(status.customPrompt, false);
  assert.equal("secret" in status, false);
  assert.equal((await api(route, { method: "POST", body: JSON.stringify({ prompt: "x" }), headers: { "X-Auth-Nonce": "wrong" } })).status, 403);
  for (const body of [{ prompt: 1 }, { prompt: ["x"] }, { prompt: "x", unexpected: true }]) {
    assert.equal((await api(route, { method: "POST", body: JSON.stringify(body) })).status, 400);
  }
  const saved = await api(route, { method: "POST", body: JSON.stringify({ prompt: "Custom.\nReply with JSON only." }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.text).onlineSummary.prompt, "Custom.\nReply with JSON only.");
  assert.equal(JSON.parse(saved.text).onlineSummary.customPrompt, true);
  const invalid = await api(route, { method: "POST", body: JSON.stringify({ prompt: "" }) });
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.text).error, "Enter a non-empty prompt of at most 8 KiB.");
  const reset = await api(route, { method: "POST", body: JSON.stringify({ prompt: null }) });
  assert.equal(JSON.parse(reset.text).onlineSummary.customPrompt, false);
  assert.deepEqual(patches, [{ summaryPrompt: "Custom.\nReply with JSON only." }, { summaryPrompt: "" }, { summaryPrompt: null }]);
});

test("Online Summary retention is allowlisted in status and saved as archiveRetentionDays", async (t) => {
  const patches = [];
  const summarySettings = {
    getStatus: async () => ({ enabled: false, retentionDays: 30, retentionOptions: [7, 30, 0, -1, "90"] }),
    configure: async (patch) => {
      patches.push(patch);
      if (patch.archiveRetentionDays === 5) throw Object.assign(new Error("raw detail"), { status: 400, code: "INVALID_RETENTION_DAYS" });
      return { enabled: false, retentionDays: patch.archiveRetentionDays, retentionOptions: [7, 30, 0] };
    }
  };
  const { api } = await fixture(t, { summarySettings });
  const route = "/api/auth/online-summary/configure";
  const status = JSON.parse((await api("/api/auth/status")).text).onlineSummary;
  assert.equal(status.retentionDays, 30);
  assert.deepEqual(status.retentionOptions, [7, 30, 0]);
  for (const retentionDays of ["7", 7.5, null]) {
    assert.equal((await api(route, { method: "POST", body: JSON.stringify({ retentionDays }) })).status, 400);
  }
  const saved = await api(route, { method: "POST", body: JSON.stringify({ retentionDays: 0 }) });
  assert.equal(JSON.parse(saved.text).onlineSummary.retentionDays, 0);
  const invalid = await api(route, { method: "POST", body: JSON.stringify({ retentionDays: 5 }) });
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.text).error, "Choose a retention period from the list.");
  assert.deepEqual(patches, [{ archiveRetentionDays: 0 }, { archiveRetentionDays: 5 }]);
});

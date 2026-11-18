const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// 使用最小 DOM 与假 fetch 验证页面事件，不读取真实凭据或调用上游。
function pageHarness(_unused, { status, configure, requestImpl, fastWait = false } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", dataset: {}, hidden: true, disabled: ["cli-configure", "statusline-configure", "hud-install", "macos-service-configure", "project-memory-enabled", "coding-discipline-install"].includes(id), attributes: {}, listeners: {}, classList: { add() {}, remove() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      replaceChildren(...children) { this.children = children; }
    });
    return elements.get(id);
  };
  const document = { hidden: false, listeners: {}, getElementById: element, createElement: () => ({ value: "", textContent: "" }),
    querySelector: () => ({ content: "test-page-nonce" }),
    addEventListener(name, handler) { this.listeners[name] = handler; }
  };
  const window = { location: { href: "http://localhost:8082/login", origin: "http://localhost:8082" },
    setTimeout, clearTimeout, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; }
  };
  const requests = [];
  const context = {
    document, window, URL, Headers, AbortController,
    DOMParser: class { parseFromString(html) { return { querySelector: () => ({ content: html.match(/content="([a-zA-Z0-9_-]{43})"/)?.[1] }) }; } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (requestImpl) return requestImpl(url, options);
      if (url.endsWith("/status")) return { ok: true, json: async () => status ? status() : ({ claudeCli: { installed: true, ready: true, configured: false }, statusline: { installed: true, ready: true, configured: false } }) };
      if (options.method === "POST") return configure ? configure(url, options) : { ok: true, json: async () => ({ success: true, message: "Done." }) };
      return { ok: true, json: async () => ({}) };
    }
  };
  const html = fs.readFileSync(path.join(__dirname, "..", "web", "login.html"), "utf8");
  vm.runInNewContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1], context);
  if (fastWait) vm.runInNewContext("wait = async () => {};", context);
  return { element, document, window, requests,
    run: (source) => vm.runInNewContext(source, context),
    refresh: () => vm.runInNewContext("refreshStatus()", context),
    authorizationComplete: () => vm.runInNewContext('startLogin("chatgpt")', context),
  };
}

test("Project Code Memory checkbox gates, configures, reports success, and restores on failure", async () => {
  let enabled = false;
  const page = pageHarness(async () => [], { status: () => ({ projectMemory: { enabled, ready: true, installed: enabled, state: enabled ? "installed" : "absent" } }),
    configure: async (url, options) => response({ ok: true, enabled: JSON.parse(options.body).enabled }) });
  const toggle = page.element("project-memory-enabled");
  assert.equal(toggle.disabled, true);
  await page.refresh(); assert.equal(toggle.disabled, false); assert.equal(toggle.checked, false);
  toggle.checked = true; await toggle.listeners.change();
  assert.equal(JSON.parse(page.requests.find((r) => r.url.endsWith("/project-memory/configure")).options.body).enabled, true);
  assert.equal(page.element("project-memory-status").textContent, "Gateway-maintained Project Code Memory is on. Start a new Claude session to use it.");
  enabled = true; await page.refresh(); assert.equal(toggle.checked, true); assert.equal(toggle.disabled, false);
  enabled = false;
  toggle.checked = false; await toggle.listeners.change();
  assert.equal(page.element("project-memory-status").textContent, "Gateway-maintained Project Code Memory is off. Start a new Claude session. Backups and project caches are kept.");
  const failing = pageHarness(async () => [], { status: () => ({ projectMemory: { enabled: false, ready: true } }), configure: async () => response({ error: "Fixed conflict." }, 409) });
  await failing.refresh(); failing.element("project-memory-enabled").checked = true; await failing.element("project-memory-enabled").listeners.change();
  assert.equal(failing.element("project-memory-enabled").checked, false); assert.equal(failing.element("project-memory-status").textContent, "Fixed conflict.");
});

test("an existing skill conflict stays selectable and replacement success identifies the relative backup", async () => {
  const reason = "An older or different Project Code Memory skill is installed. Turning this on backs up the existing skill to claude-proxy/skill-backups/ in your Claude CLI directory, then installs the query-only skill.";
  let enabled = false;
  const page = pageHarness(async () => [], { status: () => ({ projectMemory: enabled
    ? { enabled: true, installed: true, ready: true, state: "installed" }
    : { enabled: false, installed: false, ready: true, state: "conflict", reason } }),
  configure: async (url, options) => {
    enabled = JSON.parse(options.body).enabled;
    return response({ ok: true, enabled, replaced: true });
  } });
  await page.refresh();
  const toggle = page.element("project-memory-enabled");
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, false);
  assert.equal(page.element("project-memory-status").textContent, reason);
  assert.match(page.element("project-memory-status").textContent, /claude-proxy\/skill-backups\//);
  assert.match(page.element("project-memory-status").textContent, /query-only skill/);

  toggle.checked = true;
  await toggle.listeners.change();
  assert.equal(toggle.checked, true);
  assert.match(page.element("project-memory-status").textContent, /^Gateway-maintained Project Code Memory is on\..*claude-proxy\/skill-backups\//);
  assert.doesNotMatch(page.element("project-memory-status").textContent, /\/Users\//);
});

test("Project Code Memory blocks duplicate changes, permits off during conflict, and keeps independent feedback", async () => {
  let finish;
  let enabled = true;
  const page = pageHarness(async () => [], { status: () => ({ claudeCli: { ready: true }, statusline: { ready: true },
    projectMemory: { enabled, installed: false, ready: false, state: "conflict", reason: "conflict" } }),
    configure: async (url) => {
      if (!url.endsWith("/project-memory/configure")) return response({ success: true });
      return new Promise((resolve) => { finish = () => { enabled = false; resolve(response({ ok: true, enabled: false })); }; });
    } });
  await new Promise((resolve) => setImmediate(resolve));
  await page.element("cli-configure").listeners.click();
  const cliMessage = page.element("cli-status").textContent;
  const toggle = page.element("project-memory-enabled"); assert.equal(toggle.disabled, false); assert.equal(toggle.checked, true);
  toggle.checked = false; const first = toggle.listeners.change(); assert.equal(toggle.disabled, true); await toggle.listeners.change();
  assert.equal(page.element("statusline-configure").disabled, false);
  assert.equal(page.requests.filter((r) => r.url.endsWith("/project-memory/configure")).length, 1); finish(); await first;
  assert.equal(toggle.checked, false);
  assert.equal(page.element("cli-status").textContent, cliMessage);
});

test("Project Code Memory status failure disables the checkbox", async () => {
  let failStatus = false;
  const page = pageHarness(async () => [], { status: () => {
    if (failStatus) throw new Error("offline");
    return { projectMemory: { enabled: false, ready: true } };
  } });
  await page.refresh();
  assert.equal(page.element("project-memory-enabled").disabled, false);
  failStatus = true; await page.refresh();
  assert.equal(page.element("project-memory-enabled").disabled, true);
  assert.equal(page.element("project-memory-status").textContent, "Unable to load Project Code Memory status. The setting is disabled.");
});

test("Coding Discipline card is independently gated and reports install, already-installed and conflict results", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../web/login.html"), "utf8");
  assert.match(html, /id="coding-discipline-install" type="button" disabled/);
  let outcome = response({ ok: true, installed: true, changed: true });
  const page = pageHarness(async () => [], { status: () => ({ codingDiscipline: { ready: true } }), configure: async () => outcome });
  assert.equal(page.element("coding-discipline-install").disabled, true);
  await page.refresh();
  assert.equal(page.element("coding-discipline-install").disabled, false);
  assert.equal(page.element("project-memory-enabled").disabled, true);
  await page.element("coding-discipline-install").listeners.click();
  const posts = page.requests.filter((item) => item.url.endsWith("/coding-discipline/install"));
  assert.equal(posts.length, 1); assert.equal(posts[0].options.body, "{}");
  assert.match(page.element("coding-discipline-status").textContent, /^Coding Discipline installed.*new Claude session/i);
  outcome = response({ ok: true, installed: true, changed: false });
  await page.element("coding-discipline-install").listeners.click();
  assert.match(page.element("coding-discipline-status").textContent, /already installed.*new Claude session/i);
  outcome = response({ error: "Fixed install conflict." }, 409);
  await page.element("coding-discipline-install").listeners.click();
  assert.equal(page.element("coding-discipline-status").textContent, "Fixed install conflict.");
  assert.equal(page.element("project-memory-status").textContent, "Project Code Memory is not ready.");
});

test("Coding Discipline status failure disables installation", async () => {
  let failStatus = false;
  const page = pageHarness(async () => [], { status: () => {
    if (failStatus) throw new Error("offline");
    return { codingDiscipline: { ready: true } };
  } });
  await page.refresh();
  assert.equal(page.element("coding-discipline-install").disabled, false);
  failStatus = true; await page.refresh();
  assert.equal(page.element("coding-discipline-install").disabled, true);
  assert.match(page.element("coding-discipline-status").textContent, /Unable to load Coding Discipline status/);
});

test("macOS service UI polls verified identity and recovers nonce without executing markup", () => {
  const html = fs.readFileSync(path.join(__dirname, "../web/login.html"), "utf8");
  assert.match(html, /id="macos-service-card"[^>]*hidden/);
  assert.match(html, /id="macos-service-configure"[^>]*disabled/);
  assert.match(html, /id="statusline-configure"[^>]*disabled/);
  assert.match(html, /service\.operation\?\.id !== operationId/);
  assert.match(html, /service\.instance\.installationId !== installationId/);
  assert.match(html, /new DOMParser\(\)\.parseFromString\(html, "text\/html"\)/);
});

const serviceStatus = (values = {}) => ({ supported: true, ready: true, registered: false, running: false, state: "missing",
  instance: { pid: 101, installationId: "a".repeat(64) }, ...values });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("service card follows backend platform only, and status failure immediately disables registration", async () => {
  let supported = true;
  let fail = false;
  const page = pageHarness(async () => [], { status: () => {
    if (fail) throw new Error("status offline");
    return { macosService: serviceStatus({ supported }) };
  } });
  assert.equal(page.element("macos-service-configure").disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.element("macos-service-card").hidden, false);
  assert.equal(page.element("macos-service-configure").disabled, false);
  assert.equal(page.requests.length, 1);
  supported = false;
  await page.refresh();
  assert.equal(page.element("macos-service-card").hidden, true);
  assert.equal(page.element("macos-service-configure").disabled, true);
  supported = true;
  await page.refresh();
  fail = true;
  await page.refresh();
  assert.equal(page.element("macos-service-configure").disabled, true);
});

test("service registration has independent busy state, prevents duplicate POSTs, and accepts only verified completion", async () => {
  let finishPost;
  let posted = false;
  const page = pageHarness(async () => [], { fastWait: true,
    status: () => ({ claudeCli: { ready: true }, statusline: { ready: true }, macosService: serviceStatus(posted ? {
      registered: true, running: true, state: "registered", operation: { id: "op-1", phase: "completed" }
    } : {}) }),
    configure: () => new Promise((resolve) => { finishPost = resolve; posted = true; })
  });
  await new Promise((resolve) => setImmediate(resolve));
  const first = page.element("macos-service-configure").listeners.click();
  await page.element("macos-service-configure").listeners.click();
  assert.equal(page.element("macos-service-configure").disabled, true);
  assert.equal(page.element("cli-configure").disabled, false);
  assert.equal(page.element("statusline-configure").disabled, false);
  assert.doesNotMatch(page.element("macos-service-status").textContent, /running and registered/);
  finishPost(response({ accepted: true, operationId: "op-1", state: "pending" }, 202));
  await first;
  assert.equal(page.requests.filter((request) => request.options.method === "POST").length, 1);
  assert.match(page.element("macos-service-status").textContent, /running and registered/);
  assert.match(page.element("cli-status").textContent, /Ready to configure/);
  await page.refresh();
  assert.match(page.element("macos-service-status").textContent, /running and registered/);
});

test("already registered no-op and fixed backend errors keep independent persistent service feedback", async () => {
  let fails = false;
  const page = pageHarness(async () => [], { status: () => ({ macosService: serviceStatus(), statusline: { ready: true } }),
    configure: async () => fails ? response({ error: "Remove the environment override first." }, 409) : response({ state: "already_registered" }) });
  await new Promise((resolve) => setImmediate(resolve));
  await page.element("macos-service-configure").listeners.click();
  assert.match(page.element("macos-service-status").textContent, /Nothing was changed/);
  fails = true;
  await page.element("macos-service-configure").listeners.click();
  assert.match(page.element("macos-service-status").textContent, /environment override/);
  assert.match(page.element("statusline-status").textContent, /Ready/);
});

for (const lostPost of [false, true]) {
  test(`service ${lostPost ? "lost POST checks outcome" : "pending polling reconnects"} with a new nonce and never reposts`, async () => {
    let posted = false;
    let reconnected = false;
    const nextNonce = "b".repeat(43);
    const page = pageHarness(async () => [], { fastWait: true, requestImpl: async (url, options) => {
      if (url.endsWith("/login")) {
        reconnected = true;
        return { ok: true, text: async () => `<meta name="auth-nonce" content="${nextNonce}"><script>throw new Error("must not execute")</script>` };
      }
      if (options.method === "POST") {
        posted = true;
        if (lostPost) throw Object.assign(new Error("lost response"), { name: "AbortError" });
        return response({ accepted: true, operationId: "op-new", state: "pending" }, 202);
      }
      if (!posted) return response({ macosService: serviceStatus() });
      if (!reconnected) return response({}, 403);
      assert.equal(options.headers.get("X-Auth-Nonce"), nextNonce);
      return response({ macosService: serviceStatus({ registered: true, running: true, state: "registered", operation: { id: "op-new", phase: "completed" } }) });
    } });
    await new Promise((resolve) => setImmediate(resolve));
    await page.element("macos-service-configure").listeners.click();
    assert.match(page.element("macos-service-status").textContent, /running and registered/);
    assert.equal(page.requests.filter((request) => request.options.method === "POST").length, 1);
    assert.equal(page.requests.filter((request) => request.url.endsWith("/login")).length, 1);
  });
}

for (const recovery of ["recovered", "recovery_failed"]) {
  test(`service ${recovery} displays an explicit failure, not success`, async () => {
    let posted = false;
    const page = pageHarness(async () => [], { fastWait: true,
      status: () => ({ macosService: serviceStatus(posted ? { state: "failed", operation: { id: "op-failed", phase: "failed", recovery } } : {}) }),
      configure: async () => { posted = true; return response({ accepted: true, operationId: "op-failed", state: "pending" }, 202); }
    });
    await new Promise((resolve) => setImmediate(resolve));
    await page.element("macos-service-configure").listeners.click();
    assert.equal(page.element("macos-service-status").dataset.kind, "error");
    assert.match(page.element("macos-service-status").textContent, recovery === "recovered" ? /original proxy was recovered/ : /Start mac\/start-proxy.sh manually/);
  });
}

test("setup gates start disabled and one status refresh enables them without fetching credentials", async () => {
  const markup = fs.readFileSync(path.join(__dirname, "..", "web", "login.html"), "utf8");
  assert.match(markup, /id="cli-configure" type="button" disabled/);
  const page = pageHarness(async () => ["must-not-load"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.element("cli-configure").disabled, false);
  assert.equal(page.requests.length, 1);
  assert.ok(page.requests[0].url.endsWith("/status"));
  assert.equal(page.requests[0].options.headers.get("X-Auth-Nonce"), "test-page-nonce");
  assert.equal(page.requests[0].options.cache, "no-store");
});

test("independent configuration posts empty objects and presents English next steps", async () => {
  const page = pageHarness(async () => []);
  await new Promise((resolve) => setImmediate(resolve));
  await page.element("cli-configure").listeners.click();
  const request = page.requests.find((item) => item.url.endsWith("/claude/configure"));
  assert.equal(request.options.body, "{}");
  assert.match(page.element("cli-status").textContent, /Open a new terminal and run claude, then use \/model/);
});

test("credentials gate CLI, authorization updates readiness, and status failure disables configuration", async () => {
  let ready = false;
  let fail = false;
  const page = pageHarness(async () => [], { status: () => {
    if (fail) throw new Error("status failed");
    return { claudeCli: { ready, reason: ready ? "" : "Configure a credential first." } };
  }, configure: async () => ({ ok: true, json: async () => ({ status: "complete" }) }) });
  assert.equal(page.element("cli-configure").disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.element("cli-configure").disabled, true);
  assert.match(page.element("cli-status").textContent, /credential/);
  ready = false;
  await page.refresh();
  ready = true;
  await page.authorizationComplete();
  assert.equal(page.element("cli-configure").disabled, false);
  fail = true;
  await page.refresh();
  assert.equal(page.element("cli-configure").disabled, true);
});

test("Windows shows only the HUD card and checking its box installs once", async () => {
  let installed = false;
  let finish;
  const page = pageHarness(null, { status: () => ({ statusline: { kind: "claude-hud", ready: true, installed } }),
    configure: () => new Promise((resolve) => { finish = () => { installed = true; resolve(response({ success: true })); }; }) });
  await page.refresh();
  assert.equal(page.element("hud-card").hidden, false);
  assert.equal(page.element("statusline-card").hidden, true);
  const toggle = page.element("hud-install");
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  const installing = toggle.listeners.change();
  await toggle.listeners.change();
  assert.equal(toggle.disabled, true);
  assert.equal(page.requests.filter((r) => r.options.method === "POST").length, 1);
  finish(); await installing;
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, true);
  assert.match(page.element("hud-status").textContent, /\/reload-plugins.*\/hud/);
  const html = fs.readFileSync(path.join(__dirname, "../web/login.html"), "utf8");
  const card = html.match(/<section id="hud-card"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(card, /Bash|jq|ccusage|ccstatusline|Node\.js|Replaces|Configure Statusline/);
});

test("HUD missing CLI disables its checkbox and install failures allow retry", async () => {
  let ready = false;
  const page = pageHarness(null, { status: () => ({ statusline: { kind: "claude-hud", ready, reason: ready ? "" : "Install Claude CLI first." } }),
    configure: async () => response({ error: "Claude HUD installation failed." }, 503) });
  await page.refresh();
  const toggle = page.element("hud-install");
  assert.equal(toggle.disabled, true);
  ready = true; await page.refresh();
  assert.equal(toggle.disabled, false);
  toggle.checked = true; await toggle.listeners.change();
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.equal(page.element("hud-status").textContent, "Claude HUD installation failed.");
});

test("parallel setup buttons keep independent busy, success and fixed backend errors", async () => {
  const pending = new Map();
  const page = pageHarness(async () => [], { configure: (url) => new Promise((resolve) => pending.set(url, resolve)) });
  await new Promise((resolve) => setImmediate(resolve));
  const cli = page.element("cli-configure").listeners.click();
  const statusline = page.element("statusline-configure").listeners.click();
  await page.element("statusline-configure").listeners.click();
  assert.equal(page.element("statusline-configure").dataset.busy, "true");
  assert.equal(page.element("cli-configure").dataset.busy, "true");
  pending.get("http://localhost:8082/api/auth/statusline/configure")(response({ success: true, message: "Statusline done." }));
  await statusline;
  assert.match(page.element("statusline-status").textContent, /next refresh or new session/);
  assert.equal(page.element("cli-configure").dataset.busy, "true");
  pending.get("http://localhost:8082/api/auth/claude/configure")(response({ error: "Handle authentication conflicts first." }, 409));
  await cli;
  assert.match(page.element("statusline-status").textContent, /Statusline done/);
  assert.equal(page.requests.filter((request) => request.options.method === "POST").length, 2);
  assert.ok(page.requests.filter((request) => request.options.method === "POST").every((request) => request.options.body === "{}"));
});

for (const mismatch of ["operation", "installation", "socket"]) {
  test(`service refuses ${mismatch} mismatch without reporting success`, async () => {
    let posted = false;
    const page = pageHarness(null, { fastWait: true,
      status: () => ({ macosService: serviceStatus(posted ? {
        registered: true, running: true, operation: { id: mismatch === "operation" ? "op-other" : "op-1", phase: "completed" },
        ...(mismatch === "installation" ? { instance: { pid: 102, installationId: "b".repeat(64) } } : {}),
        ...(mismatch === "socket" ? { running: false } : {})
      } : {}) }),
      configure: async () => { posted = true; return response({ accepted: true, operationId: "op-1", state: "pending" }, 202); }
    });
    await new Promise((resolve) => setImmediate(resolve));
    await page.element("macos-service-configure").listeners.click();
    assert.equal(page.element("macos-service-status").dataset.kind, "error");
    assert.doesNotMatch(page.element("macos-service-status").textContent, /running and registered/);
    assert.equal(page.requests.filter((request) => request.options.method === "POST").length, 1);
  });
}

test("configuration keeps busy state and presents fixed backend errors", async () => {
  const pending = new Map();
  const page = pageHarness(async () => [], { configure: (url) => new Promise((resolve) => pending.set(url, resolve)) });
  await new Promise((resolve) => setImmediate(resolve));
  const cli = page.element("cli-configure").listeners.click();
  assert.equal(page.element("cli-configure").dataset.busy, "true");
  assert.equal(page.element("cli-configure").disabled, true);
  assert.equal(page.element("cli-status").textContent, "Configuring…");
  pending.get("http://localhost:8082/api/auth/claude/configure")({ ok: false, status: 409, json: async () => ({ error: "Handle authentication conflicts first.", fields: ["apiKeyHelper"] }) });
  await cli;
  assert.match(page.element("cli-status").textContent, /apiKeyHelper/);
  assert.equal(page.element("cli-configure").dataset.busy, "false");
});

test("Online Summary toggle greys out the model select, defaults to the detected model and saves only the changed setting", async () => {
  let settings = { available: true, enabled: false, model: null, defaultModel: "gpt-6-luna", models: ["claude-haiku-5.5", "gpt-6-luna"],
    threshold: 16384, thresholds: [4096, 8192, 16384, 32768] };
  const posts = [];
  const page = pageHarness(async () => [], { status: () => ({ onlineSummary: settings }),
    configure: async (url, options) => {
      const change = JSON.parse(options.body);
      posts.push({ url, change });
      if ("enabled" in change) settings = { ...settings, enabled: change.enabled };
      if ("model" in change) settings = { ...settings, model: change.model };
      if ("threshold" in change) settings = { ...settings, threshold: change.threshold };
      return { ok: true, json: async () => ({ success: true, onlineSummary: settings }) };
    } });
  await page.refresh();
  const toggle = page.element("online-summary-enabled");
  const select = page.element("online-summary-model");
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  const threshold = page.element("online-summary-threshold");
  assert.equal(select.disabled, true);
  assert.equal(threshold.disabled, true);
  assert.equal(select.value, "gpt-6-luna");
  assert.equal(threshold.value, "16384");
  assert.deepEqual(threshold.children.map((option) => option.textContent), ["4 KiB", "8 KiB", "16 KiB", "32 KiB"]);
  assert.deepEqual(select.children.map((option) => option.textContent), ["claude-haiku-5.5", "gpt-6-luna (detected cheap model)"]);
  assert.match(page.element("online-summary-status").textContent, /off/);

  toggle.checked = true;
  await toggle.listeners.change();
  assert.deepEqual(posts.at(-1), { url: "http://localhost:8082/api/auth/online-summary/configure", change: { enabled: true } });
  assert.equal(select.disabled, false);
  assert.equal(select.value, "gpt-6-luna");
  assert.match(page.element("online-summary-status").textContent, /Saved.*without restarting/);

  assert.equal(threshold.disabled, false);
  threshold.value = "8192";
  await threshold.listeners.change();
  assert.deepEqual(posts.at(-1).change, { threshold: 8192 });
  assert.equal(threshold.value, "8192");
  assert.match(page.element("online-summary-status").textContent, /Saved/);

  select.value = "claude-haiku-5.5";
  await select.listeners.change();
  assert.deepEqual(posts.at(-1).change, { model: "claude-haiku-5.5" });
  assert.equal(select.value, "claude-haiku-5.5");

  toggle.checked = false;
  await toggle.listeners.change();
  assert.deepEqual(posts.at(-1).change, { enabled: false });
  assert.equal(select.disabled, true);
  assert.equal(threshold.disabled, true);
  assert.equal(select.value, "claude-haiku-5.5");
});

test("Online Summary shows save failures and keeps controls disabled when settings are unavailable", async () => {
  const page = pageHarness(async () => [], { status: () => ({ onlineSummary: { available: true, enabled: true, model: null, defaultModel: "gpt-6-luna", models: ["gpt-6-luna"] } }),
    configure: async () => ({ ok: false, status: 400, json: async () => ({ error: "Choose a model from the list." }) }) });
  await page.refresh();
  await page.element("online-summary-model").listeners.change();
  assert.match(page.element("online-summary-status").textContent, /Choose a model from the list/);
  const unavailable = pageHarness(async () => [], { status: () => ({}) });
  await unavailable.refresh();
  assert.equal(unavailable.element("online-summary-enabled").disabled, true);
  assert.equal(unavailable.element("online-summary-model").disabled, true);
  assert.equal(unavailable.element("online-summary-prompt").disabled, true);
  assert.equal(unavailable.element("online-summary-prompt-reset").disabled, true);
  assert.match(unavailable.element("online-summary-status").textContent, /unavailable/);
});

test("Online Summary prompt keeps unsaved edits across refreshes, saves the text and resets to the default", async () => {
  const builtIn = "Built-in prompt.";
  let settings = { available: true, enabled: true, model: null, defaultModel: "gpt-6-luna", models: ["gpt-6-luna"],
    threshold: 16384, thresholds: [16384], prompt: builtIn, customPrompt: false };
  const posts = [];
  let reject = false;
  const page = pageHarness(async () => [], { status: () => ({ onlineSummary: settings }),
    configure: async (url, options) => {
      const change = JSON.parse(options.body);
      posts.push(change);
      if (reject) return response({ error: "Enter a non-empty prompt of at most 8 KiB." }, 400);
      if ("enabled" in change) settings = { ...settings, enabled: change.enabled };
      if ("prompt" in change) settings = { ...settings, prompt: change.prompt ?? builtIn, customPrompt: change.prompt !== null };
      return response({ success: true, onlineSummary: settings });
    } });
  await page.refresh();
  const prompt = page.element("online-summary-prompt");
  assert.equal(prompt.value, builtIn);
  assert.equal(prompt.disabled, false);
  assert.match(page.element("online-summary-status").textContent, /prompt: default/);

  prompt.value = "Unsaved edit";
  prompt.listeners.input();
  await page.refresh();
  assert.equal(prompt.value, "Unsaved edit");

  reject = true;
  prompt.value = "";
  await page.element("online-summary-prompt-save").listeners.click();
  assert.deepEqual(posts.at(-1), { prompt: "" });
  assert.match(page.element("online-summary-status").textContent, /non-empty prompt/);
  assert.equal(prompt.value, "");

  reject = false;
  prompt.value = "Custom prompt";
  await page.element("online-summary-prompt-save").listeners.click();
  assert.deepEqual(posts.at(-1), { prompt: "Custom prompt" });
  assert.match(page.element("online-summary-status").textContent, /Saved/);
  settings = { ...settings, prompt: "Saved elsewhere" };
  await page.refresh();
  assert.equal(prompt.value, "Saved elsewhere");

  prompt.value = "Broken edit";
  prompt.listeners.input();
  await page.element("online-summary-prompt-reset").listeners.click();
  assert.deepEqual(posts.at(-1), { prompt: null });
  assert.equal(prompt.value, builtIn);
  assert.match(page.element("online-summary-status").textContent, /reset to the default/);

  page.element("online-summary-enabled").checked = false;
  await page.element("online-summary-enabled").listeners.change();
  for (const id of ["online-summary-prompt", "online-summary-prompt-save", "online-summary-prompt-reset"]) assert.equal(page.element(id).disabled, true);
});

test("Online Summary retention stays editable while summaries are off and saves only the period", async () => {
  let settings = { available: true, enabled: false, model: null, defaultModel: "gpt-6-luna", models: ["gpt-6-luna"],
    threshold: 16384, thresholds: [16384], prompt: "Built-in prompt.", customPrompt: false, retentionDays: 30, retentionOptions: [7, 30, 0] };
  const posts = [];
  const page = pageHarness(async () => [], { status: () => ({ onlineSummary: settings }),
    configure: async (url, options) => {
      const change = JSON.parse(options.body);
      posts.push(change);
      settings = { ...settings, retentionDays: change.retentionDays };
      return response({ success: true, onlineSummary: settings });
    } });
  await page.refresh();
  const retention = page.element("online-summary-retention");
  assert.equal(retention.value, "30");
  assert.equal(retention.disabled, false);
  assert.equal(page.element("online-summary-threshold").disabled, true);
  assert.deepEqual(retention.children.map((option) => option.textContent), ["7 days without use", "30 days without use", "Never (keep all archives)"]);
  retention.value = "0";
  await retention.listeners.change();
  assert.deepEqual(posts, [{ retentionDays: 0 }]);
  assert.equal(retention.value, "0");
  assert.match(page.element("online-summary-status").textContent, /Saved/);
  const offline = pageHarness(async () => [], { status: () => { throw new Error("offline"); } });
  await offline.refresh();
  assert.equal(offline.element("online-summary-retention").disabled, true);
});

test("Coding Discipline stays clickable when already installed so it can reinstall", async () => {
  const page = pageHarness(async () => [], { status: () => ({ codingDiscipline: { ready: true, installed: true } }) });
  await page.refresh();
  assert.equal(page.element("coding-discipline-install").disabled, false);
  assert.match(page.element("coding-discipline-status").textContent, /is installed/);
});

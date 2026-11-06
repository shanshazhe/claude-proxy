const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const { createRequire } = require("module");
const { spawnSync } = require("child_process");

const LAUNCHER_MODULE = "../lib/claude-launcher-install";

test("macOS/Linux launcher passes the system CA flag and quoted proxy path to Node", (t) => {
  if (process.platform === "win32") return t.skip("Bash launcher requires a Unix host");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "node"), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@"\n', { mode: 0o700 });
  const result = spawnSync("bash", [path.resolve("mac/start-proxy.sh")], {
    cwd: root, env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH || ""}` }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    "Open http://127.0.0.1:8082/login to sign in.", "--use-system-ca", path.resolve("mac/proxy.js")
  ]);
});

test("Windows launchers include the system CA flag before the proxy path", () => {
  const normal = fs.readFileSync(path.resolve("windows/start-proxy.bat"), "utf8");
  assert.match(normal, /start \/min node --use-system-ca "%~dp0proxy\.js"/);
  const hidden = fs.readFileSync(path.resolve("windows/start-proxy-hidden.bat"), "utf8");
  assert.match(hidden, /-ArgumentList '--use-system-ca',/);
});

test("README direct proxy startup examples include the system CA flag", () => {
  const readme = fs.readFileSync(path.resolve("README.md"), "utf8");
  const examples = [...readme.matchAll(/\bnode (?:--use-system-ca )?(?:mac\/proxy\.js|windows\\proxy\.js)\b/g)];
  assert.equal(examples.length, 4);
  for (const [command] of examples) assert.match(command, /^node --use-system-ca /);
});

// 在隔离 VM 中完整运行代理脚本：假的 HTTP 服务、假的依赖和临时目录，不监听端口、不读写真实用户目录。
function startProxy(platform, root, { installer, installerFactory, listen = "success", auth = {},
  catalog = async () => ({ object: "list", data: [] }), gptCatalog = catalog } = {}) {
  const filename = path.resolve(platform, "proxy.js");
  const nativeRequire = createRequire(filename);
  const configRoot = path.join(root, "config");
  fs.mkdirSync(configRoot, { recursive: true });
  const observations = nativeRequire("../lib/online-summary");
  const featureFile = path.join(root, "features.json");
  const logs = [];
  const warns = [];
  const calls = { factory: 0, autoEnable: 0, listening: false, autoEnableBeforeListen: 0,
    setupFactory: 0, syncGpt: 0, syncBeforeListen: 0, syncCapacity: 0, capacityBeforeListen: 0,
    models: [], gptModels: [], invalidations: 0, gptInvalidations: 0 };
  const store = { directory: path.join(root, "store"), migrate() {}, readAuth: () => auth };
  const getAvailableModels = Object.assign((options) => {
    calls.models.push(options);
    return catalog(options);
  }, { invalidate() { calls.invalidations++; } });
  const getGptModels = Object.assign((options) => {
    calls.gptModels.push(options);
    return gptCatalog(options);
  }, { invalidate() { calls.gptInvalidations++; } });
  const server = Object.assign(new EventEmitter(), {
    listen(_port, _host, callback) {
      server.listenCallback = () => { calls.listening = true; callback(); };
      if (listen === "success") server.listenCallback();
      else if (listen === "error") setImmediate(() => server.emit("error", new Error("EADDRINUSE")));
    },
    close() {}, closeIdleConnections() {}
  });
  const fakeProcess = Object.create(process);
  fakeProcess.once = () => fakeProcess;
  fakeProcess.exit = () => {};
  fakeProcess.exitCode = undefined;
  const context = {
    require: (name) => {
      if (name === "http") return { createServer: () => server };
      if (name === LAUNCHER_MODULE) return { createClaudeLauncherInstaller: (...args) => {
        calls.factory++;
        calls.factoryArgs = args;
        if (calls.listening === false) calls.factoryBeforeListen = true;
        return installerFactory ? installerFactory(...args) : { autoEnable: async () => {
          calls.autoEnable++;
          if (!calls.listening) calls.autoEnableBeforeListen++;
          return installer ? installer() : null;
        }, getStatus: async () => ({ state: "unavailable" }) };
      } };
      if (name === "../lib/macos-service") return { createMacosService: () => ({ getStatus: async () => ({ supported: false }) }) };
      if (name === "../lib/project-memory-install") return { createProjectMemoryInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }), autoEnable: async () => null }) };
      if (name === "../lib/coding-discipline-install") return { createCodingDisciplineInstaller: () => ({ getStatus: async () => ({ state: "unavailable" }) }) };
      if (name === "../lib/project-memory-maintainer") return { createProjectMemoryMaintainer: () => ({ enqueue() {} }) };
      if (name === "../lib/credential-store") return { defaultStore: store };
      if (name === "../lib/model-discovery") return { createModelDiscovery: (options) => options.gptOnly ? getGptModels : getAvailableModels };
      if (name === "../lib/auth-server") return { createAuthRouter: (options) => {
        calls.authSetup = options.setup;
        calls.onCredentialsChanged = options.onCredentialsChanged;
        return Object.assign(async () => false, { close() {} });
      } };
      if (name === "../lib/claude-setup") return { ...nativeRequire(name), getClaudeConfigRoot: () => configRoot,
        createClaudeSetup: (options) => {
          calls.setupFactory++;
          const setup = nativeRequire(name).createClaudeSetup({ ...options, configRoot, env: {}, store, getAvailableModels,
            probe: async () => ({ cli: true }) });
          const synchronize = setup.syncGptSubagentModel;
          setup.syncGptSubagentModel = () => {
            calls.syncGpt++;
            if (!calls.listening) calls.syncBeforeListen++;
            calls.syncPending = synchronize();
            return calls.syncPending;
          };
          const synchronizeCapacity = setup.syncGptContextCapacity;
          setup.syncGptContextCapacity = () => {
            calls.syncCapacity++;
            if (!calls.listening) calls.capacityBeforeListen++;
            calls.capacityPending = synchronizeCapacity();
            return calls.capacityPending;
          };
          calls.setup = setup;
          return setup;
        } };
      if (name === "../lib/online-summary") return { ...observations,
        createOnlineSummary: (options) => observations.createOnlineSummary({ ...options, configFile: featureFile, archiveRoot: path.join(root, "observations") }),
        createSummarySettings: (options) => observations.createSummarySettings({ ...options, configFile: featureFile }) };
      return nativeRequire(name);
    },
    __filename: filename, __dirname: path.dirname(filename), process: fakeProcess, Buffer, URL,
    setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval,
    console: { log: (...args) => logs.push(args.join(" ")), warn: (...args) => warns.push(args.join(" ")), error() {} }
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return { server, calls, logs, warns, fakeProcess, featureFile, configRoot, store };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const platform of ["mac", "windows"]) {
  test(`${platform} startup saves maximum GPT capacity only after listening and leaves unchanged values untouched on restart`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-capacity-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot);
    const settings = path.join(configRoot, "settings.json");
    const original = { env: { KEEP: "yes", ANTHROPIC_MODEL: "anthropic/gpt-small", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "123456" },
      model: "personal-model", permissions: { allow: ["Read"] } };
    fs.writeFileSync(settings, JSON.stringify(original));
    const options = { auth: { openai: { type: "api_key", key: "test-key" } },
      catalog: async () => ({ data: [{ id: "gpt-main", context_window: 400000 }] }),
      gptCatalog: async () => ({ data: [{ id: "gpt-small", context_window: 400000 },
        { id: "gpt-largest", max_context_window: 1200000 }, { id: "claude-test", context_window: 2000000 }] }) };
    const first = startProxy(platform, root, { ...options, listen: "manual" });
    assert.equal(first.calls.syncCapacity, 0);
    assert.deepEqual(first.calls.gptModels, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings)), original);
    first.server.listenCallback();
    await Promise.all([first.calls.syncPending, first.calls.capacityPending]);
    const saved = JSON.parse(fs.readFileSync(settings));
    assert.equal(first.calls.syncCapacity, 1);
    assert.equal(first.calls.capacityBeforeListen, 0);
    assert.deepEqual(first.calls.gptModels, [{ waitForRefresh: true }]);
    assert.equal(saved.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1200000");
    assert.equal(saved.env.CLAUDE_CODE_SUBAGENT_MODEL, "anthropic/gpt-main");
    for (const key of ["KEEP", "ANTHROPIC_MODEL"]) assert.equal(saved.env[key], original.env[key]);
    assert.equal(saved.model, original.model);
    assert.deepEqual(saved.permissions, original.permissions);
    const bytes = fs.readFileSync(settings);
    const before = fs.statSync(settings);
    const backups = path.join(configRoot, "claude-proxy", "settings-backups");
    const names = fs.readdirSync(backups);
    const second = startProxy(platform, root, options);
    await Promise.all([second.calls.syncPending, second.calls.capacityPending]);
    assert.equal(second.calls.syncCapacity, 1);
    assert.deepEqual(second.calls.gptModels, [{ waitForRefresh: true }]);
    assert.deepEqual(fs.readFileSync(settings), bytes);
    assert.equal(fs.statSync(settings).ino, before.ino);
    assert.equal(fs.statSync(settings).mtimeMs, before.mtimeMs);
    assert.deepEqual(fs.readdirSync(backups), names);
  });

  test(`${platform} a failed proxy bind never starts capacity discovery or creates settings`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-capacity-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = startProxy(platform, root, { listen: "error", auth: { openai: { type: "api_key", key: "test-key" } },
      gptCatalog: async () => assert.fail("must not discover capacity before listening") });
    await tick();
    assert.equal(run.calls.syncCapacity, 0);
    assert.deepEqual(run.calls.gptModels, []);
    assert.equal(fs.existsSync(path.join(run.configRoot, "settings.json")), false);
  });

  test(`${platform} startup capacity discovery failure keeps the old value and retries on the next restart`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-capacity-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "config"));
    const settings = path.join(root, "config", "settings.json");
    const original = '{ "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "anthropic/gpt-test", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1", "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "123456" } }\n';
    fs.writeFileSync(settings, original);
    let attempts = 0;
    const options = { auth: { openai: { type: "api_key", key: "test-key" } },
      catalog: async () => ({ data: [{ id: "gpt-test" }] }), gptCatalog: async () => {
        if (++attempts === 1) throw new Error("private-token /private/credential/path");
        return { data: [{ id: "gpt-test", context_window: 872000 }] };
      } };
    const failed = startProxy(platform, root, options);
    await assert.rejects(failed.calls.capacityPending);
    await failed.calls.syncPending;
    await tick();
    assert.equal(fs.readFileSync(settings, "utf8"), original);
    assert.equal(failed.warns.filter((line) => line.includes("GPT context capacity sync failed")).length, 1);
    assert.doesNotMatch([...failed.logs, ...failed.warns].join("\n"), /private-token|\/private\/credential/);
    assert.equal(failed.fakeProcess.exitCode, undefined);
    const retried = startProxy(platform, root, options);
    await Promise.all([retried.calls.syncPending, retried.calls.capacityPending]);
    assert.equal(attempts, 2);
    assert.equal(JSON.parse(fs.readFileSync(settings)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "872000");
  });

  test(`${platform} pending startup capacity discovery never blocks listening and skips saving after logout`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-capacity-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const auth = { openai: { type: "api_key", key: "test-key" } };
    let complete;
    const run = startProxy(platform, root, { auth,
      gptCatalog: () => new Promise((resolve) => { complete = resolve; }) });
    assert.equal(run.calls.listening, true);
    assert.equal(run.calls.syncCapacity, 1);
    assert.ok(run.logs.some((line) => line.includes("claude-proxy running")));
    assert.equal(run.fakeProcess.exitCode, undefined);
    delete auth.openai;
    complete({ data: [{ id: "gpt-test", context_window: 872000 }] });
    assert.equal((await run.calls.capacityPending).skipped, true);
    assert.equal(fs.existsSync(path.join(run.configRoot, "settings.json")), false);
  });

  for (const provider of ["openai", "openai-codex"]) {
    test(`${platform} ${provider} login discovers fresh GPT-only maximum capacity and saves it without CLI configuration`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-login-capacity-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const auth = {};
      const run = startProxy(platform, root, { auth, gptCatalog: async (options) => {
        assert.deepEqual(options, { waitForRefresh: true });
        return { data: [{ id: "gpt-small", context_window: 400000 },
          { id: "anthropic/gpt-largest", max_context_window: 1200000 }, { id: "claude-test", context_window: 2000000 }] };
      } });
      await run.calls.syncPending;
      const settings = path.join(run.configRoot, "settings.json");
      const original = { env: { KEEP: "yes", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "123456" }, model: "personal-model" };
      fs.writeFileSync(settings, JSON.stringify(original));
      const fullCatalogCalls = run.calls.models.length;
      auth[provider] = provider === "openai" ? { type: "api_key", key: "test-login-key" }
        : { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 0 };
      await run.calls.onCredentialsChanged(provider);
      assert.deepEqual(JSON.parse(fs.readFileSync(settings)), {
        ...original, env: { ...original.env, CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1200000" }
      });
      assert.equal(run.calls.invalidations, 1);
      assert.equal(run.calls.gptInvalidations, 1);
      assert.equal(run.calls.models.length, fullCatalogCalls);
      assert.equal(run.calls.gptModels.length, 1);
      assert.ok(run.logs.some((line) => line.includes("GPT context capacity saved") && line.includes("tokens=1200000")));
      assert.equal(run.warns.some((line) => line.includes("GPT context capacity sync failed")), false);
    });
  }

  test(`${platform} Copilot login invalidates catalogs but never changes GPT context capacity`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-login-capacity-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const auth = {};
    const run = startProxy(platform, root, { auth });
    await run.calls.syncPending;
    const settings = path.join(run.configRoot, "settings.json");
    const original = '{ "env": { "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "123456" } }\n';
    fs.writeFileSync(settings, original);
    auth.openai = { type: "api_key", key: "test-existing-gpt-key" };
    await run.calls.onCredentialsChanged("github-copilot");
    assert.equal(run.calls.invalidations, 1);
    assert.equal(run.calls.gptInvalidations, 1);
    assert.deepEqual(run.calls.gptModels, []);
    assert.equal(fs.readFileSync(settings, "utf8"), original);
  });

  test(`${platform} failed post-login capacity discovery keeps old settings and logs a safe warning`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-login-capacity-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const auth = {};
    const run = startProxy(platform, root, { auth, gptCatalog: async () => {
      throw new Error("secret-access-token /private/credential/path");
    } });
    await run.calls.syncPending;
    const settings = path.join(run.configRoot, "settings.json");
    const original = '{ "env": { "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "123456" } }\n';
    fs.writeFileSync(settings, original);
    auth.openai = { type: "api_key", key: "test-login-key" };
    await run.calls.onCredentialsChanged("openai");
    assert.equal(fs.readFileSync(settings, "utf8"), original);
    assert.equal(run.warns.filter((line) => line.includes("GPT context capacity sync failed")).length, 1);
    assert.doesNotMatch([...run.logs, ...run.warns].join("\n"), /secret-access|\/private\/credential/);
    assert.equal(run.fakeProcess.exitCode, undefined);
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} startup constructs the launcher installer inertly and enables it only after listen succeeds`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = startProxy(platform, root, { listen: "manual", installer: () => ({ ok: true, changed: true, enabled: true, state: "installed" }) });
    await tick();
    assert.equal(run.calls.factory, 1);
    assert.equal(run.calls.factoryArgs.length, 1);
    assert.equal(run.calls.factoryArgs[0].store, run.store);
    assert.deepEqual(Object.keys(run.calls.factoryArgs[0]), ["store"]);
    assert.equal(run.calls.autoEnable, 0);
    run.server.listenCallback();
    assert.equal(run.calls.autoEnable, 1);
    await tick();
    assert.ok(run.logs.some((line) => line.includes("claude-launcher")), run.logs.join("\n"));
    assert.equal(run.warns.some((line) => line.includes("claude-launcher")), false);
    assert.equal(run.calls.autoEnableBeforeListen, 0);
    assert.equal(fs.existsSync(run.featureFile), false);
  });

  test(`${platform} Configure Claude CLI retries launcher installation after first login`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-onboarding-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const auth = {};
    const run = startProxy(platform, root, { auth,
      catalog: async () => ({ data: [{ id: "gpt-sol-test", context_window: 872000 }] }),
      installer: () => auth.openai ? { ok: true, enabled: true, state: "installed" } : null });
    await tick();
    assert.equal(run.calls.autoEnable, 1);
    auth.openai = { type: "api_key", key: "test-first-login" };
    await run.calls.authSetup.configureCli();
    assert.equal(run.calls.factory, 1);
    assert.equal(run.calls.autoEnable, 2);
    assert.equal(run.calls.autoEnableBeforeListen, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(run.configRoot, "settings.json"))).env.ANTHROPIC_MODEL, "anthropic/gpt-sol-test");
  });

  test(`${platform} startup does not start the launcher installer when listen fails`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = startProxy(platform, root, { listen: "error" });
    await tick(); await tick();
    assert.equal(run.calls.factory, 1);
    assert.equal(run.calls.autoEnable, 0);
    assert.equal(run.fakeProcess.exitCode, 1);
  });

  test(`${platform} startup only warns when the launcher installer rejects or returns null, and never blocks listening`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const rejected = startProxy(platform, root, { installer: () => { throw new Error("shell config exploded"); } });
    assert.equal(rejected.calls.autoEnable, 1);
    await tick();
    assert.ok(rejected.warns.some((line) => line.includes("claude-launcher") && line.includes("shell config exploded")), rejected.warns.join("\n"));
    assert.equal(rejected.fakeProcess.exitCode, undefined);
    assert.ok(rejected.logs.some((line) => line.includes("claude-proxy running")));
    const conflict = startProxy(platform, root, { installer: () => ({ ok: false, reason: "modified shell block" }) });
    await tick();
    assert.ok(conflict.warns.some((line) => line.includes("claude-launcher") && line.includes("modified shell block")));
    assert.equal(conflict.fakeProcess.exitCode, undefined);
    const skipped = startProxy(platform, root, { installer: () => null });
    await tick();
    assert.equal(skipped.warns.some((line) => line.includes("claude-launcher")), false);
    const pending = startProxy(platform, root, { installer: () => null, installerFactory: () => ({ autoEnable: () => new Promise(() => {}), getStatus: async () => ({}) }) });
    assert.ok(pending.logs.some((line) => line.includes("claude-proxy running")));
  });
}

for (const platform of ["mac", "windows"]) {
  const auth = () => ({ openai: { type: "api_key", key: "test-startup-key" } });
  const catalog = async () => ({ data: [{ id: "gpt-startup-test" }] });

  test(`${platform} startup uses one shared setup and syncs GPT only after successful listen`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = startProxy(platform, root, { listen: "manual", auth: auth(), catalog });
    assert.equal(run.calls.setupFactory, 1);
    assert.equal(run.calls.authSetup, run.calls.setup);
    assert.equal(run.calls.syncGpt, 0);
    run.server.listenCallback();
    assert.equal(run.calls.syncGpt, 1);
    assert.equal(run.calls.syncBeforeListen, 0);
    assert.equal((await run.calls.syncPending).model, "anthropic/gpt-startup-test");
    assert.equal(run.calls.models.filter((options) => options?.waitForRefresh === true).length, 1);
    const failedRoot = path.join(root, "failed");
    const failed = startProxy(platform, failedRoot, { listen: "error", auth: auth(), catalog });
    await tick();
    assert.equal(failed.calls.syncGpt, 0);
    assert.equal(fs.existsSync(path.join(failed.configRoot, "settings.json")), false);
  });

  test(`${platform} startup without GPT credentials preserves old settings and does not create new ones`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const existing of [false, true]) {
      const directory = path.join(root, String(existing));
      const configRoot = path.join(directory, "config");
      fs.mkdirSync(configRoot, { recursive: true });
      const settings = path.join(configRoot, "settings.json");
      const original = '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"anthropic/gpt-old","CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"1"},"keep":true}\n';
      if (existing) fs.writeFileSync(settings, original);
      const run = startProxy(platform, directory, { catalog });
      assert.equal((await run.calls.syncPending).skipped, true);
      assert.equal((await run.calls.capacityPending).skipped, true);
      assert.deepEqual(run.calls.gptModels, []);
      if (existing) assert.equal(fs.readFileSync(settings, "utf8"), original);
      else assert.equal(fs.existsSync(settings), false);
      assert.equal(run.calls.models.some((options) => options?.waitForRefresh), false);
      assert.equal(fs.existsSync(path.join(configRoot, "claude-proxy", "settings-backups")), false);
    }
  });

  test(`${platform} repeated startup selects dynamic GPT once and leaves identical settings and backups untouched`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot);
    const settings = path.join(configRoot, "settings.json");
    const original = '{"env":{"KEEP":"yes","ANTHROPIC_MODEL":"claude-sonnet-test"},"model":"personal-model","permissions":{"allow":[]}}\n';
    fs.writeFileSync(settings, original);
    const first = startProxy(platform, root, { auth: auth(), catalog });
    await first.calls.syncPending;
    const bytes = fs.readFileSync(settings);
    const current = JSON.parse(bytes);
    assert.deepEqual(current.env, { KEEP: "yes", ANTHROPIC_MODEL: "claude-sonnet-test",
      CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/gpt-startup-test", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" });
    assert.equal(current.model, "personal-model");
    assert.deepEqual(current.permissions, { allow: [] });
    const backups = path.join(configRoot, "claude-proxy", "settings-backups");
    const names = fs.readdirSync(backups);
    assert.equal(names.length, 1);
    assert.equal(fs.readFileSync(path.join(backups, names[0]), "utf8"), original);
    const modified = fs.statSync(settings).mtimeMs;
    const second = startProxy(platform, root, { auth: auth(), catalog });
    await second.calls.syncPending;
    assert.equal(first.calls.syncGpt, 1);
    assert.equal(second.calls.syncGpt, 1);
    assert.deepEqual(fs.readFileSync(settings), bytes);
    assert.equal(fs.statSync(settings).mtimeMs, modified);
    assert.deepEqual(fs.readdirSync(backups), names);
  });

  test(`${platform} startup without an available GPT keeps existing defaults and warns safely`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot);
    const settings = path.join(configRoot, "settings.json");
    const original = '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"anthropic/gpt-old","CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"1"}}\n';
    fs.writeFileSync(settings, original);
    const run = startProxy(platform, root, { auth: auth(), catalog: async () => ({ data: [{ id: "claude-sonnet-test" }] }) });
    await assert.rejects(run.calls.syncPending);
    await tick();
    assert.equal(fs.readFileSync(settings, "utf8"), original);
    assert.equal(fs.existsSync(path.join(configRoot, "claude-proxy", "settings-backups")), false);
    assert.equal(run.warns.filter((line) => line.includes("GPT subagent")).length, 1);
  });

  test(`${platform} credentials disappearing during startup refresh skip without overwriting settings`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configRoot = path.join(root, "config");
    fs.mkdirSync(configRoot);
    const settings = path.join(configRoot, "settings.json");
    const original = '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"anthropic/gpt-old"}}\n';
    fs.writeFileSync(settings, original);
    const credentials = auth();
    let complete;
    const pending = new Promise((resolve) => { complete = resolve; });
    const run = startProxy(platform, root, { auth: credentials,
      catalog: (options) => options?.waitForRefresh ? pending : catalog() });
    await tick();
    assert.ok(run.calls.models.some((options) => options?.waitForRefresh));
    delete credentials.openai;
    complete(await catalog());
    assert.equal((await run.calls.syncPending).skipped, true);
    assert.equal(fs.readFileSync(settings, "utf8"), original);
    assert.equal(fs.existsSync(path.join(configRoot, "claude-proxy", "settings-backups")), false);
  });

  test(`${platform} pending or failing GPT sync never blocks listening and logs only a safe warning`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pending = startProxy(platform, path.join(root, "pending"), { auth: auth(),
      catalog: (options) => options?.waitForRefresh ? new Promise(() => {}) : catalog() });
    assert.ok(pending.logs.some((line) => line.includes("claude-proxy running")));
    assert.equal(pending.fakeProcess.exitCode, undefined);
    const failure = startProxy(platform, path.join(root, "failure"), { auth: auth(), catalog: async (options) => {
      if (options?.waitForRefresh) throw new Error("secret-access-token secret-refresh-token /private/credential/path");
      return catalog();
    } });
    await tick();
    assert.equal(failure.calls.syncGpt, 1);
    assert.ok(failure.logs.some((line) => line.includes("claude-proxy running")));
    assert.equal(failure.fakeProcess.exitCode, undefined);
    const warnings = failure.warns.filter((line) => line.includes("GPT subagent"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[claude-setup\] WARN GPT subagent model sync failed; existing settings were kept\. Retry on next proxy startup\.$/);
    assert.doesNotMatch([...failure.logs, ...failure.warns].join("\n"), /secret-access|secret-refresh|\/private\/credential/);
  });
}

for (const platform of ["mac", "windows"]) {
  test(`${platform} startup without GPT credentials skips the real launcher without accessing shell or feature files`, async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let pending;
    let accesses = 0;
    const run = startProxy(platform, root, { installerFactory: (options) => {
      const installer = require(LAUNCHER_MODULE).createClaudeLauncherInstaller({ ...options, home: root,
        configRoot: path.join(root, "config"), featureFile: path.join(root, "features.json"), env: {}, platform: "darwin",
        fsImpl: new Proxy({}, { get() { accesses++; throw new Error("unexpected installer filesystem access"); } }),
        execFileSync() { accesses++; throw new Error("unexpected shell access"); } });
      return { ...installer, autoEnable: () => (pending = installer.autoEnable()) };
    } });
    assert.equal(await pending, null);
    await tick();
    assert.equal(accesses, 0);
    assert.equal(run.calls.factoryArgs[0].store, run.store);
    assert.equal(run.warns.some((line) => line.includes("claude-launcher")), false);
    assert.equal(fs.existsSync(path.join(root, ".zshrc")), false);
    assert.equal(fs.existsSync(run.featureFile), false);
    assert.equal(fs.existsSync(path.join(run.configRoot, "claude-proxy", "zsh-backups")), false);
  });
}

test("Windows startup installs the real PowerShell launcher only after listen, once, respecting auth and explicit opt-out", async (t) => {
  const installerModule = require(LAUNCHER_MODULE);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const profile = path.join(home, "Documents", "WindowsPowerShell", "profile.ps1");
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  const original = "$env:KEEP = 'yes'\r\n";
  fs.writeFileSync(profile, original);
  const featureFile = path.join(root, "features.json");
  fs.writeFileSync(featureFile, '{"version":1,"onlineSummary":false}\n');
  const commands = [];
  let pending;
  const installerFactory = (options) => {
    const installer = installerModule.createClaudeLauncherInstaller({ ...options, home,
      configRoot: path.join(root, "config"), featureFile, env: { SystemRoot: path.join(root, "Windows") }, platform: "win32",
      execFileSync(file, args) {
        commands.push({ file, args });
        if (file === process.execPath) {
          assert.deepEqual(args, ["--version"]);
          return process.version;
        }
        assert.equal(path.basename(file), "powershell.exe");
        assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
        if (args[4].includes("$PROFILE.CurrentUserAllHosts")) return profile + "\r\n";
        assert.match(args[4], /Language\.Parser\]::ParseFile/);
        return "";
      } });
    return { ...installer, autoEnable: () => (pending = installer.autoEnable()) };
  };
  const auth = { openai: { type: "api_key", key: "test-startup-key" } };
  const first = startProxy("windows", root, { installerFactory, auth, listen: "manual" });
  await tick();
  assert.equal(pending, undefined);
  assert.equal(commands.length, 0);
  assert.equal(fs.readFileSync(profile, "utf8"), original);
  first.server.listenCallback();
  assert.equal((await pending).ok, true);
  assert.equal(first.calls.factoryArgs[0].store, first.store);
  const installed = fs.readFileSync(profile);
  assert.ok(installed.toString().startsWith(original));
  assert.match(installed.toString(), /function global:claude \{/);
  assert.match(installed.toString(), /claude-launch\.js'\) \+ \$args/);
  const featureBytes = fs.readFileSync(featureFile);
  const enabled = JSON.parse(featureBytes);
  assert.equal(enabled.claudeLauncher, true);
  assert.equal(enabled.onlineSummary, false);
  const backups = path.join(root, "config", "claude-proxy", "powershell-backups");
  const names = fs.readdirSync(backups);
  assert.equal(names.length, 1);
  assert.equal(fs.readFileSync(path.join(backups, names[0]), "utf8"), original);
  startProxy("windows", root, { installerFactory, auth });
  assert.equal((await pending).changed, false);
  assert.deepEqual(fs.readFileSync(profile), installed);
  assert.deepEqual(fs.readFileSync(featureFile), featureBytes);
  assert.deepEqual(fs.readdirSync(backups), names);
  const commandCount = commands.length;
  startProxy("windows", root, { installerFactory });
  assert.equal(await pending, null);
  assert.equal(commands.length, commandCount);
  assert.deepEqual(fs.readFileSync(profile), installed);
  assert.deepEqual(fs.readFileSync(featureFile), featureBytes);
  fs.writeFileSync(profile, original);
  fs.writeFileSync(featureFile, '{"version":1,"claudeLauncher":false}\n');
  startProxy("windows", root, { installerFactory, auth });
  assert.equal(await pending, null);
  assert.equal(commands.length, commandCount);
  assert.equal(fs.readFileSync(profile, "utf8"), original);
  assert.equal(fs.readFileSync(featureFile, "utf8"), '{"version":1,"claudeLauncher":false}\n');
  assert.deepEqual(fs.readdirSync(backups), names);
});

test("real launcher installer in a temp home enables once, then leaves everything unchanged, and never overrides an explicit false", async (t) => {
  const installerModule = require(LAUNCHER_MODULE);
  if (!fs.existsSync("/bin/zsh")) return t.skip("zsh unavailable");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-startup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const featureFile = path.join(root, "features.json");
  const zshrc = path.join(home, ".zshrc");
  fs.writeFileSync(zshrc, "export KEEP=1\n");
  fs.writeFileSync(featureFile, '{"version":1,"onlineSummary":false}\n');
  const auth = { openai: { type: "api_key", key: "test-startup-key" } };
  let pending;
  const installerFactory = (options) => {
    const installer = installerModule.createClaudeLauncherInstaller({ ...options, home, configRoot: path.join(root, "config"), featureFile, env: {}, platform: "darwin" });
    return { ...installer, autoEnable: () => (pending = installer.autoEnable()) };
  };
  const first = startProxy("mac", root, { installerFactory, auth });
  await pending;
  assert.equal(first.calls.factoryArgs[0].store, first.store);
  const enabled = JSON.parse(fs.readFileSync(featureFile, "utf8"));
  assert.equal(enabled.claudeLauncher, true);
  assert.equal(enabled.onlineSummary, false);
  const installed = fs.readFileSync(zshrc);
  assert.match(installed.toString(), /claude-proxy capacity launcher/);
  const featureBytes = fs.readFileSync(featureFile);
  const second = startProxy("mac", root, { installerFactory, auth });
  await pending;
  assert.equal(second.calls.factoryArgs[0].store, second.store);
  assert.deepEqual(fs.readFileSync(zshrc), installed);
  assert.deepEqual(fs.readFileSync(featureFile), featureBytes);
  const backups = path.join(root, "config", "claude-proxy", "zsh-backups");
  const names = fs.readdirSync(backups);
  startProxy("mac", root, { installerFactory });
  assert.equal(await pending, null);
  assert.deepEqual(fs.readFileSync(zshrc), installed);
  assert.deepEqual(fs.readFileSync(featureFile), featureBytes);
  assert.deepEqual(fs.readdirSync(backups), names);
  fs.writeFileSync(zshrc, "export KEEP=1\n");
  fs.writeFileSync(featureFile, '{"version":1,"claudeLauncher":false}\n');
  const third = startProxy("mac", root, { installerFactory, auth });
  assert.equal(await pending, null);
  assert.equal(fs.readFileSync(zshrc, "utf8"), "export KEEP=1\n");
  assert.equal(fs.readFileSync(featureFile, "utf8"), '{"version":1,"claudeLauncher":false}\n');
  assert.equal(third.warns.some((line) => line.includes("claude-launcher")), false);
});

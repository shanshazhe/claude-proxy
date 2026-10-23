const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const { buildLaunch, main: launchMain } = require("../lib/claude-launch");
const signedInStore = { readAuth: () => ({ openai: { type: "api_key", key: "test-key" } }) };
const main = (options) => launchMain({ store: signedInStore, ...options });
const { createSetupProbe } = require("../lib/claude-probes");

const catalog = { data: [
  { id: "anthropic/gpt-6.1-sol", context_window: 872000 },
  { id: "anthropic/gpt-small", context_window: 400000 },
  { id: "claude-opus-4.8", context_window: 1000000 },
  { id: "claude-haiku-4.5", context_window: 200000 }
] };

test("ordinary settings-selected launches use the shared valid GPT window without selecting a model", () => {
  const args = ["--settings", "private settings.json", "--setting-sources", "user,project", "-p", "hello", "--", "--model=gpt-small"];
  const env = { KEEP: "yes" };
  const launch = buildLaunch(catalog, args, env);
  assert.deepEqual(launch.args, args);
  assert.deepEqual(launch.env, { KEEP: "yes", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000" });
  assert.deepEqual(env, { KEEP: "yes" });
  assert.equal(buildLaunch(catalog, [], { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "123456" }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "123456");
  const mixed = { data: [...catalog.data, { id: "gpt-invalid", context_window: "100" }] };
  assert.equal(buildLaunch(mixed, [], {}).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "400000");
  for (const data of [[{ id: "gpt-invalid" }], [{ id: "claude-opus-4.8", context_window: 1000000 }]]) {
    assert.deepEqual(buildLaunch({ data }, [], {}).env, {});
  }
});

test("raw and prefixed GPT selections launch with the catalog identity without injecting settings", () => {
  for (const model of ["gpt-6.1-sol", "anthropic/gpt-6.1-sol", "anthropic/gpt-6.1-sol[1m]"]) {
    for (const [args, env] of [[["-p", "hi"], { ANTHROPIC_MODEL: model }], [["--model", model, "-p", "hi"], {}],
      [["--model=" + model, "-p", "hi"], {}]]) {
      const snapshot = { args: [...args], env: { ...env } };
      const launch = buildLaunch(catalog, args, env);
      assert.deepEqual(launch.args, args[0] === "-p" ? ["-p", "hi", "--model", "anthropic/gpt-6.1-sol"]
        : ["--model", "anthropic/gpt-6.1-sol", "-p", "hi"]);
      assert.equal(launch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "872000");
      assert.match(launch.warnings[0], /\/model does not update/);
      assert.deepEqual({ args, env }, snapshot);
    }
  }
  const args = ["--model", "claude-gateway/gpt-6.1-sol"];
  assert.deepEqual(buildLaunch(catalog, args, {}).args, args);
});

test("--model wins over the environment, and a Claude start keeps a window for later raw GPT switches", () => {
  for (const args of [["--model", "claude-opus-4.8"], ["--model=claude-opus-4.8[1m]"]]) {
    const launch = buildLaunch(catalog, args, { ANTHROPIC_MODEL: "gpt-small" });
    assert.deepEqual(launch.args, ["--model", "claude-opus-4.8[1m]"]);
    assert.equal(launch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "400000");
  }
  assert.equal(buildLaunch(catalog, [], { ANTHROPIC_MODEL: "gpt-small" }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "400000");
});

test("unknown models, caller limits and the prompt after -- remain untouched", () => {
  const args = ["--model", "opus", "--", "--settings", "prompt", "--model=gpt-small"];
  const launch = buildLaunch({ data: [{ id: "anthropic/gpt-new" }] }, args, { KEEP: "1" });
  assert.deepEqual(launch.args, args);
  assert.deepEqual(launch.env, { KEEP: "1" });
  const selected = buildLaunch(catalog, ["--", "prompt"], { ANTHROPIC_MODEL: "gpt-small", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "300000" });
  assert.deepEqual(selected.args, ["--model", "anthropic/gpt-small", "--", "prompt"]);
  assert.equal(selected.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "300000");
});

test("all non-model flags pass through without parsing, reading or injecting settings", async () => {
  const args = ["--settings", "file that does not exist.json", "--setting-sources=project", "--bare", "-p", "hello"];
  const env = { ANTHROPIC_BASE_URL: "http://environment", KEEP: "yes" };
  const unknownCatalog = { data: [{ id: "gpt-unknown" }] };
  assert.deepEqual(buildLaunch(unknownCatalog, args, env).args, args);
  assert.equal(await main({ args, env,
    fetchImpl: async (url) => {
      assert.equal(url, "http://environment/v1/models?wait_for_refresh=true");
      return { ok: true, json: async () => unknownCatalog };
    },
    probe: async () => ({ claudeCommand: { file: "cli", args: [] } }),
    spawnImpl: (file, actual, options) => {
      assert.equal(file, "cli");
      assert.deepEqual(actual, args);
      assert.deepEqual(options.env, env);
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 3));
      return child;
    } }), 3);
});

test("session startup allows 15 seconds and adopts a catalog arriving after 3 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    timeouts.push(milliseconds);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  let spawned = false;
  const launching = main({ args: [], env: {},
    fetchImpl: async (url, { signal }) => {
      assert.equal(url, "http://localhost:8082/v1/models?wait_for_refresh=true");
      await new Promise((resolve, reject) => {
        setTimeout(resolve, 5000);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { ok: true, json: async () => ({ data: [{ id: "gpt-test", context_window: 872000 }] }) };
    },
    probe: async () => ({ claudeCommand: { file: "cli", args: [] } }),
    spawnImpl: (file, args, options) => {
      spawned = true;
      assert.equal(options.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "872000");
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 0));
      return child;
    } });
  t.mock.timers.tick(3000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned, false);
  t.mock.timers.tick(2000);
  assert.equal(await launching, 0);
  assert.deepEqual(timeouts, [15000]);
  assert.equal(spawned, true);
});

test("catalog failures preserve original arguments and spawn errors are reported", async () => {
  const args = ["--model", "gpt-small", "-p", "hello"];
  assert.equal(await main({ args, env: {}, fetchImpl: async () => { throw new Error("offline"); },
    probe: async () => ({ claudeCommand: { file: "node.exe", args: ["C:/npm with spaces/cli.js"] } }),
    spawnImpl: (file, actual) => {
      assert.equal(file, "node.exe");
      assert.deepEqual(actual, ["C:/npm with spaces/cli.js", ...args]);
      const child = new EventEmitter();
      process.nextTick(() => child.emit("error", new Error("ENOENT")));
      return child;
    } }), 1);
});

test("non-session commands bypass catalog discovery and preserve all arguments and environment", async () => {
  for (const args of [["--version"], ["-v"], ["--help"], ["-h"], ["update"], ["upgrade"], ["auth", "status"],
    ["mcp", "list"], ["plugin", "list"], ["doctor"], ["install", "latest"], ["--settings", "private.json", "update"]]) {
    const env = { ANTHROPIC_MODEL: "gpt-small", KEEP: "yes" };
    let fetched = 0;
    let authReads = 0;
    assert.deepEqual(buildLaunch(catalog, args, env), { args, env, warnings: [] });
    assert.equal(await main({ args, env,
      store: { readAuth() { authReads++; throw new Error("must not read auth"); } },
      fetchImpl: async () => { fetched++; throw new Error("unexpected catalog request"); },
      probe: async () => ({ claudeCommand: { file: "cli", args: [] } }),
      spawnImpl: (file, actual, options) => {
        assert.deepEqual(actual, args);
        assert.deepEqual(options.env, env);
        assert.equal(options.stdio, "inherit");
        assert.equal(options.shell, false);
        const child = new EventEmitter();
        process.nextTick(() => child.emit("exit", 7));
        return child;
      } }), 7);
    assert.equal(fetched, 0, "non-session command must not fetch models");
    assert.equal(authReads, 0, "non-session command must not read auth");
  }
  // Help-like text and command names used as option values or prompts are not subcommands.
  for (const args of [["--system-prompt", "--help", "-p", "hi"], ["--settings", "update", "-p", "hi"],
    ["-p", "update"], ["--", "update"], ["hello", "--version"]]) {
    assert.equal(buildLaunch(catalog, args, {}).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "400000");
  }
});

test("catalog HTTP, JSON and timeout failures warn but still start the original CLI", async (t) => {
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));
  for (const response of [() => ({ ok: false }), () => ({ ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } }),
    () => { throw new DOMException("timed out", "TimeoutError"); }]) {
    const args = ["--model", "gpt-small", "-p", "hello"];
    const env = { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "123456" };
    const before = process.listenerCount("SIGINT");
    assert.equal(await main({ args, env, fetchImpl: async (url, options) => {
      assert.equal(url, "http://localhost:8082/v1/models?wait_for_refresh=true");
      assert.ok(options.signal instanceof AbortSignal);
      return response();
    }, probe: async () => ({ claudeCommand: { file: "cli", args: [] } }),
    spawnImpl: (file, actual, options) => {
      assert.deepEqual(actual, args);
      assert.deepEqual(options.env, env);
      assert.equal(process.listenerCount("SIGINT"), before + 1);
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 4));
      return child;
    } }), 4);
    assert.equal(process.listenerCount("SIGINT"), before);
  }
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((message) => /model catalog unavailable/.test(message)));
});

test("invalid catalogs warn and fall back to the original CLI context", async (t) => {
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));
  for (const body of [null, {}, { data: null }, { data: [] }, { data: [null] }, { data: [{}] }]) {
    const args = ["-p", "hello"];
    const env = { KEEP: "yes" };
    assert.equal(await main({ args, env, fetchImpl: async () => ({ ok: true, json: async () => body }),
      probe: async () => ({ claudeCommand: { file: "cli", args: [] } }),
      spawnImpl: (file, actual, options) => {
        assert.deepEqual(actual, args);
        assert.deepEqual(options.env, env);
        const child = new EventEmitter();
        process.nextTick(() => child.emit("exit", 0));
        return child;
      } }), 0);
  }
  assert.equal(warnings.length, 6);
  assert.ok(warnings.every((message) => /model catalog unavailable/.test(message)));
});

test("successive launches fetch changing catalog capacities for real child processes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-launch-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, "fake cli.cjs");
  const output = path.join(directory, "result.json");
  fs.writeFileSync(fixture, 'require("node:fs").writeFileSync(process.env.RESULT_FILE, JSON.stringify({ tokens: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, args: process.argv.slice(2), cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR })); process.exitCode = 9;');
  let capacity = 500000;
  let fetched = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models?wait_for_refresh=true");
    fetched++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "anthropic/gpt-test", context_window: capacity }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const args = ["--settings", "not read.json", "-p", "original prompt", "--", "--model=gpt-test"];
  const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/`, CLAUDE_CONFIG_DIR: directory, RESULT_FILE: output };
  for (const nextCapacity of [500000, 700000]) {
    capacity = nextCapacity;
    assert.equal(await main({ args, env, probe: async () => ({ claudeCommand: { file: process.execPath, args: [fixture] } }) }), 9);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
      tokens: String(capacity), args, cwd: process.cwd(), config: directory
    });
  }
  assert.equal(fetched, 2);
});

test("signed-in sessions adopt catalog arguments, capacity and warnings after a final read-only check", async (t) => {
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));
  for (const provider of ["openai", "openai-codex", "environment"]) {
    const args = ["--model=anthropic/gpt-small[1m]", "-p", "hello"];
    const env = provider === "environment" ? { OPENAI_API_KEY: "test-key" } : {};
    let reads = 0;
    let probed = false;
    assert.equal(await main({ args, env,
      store: { readAuth(options) {
        assert.deepEqual(options, { readOnly: true });
        reads++;
        if (reads === 2) assert.equal(probed, true);
        return provider === "environment" ? {} : { [provider]: { type: "oauth", access: "access", refresh: "refresh", expires: 0 } };
      } },
      fetchImpl: async () => ({ ok: true, json: async () => catalog }),
      probe: async () => { probed = true; return { claudeCommand: { file: "cli", args: [] } }; },
      spawnImpl: (file, actual, options) => {
        assert.equal(reads, 2);
        assert.deepEqual(actual, ["--model", "anthropic/gpt-small", "-p", "hello"]);
        assert.deepEqual(options.env, { ...env, CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000" });
        const child = new EventEmitter();
        process.nextTick(() => child.emit("exit", 0));
        return child;
      } }), 0);
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  }
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((message) => /\/model does not update/.test(message)));
});

test("signed-out sessions never fetch even a cached GPT catalog and preserve caller context", async (t) => {
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));
  for (const auth of [{}, { "github-copilot": { type: "oauth", access: "access", refresh: "refresh", expires: 0 } },
    { openai: { type: "api_key", key: " " } }, null]) {
    for (const limit of [undefined, "123456"]) {
      const args = ["--model=anthropic/gpt-small[1m]", "-p", "hello"];
      const env = { ANTHROPIC_MODEL: "claude-opus-4.8", KEEP: "yes",
        ...(limit ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: limit } : {}) };
      let fetched = 0;
      assert.equal(await main({ args, env,
        store: { readAuth(options) {
          assert.deepEqual(options, { readOnly: true });
          if (auth === null) throw new Error("private-storage-detail");
          return auth;
        } },
        fetchImpl: async () => { fetched++; return { ok: true, json: async () => catalog }; },
        probe: async () => ({ claudeCommand: { file: "cli", args: [] } }),
        spawnImpl: (file, actual, options) => {
          assert.strictEqual(actual.length, args.length);
          assert.deepEqual(actual, args);
          assert.strictEqual(options.env, env);
          const child = new EventEmitter();
          process.nextTick(() => child.emit("exit", 0));
          return child;
        } }), 0);
      assert.equal(fetched, 0);
    }
  }
  assert.deepEqual(warnings, []);
});

test("logout during catalog fetch, JSON or CLI probing discards derived arguments, context and warnings", async (t) => {
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));
  for (const stage of ["fetch", "json", "probe", "catalog-error"]) {
    for (const [brokenStore, limit] of [[false, undefined], [false, "123456"], [true, undefined], [true, "123456"]]) {
      let signedIn = true;
      let reads = 0;
      const args = ["--model=anthropic/gpt-small[1m]", "-p", "hello"];
      const env = { KEEP: "yes", ...(limit ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: limit } : {}) };
      const logout = async () => { await Promise.resolve(); signedIn = false; };
      assert.equal(await main({ args, env,
        store: { readAuth(options) {
          reads++;
          assert.deepEqual(options, { readOnly: true });
          if (!signedIn && brokenStore) throw new Error("private-storage-detail");
          return signedIn ? signedInStore.readAuth() : {};
        } },
        fetchImpl: async () => {
          if (stage === "fetch" || stage === "catalog-error") await logout();
          if (stage === "catalog-error") throw new Error("offline");
          return { ok: true, json: async () => {
            if (stage === "json") await logout();
            return catalog;
          } };
        },
        probe: async () => {
          if (stage === "probe") await logout();
          return { claudeCommand: { file: "cli", args: [] } };
        },
        spawnImpl: (file, actual, options) => {
          assert.deepEqual(actual, args);
          assert.strictEqual(options.env, env);
          const child = new EventEmitter();
          process.nextTick(() => child.emit("exit", 0));
          return child;
        } }), 0);
      assert.equal(reads, 2, "credentials must be rechecked after all async operations");
    }
  }
  assert.deepEqual(warnings, []);
});

test("native and npm probes return shell-free launch commands", async () => {
  for (const native of [true, false]) {
    const cli = path.win32.join("C:/npm", "node_modules/@anthropic-ai/claude-code/cli.js");
    const executable = path.win32.join("C:/npm", "claude.exe");
    const probe = createSetupProbe({ platform: "win32", home: "C:/home", node: "C:/node/node.exe",
      env: native ? { Path: "C:/npm" } : { PATH: "C:/npm" }, includeClaudeCommand: true,
      fsImpl: { statSync: (file) => ({ isFile: () => native ? file === executable : file === cli }) },
      execFileImpl: (file, args, options, callback) => {
        assert.equal(options.shell, false);
        assert.equal(file.endsWith(".cmd"), false);
        callback(null, file.endsWith("node.exe") && args[0] === "--version" ? "v26.7.0" : "2.1.302 (Claude Code)");
      } });
    assert.deepEqual((await probe()).claudeCommand, native ? { file: executable, args: [] } : { file: "C:/node/node.exe", args: [cli] });
  }
});

test("unknown or invalid selected GPT capacity never borrows another model's limit", () => {
  for (const capacity of [undefined, null, 0, -1, 1.5, "400000", Number.MAX_SAFE_INTEGER + 1]) {
    const models = { data: [{ id: "gpt-small", context_window: capacity }, { id: "gpt-large", context_window: 1000000 }] };
    for (const [args, env] of [[["--model", "gpt-small"], {}], [[], { ANTHROPIC_MODEL: "gpt-small" }]]) {
      const launch = buildLaunch(models, args, env);
      assert.equal(launch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
    }
    assert.equal(buildLaunch(models, ["--model", "gpt-not-listed"], {}).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
    assert.equal(buildLaunch(models, ["--model", "gpt-small"], { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "300000" })
      .env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "300000");
  }
});

test("an explicit Claude selection without valid capacity does not borrow the shared GPT limit", () => {
  const models = { data: [{ id: "claude-test" }, { id: "gpt-test", context_window: 500000 }] };
  for (const [args, env] of [[["--model", "claude-test"], {}], [[], { ANTHROPIC_MODEL: "claude-test" }]]) {
    assert.equal(buildLaunch(models, args, env).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  }
});

test("model-looking values of other options are never rewritten as model flags", () => {
  for (const option of ["--system-prompt", "--append-system-prompt", "--settings", "--agent", "--debug-file", "--tools", "--mcp-config", "-n"]) {
    for (const value of ["--model=gpt-small", "--model"]) {
      const args = [option, value, "-p", "hello"];
      const launch = buildLaunch(catalog, args, {});
      assert.deepEqual(launch.args, args);
      const explicit = [...args, "--model", "anthropic/gpt-6.1-sol[1m]"];
      const selected = buildLaunch(catalog, explicit, {});
      assert.deepEqual(selected.args, [...args, "--model", "anthropic/gpt-6.1-sol"]);
      assert.equal(selected.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "872000");
    }
  }
  const optional = buildLaunch(catalog, ["--debug", "--model=gpt-small"], {});
  assert.deepEqual(optional.args, ["--debug", "--model", "anthropic/gpt-small"]);
  const repeated = buildLaunch(catalog, ["--model=gpt-small", "--system-prompt", "--model=gpt-small", "--model=gpt-6.1-sol"], {});
  assert.deepEqual(repeated.args, ["--model=gpt-small", "--system-prompt", "--model=gpt-small", "--model", "anthropic/gpt-6.1-sol"]);
});

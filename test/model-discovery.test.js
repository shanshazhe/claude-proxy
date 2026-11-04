const test = require("node:test");
const assert = require("node:assert/strict");
const { createModelDiscovery } = require("../lib/model-discovery");

const ok = (data) => ({ ok: true, json: async () => data });
const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const kind of ["api", "codex"]) {
  test(`GPT-only discovery never probes Copilot and caches independently (${kind})`, async () => {
    let clock = 0;
    let calls = 0;
    const getModels = createModelDiscovery({
      gptOnly: true,
      now: () => clock,
      loadClaudeAuth: async () => assert.fail("must not load Copilot auth"),
      loadAuth: async () => ({ kind, token: "fixture", accountId: "fixture-account" }),
      onWarning: () => assert.fail("unused providers must not produce warnings"),
      fetchImpl: async (url) => {
        calls++;
        assert.ok(url.includes(kind === "codex" ? "/backend-api/codex/models?" : "/models"));
        const model = { id: "gpt-test", slug: "gpt-test", context_window: 872000 };
        return ok(kind === "codex" ? { models: [model] } : { data: [model] });
      }
    });
    const initial = await getModels({ waitForRefresh: true });
    assert.equal(initial.data[0].context_window, 872000);
    clock = 30001;
    assert.strictEqual(await getModels({ waitForRefresh: true }), initial);
    assert.equal(calls, 1, "unused providers must not shorten the successful cache to 30s");
    getModels.invalidate();
    await getModels({ waitForRefresh: true });
    assert.equal(calls, 2);
  });
}

test("GPT-only discovery does not reuse a failed full catalog's empty cache", async () => {
  let fail = true;
  let calls = 0;
  const options = {
    loadClaudeAuth: async () => { throw new Error("no Copilot fixture"); },
    loadAuth: async () => ({ kind: "api", token: "fixture" }),
    fetchImpl: async () => {
      calls++;
      if (fail) throw new Error("offline");
      return ok({ data: [{ id: "gpt-test", context_window: 872000 }] });
    }
  };
  const full = createModelDiscovery(options);
  const gpt = createModelDiscovery({ ...options, gptOnly: true });
  assert.deepEqual((await full({ waitForRefresh: true })).data, []);
  fail = false;
  assert.equal((await gpt({ waitForRefresh: true })).data[0].context_window, 872000);
  assert.deepEqual((await full({ waitForRefresh: true })).data, []);
  assert.equal(calls, 2);
});

test("GPT-only startup waits past 2.2s but retains the 12s upstream deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const warnings = [];
  const getModels = createModelDiscovery({
    gptOnly: true,
    loadAuth: async () => ({ kind: "api", token: "fixture" }),
    loadClaudeAuth: async () => assert.fail("must not load Copilot auth"),
    onWarning: (source, message) => warnings.push([source, message]),
    fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); }
  });
  let result;
  const waiting = getModels({ waitForRefresh: true }).then((value) => { result = value; });
  await flush();
  t.mock.timers.tick(2200);
  await flush();
  assert.equal(result, undefined);
  t.mock.timers.tick(9800);
  await waiting;
  assert.deepEqual(result.data, []);
  assert.equal(signal.aborted, true);
  assert.deepEqual(warnings, [["OpenAI Responses", "Model discovery timed out"]]);
});

for (const options of [undefined, { waitForRefresh: false }]) {
  test(`discovery keeps the 2.2s empty fallback with ${JSON.stringify(options)} options`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const getModels = createModelDiscovery({
      loadAuth: async () => ({ kind: "api", token: "fixture" }),
      loadClaudeAuth: async () => { throw new Error("no Copilot fixture"); },
      fetchImpl: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return ok({ data: [{ id: "gpt-5.4" }] });
      }
    });
    let result;
    const reply = getModels(options).then((value) => { result = value; });
    await flush();
    t.mock.timers.tick(2199);
    await flush();
    assert.equal(result, undefined);
    t.mock.timers.tick(1);
    await reply;
    assert.deepEqual(result, { object: "list", data: [] });
    t.mock.timers.tick(2800);
    await flush();
    const refreshed = await getModels({ waitForRefresh: true });
    assert.deepEqual(refreshed.data.map((model) => model.id), ["gpt-5.4"]);
    assert.strictEqual(await getModels(), refreshed);
    assert.equal(calls, 1);
  });
}

test("waitForRefresh waits beyond the reply deadline and coalesces mixed callers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const getModels = createModelDiscovery({
    loadAuth: async () => ({ kind: "api", token: "fixture" }),
    loadClaudeAuth: async () => ({ token: "fixture", baseUrl: "https://api.business.githubcopilot.com" }),
    fetchImpl: async (url) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return ok({ data: url.includes("githubcopilot.com")
        ? [{ id: "claude-sonnet-4", model_picker_enabled: true }] : [{ id: "gpt-5.4" }] });
    }
  });
  let refreshed;
  const waiting = getModels({ waitForRefresh: true }).then((value) => { refreshed = value; return value; });
  const ordinary = getModels();
  const explicitDefault = getModels({ waitForRefresh: false });
  await flush();
  t.mock.timers.tick(2200);
  await flush();
  assert.deepEqual(await ordinary, { object: "list", data: [] });
  assert.deepEqual(await explicitDefault, { object: "list", data: [] });
  assert.equal(refreshed, undefined);
  const joined = getModels({ waitForRefresh: true });
  t.mock.timers.tick(2799);
  await flush();
  assert.equal(refreshed, undefined);
  t.mock.timers.tick(1);
  await flush();
  assert.ok(refreshed);
  assert.strictEqual(await joined, await waiting);
  assert.deepEqual(refreshed.data.map((model) => model.id), ["gpt-5.4", "claude-sonnet-4"]);
  assert.strictEqual(await getModels({ waitForRefresh: true }), refreshed);
  assert.equal(calls, 2);
});

test("default discovery returns stale cache while waitForRefresh awaits its refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  let calls = 0;
  const getModels = createModelDiscovery({
    now: () => clock,
    loadAuth: async () => ({ kind: "api", token: "fixture" }),
    loadClaudeAuth: async () => { throw new Error("no Copilot fixture"); },
    fetchImpl: async () => {
      const index = ++calls;
      if (index > 1) await new Promise((resolve) => setTimeout(resolve, 5000));
      return ok({ data: [{ id: `gpt-${index}.4` }] });
    }
  });
  const initial = await getModels({ waitForRefresh: true });
  assert.strictEqual(await getModels({ waitForRefresh: true }), initial);
  assert.equal(calls, 1);
  clock = 30001;
  let refreshed;
  const ordinary = getModels();
  const waiting = getModels({ waitForRefresh: true }).then((value) => { refreshed = value; });
  await flush();
  t.mock.timers.tick(2200);
  await flush();
  assert.strictEqual(await ordinary, initial);
  assert.equal(refreshed, undefined);
  t.mock.timers.tick(2800);
  await flush();
  assert.ok(refreshed);
  await waiting;
  assert.deepEqual(refreshed.data.map((model) => model.id), ["gpt-2.4"]);
  assert.equal(calls, 2);
});

for (const allUnavailable of [false, true]) {
  test(`waitForRefresh shares the original 12s upstream timeout (${allUnavailable ? "all unavailable" : "partial catalog"})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const signals = [];
    const warnings = [];
    const getModels = createModelDiscovery({
      onWarning: (source, message) => warnings.push([source, message]),
      loadAuth: async () => ({ kind: "api", token: "fixture" }),
      loadClaudeAuth: async () => ({ token: "fixture", baseUrl: "https://api.business.githubcopilot.com" }),
      fetchImpl: async (url, { signal }) => {
        signals.push(signal);
        if (!allUnavailable && !url.includes("githubcopilot.com")) return ok({ data: [{ id: "gpt-5.4" }] });
        return new Promise(() => {}); // Ignore abort to exercise the discovery deadline itself.
      }
    });
    let result;
    const waiting = getModels({ waitForRefresh: true }).then((value) => { result = value; return value; });
    await flush();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(result, undefined);
    const joined = getModels({ waitForRefresh: true });
    t.mock.timers.tick(6999);
    await flush();
    assert.equal(result, undefined);
    t.mock.timers.tick(1);
    await flush();
    assert.ok(result);
    assert.strictEqual(await joined, await waiting);
    assert.deepEqual(result.data.map((model) => model.id), allUnavailable ? [] : ["gpt-5.4"]);
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.deepEqual(warnings, (allUnavailable ? ["OpenAI Responses", "GitHub Copilot"] : ["GitHub Copilot"])
      .map((source) => [source, "Model discovery timed out"]));
    assert.strictEqual(await getModels({ waitForRefresh: true }), result);
    assert.equal(signals.length, 2);
  });
}

test("invalidation refreshes immediately and an older pending catalog cannot restore stale cache", async () => {
  let release;
  let calls = 0;
  const getModels = createModelDiscovery({
    now: () => 1,
    loadAuth: async () => ({ kind: "api", token: "test" }),
    loadClaudeAuth: async () => { throw new Error("no Copilot auth"); },
    fetchImpl: async () => {
      const index = ++calls;
      if (index === 1) await new Promise((resolve) => { release = resolve; });
      return ok({ data: [{ id: `gpt-${index}.4` }] });
    }
  });
  const old = getModels();
  await new Promise((resolve) => setImmediate(resolve));
  getModels.invalidate();
  const fresh = await getModels();
  assert.equal(fresh.data[0].id, "gpt-2.4");
  release();
  await old;
  assert.equal((await getModels()).data[0].id, "gpt-2.4");
  assert.equal(calls, 2);
  getModels.invalidate();
  assert.equal((await getModels()).data[0].id, "gpt-3.4");
});

test("OpenAI Responses and Copilot Claude catalogs merge, coalesce, and cache", async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const warnings = [];
  const getModels = createModelDiscovery({
    now: () => clock,
    onWarning: (source) => warnings.push(source),
    loadClaudeAuth: async () => ({ token: "copilot-test", baseUrl: "https://api.business.githubcopilot.com" }),
    loadAuth: async () => ({ kind: "api", token: "openai-test" }),
    fetchImpl: async (url, options) => {
      calls++;
      if (fail) throw new Error("offline");
      assert.equal(options.redirect, "error");
      if (url.includes("githubcopilot.com")) {
        assert.equal(options.headers.Authorization, "Bearer copilot-test");
        return ok({ data: [
          { id: "claude-sonnet-4", model_picker_enabled: true },
          { id: "gpt-5.4", model_picker_enabled: true }
        ] });
      }
      assert.equal(url, "https://api.openai.com/v1/models");
      assert.equal(options.headers.Authorization, "Bearer openai-test");
      return ok({ data: [{ id: "gpt-5.4" }, { id: "gpt-5.4-realtime" }, { id: "text-embedding-3-large" }] });
    }
  });
  const [first, joined] = await Promise.all([getModels(), getModels()]);
  assert.equal(calls, 2);
  assert.deepEqual(first.data.map((model) => model.id), ["gpt-5.4", "claude-sonnet-4"]);
  assert.deepEqual(joined, first);
  await getModels();
  assert.equal(calls, 2);
  clock = 300001;
  fail = true;
  assert.deepEqual((await getModels()).data, first.data);
  assert.deepEqual(warnings, ["OpenAI Responses", "GitHub Copilot"]);
  assert.equal(calls, 4);
});

test("Codex catalog honors visibility and API support filters", async () => {
  const getModels = createModelDiscovery({
    loadClaudeAuth: async () => { throw new Error("No Copilot credentials"); },
    loadAuth: async () => ({ kind: "codex", token: "codex-test", accountId: "account-test" }),
    fetchImpl: async (url, options) => {
      assert.ok(url.includes("/codex/models?client_version="));
      assert.equal(options.headers["chatgpt-account-id"], "account-test");
      return ok({ models: [
        { slug: "gpt-5.4", visibility: "list" },
        { slug: "gpt-hidden", visibility: "hide" },
        { slug: "gpt-unsupported", supported_in_api: false }
      ] });
    }
  });
  assert.deepEqual((await getModels()).data.map((model) => model.id), ["gpt-5.4"]);
});

test("API discovery selects the largest valid declared limit, including max-only catalogs", async () => {
  const getModels = createModelDiscovery({
    loadClaudeAuth: async () => { throw new Error("no Copilot fixture"); },
    loadAuth: async () => ({ kind: "api", token: "fixture" }),
    fetchImpl: async () => ok({ data: [
      { id: "gpt-test-1", max_context_window: 872000 },
      { id: "gpt-test-2", context_window: 0, max_context_window: 872000 },
      { id: "gpt-test-3", context_window: 872000, max_context_window: 500000 },
      { id: "gpt-test-4", context_window: 500000, runtime: { max_input_tokens: 872000 } },
      { id: "gpt-test-5", context_window: 500000, capabilities: { limits: { max_context_window_tokens: 872000 } } }
    ] })
  });
  for (const model of (await getModels()).data) {
    assert.equal(model.context_window, 872000);
    assert.equal(model.runtime.max_input_tokens, 872000);
    assert.equal(model.capabilities.limits.max_context_window_tokens, 872000);
  }
});

test("a source that has never answered is omitted while the other source works", async () => {
  const getModels = createModelDiscovery({
    loadClaudeAuth: async () => { throw new Error("No Copilot credentials"); },
    loadAuth: async () => ({ kind: "api", token: "test" }),
    fetchImpl: async () => ok({ data: [{ id: "gpt-5.4" }] })
  });
  assert.deepEqual((await getModels()).data.map((model) => model.id), ["gpt-5.4"]);
});

test("Claude catalog failures preserve only the stale Claude source", async () => {
  let clock = 0;
  let failCopilot = false;
  const getModels = createModelDiscovery({
    now: () => clock,
    loadAuth: async () => ({ kind: "api", token: "test" }),
    loadClaudeAuth: async () => ({ token: "test", baseUrl: "https://api.business.githubcopilot.com" }),
    fetchImpl: async (url) => {
      if (url.includes("githubcopilot.com")) {
        if (failCopilot) throw new Error("Copilot offline");
        return ok({ data: [{ id: "claude-sonnet-4", model_picker_enabled: true }] });
      }
      return ok({ data: [{ id: "gpt-5.4" }] });
    }
  });
  const initial = await getModels();
  clock = 300001;
  failCopilot = true;
  assert.deepEqual((await getModels()).data, initial.data);
});

test("Codex discovery defaults to the largest declared context and preserves output limits", async () => {
  const models = createModelDiscovery({
    loadAuth: async () => ({ kind: "codex", token: "fixture", accountId: "fixture-account" }),
    loadClaudeAuth: async () => { throw new Error("no Copilot fixture"); },
    fetchImpl: async () => ok({ models: [
      { slug: "gpt-6.1-sol", context_window: 500000, max_context_window: 872000, visibility: "list" },
      { slug: "gpt-6-luna", context_window: 1000000, max_output_tokens: 64000, visibility: "list" },
      { slug: "gpt-6-terra", visibility: "list" }
    ] })
  });
  const result = (await models()).data;
  assert.equal(result[0].capabilities.limits.max_context_window_tokens, 872000);
  assert.equal(result[0].context_window, 872000);
  assert.equal(result[0].max_context_window, 872000);
  assert.equal(result[0].runtime.max_input_tokens, 872000);
  assert.equal(result[1].capabilities.limits.max_output_tokens, 64000);
  assert.equal(result[2].capabilities, undefined);
});

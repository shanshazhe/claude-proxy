const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadPiAuth: loadStoredAuth, readCredentialAvailability } = require("../lib/pi-auth");
const { createCredentialStore } = require("../lib/credential-store");
const { requestGpt } = require("../lib/pi-gpt");
const { getPromptCacheKey } = require("../lib/pi-options");
const { eventsFor, sse, payloadOf } = require("./helpers/pi-fixture");
let store;
const loadPiAuth = (options) => loadStoredAuth({ ...options, store });

test("local credential availability validates structure without refreshing, migrating or writing", (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not make network requests"));
  const oauth = { type: "oauth", access: "access", refresh: "refresh", expires: 0 };
  const api = { type: "api_key", key: "key" };
  const cases = [
    [{}, {}, false, false],
    [{}, { OPENAI_API_KEY: " key " }, true, false],
    [{}, { OPENAI_API_KEY: " \t" }, false, false],
    [{}, { OPENAI_API_KEY: 123 }, false, false],
    [{ "github-copilot": oauth }, {}, false, true],
    [{ "github-copilot": api }, {}, false, false],
    [{ openai: api }, {}, true, false],
    [{ "openai-codex": api }, {}, true, false],
    [{ openai: oauth, "github-copilot": oauth }, {}, true, true],
    [{ "openai-codex": oauth }, {}, true, false],
    // Legacy openai wins unless codex carries a loginVersion, even if the selected value is invalid.
    [{ openai: api, "openai-codex": {} }, {}, true, false],
    [{ openai: {}, "openai-codex": oauth }, {}, false, false],
    [{ openai: api, "openai-codex": { loginVersion: "new" } }, {}, false, false],
    [{ openai: {}, "openai-codex": { ...oauth, loginVersion: "new" } }, {}, true, false]
  ];
  for (const invalid of [null, {}, { ...api, key: " " }, { ...api, key: 1 },
    { ...oauth, access: " " }, { ...oauth, refresh: "\t" }, { ...oauth, expires: "0" },
    { ...oauth, expires: Infinity }, { ...oauth, expires: NaN }]) {
    cases.push([{ openai: invalid, "github-copilot": invalid }, {}, false, false]);
  }
  for (const [auth, env, openai, copilot] of cases) {
    let reads = 0;
    const store = {
      readAuth(options) { reads++; assert.deepEqual(options, { readOnly: true }); return auth; },
      migrate() { assert.fail("must not migrate"); },
      updateProvider() { assert.fail("must not write"); },
      saveLogin() { assert.fail("must not save"); }
    };
    const before = JSON.stringify(auth);
    assert.deepEqual(readCredentialAvailability({ env, store }), { openai, copilot });
    assert.equal(reads, 1);
    assert.equal(JSON.stringify(auth), before);
  }
});

test("local credential availability propagates storage failures even with an environment key", () => {
  const error = new Error("storage failure");
  for (const env of [{}, { OPENAI_API_KEY: "key" }]) {
    assert.throws(() => readCredentialAvailability({ env, store: { readAuth() { throw error; } } }),
      (actual) => actual === error);
  }
});

const jwt = (accountId) => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.signature`;

async function withAuth(data, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-auth-test-"));
  const file = path.join(directory, "auth.json");
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  store = createCredentialStore({ directory });
  fs.writeFileSync(file, JSON.stringify(data));
  try { await callback(file); }
  finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    store = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("copied Pi API-key and OAuth credentials select correct auth", async () => {
  await withAuth({ openai: { type: "api_key", key: "test-key" } }, async () => {
    assert.deepEqual(await loadPiAuth(), { token: "test-key", kind: "api" });
  });
  await withAuth({ openai: { type: "oauth", access: "direct-token", refresh: "refresh", expires: Date.now() + 3600000, clientId: "client-test" } }, async () => {
    assert.equal((await loadPiAuth()).kind, "chatgpt");
  });
  await withAuth({ "openai-codex": { type: "oauth", access: jwt("account-test"), refresh: "refresh", expires: Date.now() + 3600000 } }, async () => {
    assert.equal((await loadPiAuth()).accountId, "account-test");
  });
});

test("expired copied OAuth credentials refresh once and persist rotation atomically", async () => {
  for (const provider of ["openai", "openai-codex"]) {
    await withAuth({ [provider]: { type: "oauth", access: "old", refresh: "refresh-old", expires: 0, clientId: "client-test" }, other: { keep: true } }, async (file) => {
      let calls = 0;
      const fetchImpl = async (url, options) => {
        calls++;
        assert.equal(url, provider === "openai" ? "https://auth.openai.com/api/accounts/oauth/token" : "https://auth.openai.com/oauth/token");
        assert.equal(options.body.get("grant_type"), "refresh_token");
        assert.equal(options.body.get("client_id"), provider === "openai" ? "client-test" : "app_EMoamEEZ73f0CkXaXp7hrann");
        return { ok: true, json: async () => ({ access_token: jwt("new-account"), refresh_token: "refresh-new", expires_in: 3600 }) };
      };
      const results = await Promise.all([loadPiAuth({ fetchImpl }), loadPiAuth({ fetchImpl })]);
      assert.equal(calls, 1);
      assert.equal(results[0].token, results[1].token);
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(stored[provider].refresh, "refresh-new");
      assert.deepEqual(stored.other, { keep: true });
      assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
    });
  }
});

test("new ChatGPT login wins over legacy openai and stale same-refresh requests cannot overwrite it", async () => {
  await withAuth({ openai: { type: "api_key", key: "legacy" }, "openai-codex": { type: "oauth", access: jwt("old"), refresh: "same", expires: 0 } }, async () => {
    assert.equal((await loadPiAuth()).token, "legacy");
    store.saveLogin("openai-codex", { type: "oauth", access: jwt("first-login"), refresh: "same", expires: 0 });
    await assert.rejects(loadPiAuth({ fetchImpl: async () => {
      store.saveLogin("openai-codex", { type: "oauth", access: jwt("new-login"), refresh: "same", expires: Date.now() + 3600000 });
      return new Response(JSON.stringify({ access_token: jwt("stale"), refresh_token: "same", expires_in: 3600 }));
    } }), /发生变化/);
    assert.equal((await loadPiAuth()).accountId, "new-login");
    process.env.OPENAI_API_KEY = "environment-secret";
    assert.deepEqual(await loadPiAuth(), { token: "environment-secret", kind: "api" });
    assert.ok(!JSON.stringify(store.readAuth()).includes("environment-secret"));
  });
});

test("OAuth failure is safe and leaves copied credentials unchanged", async () => {
  await withAuth({ openai: { type: "oauth", access: "old", refresh: "private-refresh", expires: 0, clientId: "client-test" } }, async (file) => {
    const previous = fs.readFileSync(file, "utf8");
    await assert.rejects(loadPiAuth({ fetchImpl: async () => ({ ok: false, status: 401 }) }), /refresh failed/);
    assert.equal(fs.readFileSync(file, "utf8"), previous);
  });
});

test("stored Codex OAuth is passed into the actual Pi provider without a second login", async () => {
  await withAuth({ "openai-codex": { type: "oauth", access: jwt("account-test"), refresh: "refresh", expires: Date.now() + 3600000 } }, async () => {
    const result = await requestGpt({ model: "gpt-5", system: "instructions", messages: [{ role: "user", content: "hi" }], prompt_cache_key: "stable-key" }, {
      loadAuth: loadPiAuth, remember: false, fetchImpl: async (url, options) => {
        assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
        const headers = new Headers(options.headers);
        assert.equal(headers.get("chatgpt-account-id"), "account-test");
        assert.equal(headers.get("session-id"), "stable-key");
        assert.equal(headers.get("x-client-request-id"), "stable-key");
        const body = payloadOf(options);
        assert.equal(body.instructions, undefined);
        assert.deepEqual(body.input[0], { role: "developer", content: "instructions" });
        assert.equal(body.stream, true);
        assert.equal(body.max_output_tokens, undefined);
        return sse(eventsFor());
      }
    });
    assert.equal(result.content[0].text, "你好🙂");
    assert.equal(result.usage.cache_read_input_tokens, 1536);
  });
});

test("Codex cache diagnostics stay stable, private and accurate across turns", async () => {
  await withAuth({ "openai-codex": { type: "oauth", access: jwt("account-test"), refresh: "refresh", expires: Date.now() + 3600000 } }, async () => {
    const stats = [];
    const key = getPromptCacheKey({ metadata: { user_id: "private-session-a" } });
    const common = { model: "gpt-5", system: "private-instructions", messages: [{ role: "user", content: "private-prompt" }], prompt_cache_key: key };
    const cases = [common, { ...common, messages: [...common.messages, { role: "assistant", content: "reply" }, { role: "user", content: "next" }] },
      { ...common, prompt_cache_key: getPromptCacheKey({ metadata: { user_id: "private-session-b" } }), tools: [{ name: "read", input_schema: { type: "object" } }] }];
    for (const body of cases) await requestGpt(body, { loadAuth: loadPiAuth, remember: false, onCacheUsage: (usage) => stats.push(usage),
      fetchImpl: async () => sse(eventsFor()) });
    assert.equal(stats[0].total_input_tokens, 2000);
    assert.equal(stats[0].cache_read_input_tokens, 1536);
    assert.equal(stats[0].uncached_input_tokens, 464);
    assert.equal(stats[0].cache_hit_percent, 76.8);
    assert.equal(stats[0].auth_kind, "codex");
    assert.equal(stats[0].cache_key_id, stats[1].cache_key_id);
    assert.equal(stats[0].prefix_id, stats[1].prefix_id);
    assert.notEqual(stats[0].cache_key_id, stats[2].cache_key_id);
    assert.notEqual(stats[0].prefix_id, stats[2].prefix_id);
    // Same prefix_id as the pre-Pi layout, which hashed Codex leading system text as instructions.
    const legacyPrefix = require("node:crypto").createHash("sha256")
      .update(JSON.stringify({ instructions: "private-instructions", system: "private-instructions", tools: [] })).digest("hex").slice(0, 12);
    assert.equal(stats[0].prefix_id, legacyPrefix);
    const serialized = JSON.stringify(stats);
    for (const secret of ["private-session-a", "private-prompt", "private-instructions", key, jwt("account-test")]) assert.ok(!serialized.includes(secret));
  });
});

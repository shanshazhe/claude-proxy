const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClaudeSetup, getClaudeConfigRoot, setupFailure } = require("../lib/claude-setup");
const { createSetupProbe } = require("../lib/claude-probes");

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-setup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, "settings.json");
  const state = { auth: { openai: { type: "api_key", key: "test-key" } }, probes: 0, catalogs: 0, deployed: 0, cleaned: 0 };
  const store = { readAuth: () => state.auth };
  const installer = { validateBundle() {}, deploy() { state.deployed++; return { command: "test-statusline-command", created: true }; },
    cleanup() { state.cleaned++; }, isConfigured: (statusLine) => statusLine?.command === "test-statusline-command" };
  const base = { configRoot: root, env: {}, store, installer,
    probe: async () => { state.probes++; return { cli: true, bash: "/bin/bash", jq: "/bin/jq", node: process.execPath }; },
    getAvailableModels: async () => { state.catalogs++; return { data: [{ id: "gpt-test" }] }; } };
  const setup = createClaudeSetup({ ...base, ...options });
  return { root, settingsFile, state, base, setup, read: () => JSON.parse(fs.readFileSync(settingsFile, "utf8")),
    write: (value) => fs.writeFileSync(settingsFile, typeof value === "string" ? value : JSON.stringify(value)) };
}
test("GPT startup sync merges only subagent env, backs up exact bytes and is idempotent", async (t) => {
  const f = fixture(t);
  const original = { env: { OTHER: "keep", ANTHROPIC_MODEL: "claude-opus-5-5", ANTHROPIC_BASE_URL: "https://unchanged.test",
    ANTHROPIC_API_KEY: "unchanged", ANTHROPIC_AUTH_TOKEN: "keep-token", CLAUDE_CODE_SUBAGENT_MODEL: "opus", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0" },
    model: "sonnet", hooks: { Stop: [] }, permissions: { allow: ["Read"] }, enabledPlugins: { local: true },
    statusLine: { type: "command", command: "keep" }, extra: { untouched: true } };
  const bytes = Buffer.from("﻿" + JSON.stringify(original, null, 4) + "\n");
  fs.writeFileSync(f.settingsFile, bytes);
  const result = await f.setup.syncGptSubagentModel();
  assert.equal(result.model, "anthropic/gpt-test");
  assert.deepEqual(f.read(), { ...original, env: { ...original.env,
    CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/gpt-test", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" } });
  assert.equal(f.state.probes, 0);
  assert.equal(f.state.deployed, 0);
  const backups = path.join(f.root, "claude-proxy", "settings-backups");
  const backup = path.join(backups, fs.readdirSync(backups)[0]);
  assert.deepEqual(fs.readFileSync(backup), bytes);
  const saved = fs.readFileSync(f.settingsFile);
  const before = fs.statSync(f.settingsFile);
  await f.setup.syncGptSubagentModel();
  assert.deepEqual(fs.readFileSync(f.settingsFile), saved);
  assert.equal(fs.statSync(f.settingsFile).ino, before.ino);
  assert.equal(fs.statSync(f.settingsFile).mtimeMs, before.mtimeMs);
  assert.equal(fs.readdirSync(backups).length, 1);
});

for (const auth of [{}, { "github-copilot": { type: "oauth", access: "access", refresh: "refresh", expires: 0 } },
  { openai: { type: "api_key", key: " " } }, { "openai-codex": { type: "oauth", access: "access", refresh: "", expires: 0 } }]) {
  test("GPT startup sync with no GPT credential does not read settings, discover or probe", async (t) => {
    const f = fixture(t);
    f.state.auth = auth;
    f.write("invalid-settings-must-not-be-read");
    const setup = createClaudeSetup({ ...f.base, fsImpl: { ...fs, lstatSync() { assert.fail("must not read settings"); } } });
    assert.equal((await setup.syncGptSubagentModel()).skipped, true);
    assert.equal(f.state.catalogs, 0);
    assert.equal(f.state.probes, 0);
    assert.equal(fs.readFileSync(f.settingsFile, "utf8"), "invalid-settings-must-not-be-read");
  });
}

test("GPT startup sync without credentials retains existing subagent values", async (t) => {
  const f = fixture(t);
  f.state.auth = {};
  const original = '{ "env": {"CLAUDE_CODE_SUBAGENT_MODEL":"anthropic/gpt-old","CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"1"} }\n';
  f.write(original);
  await f.setup.syncGptSubagentModel();
  assert.equal(fs.readFileSync(f.settingsFile, "utf8"), original);
  assert.deepEqual(fs.readdirSync(f.root), ["settings.json"]);
});

for (const provider of ["openai", "openai-codex", "environment"]) {
  test(`GPT startup sync accepts ${provider} credentials including expired OAuth`, async (t) => {
    const f = fixture(t);
    f.state.auth = provider === "environment" ? {} : { [provider]: { type: "oauth", access: "private-access", refresh: "private-refresh", expires: 0 } };
    const setup = createClaudeSetup({ ...f.base, env: provider === "environment" ? { OPENAI_API_KEY: "private-key" } : {} });
    await setup.syncGptSubagentModel();
    assert.deepEqual(f.read(), { env: { CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/gpt-test", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" } });
    assert.equal(f.state.probes, 0);
  });
}

for (const [settings, expected] of [
  [{ env: { CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/gpt-second", ANTHROPIC_MODEL: "gpt-first" } }, "gpt-second"],
  [{ env: { CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/gpt-removed", ANTHROPIC_MODEL: "anthropic/gpt-second" } }, "gpt-second"],
  [{ env: { ANTHROPIC_MODEL: "gpt-second" }, model: "gpt-first" }, "gpt-second"],
  [{ env: { ANTHROPIC_MODEL: "claude-opus-5-5" }, model: "anthropic/gpt-second" }, "gpt-second"],
  [{ env: { ANTHROPIC_MODEL: "claude-opus-5-5", CLAUDE_CODE_SUBAGENT_MODEL: "haiku" } }, "gpt-first"],
  [{ model: "gpt-removed" }, "gpt-first"],
  [{}, "gpt-first"]
]) {
  test(`GPT startup sync selects ${expected} from available GPTs for ${JSON.stringify(settings)}`, async (t) => {
    const f = fixture(t);
    f.write(settings);
    const setup = createClaudeSetup({ ...f.base, getAvailableModels: async (options) => {
      assert.deepEqual(options, { waitForRefresh: true });
      return { data: [{ id: "claude-opus-5-5" }, { id: "gpt-oss-120b" }, { id: "other" },
        { id: "gpt-first", context_window: 1000000 }, { id: "gpt-second" }] };
    } });
    assert.equal((await setup.syncGptSubagentModel()).model, `anthropic/${expected}`);
    assert.deepEqual(f.read(), { ...settings, env: { ...settings.env,
      CLAUDE_CODE_SUBAGENT_MODEL: `anthropic/${expected}`, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" } });
  });
}

test("GPT startup sync canonicalizes catalog prefixes and removes stale GPT context suffixes", async (t) => {
  const f = fixture(t);
  f.write({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "gpt-second[1m]" } });
  const setup = createClaudeSetup({ ...f.base, getAvailableModels: async () => ({ data: [
    { id: "anthropic/gpt-first" }, { id: "anthropic/gpt-second[1m]", context_window: 1000000 }
  ] }) });
  assert.equal((await setup.syncGptSubagentModel()).model, "anthropic/gpt-second");
  assert.equal(f.read().env.CLAUDE_CODE_SUBAGENT_MODEL, "anthropic/gpt-second");
});

test("GPT startup sync does not rewrite already correct formatted settings or create backups", async (t) => {
  const f = fixture(t);
  const original = '﻿{ "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "anthropic/gpt-test", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1" } }\n';
  f.write(original);
  await f.setup.syncGptSubagentModel();
  assert.equal(fs.readFileSync(f.settingsFile, "utf8"), original);
  assert.deepEqual(fs.readdirSync(f.root), ["settings.json"]);
});

test("GPT startup sync rechecks credentials after discovery and merges only latest settings", async (t) => {
  const f = fixture(t);
  f.write({ env: { ANTHROPIC_MODEL: "gpt-first" } });
  const latest = { env: { KEEP: "latest", ANTHROPIC_MODEL: "gpt-second" }, permissions: { deny: ["Bash"] } };
  const setup = createClaudeSetup({ ...f.base, getAvailableModels: async () => {
    f.write(latest);
    return { data: [{ id: "gpt-first" }, { id: "gpt-second" }] };
  } });
  assert.equal((await setup.syncGptSubagentModel()).model, "anthropic/gpt-second");
  assert.deepEqual(f.read(), { ...latest, env: { ...latest.env,
    CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/gpt-second", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" } });
  const original = fs.readFileSync(f.settingsFile);
  const vanished = createClaudeSetup({ ...f.base, getAvailableModels: async () => {
    f.state.auth = {}; return { data: [{ id: "gpt-test" }] };
  } });
  assert.equal((await vanished.syncGptSubagentModel()).skipped, true);
  assert.deepEqual(fs.readFileSync(f.settingsFile), original);
});

test("GPT startup sync rejects empty/non-GPT/failed catalogs with sanitized failures and no changes", async (t) => {
  const f = fixture(t);
  f.write({ untouched: true });
  for (const getAvailableModels of [async () => ({ data: [] }), async () => ({ data: [{ id: "claude-opus-5-5" }, { id: "gpt-oss-120b" }] }),
    async () => { throw new Error("private-upstream-secret"); }]) {
    const setup = createClaudeSetup({ ...f.base, getAvailableModels });
    await assert.rejects(setup.syncGptSubagentModel(), (error) => {
      assert.equal(error.setupCode, "models");
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.deepEqual(f.read(), { untouched: true });
    assert.deepEqual(fs.readdirSync(f.root), ["settings.json"]);
  }
});

test("GPT startup sync validates initial and latest conflicts without deleting helpers", async (t) => {
  const f = fixture(t);
  for (const settings of [{ apiKeyHelper: "private-command" }, { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, { forceLoginMethod: "gateway" }]) {
    f.write(settings);
    await assert.rejects(f.setup.syncGptSubagentModel(), { setupCode: "conflict" });
    assert.equal(f.state.catalogs, 0);
    assert.deepEqual(f.read(), settings);
    f.write({});
    const setup = createClaudeSetup({ ...f.base, getAvailableModels: async () => {
      f.write(settings); return { data: [{ id: "gpt-test" }] };
    } });
    await assert.rejects(setup.syncGptSubagentModel(), { setupCode: "conflict" });
    assert.deepEqual(f.read(), settings);
  }
});

test("GPT startup sync creates a missing custom root but never changes global config or shell files", async (t) => {
  const f = fixture(t);
  const configRoot = path.join(f.root, "missing", "cli");
  const globals = path.join(f.root, ".claude.json");
  const zshrc = path.join(f.root, ".zshrc");
  const original = '{"customApiKeyResponses":{"rejected":["sk-placeholder"]}}';
  fs.writeFileSync(globals, original);
  fs.writeFileSync(zshrc, "keep-shell-bytes\n");
  const setup = createClaudeSetup({ ...f.base, configRoot, home: f.root });
  await setup.syncGptSubagentModel();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configRoot, "settings.json"))), {
    env: { CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/gpt-test", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" }
  });
  assert.equal(fs.readFileSync(globals, "utf8"), original);
  assert.equal(fs.readFileSync(zshrc, "utf8"), "keep-shell-bytes\n");
  assert.equal(fs.existsSync(f.settingsFile), false);
  assert.deepEqual(fs.readdirSync(path.join(configRoot, "claude-proxy", "settings-backups")), []);
});

test("GPT startup sync safely rejects save failures and final-snapshot races", async (t) => {
  const f = fixture(t);
  const original = '{ "untouched": true }\n';
  f.write(original);
  const failed = createClaudeSetup({ ...f.base, fsImpl: { ...fs, renameSync() { throw new Error("private-save-error"); } } });
  await assert.rejects(failed.syncGptSubagentModel(), (error) => {
    assert.equal(error.setupCode, "save"); assert.doesNotMatch(error.message, /private/); return true;
  });
  assert.equal(fs.readFileSync(f.settingsFile, "utf8"), original);
  const setup = createClaudeSetup({ ...f.base, fsImpl: { ...fs, writeFileSync(file, ...args) {
    fs.writeFileSync(file, ...args);
    if (file.endsWith(".tmp")) f.write({ external: true });
  } } });
  await assert.rejects(setup.syncGptSubagentModel(), { setupCode: "changed" });
  assert.deepEqual(f.read(), { external: true });
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith(".tmp")), false);
});

test("GPT startup sync serializes with web-button writes and preserves all three merges", async (t) => {
  const f = fixture(t);
  f.write({ env: { KEEP: "yes" } });
  const second = createClaudeSetup(f.base);
  await Promise.all([f.setup.configureCli(), second.syncGptSubagentModel(), second.configureStatusline()]);
  assert.equal(f.read().env.KEEP, "yes");
  assert.equal(f.read().env.ANTHROPIC_BASE_URL, "http://localhost:8082");
  assert.equal(f.read().env.CLAUDE_CODE_SUBAGENT_MODEL, "anthropic/gpt-test");
  assert.equal(f.read().env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
  assert.equal(f.read().statusLine.command, "test-statusline-command");
});

test("read-only status uses cached probes, never models or configuration writes, and credentials gate only CLI", async (t) => {
  const f = fixture(t);
  f.state.auth = {};
  const status = await f.setup.getStatus();
  assert.equal(status.claudeCli.ready, false);
  assert.match(status.claudeCli.reason, /credential/);
  assert.equal(status.statusline.ready, true);
  assert.equal(f.state.deployed, 0);
  await f.setup.getStatus();
  assert.equal(f.state.probes, 1);
  assert.equal(f.state.catalogs, 0);
  await assert.rejects(f.setup.configureCli(), /credential/);
  assert.equal(fs.existsSync(f.settingsFile), false);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("merge preserves unrelated settings, backs up original BOM bytes privately and retries idempotently", async (t) => {
  const f = fixture(t);
  const unrelated = { env: { OTHER: "unchanged", ANTHROPIC_API_KEY: "old-secret", ANTHROPIC_AUTH_TOKEN: "old-token",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "sonnet", CLAUDE_CODE_SUBAGENT_MODEL: "opus" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] }, permissions: { allow: ["Read"] },
    enabledPlugins: { "other@local": true }, model: "old-model", statusLine: { type: "command", command: "old-script" } };
  const original = Buffer.from("﻿" + JSON.stringify(unrelated, null, 4) + "\n");
  fs.writeFileSync(f.settingsFile, original);
  const result = await f.setup.configureCli();
  assert.equal(result.model, "anthropic/gpt-test");
  const saved = f.read();
  for (const key of ["hooks", "permissions", "enabledPlugins", "model", "statusLine"]) assert.deepEqual(saved[key], unrelated[key]);
  for (const key of ["OTHER", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) assert.equal(saved.env[key], unrelated.env[key]);
  assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(saved.env.ANTHROPIC_API_KEY, "sk-placeholder");
  const backupDir = path.join(f.root, "claude-proxy", "settings-backups");
  const backup = path.join(backupDir, fs.readdirSync(backupDir)[0]);
  assert.deepEqual(fs.readFileSync(backup), original);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.settingsFile).mode & 0o777, 0o600);
  }
  const bytes = fs.readFileSync(f.settingsFile);
  await f.setup.configureCli();
  assert.deepEqual(fs.readFileSync(f.settingsFile), bytes);
  assert.equal(fs.readdirSync(backupDir).length, 1);
  assert.equal((await f.setup.getStatus()).claudeCli.configured, true);
});

for (const value of ["invalid-private-content", "[]", "null", '{"env":[]}', '{"env":{"KEY":42}}', '{"hooks":[]}', '{"statusLine":null}', '{"model":42}']) {
  test(`rejects malformed settings structure ${value.slice(0, 20)} without overwriting`, async (t) => {
    const f = fixture(t); f.write(value);
    assert.equal((await f.setup.getStatus()).claudeCli.ready, false);
    await assert.rejects(f.setup.configureCli(), /Settings/);
    await assert.rejects(f.setup.configureStatusline(), /Settings/);
    await assert.rejects(f.setup.syncGptSubagentModel(), /Settings/);
    assert.equal(f.state.catalogs, 0);
    assert.equal(fs.readFileSync(f.settingsFile, "utf8"), value);
  });
}

test("rejects symlink, directory, readonly targets and linked private backup roots", async (t) => {
  const f = fixture(t);
  const original = path.join(f.root, "original"); fs.writeFileSync(original, "{}");
  // A directory Junction also exercises the unsafe-settings path without Windows symlink privileges.
  fs.symlinkSync(process.platform === "win32" ? f.root : original, f.settingsFile, process.platform === "win32" ? "junction" : "file");
  await assert.rejects(f.setup.configureCli(), /Settings/);
  await assert.rejects(f.setup.syncGptSubagentModel(), /Settings/);
  fs.unlinkSync(f.settingsFile); fs.mkdirSync(f.settingsFile);
  await assert.rejects(f.setup.configureCli(), /Settings/);
  await assert.rejects(f.setup.syncGptSubagentModel(), /Settings/);
  fs.rmdirSync(f.settingsFile); f.write({});
  if (process.platform !== "win32") {
    fs.chmodSync(f.settingsFile, 0o400);
    await assert.rejects(f.setup.configureCli(), /Settings/);
    await assert.rejects(f.setup.syncGptSubagentModel(), /Settings/);
    fs.chmodSync(f.settingsFile, 0o600);
  }
  fs.symlinkSync(f.root, path.join(f.root, "claude-proxy"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.setup.configureCli(), /Settings/);
  await assert.rejects(f.setup.syncGptSubagentModel(), /Settings/);
  assert.equal(fs.readFileSync(original, "utf8"), "{}");
});

test("distinct setup instances serialize latest-settings merges", async (t) => {
  const f = fixture(t); f.write({ env: { KEEP: "yes" } });
  const second = createClaudeSetup(f.base);
  await Promise.all([f.setup.configureCli(), second.configureCli()]);
  assert.equal(f.read().env.ANTHROPIC_BASE_URL, "http://localhost:8082");
  assert.equal(f.read().env.KEEP, "yes");
});

test("external edits during model lookup are merged and latest auth conflicts abort", async (t) => {
  const f = fixture(t);
  const setup = createClaudeSetup({ ...f.base, getAvailableModels: async () => {
    f.write({ env: { EXTERNAL: "latest" }, permissions: { deny: ["Bash"] } });
    return { data: [{ id: "gpt-test" }] };
  } });
  await setup.configureCli();
  assert.equal(f.read().env.EXTERNAL, "latest");
  assert.deepEqual(f.read().permissions, { deny: ["Bash"] });
  const conflicted = createClaudeSetup({ ...f.base, getAvailableModels: async () => {
    f.write({ apiKeyHelper: "private-helper" }); return { data: [{ id: "gpt-test" }] };
  } });
  await assert.rejects(conflicted.configureCli(), /apiKeyHelper/);
  assert.deepEqual(f.read(), { apiKeyHelper: "private-helper" });
});

test("save failure leaves original bytes and cleans temporary files", async (t) => {
  const f = fixture(t); f.write({ statusLine: { command: "original" } });
  const bytes = fs.readFileSync(f.settingsFile);
  const setup = createClaudeSetup({ ...f.base, fsImpl: { ...fs, renameSync() { throw new Error("private-failure"); } } });
  await assert.rejects(setup.configureCli(), /Existing settings were kept/);
  assert.deepEqual(fs.readFileSync(f.settingsFile), bytes);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith(".tmp")), false);
});

test("target changes at final validation cause conflict rather than lost external edits", async (t) => {
  const f = fixture(t); f.write({ old: true });
  let altered = false;
  const setup = createClaudeSetup({ ...f.base, fsImpl: { ...fs, writeFileSync(file, ...args) {
    fs.writeFileSync(file, ...args);
    if (file.endsWith(".tmp") && !altered) { altered = true; f.write({ external: true }); }
  } } });
  await assert.rejects(setup.configureCli(), /changed during configuration/);
  assert.deepEqual(f.read(), { external: true });
});
for (const provider of ["openai-codex", "github-copilot", "environment"]) {
  test(`chooses only credential-matching catalog models for ${provider}`, async (t) => {
    const f = fixture(t); f.state.auth = {};
    if (provider !== "environment") f.state.auth[provider] = { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 0 };
    const expected = provider === "github-copilot" ? "claude-opus-5-5" : "gpt-test";
    const setup = createClaudeSetup({ ...f.base, env: provider === "environment" ? { OPENAI_API_KEY: "env-only-secret" } : {},
      getAvailableModels: async () => ({ data: [{ id: "unsupported-model" }, { id: "gpt-test" }, { id: "claude-opus-5-5" }] }) });
    f.write({ env: { ANTHROPIC_MODEL: "anthropic/vendor/stale" } });
    const result = await setup.configureCli();
    assert.equal(result.model.replace(/\[1m\]$/, ""), provider === "github-copilot" ? expected : `anthropic/${expected}`);
    assert.ok(!JSON.stringify(f.read()).includes("env-only-secret"));
    assert.equal(f.read().env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
    assert.equal(f.read().env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  });
}

test("preserves the latest available model choice including extended context gateway spelling", async (t) => {
  const f = fixture(t);
  f.write({ env: { ANTHROPIC_MODEL: "anthropic/gpt-second" } });
  const setup = createClaudeSetup({ ...f.base, getAvailableModels: async () => ({ data: [{ id: "gpt-first" }, { id: "gpt-second" }] }) });
  assert.equal((await setup.configureCli()).model, "anthropic/gpt-second");
});

test("empty or failed catalogs and vanished credentials never write settings", async (t) => {
  const f = fixture(t); f.write({ untouched: true });
  for (const getAvailableModels of [async () => ({ data: [] }), async () => { throw new Error("upstream-secret"); },
    async () => { f.state.auth = {}; return { data: [{ id: "gpt-test" }] }; }]) {
    const setup = createClaudeSetup({ ...f.base, getAvailableModels });
    await assert.rejects(setup.configureCli());
    assert.deepEqual(f.read(), { untouched: true });
  }
});

test("missing CLI and authentication modes have fixed gates without deleting helpers", async (t) => {
  const f = fixture(t);
  const missing = createClaudeSetup({ ...f.base, probe: async () => ({ cli: false }) });
  assert.equal((await missing.getStatus()).claudeCli.ready, false);
  await assert.rejects(missing.configureCli(), /Install Claude/);
  for (const value of [{ apiKeyHelper: "private-command" }, { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, { forceLoginMethod: "gateway" }]) {
    f.write(value);
    assert.equal((await f.setup.getStatus()).claudeCli.ready, false);
    await assert.rejects(f.setup.configureCli(), (error) => {
      const failure = setupFailure(error);
      assert.equal(failure.status, 409);
      assert.ok(!JSON.stringify(failure).includes("private-command"));
      assert.ok(failure.body.fields.length);
      return true;
    });
    assert.deepEqual(f.read(), value);
  }
});

test("custom actual config root writes only the selected CLI root", async (t) => {
  const f = fixture(t);
  const custom = path.join(f.root, "custom cli");
  assert.equal(getClaudeConfigRoot({ CLAUDE_CONFIG_DIR: custom }, "/unused"), custom);
  assert.equal(getClaudeConfigRoot({ CLAUDE_CONFIG_DIR: " ~/custom " }, f.root), path.join(f.root, "custom"));
  const setup = createClaudeSetup({ ...f.base, configRoot: custom, env: { CLAUDE_CONFIG_DIR: custom } });
  assert.match((await setup.getStatus()).claudeCli.notice, /CLAUDE_CONFIG_DIR/);
  await setup.configureCli();
  const saved = JSON.parse(fs.readFileSync(path.join(custom, "settings.json"), "utf8"));
  assert.equal(saved.env.ANTHROPIC_BASE_URL, "http://localhost:8082");
  assert.equal(fs.existsSync(f.settingsFile), false);
});

test("two buttons and distinct services serialize latest-settings merges", async (t) => {
  const f = fixture(t); f.write({ env: { KEEP: "yes" } });
  const second = createClaudeSetup(f.base);
  await Promise.all([f.setup.configureCli(), second.configureStatusline()]);
  assert.equal(f.read().env.ANTHROPIC_BASE_URL, "http://localhost:8082");
  assert.equal(f.read().env.KEEP, "yes");
  assert.equal(f.read().statusLine.command, "test-statusline-command");
  assert.equal((await f.setup.getStatus()).statusline.configured, true);
});

test("save failure leaves original bytes and cleans only this statusline deployment", async (t) => {
  const f = fixture(t); f.write({ statusLine: { command: "original" } });
  const bytes = fs.readFileSync(f.settingsFile);
  const setup = createClaudeSetup({ ...f.base, fsImpl: { ...fs, renameSync() { throw new Error("private-failure"); } } });
  await assert.rejects(setup.configureStatusline(), /Existing settings were kept/);
  assert.deepEqual(fs.readFileSync(f.settingsFile), bytes);
  assert.equal(f.state.cleaned, 1);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith(".tmp")), false);
  const failed = createClaudeSetup({ ...f.base, installer: { ...f.base.installer, deploy() { throw new Error("private-deployment"); } } });
  await assert.rejects(failed.configureStatusline(), /deploy/);
  assert.deepEqual(fs.readFileSync(f.settingsFile), bytes);
});

test("custom actual config root and statusline leave routing untouched", async (t) => {
  const f = fixture(t);
  f.state.auth = {};
  const custom = path.join(f.root, "custom cli");
  const setup = createClaudeSetup({ ...f.base, configRoot: custom, env: { CLAUDE_CONFIG_DIR: custom } });
  assert.match((await setup.getStatus()).statusline.notice, /CLAUDE_CONFIG_DIR/);
  await setup.configureStatusline();
  const saved = JSON.parse(fs.readFileSync(path.join(custom, "settings.json"), "utf8"));
  assert.equal(saved.env, undefined);
  assert.equal(fs.existsSync(f.settingsFile), false);
});

test("real bundled statusline setup is independent, idempotent and preserves reused deployments on save failure", async (t) => {
  const f = fixture(t);
  const setup = createClaudeSetup({ ...f.base, installer: undefined });
  f.state.auth = {};
  await setup.configureStatusline();
  const first = f.read();
  assert.equal(first.env, undefined);
  assert.equal((await setup.getStatus()).statusline.configured, true);
  await setup.configureStatusline();
  assert.deepEqual(f.read(), first);
  const root = path.join(f.root, "claude-proxy", "statusline");
  assert.equal(fs.readdirSync(root).length, 1);
  f.write({ statusLine: { type: "command", command: "other-personal-script" } });
  const failing = createClaudeSetup({ ...f.base, installer: undefined, fsImpl: { ...fs, renameSync() { throw new Error("save failure"); } } });
  await assert.rejects(failing.configureStatusline(), /Existing settings were kept/);
  assert.equal(fs.readdirSync(root).length, 1);
  assert.equal(f.read().statusLine.command, "other-personal-script");
});

test("Statusline backs up exact bytes and preserves unrelated configuration without credentials", async (t) => {
  const f = fixture(t);
  f.state.auth = {};
  const original = Buffer.from('﻿{ "env": {"KEEP":"yes"}, "statusLine":{"type":"command","command":"old"}, "enabledPlugins":{"other":true}, "apiKeyHelper":"untouched" }\n');
  fs.writeFileSync(f.settingsFile, original);
  await f.setup.configureStatusline();
  assert.deepEqual(f.read().env, { KEEP: "yes" });
  assert.deepEqual(f.read().enabledPlugins, { other: true });
  assert.equal(f.read().apiKeyHelper, "untouched");
  const backups = path.join(f.root, "claude-proxy", "settings-backups");
  assert.deepEqual(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0])), original);
  assert.equal(f.state.catalogs, 0);
});

test("failed settings commit retains a deployment referenced by an external latest edit", async (t) => {
  const f = fixture(t); f.write({ before: true });
  const setup = createClaudeSetup({ ...f.base, fsImpl: { ...fs, writeFileSync(file, ...args) {
    fs.writeFileSync(file, ...args);
    if (file.endsWith(".tmp")) f.write({ external: true, statusLine: { type: "command", command: "test-statusline-command" } });
  } } });
  await assert.rejects(setup.configureStatusline(), /changed during configuration/);
  assert.equal(f.state.cleaned, 0);
  assert.equal(f.read().external, true);
});

test("version probes reject old Bash/jq/Node without shell or automatic installation", async () => {
  for (const [bashVersion, jqVersion, nodeVersion, expected] of [
    ["2.9", "1.6", "18.0", [false, true, true]],
    ["3.2", "1.5", "18.0", [true, false, true]],
    ["3.2", "1.6", "17.0", [true, true, false]],
    ["3.2", "2.0", "18.0", [true, true, true]]
  ]) {
    const probe = createSetupProbe({ platform: "darwin", env: { PATH: "/fake" }, home: "/fake-home", node: "/fake-node",
      fsImpl: { statSync: () => ({ isFile: () => true }) }, execFileImpl(file, args, options, done) {
        assert.deepEqual(args, ["--version"]);
        assert.equal(options.shell, false);
        done(null, file.endsWith("bash") ? `GNU bash, version ${bashVersion}` : file.endsWith("jq") ? `jq-${jqVersion}` : file.endsWith("claude") ? "2.1.296 (Claude Code)" : `v${nodeVersion}.0`);
      } });
    const deps = await probe();
    assert.deepEqual([Boolean(deps.bash), Boolean(deps.jq), Boolean(deps.node)], expected);
  }
});

test("missing CLI/dependencies and invalid bundles gate statusline without deploying", async (t) => {
  const f = fixture(t);
  for (const missing of ["cli", "bash", "jq"]) {
    const deps = { cli: true, bash: "/bash", jq: "/jq", node: process.execPath, [missing]: null };
    const setup = createClaudeSetup({ ...f.base, probe: async () => deps });
    assert.equal((await setup.getStatus()).statusline.ready, false);
    await assert.rejects(setup.configureStatusline(), /Install|Bash/);
  }
  const setup = createClaudeSetup({ ...f.base, installer: { validateBundle() { throw new Error("private-path"); } } });
  await assert.rejects(setup.configureStatusline(), (error) => {
    assert.equal(setupFailure(error).status, 503);
    assert.ok(!JSON.stringify(setupFailure(error)).includes("private-path"));
    return true;
  });
  assert.equal(f.state.deployed, 0);
  assert.equal(fs.existsSync(f.settingsFile), false);
});

test("probe uses bounded shell-free fixed arguments, common install locations and sanitized outputs", async () => {
  const calls = [];
  const probe = createSetupProbe({ platform: "darwin", env: { PATH: "/limited", BASH_ENV: "private-hook", NODE_OPTIONS: "private-options" }, home: "/home/test", node: "/node",
    fsImpl: { statSync: () => ({ isFile: () => true }) }, execFileImpl(file, args, options, done) {
      calls.push({ file, args, options });
      done(null, file.endsWith("claude") ? "2.1.296 (Claude Code)" : file.endsWith("bash") ? "GNU bash, version 3.2.57" : file.endsWith("jq") ? "jq-1.6" : "v22.1.0");
    } });
  const result = await probe();
  assert.equal(result.cli, true);
  assert.equal(result.node, "/node");
  assert.ok(calls.some((call) => call.file === "/home/test/.local/bin/claude"));
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.timeout, 1800);
    assert.equal(call.options.env.BASH_ENV, undefined);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.equal(call.args.at(-1), "--version");
  }
});

test("Windows probe resolves npm cli.js without invoking cmd wrappers", async () => {
  const calls = [];
  const probe = createSetupProbe({ platform: "win32", env: { PATH: "C:\\short", ProgramFiles: "C:\\Program Files" }, home: "C:\\Users\\test", node: "C:\\node.exe",
    fsImpl: { statSync(file) { return { isFile: () => !file.endsWith("claude.exe") }; } },
    execFileImpl(file, args, options, done) {
      calls.push({ file, args, options });
      done(null, args[0].endsWith("cli.js") ? "2.1.296 (Claude Code)" : file.endsWith("bash.exe") ? "GNU bash, version 5.2.0" : file.endsWith("jq.exe") ? "jq-1.7" : "v22.1.0");
    } });
  const result = await probe();
  assert.equal(result.cli, true);
  assert.ok(calls.some((call) => call.args[0].endsWith("cli.js")));
  assert.ok(calls.every((call) => !call.file.endsWith(".cmd") && call.options.shell === false));
});

test("configureCli clears only the rejected placeholder API key from Claude global config", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".claude");
  fs.mkdirSync(root);
  const f = fixture(t, { configRoot: root, home });
  const homeConfig = path.join(home, ".claude.json");
  const rootConfig = path.join(root, ".claude.json");
  const config = { theme: "dark", customApiKeyResponses: { approved: ["keep-approved"], rejected: ["sk-placeholder", "other-key"] } };
  fs.writeFileSync(homeConfig, JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(rootConfig, JSON.stringify(config));
  const result = await f.setup.configureCli();
  assert.doesNotMatch(result.notice, /rejected API key/);
  for (const file of [homeConfig, rootConfig]) {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.theme, "dark");
    assert.deepEqual(saved.customApiKeyResponses, { approved: ["keep-approved"], rejected: ["other-key"] });
  }
  if (process.platform !== "win32") assert.equal(fs.statSync(homeConfig).mode & 0o777, 0o600);
  const bytes = fs.readFileSync(homeConfig);
  await f.setup.configureCli();
  assert.deepEqual(fs.readFileSync(homeConfig), bytes);
  assert.deepEqual(fs.readdirSync(home).sort(), [".claude", ".claude.json"]);
});

test("configureCli ignores home .claude.json for a custom config root and reports unreadable config", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const homeConfig = path.join(home, ".claude.json");
  const original = JSON.stringify({ customApiKeyResponses: { rejected: ["sk-placeholder"] } });
  fs.writeFileSync(homeConfig, original);
  const f = fixture(t, { home });
  fs.writeFileSync(path.join(f.root, ".claude.json"), "{broken");
  const result = await f.setup.configureCli();
  assert.match(result.notice, /rejected API key/);
  assert.equal(fs.readFileSync(homeConfig, "utf8"), original);
  assert.equal(fs.readFileSync(path.join(f.root, ".claude.json"), "utf8"), "{broken");
});

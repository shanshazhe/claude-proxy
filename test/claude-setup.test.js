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
  const base = { configRoot: root, env: {}, store, installer, platform: "darwin",
    probe: async () => { state.probes++; return { cli: true, bash: "/bin/bash", jq: "/bin/jq", node: process.execPath }; },
    getAvailableModels: async () => { state.catalogs++; return { data: [{ id: "gpt-test", owned_by: "openai", api: "openai-responses" }] }; } };
  const setup = createClaudeSetup({ ...base, ...options });
  return { root, settingsFile, state, base, setup, read: () => JSON.parse(fs.readFileSync(settingsFile, "utf8")),
    write: (value) => fs.writeFileSync(settingsFile, typeof value === "string" ? value : JSON.stringify(value)) };
}
test("GPT post-login capacity sync saves the largest valid GPT window with an exact backup and no unrelated changes", async (t) => {
  const f = fixture(t);
  const original = { env: { KEEP: "yes", ANTHROPIC_MODEL: "anthropic/gpt-small", ANTHROPIC_BASE_URL: "https://unchanged.test",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "123456" }, model: "personal-model", permissions: { allow: ["Read"] }, extra: true };
  const bytes = Buffer.from("﻿" + JSON.stringify(original, null, 4) + "\n");
  fs.writeFileSync(f.settingsFile, bytes);
  let discoveries = 0;
  const setup = createClaudeSetup({ ...f.base, getAvailableModels: async () => assert.fail("must use the GPT-only catalog"),
    getGptModels: async (options) => {
      discoveries++;
      assert.deepEqual(options, { waitForRefresh: true });
      return { data: [
        { id: "gpt-small", owned_by: "openai", api: "openai-responses", context_window: 400000 },
        { id: "gpt-invalid", owned_by: "openai", api: "openai-responses", context_window: Number.MAX_SAFE_INTEGER + 1 },
        { id: "anthropic/gpt-largest[1m]", owned_by: "openai", api: "openai-responses", context_window: 600000, max_context_window: 1200000 },
        { id: "gpt-medium", owned_by: "openai", api: "openai-responses", runtime: { max_input_tokens: 872000 } },
        { id: "gpt-other", owned_by: "openai", api: "openai-responses", capabilities: { limits: { max_context_window_tokens: 900000 } } },
        { id: "claude-test", owned_by: "github-copilot", api: "anthropic-messages", context_window: 2000000 },
        { id: "gpt-oss-120b", context_window: 4000000 }, null, {}
      ] };
    } });
  assert.deepEqual(await setup.syncGptContextCapacity(), { success: true, tokens: 1200000 });
  assert.deepEqual(f.read(), { ...original, env: { ...original.env, CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1200000" } });
  assert.equal(f.state.probes, 0);
  assert.equal(f.state.deployed, 0);
  const backups = path.join(f.root, "claude-proxy", "settings-backups");
  const names = fs.readdirSync(backups);
  assert.equal(names.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(backups, names[0])), bytes);
  const saved = fs.readFileSync(f.settingsFile);
  const before = fs.statSync(f.settingsFile);
  await setup.syncGptContextCapacity();
  assert.equal(discoveries, 2);
  assert.deepEqual(fs.readFileSync(f.settingsFile), saved);
  assert.equal(fs.statSync(f.settingsFile).ino, before.ino);
  assert.equal(fs.statSync(f.settingsFile).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(backups), names);
});

test("GPT post-login capacity sync creates only settings in the actual custom configuration root", async (t) => {
  const f = fixture(t);
  const configRoot = path.join(f.root, "custom", "cli");
  const setup = createClaudeSetup({ ...f.base, configRoot,
    getGptModels: async () => ({ data: [{ id: "gpt-test", owned_by: "openai", api: "openai-responses", context_window: 872000 }] }) });
  await setup.syncGptContextCapacity();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configRoot, "settings.json"))), {
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "872000" }
  });
  assert.equal(fs.existsSync(f.settingsFile), false);
  assert.equal(f.state.probes, 0);
  assert.deepEqual(fs.readdirSync(path.join(configRoot, "claude-proxy", "settings-backups")), []);
});

test("GPT post-login capacity sync skips without GPT credentials before touching settings or discovery", async (t) => {
  for (const auth of [{}, { "github-copilot": { type: "oauth", access: "access", refresh: "refresh", expires: 0 } }]) {
    const f = fixture(t);
    f.state.auth = auth;
    f.write("invalid-settings-must-not-be-read");
    const setup = createClaudeSetup({ ...f.base,
      fsImpl: { ...fs, lstatSync() { assert.fail("must not read settings"); } },
      getGptModels: async () => assert.fail("must not discover models") });
    assert.equal((await setup.syncGptContextCapacity()).skipped, true);
    assert.equal(fs.readFileSync(f.settingsFile, "utf8"), "invalid-settings-must-not-be-read");
  }
});

test("GPT post-login capacity sync preserves old settings on unavailable or invalid GPT capacity", async (t) => {
  const f = fixture(t);
  const original = '{ "env": { "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "123456" }, "keep": true }\n';
  f.write(original);
  const invalid = [undefined, null, 0, -1, 1.5, "400000", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const getGptModels of [async () => ({}), async () => ({ data: [] }), async () => ({ data: {} }),
    async () => ({ data: [{ id: "claude-test", owned_by: "github-copilot", api: "anthropic-messages", context_window: 2000000 }, null, {},
      ...invalid.map((context_window) => ({ id: "gpt-invalid", owned_by: "openai", api: "openai-responses", context_window }))] }),
    async () => { throw new Error("private-upstream-secret"); }]) {
    const setup = createClaudeSetup({ ...f.base, getGptModels });
    await assert.rejects(setup.syncGptContextCapacity(), (error) => {
      assert.equal(error.setupCode, "models");
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(fs.readFileSync(f.settingsFile, "utf8"), original);
    assert.deepEqual(fs.readdirSync(f.root), ["settings.json"]);
  }
});

test("GPT post-login capacity sync merges the latest settings and rechecks credentials before saving", async (t) => {
  const f = fixture(t);
  f.write({ env: { KEEP: "original" } });
  const latest = { env: { KEEP: "latest", ANTHROPIC_MODEL: "gpt-personal" }, permissions: { deny: ["Bash"] } };
  const setup = createClaudeSetup({ ...f.base, getGptModels: async () => {
    f.write(latest);
    return { data: [{ id: "gpt-test", owned_by: "openai", api: "openai-responses", context_window: 872000 }] };
  } });
  await setup.syncGptContextCapacity();
  assert.deepEqual(f.read(), { ...latest, env: { ...latest.env, CLAUDE_CODE_MAX_CONTEXT_TOKENS: "872000" } });
  const saved = fs.readFileSync(f.settingsFile);
  const vanished = createClaudeSetup({ ...f.base, getGptModels: async () => {
    f.state.auth = {};
    return { data: [{ id: "gpt-test", owned_by: "openai", api: "openai-responses", context_window: 1200000 }] };
  } });
  assert.equal((await vanished.syncGptContextCapacity()).skipped, true);
  assert.deepEqual(fs.readFileSync(f.settingsFile), saved);
});

test("a previous pending GPT capacity sync cannot overwrite a newer login's result", async (t) => {
  const f = fixture(t);
  let complete;
  let calls = 0;
  const setup = createClaudeSetup({ ...f.base, getGptModels: async () => {
    if (++calls === 1) return new Promise((resolve) => { complete = resolve; });
    return { data: [{ id: "gpt-new", owned_by: "openai", api: "openai-responses", context_window: 900000 }] };
  } });
  const earlier = setup.syncGptContextCapacity();
  await setup.syncGptContextCapacity();
  complete({ data: [{ id: "gpt-old", owned_by: "openai", api: "openai-responses", context_window: 1200000 }] });
  assert.equal((await earlier).skipped, true);
  assert.equal(f.read().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "900000");
});

test("GPT post-login capacity sync preserves unsafe settings and sanitizes save failures", async (t) => {
  const f = fixture(t);
  const getGptModels = async () => ({ data: [{ id: "gpt-test", owned_by: "openai", api: "openai-responses", context_window: 872000 }] });
  for (const value of ["damaged", '{"env":[]}', '{"env":{"KEY":42}}']) {
    f.write(value);
    await assert.rejects(createClaudeSetup({ ...f.base, getGptModels }).syncGptContextCapacity(), { setupCode: "settings" });
    assert.equal(fs.readFileSync(f.settingsFile, "utf8"), value);
  }
  const original = '{ "env": { "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "123456" } }\n';
  f.write(original);
  const failed = createClaudeSetup({ ...f.base, getGptModels,
    fsImpl: { ...fs, renameSync() { throw new Error("private-save-error"); } } });
  await assert.rejects(failed.syncGptContextCapacity(), (error) => {
    assert.equal(error.setupCode, "save");
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(fs.readFileSync(f.settingsFile, "utf8"), original);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith(".tmp")), false);
});

test("GPT capacity sync serializes with web-button writes and preserves explicit subagent settings", async (t) => {
  const f = fixture(t);
  f.write({ env: { KEEP: "yes", CLAUDE_CODE_SUBAGENT_MODEL: "opus", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0" } });
  const second = createClaudeSetup({ ...f.base,
    getGptModels: async () => ({ data: [{ id: "gpt-test", owned_by: "openai", api: "openai-responses", context_window: 872000 }] }) });
  await Promise.all([f.setup.configureCli(), second.syncGptContextCapacity(), second.configureStatusline()]);
  assert.equal(f.read().env.KEEP, "yes");
  assert.equal(f.read().env.ANTHROPIC_BASE_URL, "http://localhost:8082");
  assert.equal(f.read().env.CLAUDE_CODE_SUBAGENT_MODEL, "opus");
  assert.equal(f.read().env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "0");
  assert.equal(f.read().env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "872000");
  assert.equal(f.read().statusLine.command, "test-statusline-command");
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} first-login CLI configuration installs the skipped capacity launcher without restarting the proxy`,
    { skip: platform === "darwin" && process.platform === "win32" ? "zsh installation requires Unix permissions" : false }, async (t) => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-onboarding-")));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const configRoot = path.join(home, "cli");
    const profile = path.join(home, platform === "win32" ? "profile.ps1" : ".zshrc");
    const auth = {};
    const store = { readAuth: () => auth };
    const { createClaudeLauncherInstaller } = require("../lib/claude-launcher-install");
    const launcherInstaller = createClaudeLauncherInstaller({ home, configRoot, platform, env: { SystemRoot: path.join(home, "Windows") }, store,
      featureFile: path.join(home, "features.json"),
      execFileSync: (_file, args) => args.at(-1).includes("$PROFILE.CurrentUserAllHosts") ? profile : process.version });
    const setup = createClaudeSetup({ configRoot, env: {}, store, launcherInstaller,
      probe: async () => ({ cli: true }), getAvailableModels: async () => ({ data: [{ id: "gpt-sol-test", owned_by: "openai", api: "openai-responses", context_window: 872000 }] }) });
    assert.equal(await launcherInstaller.autoEnable(), null);
    assert.equal(fs.existsSync(profile), false);
    assert.equal((await setup.getStatus()).claudeCli.ready, false);
    assert.equal(fs.existsSync(profile), false);
    auth.openai = { type: "api_key", key: "test-login-key" };
    assert.equal((await setup.configureCli()).model, "anthropic/gpt-sol-test");
    assert.match(fs.readFileSync(profile, "utf8"), /claude-launch\.js/);
    const settings = JSON.parse(fs.readFileSync(path.join(configRoot, "settings.json")));
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
    const before = fs.statSync(profile);
    await setup.configureCli();
    assert.equal(fs.statSync(profile).ino, before.ino);
    assert.equal(fs.statSync(profile).mtimeMs, before.mtimeMs);
    await launcherInstaller.configure(false);
    const disabled = fs.readFileSync(profile);
    const result = await setup.configureCli();
    assert.deepEqual(fs.readFileSync(profile), disabled);
    assert.equal(launcherInstaller.getStatus().enabled, false);
    assert.match(result.notice, /context capacity could not be enabled/i);
  });
}

test("CLI configuration keeps routing and reports a safe notice when capacity launcher setup fails", async (t) => {
  for (const outcome of [null, { ok: false, reason: "private-profile-path" }, new Error("private-command-output")]) {
    let calls = 0;
    const f = fixture(t, { launcherInstaller: { async autoEnable() {
      calls++;
      assert.equal(f.read().env.ANTHROPIC_MODEL, "anthropic/gpt-test");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    } } });
    const result = await f.setup.configureCli();
    assert.equal(result.success, true);
    assert.match(result.notice, /context capacity could not be enabled/i);
    assert.doesNotMatch(result.notice, /private-/);
    assert.equal(calls, 1);
    await f.setup.configureStatusline();
    assert.equal(calls, 1);
    f.state.auth = {};
    await assert.rejects(f.setup.configureCli(), { setupCode: "no-credentials" });
    assert.equal(calls, 1);
  }
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
  fs.unlinkSync(f.settingsFile); fs.mkdirSync(f.settingsFile);
  await assert.rejects(f.setup.configureCli(), /Settings/);
  fs.rmdirSync(f.settingsFile); f.write({});
  if (process.platform !== "win32") {
    fs.chmodSync(f.settingsFile, 0o400);
    await assert.rejects(f.setup.configureCli(), /Settings/);
    fs.chmodSync(f.settingsFile, 0o600);
  }
  fs.symlinkSync(f.root, path.join(f.root, "claude-proxy"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.setup.configureCli(), /Settings/);
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
    return { data: [{ id: "gpt-test", owned_by: "openai", api: "openai-responses" }] };
  } });
  await setup.configureCli();
  assert.equal(f.read().env.EXTERNAL, "latest");
  assert.deepEqual(f.read().permissions, { deny: ["Bash"] });
  const conflicted = createClaudeSetup({ ...f.base, getAvailableModels: async () => {
    f.write({ apiKeyHelper: "private-helper" }); return { data: [{ id: "gpt-test", owned_by: "openai", api: "openai-responses" }] };
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
      getAvailableModels: async () => ({ data: [{ id: "unsupported-model" }, { id: "gpt-test", owned_by: "openai", api: "openai-responses" }, { id: "claude-opus-5-5", owned_by: "github-copilot", api: "anthropic-messages" }] }) });
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
  const setup = createClaudeSetup({ ...f.base, getAvailableModels: async () => ({ data: [{ id: "gpt-first", owned_by: "openai", api: "openai-responses" }, { id: "gpt-second", owned_by: "openai", api: "openai-responses" }] }) });
  assert.equal((await setup.configureCli()).model, "anthropic/gpt-second");
});

test("empty or failed catalogs and vanished credentials never write settings", async (t) => {
  const f = fixture(t); f.write({ untouched: true });
  for (const getAvailableModels of [async () => ({ data: [] }), async () => { throw new Error("upstream-secret"); },
    async () => { f.state.auth = {}; return { data: [{ id: "gpt-test", owned_by: "openai", api: "openai-responses" }] }; }]) {
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
  // 在 Windows 测试机上仍使用能转换本机路径的 launcher，后端分支显式固定为非 Windows。
  const installer = require("../lib/statusline-install").createStatuslineInstaller({ configRoot: f.root });
  const setup = createClaudeSetup({ ...f.base, installer });
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
  const failing = createClaudeSetup({ ...f.base, installer, fsImpl: { ...fs, renameSync() { throw new Error("save failure"); } } });
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

test("Windows HUD only requires Claude CLI, independent of settings and other dependencies", async (t) => {
  const f = fixture(t);
  f.state.auth = {};
  f.write("damaged settings must be left to Claude CLI");
  let installs = 0;
  const setup = createClaudeSetup({ ...f.base, platform: "win32",
    probe: async () => ({ cli: true, claudeCommand: { file: "claude.exe", args: [] } }),
    hudInstaller: { isInstalled: () => installs > 0, async install() { installs++; return { success: true }; } } });
  assert.equal((await setup.getStatus()).statusline.ready, true);
  assert.equal(installs, 0);
  assert.equal((await setup.configureStatusline()).success, true);
  assert.equal((await setup.getStatus()).statusline.installed, true);
  assert.equal(installs, 1);
  assert.deepEqual(fs.readdirSync(f.root), ["settings.json"]);
  assert.equal(fs.readFileSync(f.settingsFile, "utf8"), "damaged settings must be left to Claude CLI");
});

test("Windows HUD status survives setup recreation and reflects removal from Claude's registry", async (t) => {
  const f = fixture(t);
  const plugins = path.join(f.root, "plugins");
  fs.mkdirSync(plugins);
  const registry = path.join(plugins, "installed_plugins.json");
  fs.writeFileSync(registry, JSON.stringify({ version: 2, plugins: {
    "claude-hud@claude-hud": [{ scope: "user", installPath: "managed-by-claude" }]
  } }));
  const create = () => createClaudeSetup({ ...f.base, platform: "win32" });
  const first = create();
  const restarted = create();
  assert.equal((await first.getStatus()).statusline.installed, true);
  assert.equal((await restarted.getStatus()).statusline.installed, true);
  assert.equal(fs.existsSync(f.settingsFile), false);
  fs.writeFileSync(registry, JSON.stringify({ version: 2, plugins: {} }));
  assert.equal((await restarted.getStatus()).statusline.installed, false);
});

test("Windows HUD off removes only this configuration root's HUD command and preserves unrelated settings", async (t) => {
  const f = fixture(t);
  const calls = [];
  let enabled = true;
  const create = () => createClaudeSetup({ ...f.base, platform: "win32",
    hudInstaller: { isInstalled: () => true, isEnabled: () => enabled, async configure(_deps, wanted) {
      calls.push(wanted); enabled = wanted; return { success: true, enabled };
    } } });
  const original = { env: { KEEP: "yes" }, enabledPlugins: { other: true }, statusLine: { type: "command", command:
    `node "${path.join(f.root, "plugins", "claude-hud", "statusline.mjs")}"` } };
  f.write(original);
  await create().configureStatusline(false);
  const { statusLine, ...rest } = original;
  assert.deepEqual(f.read(), rest);
  assert.equal((await create().getStatus()).statusline.enabled, false);
  f.write({ ...original, statusLine: { type: "command", command: "my-custom-statusline" } });
  await create().configureStatusline(false);
  assert.equal(f.read().statusLine.command, "my-custom-statusline");
  await create().configureStatusline(true);
  assert.equal((await create().getStatus()).statusline.enabled, true);
  assert.deepEqual(calls, [false, false, true]);
});

test("Windows HUD is disabled only when Claude CLI is missing", async (t) => {
  const f = fixture(t);
  const setup = createClaudeSetup({ ...f.base, platform: "win32", probe: async () => ({ cli: false }),
    hudInstaller: { install() { assert.fail("must not install"); } } });
  const status = (await setup.getStatus()).statusline;
  assert.equal(status.ready, false);
  assert.equal(status.kind, "claude-hud");
  assert.match(status.reason, /Claude CLI/);
  await assert.rejects(setup.configureStatusline(), { setupCode: "cli" });
});

test("CLI-only Windows probe does not run Bash, jq or Node version checks", async () => {
  const deps = await createSetupProbe({ platform: "win32", env: { PATH: "C:\\tools" }, home: "C:\\home",
    cliOnly: true, includeClaudeCommand: true, fsImpl: { statSync: () => ({ isFile: () => true }) },
    execFileImpl(file, args, options, done) {
      assert.ok(file.endsWith("claude.exe"));
      done(null, "2.1.327 (Claude Code)");
    } })();
  assert.equal(deps.cli, true);
  assert.deepEqual(deps.claudeCommand, { file: "C:\\tools\\claude.exe", args: [] });
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

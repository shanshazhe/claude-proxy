"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createClaudeHudInstaller, isClaudeHudCommand } = require("../lib/claude-hud-install");
const { setupFailure } = require("../lib/claude-setup");
const command = { file: "C:\\Program Files\\node.exe", args: ["C:\\npm folder\\cli.js"] };
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("HUD status reads only Claude's user-scope installation record without running commands", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = createClaudeHudInstaller({ configRoot: root, execFileImpl() { assert.fail("status must not execute commands"); } });
  assert.equal(installer.isInstalled(), false);
  fs.mkdirSync(path.join(root, "plugins"));
  const file = path.join(root, "plugins", "installed_plugins.json");
  for (const [contents, installed] of [
    ["invalid json", false],
    [JSON.stringify({ plugins: {} }), false],
    [JSON.stringify({ plugins: { "claude-hud@claude-hud": [{ scope: "project" }] } }), false],
    [String.fromCharCode(65279) + JSON.stringify({ plugins: { "claude-hud@claude-hud": [{ scope: "user" }] } }), true]
  ]) {
    fs.writeFileSync(file, contents);
    assert.equal(installer.isInstalled(), installed);
  }
});

test("HUD configuration installs only when needed, enables/disables at user scope and persists state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-toggle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const settingsFile = path.join(root, "settings.json");
  const options = { configRoot: root, execFileImpl(_file, args, _options, done) {
    const operation = args[command.args.length + 1];
    calls.push(operation);
    if (operation === "install") {
      fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
      fs.writeFileSync(path.join(root, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {
        "claude-hud@claude-hud": [{ scope: "user" }]
      } }));
    }
    if (["enable", "disable"].includes(operation)) {
      assert.deepEqual(args.slice(-2), ["--scope", "user"]);
      fs.writeFileSync(settingsFile, JSON.stringify({ enabledPlugins: { "claude-hud@claude-hud": operation === "enable" } }));
    }
    done(null);
  } };
  const installer = createClaudeHudInstaller(options);
  assert.equal(installer.isEnabled(), false);
  assert.equal((await installer.configure({ claudeCommand: command }, true)).enabled, true);
  assert.equal(installer.isEnabled(), true);
  assert.equal(createClaudeHudInstaller(options).isEnabled(), true);
  assert.equal((await installer.configure({ claudeCommand: command }, false)).enabled, false);
  assert.equal(installer.isInstalled(), true);
  assert.equal(installer.isEnabled(), false);
  await installer.configure({ claudeCommand: command }, true);
  assert.deepEqual(calls, ["marketplace", "install", "enable", "disable", "enable"]);
});

test("HUD launcher recognition covers official relative commands and user registry paths only", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const installed = path.join(root, "custom cache", "0.15.3");
  fs.mkdirSync(path.join(root, "plugins"));
  fs.writeFileSync(path.join(root, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {
    "claude-hud@claude-hud": [null, { scope: "project", installPath: "/project/hud" }, { scope: "user", installPath: installed }]
  } }));
  const matches = (command) => isClaudeHudCommand(command, { configRoot: root, home });
  for (const command of [
    'exec "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/claude-hud/statusline.cmd"',
    'node "$HOME/.claude/plugins/claude-hud/statusline.mjs"',
    'node "${CLAUDE_CONFIG_DIR}/plugins/claude-hud/statusline.mjs"',
    `node "${path.join(root, "plugins", "claude-hud", "statusline.mjs")}"`,
    `C:\\Windows\\System32\\cmd.exe /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "${path.join(root, "plugins", "claude-hud", "statusline.mjs")}""`,
    `"${path.join(home, ".claude", "plugins", "claude-hud", "statusline.cmd")}"`,
    `"C:\\Program Files\\nodejs\\node.exe" "${installed}/scripts/statusline.mjs"`,
    `node "${installed}/hud.mjs"`, `node "${installed}/dist/index.js"`
  ]) assert.equal(matches(command), true, command);
  for (const command of [undefined, "my-custom-statusline", 'node "/project/hud/statusline.mjs"',
    `node "${installed}/custom.mjs"`, `node "${installed}-other/statusline.mjs"`,
    'exec "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/claude-hud/custom.cmd"',
    `echo "${installed}/statusline.mjs"`, `node "${installed}/statusline.mjs" --custom`,
    `node "${installed}/statusline.mjs.backup"`
  ]) assert.equal(matches(command), false, String(command));
  fs.writeFileSync(path.join(root, "plugins", "installed_plugins.json"), "broken");
  assert.equal(matches(`node "${installed}/hud.mjs"`), false);
  assert.equal(matches('exec "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/claude-hud/statusline.cmd"'), true);
});

for (const alreadyAdded of [false, true]) {
  test(`HUD runs the official plugin commands with marketplace already added: ${alreadyAdded}`, async () => {
    const calls = [];
    const installer = createClaudeHudInstaller({ configRoot: "C:\\custom cli", home: "C:\\home", env: { NODE_OPTIONS: "private" },
      execFileImpl(file, args, options, done) {
        calls.push(args);
        assert.equal(file, command.file);
        assert.equal(options.shell, false);
        assert.equal(options.cwd, "C:\\home");
        assert.equal(options.env.CLAUDE_CONFIG_DIR, "C:\\custom cli");
        assert.equal(options.env.NODE_OPTIONS, undefined);
        done(alreadyAdded && args.includes("add") ? new Error("already added") : null);
      } });
    const result = await installer.install({ claudeCommand: command });
    assert.equal(result.success, true);
    assert.match(result.message, /\/reload-plugins.*\/hud/);
    assert.deepEqual(calls, [
      [...command.args, "plugin", "marketplace", "add", "jarrodwatts/claude-hud"],
      [...command.args, "plugin", "install", "claude-hud@claude-hud", "--scope", "user"]
    ]);
  });
}

test("HUD reports a fixed install failure without exposing subprocess output", async () => {
  const installer = createClaudeHudInstaller({ configRoot: "unused", execFileImpl(file, args, options, done) {
    done(new Error("private command output"));
  } });
  await assert.rejects(installer.install({ claudeCommand: command }), (error) => {
    const result = setupFailure(error);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "Claude HUD installation failed. Please retry.");
    return true;
  });
});

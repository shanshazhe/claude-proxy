"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createClaudeHudInstaller } = require("../lib/claude-hud-install");
const { setupFailure } = require("../lib/claude-setup");
const command = { file: "C:\\Program Files\\node.exe", args: ["C:\\npm folder\\cli.js"] };

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

"use strict";

const os = require("node:os");
const { execFile } = require("node:child_process");

function createClaudeHudInstaller({ configRoot, env = process.env, home = os.homedir(), execFileImpl = execFile } = {}) {
  const childEnv = { ...env, CLAUDE_CONFIG_DIR: configRoot };
  for (const name of ["BASH_ENV", "ENV", "NODE_OPTIONS"]) delete childEnv[name];
  function run(command, args) {
    return new Promise((resolve, reject) => {
      execFileImpl(command.file, [...command.args, ...args], { cwd: home, env: childEnv, shell: false,
        windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 }, (error) => error ? reject(error) : resolve());
    });
  }
  async function install({ claudeCommand }) {
    try {
      // 已添加过的 marketplace 可能使 add 失败；继续让官方 install 命令处理。
      await run(claudeCommand, ["plugin", "marketplace", "add", "jarrodwatts/claude-hud"]).catch(() => {});
      await run(claudeCommand, ["plugin", "install", "claude-hud@claude-hud", "--scope", "user"]);
      return { success: true, message: "Claude HUD installed. Run /reload-plugins, then /hud in Claude Code to finish setup." };
    } catch (_) { throw Object.assign(new Error("Claude HUD installation failed. Please retry."), { setupCode: "hud-install" }); }
  }
  return { install };
}

module.exports = { createClaudeHudInstaller };

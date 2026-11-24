"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

function userInstallRecords(configRoot) {
  try {
    const file = path.join(configRoot, "plugins", "installed_plugins.json");
    const records = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")).plugins?.["claude-hud@claude-hud"];
    return Array.isArray(records) ? records.filter((record) => record?.scope === "user") : [];
  } catch (_) { return []; }
}

function isClaudeHudCommand(command, { configRoot, home = os.homedir() }) {
  if (typeof command !== "string") return false;
  // Match a launcher invocation, not an arbitrary command mentioning a HUD directory.
  const trimmed = command.trim();
  const cmd = trimmed.match(/^[A-Za-z]:[\\/][^"\r\n]*[\\/]System32[\\/]cmd\.exe \/d \/s \/c ""([^"\r\n]+)" "([^"\r\n]+)""$/i);
  const tokens = cmd ? [cmd[1], cmd[2]] : [...trimmed.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
  if (cmd && !/[\\/]node\.exe$/i.test(tokens[0])) return false;
  if (tokens[0] === "exec") tokens.shift();
  if (tokens.length === 2 && /(?:^|[\\/])(?:node|node\.exe|bun|bun\.exe)$/i.test(tokens[0])) tokens.shift();
  if (tokens.length !== 1) return false;
  const normalize = (value) => value.replace(/\\/g, "/").replace(/\/$/, "");
  const target = normalize(tokens[0]);
  const roots = [path.join(configRoot, "plugins", "claude-hud"), path.join(home, ".claude", "plugins", "claude-hud"),
    "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/claude-hud", "${CLAUDE_CONFIG_DIR}/plugins/claude-hud",
    "$CLAUDE_CONFIG_DIR/plugins/claude-hud", "$HOME/.claude/plugins/claude-hud", "${HOME}/.claude/plugins/claude-hud",
    "~/.claude/plugins/claude-hud"];
  if (roots.some((root) => ["statusline.cmd", "statusline.mjs"].some((name) => target === normalize(root) + "/" + name))) return true;
  return userInstallRecords(configRoot).some((record) => typeof record.installPath === "string" &&
    ["statusline.cmd", "statusline.mjs", "scripts/statusline.mjs", "hud.mjs", "dist/index.js"].some((name) =>
      target === normalize(record.installPath) + "/" + name));
}

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
  function isInstalled() {
    return userInstallRecords(configRoot).length > 0;
  }
  function isEnabled() {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(configRoot, "settings.json"), "utf8").replace(/^﻿/, ""));
      return settings.enabledPlugins?.["claude-hud@claude-hud"] === true;
    } catch (_) { return false; }
  }
  async function configure(deps, enabled) {
    try {
      if (enabled && !isInstalled()) await install(deps);
      await run(deps.claudeCommand, ["plugin", enabled ? "enable" : "disable", "claude-hud@claude-hud", "--scope", "user"]);
      return { success: true, enabled, message: enabled
        ? "Claude HUD is on. Run /reload-plugins, then /hud in Claude Code to finish setup."
        : "Claude HUD is off. Start a new Claude session. Plugin files are kept." };
    } catch (_) { throw Object.assign(new Error("Claude HUD configuration failed. Please retry."), { setupCode: "hud-configure" }); }
  }
  return { install, isInstalled, isEnabled, configure };
}

module.exports = { createClaudeHudInstaller, isClaudeHudCommand };

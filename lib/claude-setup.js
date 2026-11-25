const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { defaultStore } = require("./credential-store");
const { readCredentialAvailability } = require("./pi-auth");
const { maximumContextWindow, isResponsesDescriptor } = require("./model-routing");
const { createSetupProbe } = require("./claude-probes");

const queues = new Map();
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const setupError = (code, message, fields) => Object.assign(new Error(message), { setupCode: code, fields });
const SETTINGS_ERROR = "Settings are damaged, unsafe, or not writable. Fix the user settings file first.";
const NO_CREDENTIALS = "Configure credentials for at least one model provider first.";
const OVERRIDE_NOTICE = "Shell, project, local, and managed settings may override user settings. This operation does not bypass policies.";
const CAPACITY_NOTICE = " Automatic GPT context capacity could not be enabled. Check the shell launcher configuration or opt-out, then retry. Without the launcher, GPT may use Claude Code's default context window.";

function getClaudeConfigRoot(env = process.env, home = os.homedir()) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  const expanded = configured === "~" ? home : /^~[\\/]/.test(configured) ? path.join(home, configured.slice(2)) : configured;
  return path.resolve(expanded || path.join(home, ".claude"));
}

// 按钮只配置代理连接；启动和登录后单独同步 GPT 容量。
function createClaudeSetup({ env = process.env, configRoot = getClaudeConfigRoot(env), store = defaultStore,
  getGptModels = async () => ({ data: [] }), probe,
  platform = process.platform, now = Date.now, fsImpl = fs, installer, hudInstaller, launcherInstaller, home = os.homedir() } = {}) {
  probe ||= createSetupProbe({ env, platform, home, includeClaudeCommand: platform === "win32", cliOnly: platform === "win32" });
  const root = path.resolve(configRoot);
  const settingsFile = path.join(root, "settings.json");
  const privateRoot = path.join(root, "claude-proxy");
  const backups = path.join(privateRoot, "settings-backups");
  const endpoint = "http://localhost:8082";
  const routing = { ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: "sk-placeholder",
    CLAUDE_CODE_USE_GATEWAY: "1", CLAUDE_GATEWAY_ALLOW_LOOPBACK: "1", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" };
  const useHud = platform === "win32";
  const statuslineInstaller = useHud
    ? hudInstaller || require("./claude-hud-install").createClaudeHudInstaller({ configRoot: root, env, home })
    : installer || require("./statusline-install").createStatuslineInstaller({ configRoot: root, platform, fsImpl });
  let capacityGeneration = 0;
  let probeCache;
  let probeExpires = 0;
  let probePending;
  const notice = (env.CLAUDE_CONFIG_DIR ? "Using the actual CLI root selected by CLAUDE_CONFIG_DIR. " : "") + OVERRIDE_NOTICE;

  function statOptional(file) {
    try { return fsImpl.lstatSync(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function checkDirectory(directory, create = false, privateMode = false) {
    const info = statOptional(directory);
    if (!info) {
      if (create) fsImpl.mkdirSync(directory, { mode: 0o700 });
      else { checkDirectory(path.dirname(directory)); return; }
    } else if (!info.isDirectory() || info.isSymbolicLink()) throw setupError("settings", SETTINGS_ERROR);
    if (create && privateMode && platform !== "win32") fsImpl.chmodSync(directory, 0o700);
  }
  function readSettings() {
    let fd;
    try {
      checkDirectory(root);
      const info = statOptional(settingsFile);
      if (!info) return { value: {}, bytes: null, info: null };
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error();
      fd = fsImpl.openSync(settingsFile, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0));
      const opened = fsImpl.fstatSync(fd);
      if (!opened.isFile() || opened.size > 2 * 1024 * 1024 || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error();
      const bytes = fsImpl.readFileSync(fd);
      const value = JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""));
      if (!isObject(value) || ["env", "hooks", "permissions", "enabledPlugins", "statusLine"].some((key) => Object.hasOwn(value, key) && !isObject(value[key])) ||
        value.env && Object.values(value.env).some((item) => typeof item !== "string") || Object.hasOwn(value, "model") && typeof value.model !== "string") throw new Error();
      return { value, bytes, info: opened };
    } catch (_) { throw setupError("settings", SETTINGS_ERROR); }
    finally { if (fd !== undefined) fsImpl.closeSync(fd); }
  }
  function checkWritable(snapshot) {
    try {
      let directory = root;
      while (!statOptional(directory)) directory = path.dirname(directory);
      checkDirectory(directory);
      fsImpl.accessSync(directory, fsImpl.constants.W_OK | fsImpl.constants.X_OK);
      if (platform !== "win32" && !(fsImpl.statSync(directory).mode & 0o222)) throw new Error();
      if (snapshot.info) {
        fsImpl.accessSync(settingsFile, fsImpl.constants.W_OK);
        if (platform !== "win32" && !(snapshot.info.mode & 0o222)) throw new Error();
      }
      for (const directory of [privateRoot, backups]) {
        const info = statOptional(directory);
        if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error();
        if (info) fsImpl.accessSync(directory, fsImpl.constants.W_OK | fsImpl.constants.X_OK);
      }
    } catch (_) { throw setupError("settings", SETTINGS_ERROR); }
  }
  function credentials() {
    try { return readCredentialAvailability({ env, store }); }
    catch (_) { throw setupError("credentials", "Credential storage is unavailable. Fix the local credential files first."); }
  }
  function conflicts(settings) {
    const names = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE"];
    const enabled = (value) => value && !["0", "false"].includes(String(value).toLowerCase());
    const fields = names.filter((name) => enabled(settings.env?.[name]) || enabled(env[name]));
    for (const name of ["apiKeyHelper", "proxyAuthHelper", "forceLoginGatewayUrl"]) if (settings[name]) fields.push(name);
    if (settings.forceLoginMethod) fields.push("forceLoginMethod");
    for (const name of ["CLAUDE_CODE_API_KEY_HELPER", "CLAUDE_CODE_GATEWAY_AUTH_HELPER", "CLAUDE_CODE_GATEWAY_URL", "ANTHROPIC_GATEWAY_AUTH_TOKEN"]) {
      if (settings.env?.[name] || env[name]) fields.push(name);
    }
    if (fields.length) throw setupError("conflict", "Conflicting authentication settings must be handled manually first: " + fields.join(", ") + ".", fields);
  }
  async function dependencies(fresh = false) {
    if (!fresh && probeCache && now() < probeExpires) return probeCache;
    if (!probePending) {
      probePending = Promise.resolve().then(probe).then((result) => {
        probeCache = result;
        probeExpires = now() + 15000;
        return result;
      }).finally(() => { probePending = null; });
    }
    return probePending;
  }

  function sameSnapshot(before, after) {
    if (!before.bytes || !after.bytes) return before.bytes === after.bytes;
    return before.info.ino === after.info.ino && before.info.dev === after.info.dev &&
      before.info.mtimeMs === after.info.mtimeMs && before.bytes.equals(after.bytes);
  }
  function ensureRoot() {
    const create = (directory) => {
      if (!statOptional(directory)) create(path.dirname(directory));
      checkDirectory(directory, true);
    };
    create(root);
    checkDirectory(privateRoot, true, true);
    checkDirectory(backups, true, true);
  }
  function backup(snapshot) {
    if (!snapshot.bytes) return;
    const digest = crypto.createHash("sha256").update(snapshot.bytes).digest("hex");
    const file = path.join(backups, `settings-${digest}.json`);
    const info = statOptional(file);
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || !fsImpl.readFileSync(file).equals(snapshot.bytes)) throw new Error();
      if (platform !== "win32") fsImpl.chmodSync(file, 0o600);
    } else fsImpl.writeFileSync(file, snapshot.bytes, { flag: "wx", mode: 0o600 });
  }
  function commit(merge) {
    // 异步发现/探测已结束；提交阶段同步重读、合并、校验，不跨 await 留旧快照。
    const snapshot = readSettings();
    checkWritable(snapshot);
    const result = merge(snapshot.value);
    if (JSON.stringify(snapshot.value) === JSON.stringify(result)) return;
    let temporary;
    try {
      ensureRoot();
      backup(snapshot);
      temporary = path.join(root, `.settings-${crypto.randomUUID()}.tmp`);
      fsImpl.writeFileSync(temporary, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      if (!sameSnapshot(snapshot, readSettings())) throw setupError("changed", "Settings changed during configuration. Nothing was overwritten; please retry.");
      if (snapshot.bytes) fsImpl.renameSync(temporary, settingsFile);
      else fsImpl.linkSync(temporary, settingsFile); // 新建时不可覆盖外部同时创建的文件。
    } catch (error) {
      if (error.setupCode) throw error;
      throw setupError("save", "Unable to save configuration safely. Existing settings were kept; check permissions and retry.");
    } finally {
      if (temporary && statOptional(temporary)) fsImpl.unlinkSync(temporary);
    }
  }
  // Claude Code 记住了“拒绝使用自定义 API key”时会忽略 ANTHROPIC_API_KEY；这里只删除对占位 key 的拒绝记录。
  // 全局配置为 $CLAUDE_CONFIG_DIR/.claude.json；默认根目录时 CLI 使用 ~/.claude.json（服务可能显式注入了默认根目录）。
  function clearRejectedApiKey() {
    const key = routing.ANTHROPIC_API_KEY.slice(-20);
    const files = [path.join(root, ".claude.json")];
    if (root === path.resolve(home, ".claude")) files.push(path.join(home, ".claude.json"));
    let failed = false;
    for (const file of files) {
      let temporary;
      try {
        const info = statOptional(file);
        if (!info || !info.isFile()) continue;
        const config = JSON.parse(fsImpl.readFileSync(file, "utf8"));
        const rejected = config?.customApiKeyResponses?.rejected;
        if (!Array.isArray(rejected) || !rejected.includes(key)) continue;
        config.customApiKeyResponses.rejected = rejected.filter((value) => value !== key);
        temporary = `${file}.${crypto.randomUUID()}.tmp`;
        fsImpl.writeFileSync(temporary, JSON.stringify(config, null, 2), { flag: "wx", mode: info.mode & 0o777 });
        fsImpl.renameSync(temporary, file);
      } catch (_) {
        failed = true;
      } finally {
        if (temporary && statOptional(temporary)) fsImpl.unlinkSync(temporary);
      }
    }
    return failed ? " Could not clear a previously rejected API key in .claude.json; if Claude asks, choose to use the custom API key." : "";
  }
  function serialize(operation) {
    const pending = (queues.get(root) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(root, pending);
    return pending.finally(() => { if (queues.get(root) === pending) queues.delete(root); });
  }
  function requireCli(deps) {
    if (!deps.cli) throw setupError("cli", "Claude CLI was not found. Install Claude Code manually, then retry.");
  }
  function requireStatusline(deps) {
    requireCli(deps);
    if (!deps.bash || !deps.jq) throw setupError("dependencies", "Statusline requires Bash 3+ and jq 1.6+. Install them manually, then retry.");
    try { statuslineInstaller.validateTarget?.(); }
    catch (_) { throw setupError("settings", SETTINGS_ERROR); }
    try { statuslineInstaller.validateBundle(); }
    catch (_) { throw setupError("bundle", "The bundled statusline files are missing or invalid. Restore the claude-proxy bundle first."); }
  }
  function requireCredentials() {
    const available = credentials();
    if (!Object.values(available).some(Boolean)) throw setupError("no-credentials", NO_CREDENTIALS);
  }
  async function getStatus() {
    let deps;
    try { deps = await dependencies(); } catch (_) { deps = {}; }
    let snapshot;
    let commonError;
    try { snapshot = readSettings(); checkWritable(snapshot); requireCli(deps); }
    catch (error) { commonError = error.setupCode ? error.message : SETTINGS_ERROR; }
    const settings = snapshot?.value || {};
    let cliReason = commonError;
    let statuslineReason = commonError;
    if (!cliReason) {
      try { requireCredentials(); conflicts(settings); } catch (error) { cliReason = error.message; }
    }
    if (!useHud && !statuslineReason) {
      try { requireStatusline(deps); } catch (error) { statuslineReason = error.message; }
    }
    const cliConfigured = Object.entries(routing).every(([key, value]) => settings.env?.[key] === value) &&
      !settings.env?.ANTHROPIC_AUTH_TOKEN;
    const statuslineConfigured = !useHud && (statuslineInstaller.isConfigured
      ? statuslineInstaller.isConfigured(settings.statusLine)
      : settings.statusLine?.type === "command" && settings.statusLine.command?.includes(path.join(privateRoot, "statusline")));
    return { claudeCli: { installed: Boolean(deps.cli), ready: !cliReason, configured: Boolean(cliConfigured), reason: cliReason || "", notice },
      statusline: useHud ? { kind: "claude-hud", ready: Boolean(deps.cli), installed: statuslineInstaller.isInstalled?.() === true,
        enabled: statuslineInstaller.isEnabled?.() === true,
        reason: deps.cli ? "" : "Claude CLI was not found. Install Claude Code manually, then retry." }
        : { kind: "statusline", installed: Boolean(deps.bash && deps.jq), ready: !statuslineReason,
          configured: Boolean(statuslineConfigured), reason: statuslineReason || "", notice } };
  }
  async function configureCli() {
    requireCredentials();
    const before = readSettings();
    checkWritable(before);
    conflicts(before.value);
    const deps = await dependencies(true);
    requireCli(deps);
    return serialize(async () => {
      requireCredentials();
      commit((latest) => {
        conflicts(latest);
        const nextEnv = { ...latest.env, ...routing };
        delete nextEnv.ANTHROPIC_AUTH_TOKEN;
        return { ...latest, env: nextEnv };
      });
      // 首次启动时可能尚未登录 GPT；配置成功后补装启动器，不要求重启代理，也不覆盖显式关闭。
      let capacityNotice = "";
      if (launcherInstaller && credentials().openai) {
        try {
          if (!(await launcherInstaller.autoEnable())?.ok) capacityNotice = CAPACITY_NOTICE;
        } catch (_) { capacityNotice = CAPACITY_NOTICE; }
      }
      return { success: true, message: "Keep the proxy running. Open a new terminal and run claude. Use /model to choose a model.",
        notice: notice + clearRejectedApiKey() + capacityNotice };
    });
  }
  async function syncGptContextCapacity() {
    const generation = ++capacityGeneration;
    if (!credentials().openai) return { skipped: true };
    const before = readSettings();
    checkWritable(before);
    conflicts(before.value);
    let catalog;
    try { catalog = await getGptModels({ waitForRefresh: true }); }
    catch (_) { throw setupError("models", "No valid GPT context capacity is available. Please retry after logging in again."); }
    return serialize(() => {
      if (generation !== capacityGeneration || !credentials().openai) return { skipped: true };
      const capacities = (Array.isArray(catalog?.data) ? catalog.data : [])
        .filter((model) => typeof model?.id === "string" && model.owned_by === "openai" && isResponsesDescriptor(model))
        .map(maximumContextWindow).filter(Boolean);
      const tokens = capacities.length ? Math.max(...capacities) : undefined;
      if (!Number.isSafeInteger(tokens) || tokens <= 0) {
        throw setupError("models", "No valid GPT context capacity is available. Please retry after logging in again.");
      }
      commit((latest) => {
        conflicts(latest);
        return { ...latest, env: { ...latest.env, CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(tokens) } };
      });
      return { success: true, tokens };
    });
  }
  async function configureStatusline(enabled) {
    if (enabled !== undefined && (!useHud || typeof enabled !== "boolean")) {
      throw setupError("hud-configure", "Claude HUD configuration failed. Please retry.");
    }
    if (useHud) return serialize(async () => {
      const deps = await dependencies(true);
      requireCli(deps);
      if (enabled === undefined) return statuslineInstaller.install(deps);
      // Validate settings before asking the CLI to change them; commit keeps unrelated commands.
      const before = readSettings();
      checkWritable(before);
      const result = await statuslineInstaller.configure(deps, enabled);
      if (!enabled) commit((settings) => {
        const command = settings.statusLine?.command;
        if (!require("./claude-hud-install").isClaudeHudCommand(command, { configRoot: root, home })) return settings;
        const { statusLine, ...rest } = settings;
        return rest;
      });
      return result;
    });
    const before = readSettings();
    checkWritable(before);
    const deps = await dependencies(true);
    requireStatusline(deps);
    return serialize(() => {
      let deployment;
      try {
        const latest = readSettings();
        checkWritable(latest);
        // 部署完毕后才提交 statusLine；部署失败绝不修改 settings。
        deployment = statuslineInstaller.deploy(deps);
        commit((settings) => ({ ...settings, statusLine: { type: "command", command: deployment.command } }));
        return { success: true, message: "Statusline configured. It takes effect on the next statusline refresh or in a new Claude session.", notice };
      } catch (error) {
        if (deployment) {
          // 外部修改若已引用本次部署，则保留它；清理失败也不泄漏底层文件错误。
          try {
            if (readSettings().value.statusLine?.command !== deployment.command) statuslineInstaller.cleanup(deployment);
          } catch (_) {}
        }
        if (error.setupCode) throw error;
        throw setupError("deployment", "Unable to deploy the bundled statusline safely. Existing settings were kept; please retry.");
      }
    });
  }
  return { getStatus, configureCli, configureStatusline, syncGptContextCapacity };
}

function setupFailure(error) {
  const messages = {
    settings: SETTINGS_ERROR,
    credentials: "Credential storage is unavailable. Fix the local credential files first.",
    cli: "Claude CLI was not found. Install Claude Code manually, then retry.",
    dependencies: "Statusline requires Bash 3+ and jq 1.6+. Install them manually, then retry.",
    "hud-install": "Claude HUD installation failed. Please retry.",
    "hud-configure": "Claude HUD configuration failed. Please retry.",
    bundle: "The bundled statusline files are missing or invalid. Restore the claude-proxy bundle first.",
    deployment: "Unable to deploy the bundled statusline safely. Existing settings were kept; please retry.",
    "no-credentials": NO_CREDENTIALS,
    models: "No supported models are available for the configured credentials. Please retry later.",
    changed: "Settings changed during configuration. Nothing was overwritten; please retry.",
    save: "Unable to save configuration safely. Existing settings were kept; check permissions and retry.",
    conflict: "Conflicting authentication settings must be handled manually first."
  };
  const code = error.setupCode;
  const fields = (Array.isArray(error.fields) ? error.fields : []).filter((field) => ["apiKeyHelper", "proxyAuthHelper", "forceLoginMethod", "forceLoginGatewayUrl",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_API_KEY_HELPER", "CLAUDE_CODE_GATEWAY_AUTH_HELPER", "CLAUDE_CODE_GATEWAY_URL", "ANTHROPIC_GATEWAY_AUTH_TOKEN"].includes(field));
  return { status: ["conflict", "changed", "settings"].includes(code) ? 409 : ["cli", "dependencies", "no-credentials"].includes(code) ? 400 : 503,
    body: { error: Object.hasOwn(messages, code) ? messages[code] : "Local configuration could not be completed. Please retry.", ...(code === "conflict" ? { fields } : {}) } };
}

module.exports = { createClaudeSetup, getClaudeConfigRoot, setupFailure };

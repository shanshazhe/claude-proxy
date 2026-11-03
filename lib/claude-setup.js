const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { defaultStore } = require("./credential-store");
const { readCredentialAvailability } = require("./pi-auth");
const { selectModel, toGatewayModels } = require("./model-routing");
const { isResponsesModel } = require("./openai-responses");
const { isClaudeModel } = require("./github-copilot");
const { createSetupProbe } = require("./claude-probes");

const queues = new Map();
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const setupError = (code, message, fields) => Object.assign(new Error(message), { setupCode: code, fields });
const SETTINGS_ERROR = "Settings are damaged, unsafe, or not writable. Fix the user settings file first.";
const OVERRIDE_NOTICE = "Shell, project, local, and managed settings may override user settings. This operation does not bypass policies.";
const CAPACITY_NOTICE = " Automatic GPT context capacity could not be enabled. Check the shell launcher configuration or opt-out, then retry. Without the launcher, GPT may use Claude Code's default context window.";

function getClaudeConfigRoot(env = process.env, home = os.homedir()) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  const expanded = configured === "~" ? home : /^~[\\/]/.test(configured) ? path.join(home, configured.slice(2)) : configured;
  return path.resolve(expanded || path.join(home, ".claude"));
}

// 加载模块只描述路径；按钮负责部署和主会话配置，启动时仅单独同步 GPT 子代理。
function createClaudeSetup({ env = process.env, configRoot = getClaudeConfigRoot(env), store = defaultStore,
  getAvailableModels = async () => ({ data: [] }), probe = createSetupProbe({ env }),
  platform = process.platform, now = Date.now, fsImpl = fs, installer, launcherInstaller, home = os.homedir() } = {}) {
  const root = path.resolve(configRoot);
  const settingsFile = path.join(root, "settings.json");
  const privateRoot = path.join(root, "claude-proxy");
  const backups = path.join(privateRoot, "settings-backups");
  const endpoint = "http://localhost:8082";
  const routing = { ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: "sk-placeholder",
    CLAUDE_CODE_USE_GATEWAY: "1", CLAUDE_GATEWAY_ALLOW_LOOPBACK: "1", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" };
  const statuslineInstaller = installer || require("./statusline-install").createStatuslineInstaller({ configRoot: root, platform, fsImpl });
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
    if (!deps.bash || !deps.jq) throw setupError("dependencies", "Statusline requires Bash 3+ and jq 1.6+. Install them manually (Git Bash on Windows), then retry.");
    try { statuslineInstaller.validateTarget?.(); }
    catch (_) { throw setupError("settings", SETTINGS_ERROR); }
    try { statuslineInstaller.validateBundle(); }
    catch (_) { throw setupError("bundle", "The bundled statusline files are missing or invalid. Restore the claude-proxy bundle first."); }
  }
  function requireCredentials() {
    const available = credentials();
    if (!Object.values(available).some(Boolean)) throw setupError("no-credentials", "Configure a ChatGPT or Copilot credential first (or set OPENAI_API_KEY).");
    return available;
  }
  function eligibleModels(catalog) {
    const available = requireCredentials();
    return toGatewayModels({ data: (catalog?.data || []).filter((model) => typeof model.id === "string" &&
      (isClaudeModel(model.id) ? available.copilot : isResponsesModel(model.id) ? available.openai : false)) }).data;
  }
  function chooseModel(settings, catalog) {
    const models = eligibleModels(catalog);
    if (!models.length) throw setupError("models", "No supported models are available for the configured credentials. Please retry later.");
    const normalize = (id) => typeof id === "string" ? selectModel(id, "").replace(/\[1m\]$/i, "") : "";
    for (const current of [settings.env?.ANTHROPIC_MODEL, settings.model]) {
      const match = models.find((model) => normalize(model.id) === normalize(current));
      if (match) return match.id;
    }
    return models[0].id;
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
    if (!statuslineReason) {
      try { requireStatusline(deps); } catch (error) { statuslineReason = error.message; }
    }
    const cliConfigured = Object.entries(routing).every(([key, value]) => settings.env?.[key] === value) &&
      typeof settings.env?.ANTHROPIC_MODEL === "string" &&
      settings.env.ANTHROPIC_MODEL.trim() !== "" && !settings.env?.ANTHROPIC_AUTH_TOKEN;
    const statuslineConfigured = statuslineInstaller.isConfigured
      ? statuslineInstaller.isConfigured(settings.statusLine)
      : settings.statusLine?.type === "command" && settings.statusLine.command?.includes(path.join(privateRoot, "statusline"));
    return { claudeCli: { installed: Boolean(deps.cli), ready: !cliReason, configured: Boolean(cliConfigured), reason: cliReason || "", notice },
      statusline: { installed: Boolean(deps.bash && deps.jq), ready: !statuslineReason, configured: Boolean(statuslineConfigured), reason: statuslineReason || "", notice } };
  }
  async function configureCli() {
    requireCredentials();
    const before = readSettings();
    checkWritable(before);
    conflicts(before.value);
    const deps = await dependencies(true);
    requireCli(deps);
    let catalog;
    try { catalog = await getAvailableModels(); }
    catch (_) { throw setupError("models", "No supported models are available for the configured credentials. Please retry later."); }
    return serialize(async () => {
      let model;
      commit((latest) => {
        conflicts(latest);
        model = chooseModel(latest, catalog);
        const nextEnv = { ...latest.env, ...routing, ANTHROPIC_MODEL: model };
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
      return { success: true, model, message: "Keep the proxy running. Open a new terminal and run claude. Use /model to switch models.",
        notice: notice + clearRejectedApiKey() + capacityNotice };
    });
  }
  async function syncGptSubagentModel() {
    if (!credentials().openai) return { skipped: true };
    const before = readSettings();
    checkWritable(before);
    conflicts(before.value);
    let catalog;
    try { catalog = await getAvailableModels({ waitForRefresh: true }); }
    catch (_) { throw setupError("models", "No supported models are available for the configured credentials. Please retry later."); }
    return serialize(() => {
      if (!credentials().openai) return { skipped: true };
      let model;
      commit((latest) => {
        conflicts(latest);
        const normalize = (id) => typeof id === "string" ? selectModel(id, "").replace(/\[1m\]$/i, "") : "";
        const models = toGatewayModels({ data: (catalog?.data || [])
          .filter((item) => isResponsesModel(normalize(item.id)))
          .map((item) => ({ ...item, id: normalize(item.id) })) }).data;
        if (!models.length) throw setupError("models", "No supported models are available for the configured credentials. Please retry later.");
        for (const current of [latest.env?.CLAUDE_CODE_SUBAGENT_MODEL, latest.env?.ANTHROPIC_MODEL, latest.model]) {
          const match = models.find((item) => normalize(item.id) === normalize(current));
          if (match) { model = match.id; break; }
        }
        model ||= models[0].id;
        return { ...latest, env: { ...latest.env, CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" } };
      });
      return { success: true, model };
    });
  }
  async function configureStatusline() {
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
  return { getStatus, configureCli, configureStatusline, syncGptSubagentModel };
}

function setupFailure(error) {
  const messages = {
    settings: SETTINGS_ERROR,
    credentials: "Credential storage is unavailable. Fix the local credential files first.",
    cli: "Claude CLI was not found. Install Claude Code manually, then retry.",
    dependencies: "Statusline requires Bash 3+ and jq 1.6+. Install them manually (Git Bash on Windows), then retry.",
    bundle: "The bundled statusline files are missing or invalid. Restore the claude-proxy bundle first.",
    deployment: "Unable to deploy the bundled statusline safely. Existing settings were kept; please retry.",
    "no-credentials": "Configure a ChatGPT or Copilot credential first (or set OPENAI_API_KEY).",
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

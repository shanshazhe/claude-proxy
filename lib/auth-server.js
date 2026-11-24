const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { defaultStore } = require("./credential-store");
const { selectOpenAIProvider } = require("./pi-auth");
const { createDeviceLogin } = require("./device-login");
const { setupFailure } = require("./claude-setup");
const { serviceFailure } = require("./macos-service");

const MAX_AUTH_BODY_BYTES = 16 * 1024;

function createAuthRouter({ port = 8082, store = defaultStore, login, setup, macosService, projectMemory, codingDiscipline, summarySettings, onCredentialsChanged = () => {}, env = process.env } = {}) {
  const nonce = crypto.randomBytes(32).toString("base64url");
  const flows = login || createDeviceLogin({ store, onCredentialsChanged });
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  function isLocal(req) {
    const address = req.socket.remoteAddress;
    return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) && hosts.has(req.headers.host?.toLowerCase());
  }

  function headers(res, page = false) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const resources = page ? `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` : "";
    res.setHeader("Content-Security-Policy", `default-src 'none'; ${resources}connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  }

  function json(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let settled = false;
      const timer = setTimeout(() => fail(408), 10000);
      function fail(status) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chunks.length = 0;
        reject(Object.assign(new Error(), { status }));
      }
      req.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_AUTH_BODY_BYTES) { fail(413); return; }
        chunks.push(chunk);
      });
      req.on("error", () => fail(400));
      req.on("aborted", () => fail(400));
      req.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
          resolve(value);
        } catch (_) { reject(Object.assign(new Error(), { status: 400 })); }
      });
    });
  }

  function safeMacosStatus(value) {
    const result = {};
    for (const key of ["supported", "ready", "registered", "running", "state", "reason", "notice"]) {
      if (typeof value?.[key] === "boolean" || typeof value?.[key] === "string") result[key] = value[key];
    }
    if (value?.instance && typeof value.instance === "object" && Number.isSafeInteger(value.instance.pid) && value.instance.pid > 0 &&
      typeof value.instance.installationId === "string" && /^[a-f0-9]{64}$/.test(value.instance.installationId)) {
      result.instance = { pid: value.instance.pid, installationId: value.instance.installationId };
    }
    if (value?.operation && typeof value.operation === "object") {
      const operation = {};
      for (const key of ["id", "phase", "errorCode", "recovery"]) {
        if (typeof value.operation[key] === "string") operation[key] = value.operation[key];
      }
      result.operation = operation;
    }
    return result;
  }

  function safeProjectMemoryStatus(value) {
    const state = ["absent", "installed", "conflict", "unavailable"].includes(value?.state) ? value.state : "unavailable";
    const reasons = {
      absent: "", installed: "",
      conflict: "An older or different project-code-memory skill is installed. Turning this on backs up the existing skill to claude-proxy/skill-backups/ in your Claude CLI directory, then installs the query-only skill.",
      unavailable: value?.reason === "Install Claude CLI and Python 3.9+ manually first."
        ? "Install Claude CLI and Python 3.9+ manually first." : "Project Code Memory is unavailable. Check the bundled files and dependencies."
    };
    return { enabled: value?.enabled === true, installed: state === "installed" && value?.installed === true,
      ready: ["absent", "installed", "conflict"].includes(state) && value?.ready === true, state, reason: reasons[state],
      notice: "Open a new Claude session after turning this on or off. Skill use is model-driven, not a hook. Query creates a project cache and updates .gitignore; the gateway only maintains existing caches." };
  }

  function safeCodingDisciplineStatus(value) {
    const state = ["absent", "installed", "conflict", "unavailable"].includes(value?.state) ? value.state : "unavailable";
    const reasons = {
      absent: "", installed: "",
      conflict: "Existing skill or directories are unsafe or different. Handle them manually; nothing will be overwritten.",
      unavailable: value?.reason === "Install Claude CLI manually first."
        ? "Install Claude CLI manually first." : "Coding Discipline is unavailable. Check the bundled files and Claude CLI."
    };
    return { installed: state === "installed" && value?.installed === true,
      ready: ["absent", "installed"].includes(state) && value?.ready === true, state, reason: reasons[state],
      notice: "Open a new Claude session after installation. Skill use is model-driven, not a hook." };
  }

  function safeSummaryStatus(value) {
    const id = (model) => typeof model === "string" && model.length <= 128 ? model : null;
    const size = (bytes) => Number.isSafeInteger(bytes) && bytes > 0;
    const days = (count) => Number.isSafeInteger(count) && count >= 0;
    if (!value || typeof value !== "object") return { available: false, enabled: false, model: null, defaultModel: null, models: [], threshold: null, thresholds: [], prompt: "", customPrompt: false, retentionDays: null, retentionOptions: [] };
    return { available: true, enabled: value.enabled === true, model: id(value.model), defaultModel: id(value.defaultModel),
      models: Array.isArray(value.models) ? value.models.filter(id).slice(0, 500) : [],
      threshold: size(value.threshold) ? value.threshold : null, thresholds: Array.isArray(value.thresholds) ? value.thresholds.filter(size).slice(0, 20) : [],
      prompt: typeof value.prompt === "string" && value.prompt.length <= MAX_AUTH_BODY_BYTES ? value.prompt : "", customPrompt: value.customPrompt === true,
      retentionDays: days(value.retentionDays) ? value.retentionDays : null, retentionOptions: Array.isArray(value.retentionOptions) ? value.retentionOptions.filter(days).slice(0, 20) : [] };
  }

  function status() {
    const auth = store.readAuth();
    const selected = auth[selectOpenAIProvider(auth)];
    const configured = (value) => Boolean(value && (value.type === "api_key" && typeof value.key === "string" && value.key ||
      value.type === "oauth" && typeof value.access === "string" && value.access && typeof value.refresh === "string" && value.refresh && Number.isFinite(value.expires)));
    return {
      chatgpt: { configured: configured(selected), environmentOverride: Boolean(env.OPENAI_API_KEY) },
      copilot: { configured: auth["github-copilot"]?.type === "oauth" && configured(auth["github-copilot"]) },
      storagePath: store.directory
    };
  }
  async function handle(req, res) {
    const route = req.url?.split("?")[0];
    const summaryRoute = route === "/api/auth/online-summary/configure";
    const setupRoute = summaryRoute || ["/api/auth/claude/configure", "/api/auth/statusline/configure", "/api/auth/macos/service/configure", "/api/auth/project-memory/configure", "/api/auth/coding-discipline/install"].includes(route);
    if (route !== "/login" && route !== "/api/auth" && !route?.startsWith("/api/auth/")) return false;
    headers(res);
    if (!isLocal(req)) { json(res, 403, { error: setupRoute ? "Configuration is available only through the local page." : "登录入口仅允许本机同源访问。" }); return true; }
    if (route === "/login") {
      if (req.method !== "GET") { json(res, 405, { error: "请求方法不支持。" }); return true; }
      try {
        const page = fs.readFileSync(path.join(__dirname, "..", "web", "login.html"), "utf8").replaceAll("__AUTH_NONCE__", nonce);
        headers(res, true);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
      } catch (_) { json(res, 503, { error: "本地登录页面不可用。" }); }
      return true;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      json(res, 405, { error: setupRoute ? "Request method is not supported." : "请求方法不支持。" }); return true;
    }
    if (req.headers["x-auth-nonce"] !== nonce) { json(res, 403, { error: setupRoute ? "Reload the local page before configuring." : "请从本地登录页面发起请求。" }); return true; }
    if (req.method === "POST" && (req.headers.origin !== `http://${req.headers.host}` ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || ""))) {
      json(res, 403, { error: setupRoute ? "Only local same-origin JSON requests are allowed." : "仅允许本机同源 JSON 请求。" }); return true;
    }
    let projectMemoryEnabled;
    try {
      if (req.method === "GET" && route === "/api/auth/status") {
        const unavailable = { installed: false, ready: false, configured: false, reason: "Local setup is unavailable." };
        const macStatus = macosService ? safeMacosStatus(await macosService.getStatus()) : { supported: false, ready: false, registered: false, running: false, state: "unsupported", reason: "macOS service is unavailable." };
        let pcm;
        try { pcm = safeProjectMemoryStatus(projectMemory ? await projectMemory.getStatus() : null); }
        catch (_) { pcm = safeProjectMemoryStatus(null); }
        let discipline;
        try { discipline = safeCodingDisciplineStatus(codingDiscipline ? await codingDiscipline.getStatus() : null); }
        catch (_) { discipline = safeCodingDisciplineStatus(null); }
        let summary;
        try { summary = safeSummaryStatus(summarySettings ? await summarySettings.getStatus() : null); }
        catch (_) { summary = safeSummaryStatus(null); }
        json(res, 200, { ...status(), ...(setup ? await setup.getStatus() : { claudeCli: unavailable, statusline: unavailable }), macosService: macStatus, projectMemory: pcm, codingDiscipline: discipline, onlineSummary: summary });
      } else if (req.method === "POST" && summaryRoute) {
        const body = await readBody(req);
        const keys = Object.keys(body);
        if (!keys.length || keys.some((key) => !["enabled", "model", "threshold", "prompt", "retentionDays"].includes(key)) ||
          ("enabled" in body && typeof body.enabled !== "boolean") || ("model" in body && body.model !== null && typeof body.model !== "string") ||
          ("threshold" in body && !Number.isSafeInteger(body.threshold)) || ("prompt" in body && body.prompt !== null && typeof body.prompt !== "string") ||
          ("retentionDays" in body && !Number.isSafeInteger(body.retentionDays))) {
          json(res, 400, { error: "Send enabled (true or false), a model, threshold or retention period from the list, or a prompt (text, or null for the default)." }); return true;
        }
        if (!summarySettings) { json(res, 503, { error: "Online Summary settings are unavailable." }); return true; }
        const patch = {};
        if ("enabled" in body) patch.onlineSummary = body.enabled;
        if ("model" in body) patch.summaryModel = body.model;
        if ("threshold" in body) patch.summaryThreshold = body.threshold;
        if ("prompt" in body) patch.summaryPrompt = body.prompt;
        if ("retentionDays" in body) patch.archiveRetentionDays = body.retentionDays;
        json(res, 200, { success: true, onlineSummary: safeSummaryStatus(await summarySettings.configure(patch)) });
      } else if (req.method === "POST" && route === "/api/auth/project-memory/configure") {
        const body = await readBody(req);
        if (Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") { json(res, 400, { error: "Send enabled (true or false) only." }); return true; }
        if (!projectMemory) { json(res, 503, { error: "Project Code Memory is unavailable." }); return true; }
        projectMemoryEnabled = body.enabled;
        const result = await projectMemory.configure(body.enabled);
        if (!result || result.ok !== true) throw new Error();
        json(res, 200, { ok: true, changed: result.changed === true, replaced: result.replaced === true, ...safeProjectMemoryStatus(result) });
      } else if (req.method === "POST" && route === "/api/auth/coding-discipline/install") {
        const body = await readBody(req);
        if (Object.keys(body).length) { json(res, 400, { error: "Installation requests must contain only an empty JSON object." }); return true; }
        if (!codingDiscipline) { json(res, 503, { error: "Coding Discipline installation is unavailable." }); return true; }
        const result = await codingDiscipline.install();
        if (!result || result.ok !== true) throw new Error();
        json(res, 200, { ok: true, changed: result.changed === true, ...safeCodingDisciplineStatus(result) });
      } else if (req.method === "POST" && route === "/api/auth/macos/service/configure") {
        const body = await readBody(req);
        if (Object.keys(body).length) { json(res, 400, { error: "Configuration requests must contain only an empty JSON object." }); return true; }
        if (!macosService) { json(res, 503, { error: "macOS service operation is unavailable." }); return true; }
        const result = await macosService.configure();
        if (![200, 202].includes(result.status) || !result.body || typeof result.body.state !== "string") throw new Error();
        if (typeof result.activate === "function") res.once("finish", result.activate);
        if (typeof result.cancel === "function") {
          if (res.destroyed || req.aborted) { result.cancel(); return true; }
          res.once("close", () => { if (!res.writableFinished) result.cancel(); });
        }
        const responseBody = {};
        for (const key of ["accepted", "operationId", "state", "message"]) {
          if (typeof result.body[key] === "string" || typeof result.body[key] === "boolean") responseBody[key] = result.body[key];
        }
        json(res, result.status, responseBody);
      } else if (req.method === "POST" && setupRoute) {
        const body = await readBody(req);
        const hudToggle = route === "/api/auth/statusline/configure" && Object.keys(body).length === 1 && typeof body.enabled === "boolean";
        if (Object.keys(body).length && !hudToggle) { json(res, 400, { error: "Configuration requests accept an empty object, or enabled (true or false) for Claude HUD." }); return true; }
        if (!setup) { json(res, 503, { error: "Local setup is unavailable." }); return true; }
        const result = await (route === "/api/auth/claude/configure" ? setup.configureCli() : setup.configureStatusline(body.enabled));
        json(res, 200, result);
      }
      else if (req.method === "GET" && /^\/api\/auth\/flow\/[a-zA-Z0-9_-]+$/.test(route)) {
        const flow = flows.get(route.slice("/api/auth/flow/".length));
        json(res, flow ? 200 : 404, flow || { error: "登录流程不存在或已过期。" });
      } else if (req.method === "POST" && ["/api/auth/chatgpt/start", "/api/auth/copilot/start"].includes(route)) {
        const body = await readBody(req);
        json(res, 200, await flows.start(route.includes("/chatgpt/") ? "chatgpt" : "copilot"));
      } else json(res, 404, { error: "登录接口不存在。" });
    } catch (error) {
      if (summaryRoute) {
        const code = [400, 408, 413].includes(error.status) ? error.status : 503;
        json(res, code, { error: error.code === "UNKNOWN_SUMMARY_MODEL" ? "Choose a model from the list."
          : error.code === "INVALID_SUMMARY_THRESHOLD" ? "Choose a threshold from the list."
          : error.code === "INVALID_SUMMARY_PROMPT" ? "Enter a non-empty prompt of at most 8 KiB."
          : error.code === "INVALID_RETENTION_DAYS" ? "Choose a retention period from the list." : code === 400 ? "A JSON object is required."
          : code === 413 ? "Request body is too large."
          : code === 408 ? "Configuration request timed out." : "Online Summary settings could not be saved. Check ~/.claude/gateway-features.json." });
      } else if (route === "/api/auth/project-memory/configure") {
        const code = error.code === "PROJECT_MEMORY_CONFLICT" ? 409 : [400, 408, 413].includes(error.status) ? error.status : 503;
        json(res, code, { error: code === 409 && projectMemoryEnabled === false
          ? "Gateway maintenance is off, but the installed skill differs from the bundle and was left in place. Remove it manually if you no longer need it."
          : code === 409 ? "Project Code Memory could not be enabled because the skill folder changed during installation or a required directory is unsafe. Existing content was kept; check the skill and claude-proxy/skill-backups/ before retrying."
          : code === 400 ? "A JSON object is required." : code === 413 ? "Request body is too large." : code === 408 ? "Configuration request timed out."
          : "Project Code Memory could not be configured. Check Claude CLI, Python 3.9+ and ~/.claude/gateway-features.json." });
      } else if (route === "/api/auth/coding-discipline/install" && ![400, 408, 413].includes(error.status)) {
        const conflict = error.code === "CODING_DISCIPLINE_CONFLICT";
        json(res, conflict ? 409 : 503, { error: conflict ? "Coding Discipline cannot be installed because existing files conflict." : "Coding Discipline installation is unavailable." });
      } else if (route === "/api/auth/macos/service/configure" && ![400, 408, 413].includes(error.status)) {
        const failure = serviceFailure(error);
        json(res, failure.status, failure.body);
      } else if (setupRoute) {
        if ([400, 408, 413].includes(error.status)) {
          json(res, error.status, { error: error.status === 413 ? "Request body is too large." : error.status === 408 ? "Configuration request timed out." : "An empty JSON object is required." });
        } else {
          const failure = setupFailure(error);
          json(res, failure.status, failure.body);
        }
      } else {
        const code = [400, 408, 413].includes(error.status) ? error.status : 503;
        json(res, code, { error: code === 413 ? "请求体过大。" : "登录操作未完成；请检查输入或稍后重试。" });
      }
    }
    return true;
  }
  handle.close = () => flows.close();
  return handle;
}

module.exports = { createAuthRouter, MAX_AUTH_BODY_BYTES };

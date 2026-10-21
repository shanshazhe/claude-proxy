const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { loadCopilotAuth, COPILOT_HEADERS } = require("./copilot-auth");
const { prepareClaudeCache, createClaudeCacheObserver } = require("./anthropic-cache");
const { createProjectMemoryResponseTransform } = require("./project-memory-response");

const isClaudeModel = (model) => /^claude-[^/]+$/i.test(model || "");
// Account discovery supplies the same adaptive-thinking compatibility that Pi
// gets from its model registry. Unknown models retain the client's native body.
const adaptiveModels = new Map();
// Some models reject thinking "disabled" (sent by Claude Code side queries such as
// WebFetch) and the catalog does not say which. Their 400 names the off switch, if any.
const disabledThinkingFallbacks = new Map();
// 目录里可走 /responses 的模型（GPT 等）；内置 WebSearch 在 Claude 会话中用它们执行搜索。
let responsesModels = [];

function hasImage(value) {
  if (Array.isArray(value)) return value.some(hasImage);
  return value && typeof value === "object" && (value.type === "image" || Object.values(value).some(hasImage));
}

// Opus 4.7+ return empty thinking text unless display is requested, and Claude
// Code does not request it through a gateway. An explicit client display wins.
function getUpstreamThinking(body) {
  if (body.thinking?.type === "disabled" && disabledThinkingFallbacks.has(body.model)) {
    return disabledThinkingFallbacks.get(body.model);
  }
  const thinking = body.thinking?.type === "enabled" && adaptiveModels.get(body.model)
    ? { type: "adaptive", ...(body.thinking.display ? { display: body.thinking.display } : {}) } : body.thinking;
  return thinking?.type === "adaptive" && !thinking.display ? { ...thinking, display: "summarized" } : thinking;
}

function getCopilotHeaders(auth, clientHeaders = {}, body = {}) {
  const last = body.messages?.at(-1);
  const isToolResult = Array.isArray(last?.content) && last.content.some((block) => block.type === "tool_result");
  const headers = {
    ...COPILOT_HEADERS,
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "anthropic-version": clientHeaders["anthropic-version"] || "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "X-GitHub-Api-Version": "2026-06-01",
    "X-Initiator": last && (last.role !== "user" || isToolResult) ? "agent" : "user",
    "Openai-Intent": "conversation-edits"
  };
  if (clientHeaders["anthropic-beta"]) headers["anthropic-beta"] = clientHeaders["anthropic-beta"];
  if (hasImage(body.messages)) headers["Copilot-Vision-Request"] = "true";
  // Never forward client Authorization, cookies or Toolkit's placeholder key.
  return headers;
}

async function discoverCopilotModels({ fetchImpl = fetch, loadAuth = loadCopilotAuth, signal } = {}) {
  const auth = await loadAuth({ fetchImpl, signal });
  const response = await fetchImpl(auth.baseUrl + "/models", {
    headers: getCopilotHeaders(auth), signal, redirect: "error"
  });
  if (!response.ok) throw new Error(`Copilot model catalog HTTP ${response.status}`);
  const catalog = await response.json();
  if (!Array.isArray(catalog.data)) throw new Error("Invalid Copilot model catalog");
  const models = catalog.data.filter((model) => typeof model.id === "string" && model.capabilities?.supports?.tool_calls !== false);
  const picker = models.filter((model) => model.model_picker_enabled === true && model.policy?.state !== "disabled");
  // Match Pi's policy fallback for Individual accounts only, not Business/Enterprise.
  const available = picker.length || auth.baseUrl !== "https://api.individual.githubcopilot.com"
    ? picker : models.filter((model) => model.policy?.state === "enabled");
  const claudeModels = available.filter((model) => isClaudeModel(model.id) &&
    (!Array.isArray(model.supported_endpoints) || model.supported_endpoints.includes("/v1/messages")));
  for (const model of claudeModels) adaptiveModels.set(model.id, model.capabilities?.supports?.adaptive_thinking === true);
  responsesModels = available.filter((model) => Array.isArray(model.supported_endpoints) && model.supported_endpoints.includes("/responses")).map((model) => model.id);
  return claudeModels.map((model) => ({ ...model, object: "model", owned_by: "github-copilot" }));
}

async function forwardClaudeRequest(body, request, clientRes, { fetchImpl = fetch, loadAuth = loadCopilotAuth, onCacheUsage = () => {}, responseHandler = null } = {}) {
  const controller = new AbortController();
  const abort = () => { if (!clientRes.writableFinished) controller.abort(); };
  clientRes.on("close", abort);
  const timeout = setTimeout(() => controller.abort(new Error("Copilot Claude request timed out")), 3600000);
  try {
    const auth = await loadAuth({ fetchImpl, signal: controller.signal });
    const send = async () => {
      const thinking = getUpstreamThinking(body);
      const payload = prepareClaudeCache(thinking === body.thinking ? body : { ...body, thinking });
      const upstream = await fetchImpl(auth.baseUrl + request.url, {
        method: "POST", headers: getCopilotHeaders(auth, request.headers, payload), body: JSON.stringify(payload),
        signal: controller.signal, redirect: "error"
      });
      return { payload, upstream };
    };
    let { payload, upstream } = await send();
    if (upstream.status === 400 && payload.thinking?.type === "disabled") {
      const message = await upstream.clone().text();
      if (message.includes("thinking") && message.includes("disabled")) {
        // No off switch means omit thinking; the model then decides adaptively.
        disabledThinkingFallbacks.set(body.model, message.includes("between_tools") ? { type: "between_tools" } : undefined);
        ({ payload, upstream } = await send());
      }
    }
    const headers = {};
    for (const [name, value] of upstream.headers) {
      if (["content-type", "cache-control", "retry-after", "x-should-retry"].includes(name) || name.startsWith("anthropic-ratelimit-")) headers[name] = value;
    }
    if (upstream.headers.get("content-type")?.includes("text/event-stream")) headers["X-Accel-Buffering"] = "no";
    clientRes.writeHead(upstream.status, headers);
    // Preserve native blocks and errors; only gateway-owned memory calls become text.
    // Cache accounting observes the original bytes before response filtering.
    const isStream = upstream.headers.get("content-type")?.includes("text/event-stream");
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body),
      createClaudeCacheObserver(payload, isStream, onCacheUsage),
      ...(upstream.ok && responseHandler ? [createProjectMemoryResponseTransform(responseHandler, isStream)] : []),
      clientRes, { signal: controller.signal });
    else clientRes.end();
  } finally {
    clearTimeout(timeout);
    clientRes.off("close", abort);
    controller.abort();
  }
}

async function listCopilotResponsesModels(options) {
  if (!responsesModels.length) await discoverCopilotModels(options);
  return responsesModels;
}

// requestResponses 的 copilot 认证：同一登录与请求头，去掉 Anthropic 专用头；搜索始终流式，由工具发起，按 agent 计。
async function loadCopilotResponsesAuth({ loadAuth = loadCopilotAuth, ...options } = {}) {
  const auth = await loadAuth(options);
  const { "anthropic-version": _version, "anthropic-dangerous-direct-browser-access": _browser, Authorization: _authorization,
    "Content-Type": _type, ...headers } = getCopilotHeaders(auth);
  return { kind: "copilot", token: auth.token, baseUrl: auth.baseUrl, headers: { ...headers, Accept: "text/event-stream", "X-Initiator": "agent" } };
}

module.exports = { isClaudeModel, getCopilotHeaders, discoverCopilotModels, forwardClaudeRequest, listCopilotResponsesModels, loadCopilotResponsesAuth };

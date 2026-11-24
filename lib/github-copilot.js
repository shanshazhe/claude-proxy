const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { loadCopilotAuth, COPILOT_HEADERS } = require("./copilot-auth");
const { prepareClaudeCache } = require("./anthropic-cache");
const { maximumContextWindow } = require("./model-routing");
const { isReplayCarrier } = require("./responses-replay");

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
  const { loadPiModels } = require("./pi-registry");
  const registry = await loadPiModels();
  const claudeModels = available.filter((model) => Array.isArray(model.supported_endpoints)
    ? model.supported_endpoints.includes("/v1/messages")
    : registry.getModel("github-copilot", model.id)?.api === "anthropic-messages");
  for (const model of claudeModels) adaptiveModels.set(model.id, model.capabilities?.supports?.adaptive_thinking === true);
  responsesModels = available.filter((model) => Array.isArray(model.supported_endpoints) && model.supported_endpoints.includes("/responses")).map((model) => model.id);
  return claudeModels.map((model) => {
    const context = registry.getModel("github-copilot", model.id)?.contextWindow;
    return { ...model, ...(!maximumContextWindow(model) && context ? { context_window: context } : {}),
      object: "model", owned_by: "github-copilot", api: "anthropic-messages" };
  });
}

function prepareClaudePayload(body) {
  const thinking = getUpstreamThinking(body);
  return prepareClaudeCache({ ...body, thinking, messages: body.messages?.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
    // The GPT bridge emits an empty signature for display-only reasoning, and a
    // gateway carrier for Codex replay. Neither is signed Claude history; leave
    // genuine and redacted Claude blocks intact.
    const content = message.content.filter((block) => block.type !== "thinking" ||
      (block.signature !== "" && !isReplayCarrier(block.signature)));
    return content.length ? [{ ...message, content }] : [];
  }) });
}
function learnDisabledThinkingFallback(payload, status, message) {
  if (status !== 400 || payload.thinking?.type !== "disabled" || !/thinking/i.test(message) || !/disabled/i.test(message)) return false;
  disabledThinkingFallbacks.set(payload.model, message.includes("between_tools") ? { type: "between_tools" } : undefined);
  return true;
}
function claudeResponseHeaders(headers) {
  return Object.fromEntries([...headers].filter(([name]) =>
    ["content-type", "cache-control", "retry-after", "x-should-retry"].includes(name) || name.startsWith("anthropic-ratelimit-")));
}

// Count tokens is a native read-only operation, not a Pi generation request.
async function forwardClaudeCount(body, request, clientRes, { fetchImpl = fetch, loadAuth = loadCopilotAuth } = {}) {
  const controller = new AbortController();
  const abort = () => { if (!clientRes.writableFinished) controller.abort(); };
  clientRes.on("close", abort);
  const timeout = setTimeout(() => controller.abort(new Error("Copilot Claude request timed out")), 3600000);
  try {
    const auth = await loadAuth({ fetchImpl, signal: controller.signal });
    const send = (payload) => fetchImpl(auth.baseUrl + request.url, {
      method: "POST", headers: getCopilotHeaders(auth, request.headers, payload), body: JSON.stringify(payload),
      signal: controller.signal, redirect: "error"
    });
    const payload = prepareClaudePayload(body);
    let upstream = await send(payload);
    if (payload.thinking?.type === "disabled" && upstream.status === 400 &&
      learnDisabledThinkingFallback(payload, upstream.status, await upstream.clone().text())) {
      await upstream.body?.cancel();
      upstream = await send(prepareClaudePayload(body));
    }
    clientRes.writeHead(upstream.status, claudeResponseHeaders(upstream.headers));
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), clientRes, { signal: controller.signal });
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

// Pi GPT 搜索的 copilot 认证：同一登录与请求头，去掉 Anthropic 专用头；搜索始终流式，由工具发起，按 agent 计。
async function loadCopilotResponsesAuth({ loadAuth = loadCopilotAuth, ...options } = {}) {
  const auth = await loadAuth(options);
  const { "anthropic-version": _version, "anthropic-dangerous-direct-browser-access": _browser, Authorization: _authorization,
    "Content-Type": _type, ...headers } = getCopilotHeaders(auth);
  return { kind: "copilot", token: auth.token, baseUrl: auth.baseUrl, headers: { ...headers, Accept: "text/event-stream", "X-Initiator": "agent" } };
}

module.exports = { getCopilotHeaders, discoverCopilotModels, forwardClaudeCount, prepareClaudePayload,
  learnDisabledThinkingFallback, claudeResponseHeaders, listCopilotResponsesModels, loadCopilotResponsesAuth };

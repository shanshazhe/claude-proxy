"use strict";

const { toPiContext, toAnthropicMessage, restoreImageUrls } = require("./anthropic-pi");
const { loadPiModels, piModel } = require("./pi-registry");
const { piStreamError } = require("./upstream-error");
const { createRequestController, streamPi } = require("./pi-stream");
const { MODEL_TIMEOUT_MS } = require("./pi-options");
const { readNvidiaApiKey, NVIDIA_BASE_URL } = require("./pi-auth");
const { paceNvidiaRequest } = require("./nvidia-pacing");

// These hosted chat endpoints are listed without capability metadata and are not yet in Pi's catalog.
const legacyChatInputs = new Map([
  ["mistralai/mistral-large-4-1t-a52b", ["text"]],
  ["nvidia/nemotron-3.5-bolt-e4b", ["text"]],
  ["nvidia/riva-translate-4b-instruct-v2", ["text"]],
  ["nvidia/ising-calibration-1.5-31b", ["text", "image"]]
]);

function nvidiaChatModel(row, registry) {
  if (typeof row?.id !== "string" || !row.id) return undefined;
  const known = registry.getModel("nvidia", row.id);
  const type = row.model_type?.toLowerCase?.();
  if (Array.isArray(row.supported_endpoints)) {
    if (!row.supported_endpoints.some((endpoint) => endpoint === "/chat/completions" || endpoint === "/v1/chat/completions")) return undefined;
  } else if (type ? !["llm", "vlm", "chat"].includes(type)
    : known?.api !== "openai-completions" && !legacyChatInputs.has(row.id)) return undefined;
  return {
    id: row.id, object: "model", created: row.created || 0, owned_by: "nvidia", api: "openai-completions",
    context_window: row.context_window ?? known?.contextWindow,
    max_output_tokens: row.max_output_tokens ?? known?.maxTokens,
    input: known?.input || legacyChatInputs.get(row.id) || (type === "vlm" ? ["text", "image"] : ["text"]),
    supports_tools: row.supports_tools,
    reasoning: row.supports_thinking ?? known?.reasoning ?? false
  };
}

async function requestNvidia(body, { route, store, env, apiKey = readNvidiaApiKey({ store, env, rotate: true }), fetchImpl = fetch,
  pace = paceNvidiaRequest, control, onEvent = async () => {} } = {}) {
  apiKey = apiKey?.trim();
  if (!apiKey) throw Object.assign(new Error("NVIDIA Build is not configured. Add an API key on the local login page."), { status: 401 });
  const controller = createRequestController(control);
  const signal = controller.signal;
  let httpStatus;
  try {
    const registry = await loadPiModels();
    signal.throwIfAborted();
    const supportsTools = route.supports_tools !== false;
    const { context, images } = toPiContext(supportsTools ? body : { ...body, tools: [] });
    if (!supportsTools) {
      context.messages = context.messages.map((message) => {
        if (message.role === "assistant") {
          return { ...message, content: message.content.map((block) => block.type === "toolCall"
            ? { type: "text", text: `[Tool call: ${block.name}] ${JSON.stringify(block.arguments)}` } : block) };
        }
        if (message.role === "toolResult") {
          return { role: "user", timestamp: message.timestamp, content: [
            { type: "text", text: `[Tool ${message.isError ? "error" : "result"}: ${message.toolName}]` }, ...message.content
          ] };
        }
        return message;
      });
    }
    const model = piModel(registry, route, { provider: "nvidia", api: "openai-completions", baseUrl: NVIDIA_BASE_URL,
      ...(route.input ? { input: route.input } : {}), ...(route.reasoning !== undefined ? { reasoning: route.reasoning } : {}) });
    const result = await streamPi(registry, model, context, {
      signal, label: "NVIDIA", toError: (message) => piStreamError(message, httpStatus), deliver: onEvent,
      apiKey, maxRetries: 0, timeoutMs: MODEL_TIMEOUT_MS, cacheRetention: "none", maxTokens: Math.min(body.max_tokens || 4096, model.maxTokens),
      ...(context.tools.length && body.tool_choice?.type === "none" ? { toolChoice: "none" } : {}),
      onPayload(payload) { restoreImageUrls(payload.messages, images); return payload; },
      async fetch(url, options) {
        await pace(signal);
        signal.throwIfAborted();
        const response = await fetchImpl(url, { ...options, redirect: "error" });
        if (!response.ok) httpStatus = response.status;
        return response;
      }
    });
    return toAnthropicMessage(result, body.model);
  } finally {
    controller.abort();
  }
}

module.exports = { nvidiaChatModel, requestNvidia };

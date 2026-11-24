const http = require("http");
const { countTokens, getModelCapabilities } = require("../lib/pi-capabilities");
const { resolveGatewayModel } = require("../lib/pi-registry");
const { isReplayCarrier } = require("../lib/responses-replay");
const fs = require("fs");
const path = require("path");

const { requestPiModel } = require("../lib/pi-model");
const { selectModel, toGatewayModelId, toGatewayModels } = require("../lib/model-routing");
const { createModelDiscovery } = require("../lib/model-discovery");
const { parseWebSearchRequest, runWebSearch, toAnthropicMessage, toAnthropicEvents } = require("../lib/web-search");
const { createOnlineSummary, createSummarySettings } = require("../lib/online-summary");
const { createSummaryModel, DEFAULT_PROMPT: DEFAULT_SUMMARY_PROMPT } = require("../lib/summary-model");
const { defaultStore: credentialStore } = require("../lib/credential-store");
const { createAuthRouter } = require("../lib/auth-server");
const { createClaudeSetup, getClaudeConfigRoot } = require("../lib/claude-setup");
const { createMacosService } = require("../lib/macos-service");
const { createProjectMemoryInstaller } = require("../lib/project-memory-install");
const { createClaudeLauncherInstaller } = require("../lib/claude-launcher-install");
const { createCodingDisciplineInstaller } = require("../lib/coding-discipline-install");
const { createProjectMemoryGateway } = require("../lib/project-memory-gateway");
const { createProjectMemoryMaintainer } = require("../lib/project-memory-maintainer");

const PORT = 8082;
const getAvailableModels = createModelDiscovery({
  onWarning: (provider, message) => console.warn(`Model catalog fallback (${provider}): ${message}`)
});
const getGptModels = createModelDiscovery({
  gptOnly: true,
  onWarning: (provider, message) => console.warn(`Startup model catalog fallback (${provider}): ${message}`)
});
const summaryModel = createSummaryModel({
  getAvailableModels,
  // 页面选择的模型每次请求重新读取，修改无需重启代理。
  getPreferredModel: () => onlineSummary.getStatus().summaryModel,
  getPrompt: () => onlineSummary.getStatus().summaryPrompt,
  onEvent: (details) => logEvent("online-summary", "Tool output summarized", details),
  onWarning: (details) => logWarn("online-summary", "Summary model failed", details)
});
const onlineSummary = createOnlineSummary({
  summarize: summaryModel.summarize,
  onWarning: (details) => logWarn("online-summary", "Online summary archive warning", details),
  onEvent: (details) => logEvent("online-summary", "Online summary configuration", details)
});
const projectMemoryGateway = createProjectMemoryGateway();
const projectMemoryMaintainer = createProjectMemoryMaintainer({
  complete: summaryModel.complete,
  onEvent: (details) => logEvent("project-memory", "Project memory updated", details),
  onWarning: (details) => logWarn("project-memory", "Project memory update failed", details)
});

let requestCounter = 0;

// Increase default timeouts
const SERVER_TIMEOUT = 3600000; // 1 hour
const SSE_KEEPALIVE_MS = 10000;
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024; // reject request bodies larger than 32 MB
const ESTIMATED_BYTES_PER_TOKEN = 4;

function nextRequestId() {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function formatLogDetails(details) {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
}

function formatLogValue(value) {
  const text = String(value).replace(/\s+/g, " ");
  return text.length > 300 ? text.slice(0, 300) + "..." : text;
}

function logEvent(requestId, message, details = {}) {
  const detailText = formatLogDetails(details);
  console.log(`[${new Date().toISOString()}] [${requestId}] ${message}${detailText ? " " + detailText : ""}`);
}

function logWarn(requestId, message, details = {}) {
  const detailText = formatLogDetails(details);
  console.warn(`[${new Date().toISOString()}] [${requestId}] WARN ${message}${detailText ? " " + detailText : ""}`);
}

function logError(requestId, message, details = {}) {
  const detailText = formatLogDetails(details);
  console.error(`[${new Date().toISOString()}] [${requestId}] ERROR ${message}${detailText ? " " + detailText : ""}`);
}

function getClaudeSettingsPath() {
  return path.join(getClaudeConfigRoot(), "settings.json");
}

function syncClaudeSettings() {
  // Legacy import boundary stays inert; GPT-only sync runs after listening succeeds.
}

function getSettingsPaths() { return [getClaudeSettingsPath()]; }

function readJsonFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(content);
}

// Cache parsed settings per path, keyed by mtime, so the request hot path
// re-reads from disk only when settings.json actually changes.
const settingsCache = new Map();

function readSettingsCached(filePath) {
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const cached = settingsCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.settings;
  }
  const settings = readJsonFile(filePath);
  settingsCache.set(filePath, { mtimeMs, settings });
  return settings;
}

function getConfiguredModel(fallbackModel) {
  for (const settingsPath of getSettingsPaths()) {
    try {
      if (!fs.existsSync(settingsPath)) {
        continue;
      }
      const settings = readSettingsCached(settingsPath);
      const env = settings.env || {};
      const model = typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL.trim() : "";
      if (model) {
        return selectModel(model, model);
      }
    } catch (e) {
      console.warn(`Failed to read model from ${settingsPath}: ${e.message}`);
    }
  }
  return fallbackModel;
}

function getErrorType(status) {
  if (status === 429) return "rate_limit_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 400) return "invalid_request_error";
  return "api_error";
}

function sendJsonError(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type: getErrorType(status), message: message }
    })
  );
}

function sendUpstreamError(res, error) {
  const status = error.status || 502;
  res.writeHead(status, { ...error.responseHeaders, "Content-Type": "application/json" });
  res.end(JSON.stringify(error.body || {
    type: "error", error: { type: getErrorType(status), message: error.message }
  }));
}

function sendStreamError(res, status, message) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.shouldKeepAlive = false;
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "close"
    });
  }
  if (!res.destroyed && !res.writableEnded) {
    res.write(
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: getErrorType(status), message: message }
      })}\n\n`
    );
    res.end();
  }
}

function writeWithBackpressure(res, payload) {
  return new Promise((resolve, reject) => {
    if (res.destroyed || res.writableEnded) {
      resolve(false);
      return;
    }
    let settled = false;

    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
    };

    const finish = (err, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };

    const onDrain = () => finish(null, true);
    const onError = (err) => finish(err);
    const onClose = () => finish(new Error("Client SSE closed during write"));

    res.once("error", onError);
    res.once("close", onClose);

    const canContinue = res.write(payload);
    if (canContinue) {
      finish(null, true);
    } else {
      res.once("drain", onDrain);
    }
  });
}

function endWithBackpressure(res) {
  return new Promise((resolve, reject) => {
    if (res.destroyed || res.writableEnded) {
      resolve(false);
      return;
    }
    let settled = false;

    const cleanup = () => {
      res.off("error", onError);
      res.off("finish", onFinish);
      res.off("close", onClose);
    };

    const finish = (err, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };

    const onError = (err) => finish(err);
    const onFinish = () => finish(null, true);
    const onClose = () => finish(new Error("Client SSE closed before finish"));

    res.once("error", onError);
    res.once("finish", onFinish);
    res.once("close", onClose);
    res.end();
  });
}

async function writeSseEvent(res, eventName, data) {
  return writeWithBackpressure(res, `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

// 项目记忆调用的后续请求由代理直接结束这一轮；用量按请求体字节估算，避免客户端的上下文统计归零。
async function sendLocalMessage(res, body, text, requestBytes, requestId) {
  const model = selectModel(body.model, getConfiguredModel(body.model))?.replace(/\[1m\]$/i, "");
  const usage = {
    input_tokens: Math.ceil(requestBytes / ESTIMATED_BYTES_PER_TOKEN),
    output_tokens: Math.ceil(Buffer.byteLength(text) / ESTIMATED_BYTES_PER_TOKEN)
  };
  if (!body.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "msg_" + Date.now(), type: "message", role: "assistant", model: toGatewayModelId(model),
      content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }));
    return;
  }
  if (!(await openAnthropicStream(res, model, requestId))) return;
  await writeSseEvent(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  await writeSseEvent(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  await writeSseEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  await writeSseEvent(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage });
  await writeSseEvent(res, "message_stop", { type: "message_stop" });
  await endWithBackpressure(res);
}

function startSseKeepAlive(res, requestId) {
  let writing = false;
  const timer = setInterval(() => {
    if (writing || res.destroyed || res.writableEnded) {
      return;
    }
    writing = true;
    writeWithBackpressure(res, `: keepalive\n\n`)
      .catch((e) => {
        logWarn(requestId, "Anthropic SSE keepalive failed", { message: e.message });
        clearInterval(timer);
      })
      .finally(() => {
        writing = false;
      });
  }, SSE_KEEPALIVE_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return () => clearInterval(timer);
}

async function openAnthropicStream(clientRes, model, requestId, initialMessage = {}, headers = {}) {
  if (clientRes.destroyed || clientRes.writableEnded) {
    return false;
  }
  clientRes.writeHead(200, {
    ...headers,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "close"
  });
  if (typeof clientRes.flushHeaders === "function") {
    clientRes.flushHeaders();
  }
  await writeSseEvent(clientRes, "message_start", {
    type: "message_start",
    message: {
      id: "msg_" + Date.now(),
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      ...initialMessage,
      model: toGatewayModelId(model)
    }
  });
  await writeWithBackpressure(clientRes, `: waiting for upstream response\n\n`);
  logEvent(requestId, "Anthropic SSE opened", { model: model });
  return true;
}

// Both providers use Pi content events; only native Claude identity permits
// signed/redacted thinking and the narrow opaque-block/citation extensions.
function createAnthropicStreamHandler(clientRes, responseHandler = null) {
  const writeEvent = async (name, data) => {
    if (!responseHandler) return writeSseEvent(clientRes, name, data);
    for (const event of responseHandler.event(data)) await writeSseEvent(clientRes, event.type, event);
  };
  let index = 0;
  let blockKind = null;
  let contentIndex = null;
  let thinkingIsNative = false;
  let finished = false;
  const blockIndices = new Map();

  const stopBlock = async () => {
    if (blockKind === null) return;
    if (blockKind === "thinking" && !thinkingIsNative) {
      // Empty marks synthetic GPT thinking without exposing provider signatures.
      await writeEvent("content_block_delta", { type: "content_block_delta", index,
        delta: { type: "signature_delta", signature: "" } });
    }
    await writeEvent("content_block_stop", { type: "content_block_stop", index });
    blockKind = null;
    contentIndex = null;
    index++;
  };
  const openBlock = async (kind, piIndex, block, native = false) => {
    await stopBlock();
    await writeEvent("content_block_start", { type: "content_block_start", index, content_block: block });
    blockKind = kind;
    contentIndex = piIndex;
    thinkingIsNative = native;
    blockIndices.set(piIndex, index);
  };
  const applyPiEvent = async (event) => {
    const native = event.partial?.api === "anthropic-messages" && event.partial?.provider === "github-copilot";
    const block = event.partial?.content?.[event.contentIndex];
    const kind = event.type.startsWith("thinking_") ? "thinking" : "text";
    if (event.type === "native_block_start") {
      await openBlock(event.block.type, event.contentIndex, event.block);
    } else if (event.type === "native_block_delta") {
      const wireIndex = blockIndices.get(event.contentIndex);
      if (wireIndex === undefined) throw new Error("Native delta has no corresponding content block");
      await writeEvent("content_block_delta", { type: "content_block_delta", index: wireIndex, delta: event.delta });
    } else if (event.type === "native_block_stop") {
      if (contentIndex === event.contentIndex) await stopBlock();
    } else if (kind === "thinking" && block?.redacted) {
      if (!native) return;
      if (event.type === "thinking_start") {
        await openBlock("redacted_thinking", event.contentIndex, { type: "redacted_thinking", data: block.thinkingSignature });
      } else if (event.type === "thinking_end" && contentIndex === event.contentIndex) await stopBlock();
    } else if (event.type === "text_start") {
      await openBlock("text", event.contentIndex, { type: "text", text: "" });
    } else if (event.type === "thinking_start" && native) {
      await openBlock("thinking", event.contentIndex, { type: "thinking", thinking: "" }, true);
    } else if (["text_delta", "thinking_delta"].includes(event.type)) {
      // GPT encrypted-only reasoning never creates a visible block or signature.
      if (!event.delta) return;
      if (blockKind !== kind || contentIndex !== event.contentIndex) {
        await openBlock(kind, event.contentIndex, kind === "thinking"
          ? { type: "thinking", thinking: "" } : { type: "text", text: "" }, native);
      }
      await writeEvent("content_block_delta", { type: "content_block_delta", index,
        delta: kind === "thinking" ? { type: "thinking_delta", thinking: event.delta } : { type: "text_delta", text: event.delta } });
    } else if (["text_end", "thinking_end"].includes(event.type)) {
      if (event.type === "thinking_end" && native && block?.thinkingSignature !== undefined) {
        if (contentIndex !== event.contentIndex) await openBlock("thinking", event.contentIndex, { type: "thinking", thinking: "" }, true);
        await writeEvent("content_block_delta", { type: "content_block_delta", index,
          delta: { type: "signature_delta", signature: block.thinkingSignature } });
      }
      if (contentIndex === event.contentIndex) await stopBlock();
    } else if (event.type === "toolcall_end") {
      // Wait for complete parsed arguments: parallel/interleaved partial calls
      // must never create overlapping blocks or invalid input_json_delta JSON.
      const call = event.toolCall;
      await openBlock("tool_use", event.contentIndex,
        { type: "tool_use", id: native ? call.id : call.id.split("|")[0], name: call.name, input: {} });
      await writeEvent("content_block_delta", { type: "content_block_delta", index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) } });
      await stopBlock();
    }
  };
  const finish = async (message) => {
    if (finished) return;
    finished = true;
    const carrier = message.content?.at(-1);
    if (carrier?.type === "thinking" && isReplayCarrier(carrier.signature)) {
      // Native mode: carry this exact signature instead of the synthetic empty one.
      await openBlock("thinking", null, { type: "thinking", thinking: "" }, true);
      await writeEvent("content_block_delta", { type: "content_block_delta", index,
        delta: { type: "signature_delta", signature: carrier.signature } });
    }
    await stopBlock();
    const delta = { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence ?? null };
    if (message.stop_details !== undefined) delta.stop_details = message.stop_details;
    await writeEvent("message_delta", { type: "message_delta", delta, usage: message.usage });
    await writeEvent("message_stop", { type: "message_stop" });
    await endWithBackpressure(clientRes);
  };
  return { applyPiEvent, finish };
}

function requestPiStream(anthropicBody, model, requestId, clientRes, upstreamControl, responseHandler = null, requestOptions = {}) {
  logEvent(requestId, "Pi stream started", { model });
  const handler = createAnthropicStreamHandler(clientRes, responseHandler);
  return requestPiModel(anthropicBody, {
    ...requestOptions, onEvent: handler.applyPiEvent, control: upstreamControl,
    onCacheUsage: (usage) => logEvent(requestId, "Prompt cache usage", usage)
  }).then(async (message) => {
    await handler.finish(message);
    return message;
  });
}

function streamToClient(anthropicBody, model, requestId, clientRes, responseHandler = null, requestOptions = {}) {
  const upstreamControl = {};
  let completed = false;
  let clientClosed = false;
  let streamOpened = false;
  let stopKeepAlive = () => {};

  clientRes.on("close", () => {
    // "close" also follows our own end() of a finished stream, before the upstream
    // promise settles; only a close before the response finished is a disconnect.
    if (completed || clientRes.writableFinished) {
      return;
    }
    clientClosed = true;
    stopKeepAlive();
    logWarn(requestId, "client SSE closed; aborting upstream request", { model: model });
    if (upstreamControl.abort) {
      upstreamControl.abort("Client SSE closed before upstream response", 499);
    }
  });

  const open = async (initialMessage, headers) => {
    streamOpened = await openAnthropicStream(clientRes, model, requestId, initialMessage, headers);
    if (streamOpened && !clientClosed && !clientRes.destroyed && !clientRes.writableEnded) {
      stopKeepAlive = startSseKeepAlive(clientRes, requestId);
    }
    return streamOpened;
  };
  return Promise.resolve()
    .then(async () => {
      const nativeStart = requestOptions.route?.api === "anthropic-messages";
      if (!nativeStart && !(await open())) return null;
      if (clientClosed || clientRes.destroyed || clientRes.writableEnded) return null;
      return requestPiStream(anthropicBody, model, requestId, clientRes, upstreamControl, responseHandler,
        { ...requestOptions, onResponse: nativeStart ? open : undefined });
    })
    .then((result) => {
      completed = true;
      stopKeepAlive();
      if (!result || clientClosed || clientRes.destroyed || clientRes.writableEnded) {
        return;
      }
      logEvent(requestId, "Upstream SSE stream completed", { model: model, streamed: true });
    })
    .catch((err) => {
      if (clientClosed || clientRes.destroyed || clientRes.writableEnded) {
        return;
      }
      completed = true;
      stopKeepAlive();
      logError(requestId, "Upstream SSE stream failed", {
        status: err.status || 502,
        message: err.message,
        mode: "stream"
      });
      if (streamOpened && clientRes.headersSent) {
        writeSseEvent(clientRes, "error", err.body || {
          type: "error",
          error: { type: getErrorType(err.status || 502), message: err.message }
        })
          .then(() => endWithBackpressure(clientRes))
          .catch(() => {});
      } else {
        sendUpstreamError(clientRes, err);
      }
    });
}

// Claude Code 内置 WebSearch 的独立请求：执行上游原生搜索，按客户端要求以 JSON 或 SSE 返回搜索块。
// 不支持的选项在请求上游前拒绝；SSE 先打开并保持 keepalive，客户端断开时取消上游。
async function answerWebSearch(anthropicBody, search, model, requestId, res, capabilities) {
  if (search.error) {
    logWarn(requestId, "Web search request rejected", { model });
    sendJsonError(res, 400, search.error);
    return;
  }
  if (!capabilities.search) {
    sendJsonError(res, 400, `Built-in web search is not supported for model ${model || "(missing)"}`);
    return;
  }
  const control = {};
  let stopKeepAlive = () => {};
  let finished = false;
  const onClose = () => {
    if (!finished && !res.writableFinished) control.abort?.("Client closed before web search finished", 499);
  };
  res.on("close", onClose);
  try {
    if (anthropicBody.stream) {
      if (!(await openAnthropicStream(res, model, requestId))) return;
      stopKeepAlive = startSseKeepAlive(res, requestId);
    }
    const result = await runWebSearch(anthropicBody, search, { capabilities, control,
      onCacheUsage: (usage) => logEvent(requestId, "OpenAI prompt cache usage", usage) });
    stopKeepAlive();
    logEvent(requestId, "Web search completed", { model: result.model, auth_kind: result.authKind, searches: result.searches, results: result.hits, capped: result.capped });
    const message = toAnthropicMessage(result, toGatewayModelId(model));
    if (!anthropicBody.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(message));
      return;
    }
    for (const [name, data] of toAnthropicEvents(message)) await writeSseEvent(res, name, data);
    await endWithBackpressure(res);
  } catch (error) {
    stopKeepAlive();
    if (res.destroyed || res.writableEnded) return;
    logError(requestId, "Web search failed", { status: error.status || 502, message: error.message });
    if (!res.headersSent) sendJsonError(res, error.status || 502, error.message);
    else await writeSseEvent(res, "error", { type: "error", error: { type: getErrorType(error.status || 502), message: error.message } })
      .then(() => endWithBackpressure(res)).catch(() => {});
  } finally {
    finished = true;
    stopKeepAlive();
    res.off("close", onClose);
  }
}

const macosService = createMacosService({ proxyPath: __filename, port: PORT, onHandoff: shutdownProxy });
const projectMemoryInstaller = createProjectMemoryInstaller({ configRoot: getClaudeConfigRoot() });
const claudeLauncherInstaller = createClaudeLauncherInstaller({ store: credentialStore });
const claudeSetup = createClaudeSetup({ store: credentialStore, getAvailableModels, getGptModels, launcherInstaller: claudeLauncherInstaller });
const authRouter = createAuthRouter({
  port: PORT,
  macosService,
  projectMemory: projectMemoryInstaller,
  codingDiscipline: createCodingDisciplineInstaller({ configRoot: getClaudeConfigRoot() }),
  store: credentialStore,
  setup: claudeSetup,
  summarySettings: createSummarySettings({ getDefaultModel: summaryModel.getDefaultModel, listModels: summaryModel.listModels,
    defaultPrompt: DEFAULT_SUMMARY_PROMPT }),
  onCredentialsChanged: (provider) => {
    getAvailableModels.invalidate();
    getGptModels.invalidate();
    if (!["openai", "openai-codex"].includes(provider)) return;
    return claudeSetup.syncGptContextCapacity().then((result) => {
      if (result.success) logEvent("claude-setup", "GPT context capacity saved", { tokens: result.tokens });
    }).catch(() => logWarn("claude-setup", "GPT context capacity sync failed; existing settings were kept. Retry by logging in again."));
  }
});

const server = http.createServer(async (req, res) => {
  // 登录入口在通配 CORS 和请求日志之前处理，不记录认证 URL 或数据。
  if (await authRouter(req, res)) return;
  const requestId = nextRequestId();

  // Handle CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.url === "/features" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(onlineSummary.getStatus()));
    return;
  }

  // Handle /v1/models; startup capacity queries never initiate other providers.
  const requestUrl = new URL(req.url, "http://localhost");
  if (requestUrl.pathname === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const waitForRefresh = requestUrl.searchParams.get("wait_for_refresh") === "true";
    const discoverModels = requestUrl.searchParams.get("provider") === "gpt" ? getGptModels : getAvailableModels;
    res.end(JSON.stringify(toGatewayModels(await discoverModels({ waitForRefresh }))));
    return;
  }

  // Handle /v1/messages (Anthropic format) - match with or without query params
  if (req.url.startsWith("/v1/messages") && req.method === "POST") {
    let body = "";
    let bodyBytes = 0;
    let bodyTooLarge = false;

    req.on("data", (chunk) => {
      if (bodyTooLarge) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
        bodyTooLarge = true;
        logWarn(requestId, "request body too large; rejected", { max_bytes: MAX_REQUEST_BODY_BYTES });
        sendJsonError(res, 413, `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on("end", async () => {
      if (bodyTooLarge) return;
      try {
        const readOnly = new URL(req.url, "http://localhost").pathname !== "/v1/messages";
        const prepared = await onlineSummary.prepare(JSON.parse(body), { readOnly });
        if (prepared.stats.packed_results || prepared.stats.recalled_results) {
          logEvent(requestId, "Gateway online summary", prepared.stats);
        }
        // 摘要账本按客户端原始消息记录，项目记忆的注入与改写在其后进行。
        const memory = projectMemoryGateway.prepare(prepared.body, { enabled: onlineSummary.getStatus().projectMemory === true, readOnly });
        if (memory.triggers.length) logEvent(requestId, "Project memory update queued", { calls: memory.triggers.length });
        for (const input of memory.triggers) projectMemoryMaintainer.enqueue(input);
        const anthropicBody = memory.body;
        if (memory.reply) {
          logEvent(requestId, "Project memory call answered locally", { stream: Boolean(anthropicBody.stream) });
          await sendLocalMessage(res, anthropicBody, memory.reply, bodyBytes, requestId);
          return;
        }
        const responseHandler = !readOnly && onlineSummary.getStatus().projectMemory === true && anthropicBody.tools?.some((tool) => tool.name === "ProjectMemoryUpdate")
          ? projectMemoryGateway.createResponseHandler({ enqueue: (input) => {
            const accepted = projectMemoryMaintainer.enqueue(input).accepted === true;
            logEvent(requestId, accepted ? "Project memory update queued at response" : "Project memory update not queued");
            return accepted;
          } }) : null;
        const isStream = anthropicBody.stream || false;
        const requestedModel = anthropicBody.model;
        const configuredModel = selectModel(requestedModel, getConfiguredModel(requestedModel));
        const model = configuredModel?.replace(/\[1m\]$/i, "");
        anthropicBody.model = model;

        const operation = new URL(req.url, "http://localhost").pathname;
        if (readOnly && operation !== "/v1/messages/count_tokens") { sendJsonError(res, 404, "Unsupported messages operation"); return; }
        const route = await resolveGatewayModel(model, getAvailableModels);
        if (!route?.api) { sendJsonError(res, 400, `Unsupported model: ${model || "(missing)"}`); return; }
        const capabilities = getModelCapabilities(model, () => route);
        if (readOnly) {
          await countTokens(anthropicBody, req, res, capabilities);
          return;
        }
        const search = parseWebSearchRequest(anthropicBody);
        if (search) {
          await answerWebSearch(anthropicBody, search, model, requestId, res, capabilities);
          return;
        }
        const requestOptions = { route, clientHeaders: req.headers, url: req.url };
        if (isStream) {
          // Client wants streaming - bridge unified Pi events to Anthropic SSE.
          streamToClient(anthropicBody, model, requestId, res, responseHandler, requestOptions);
        } else {
          const control = {};
          let responseHeaders = {};
          const onClose = () => {
            if (!res.writableFinished) control.abort?.("Client closed before upstream response", 499);
          };
          res.on("close", onClose);
          try {
            const anthropicResp = await requestPiModel(anthropicBody, {
              ...requestOptions, control,
              onResponse: (_message, headers) => { responseHeaders = headers; },
              onCacheUsage: (usage) => logEvent(requestId, "Prompt cache usage", usage)
            });
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(200, { ...responseHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify(responseHandler ? responseHandler.message(anthropicResp) : anthropicResp));
          } finally {
            res.off("close", onClose);
          }
        }
      } catch (error) {
        if (!res.destroyed && !res.writableEnded) {
          if (!res.headersSent) sendUpstreamError(res, error);
          else sendStreamError(res, error.status || 502, error.message);
        }
      }
    });
    return;
  }

  // Fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", path: req.url }));
});

const proxySockets = new Set();
let shutdownStarted = false;
function shutdownProxy() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  authRouter.close();
  const deadline = setTimeout(() => {
    for (const socket of proxySockets) socket.destroy();
    process.exit(0);
  }, 10000);
  server.close(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
server.timeout = SERVER_TIMEOUT;
server.keepAliveTimeout = SERVER_TIMEOUT;
server.headersTimeout = SERVER_TIMEOUT + 1000;
syncClaudeSettings();
// 真实进程信号只在启动截断点之后注册，VM 导入测试不污染主进程。
server.on("connection", (socket) => {
  proxySockets.add(socket);
  socket.once("close", () => proxySockets.delete(socket));
});
server.on("error", () => {
  console.error("Proxy could not listen. Check the local port and start the proxy manually.");
  authRouter.close();
  process.exitCode = 1;
});
process.once("SIGTERM", shutdownProxy);
process.once("SIGINT", shutdownProxy);
credentialStore.migrate({ onWarning: (message) => console.warn(message) });
getAvailableModels().catch((error) => console.warn(`Model discovery failed: ${error.message}`));
// 启动时和之后每小时删除超过保留天数未使用的会话归档；页面修改天数后在下一次检查生效。
const cleanupObservationArchives = () => {
  const removed = onlineSummary.cleanup();
  if (removed) logEvent("online-summary", "Online summary archive cleanup", { removed_sessions: removed });
};
cleanupObservationArchives();
setInterval(cleanupObservationArchives, 60 * 60 * 1000).unref();
// 从未选择时尝试安装并启用，精确匹配的已知旧版先备份再升级；开关已开时只升级精确匹配的已知旧版；显式关闭或配置不安全时不自动安装。
projectMemoryInstaller.autoEnable().then((result) => {
  if (result) logEvent("project-memory", `Project Code Memory ${result.upgraded ? "upgraded" : "enabled"} automatically`, { installed: result.changed, previous_skill_backed_up: result.replaced });
}).catch(() => logEvent("project-memory", "Project Code Memory stays off", { reason: "not installable" }));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`claude-proxy running on http://127.0.0.1:${PORT}`);
  console.log(`本地登录页面：http://127.0.0.1:${PORT}/login`);
  console.log(`凭据存储目录：${credentialStore.directory}`);
  // 已登录 GPT 时异步探测并保存最大容量；未登录跳过，失败保留旧值，重启后重试。
  claudeSetup.syncGptContextCapacity().then((result) => {
    if (result.success) logEvent("claude-setup", "GPT context capacity saved", { tokens: result.tokens });
  }).catch(() => logWarn("claude-setup", "GPT context capacity sync failed; existing settings were kept. Retry on next proxy startup or login."));
  // 仅在监听成功后、不阻塞启动地检查 zsh 启动器；显式关闭、配置不安全或平台不支持时不安装。
  claudeLauncherInstaller.autoEnable().then((result) => {
    if (result?.ok === false) logWarn("claude-launcher", "Claude launcher automatic setup failed", { reason: result.reason });
    else if (result) logEvent("claude-launcher", "Claude launcher automatic setup", { changed: result.changed, enabled: result.enabled, state: result.state });
  }).catch((error) => logWarn("claude-launcher", "Claude launcher automatic setup failed", { reason: error && error.message }));
});

const http = require("http");
const { estimateInputTokens } = require("../lib/token-count");
const fs = require("fs");
const path = require("path");

const { isResponsesModel, getPromptCacheKey, getResponsesReasoning, requestResponses } = require("../lib/openai-responses");
const { selectModel, toGatewayModelId, toGatewayModels } = require("../lib/model-routing");
const { createModelDiscovery } = require("../lib/model-discovery");
const { isClaudeModel, forwardClaudeRequest } = require("../lib/github-copilot");
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
const IMAGE_UNCONVERTIBLE_TEXT = "[image omitted: invalid or unsupported image source]";

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

function convertAnthropicImageToOpenAI(block) {
  const source = block && block.source ? block.source : {};
  if (source.type === "base64" && typeof source.data === "string") {
    const mediaType = source.media_type || "image/png";
    return {
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${source.data}` }
    };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

// Convert Anthropic messages format to OpenAI format
function convertAnthropicToOpenAI(anthropicBody, requestId) {
  const messages = [];
  let droppedImages = 0;
  let forwardedImages = 0;

  // Add system message if present
  if (anthropicBody.system) {
    if (typeof anthropicBody.system === "string") {
      messages.push({ role: "system", content: anthropicBody.system });
    } else if (Array.isArray(anthropicBody.system)) {
      const text = anthropicBody.system.map((b) => b.text || "").join("\n");
      messages.push({ role: "system", content: text });
    }
  }

  // Convert messages
  for (const msg of anthropicBody.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      continue;
    }

    const parts = [];
    const contentParts = [];
    let hasOpenAIImagePart = false;
    const toolCalls = [];
    const toolResults = [];
    const toolResultImageParts = [];

    const addTextPart = (text) => {
      if (!text) {
        return;
      }
      parts.push(text);
      contentParts.push({ type: "text", text: text });
    };

    for (const block of msg.content) {
      if (block.type === "text") {
        addTextPart(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input)
          }
        });
      } else if (block.type === "tool_result") {
        let content = "";
        if (typeof block.content === "string") {
          content = block.content;
        } else if (Array.isArray(block.content)) {
          content = block.content
            .map((c) => {
              if (c && c.type === "image") {
                // OpenAI-compatible tool messages cannot contain image_url
                // parts. Preserve the tool result and attach its images in a
                // following user message, which the configured model can read.
                const imagePart = convertAnthropicImageToOpenAI(c);
                if (imagePart) {
                  toolResultImageParts.push(imagePart);
                  forwardedImages += 1;
                  return "";
                }
                droppedImages += 1;
                return IMAGE_UNCONVERTIBLE_TEXT;
              }
              return c.text || JSON.stringify(c);
            })
            .filter(Boolean)
            .join("\n");
        } else if (block.content) {
          content = JSON.stringify(block.content);
        }
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: content || "[Image result forwarded in the following user message.]"
        });
      } else if (block.type === "image") {
        const imagePart = convertAnthropicImageToOpenAI(block);
        if (imagePart) {
          contentParts.push(imagePart);
          hasOpenAIImagePart = true;
          forwardedImages += 1;
        } else {
          addTextPart(IMAGE_UNCONVERTIBLE_TEXT);
          droppedImages += 1;
        }
      }
    }

    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: parts.length > 0 ? parts.join("\n") : null,
        tool_calls: toolCalls
      });
    }
    // Tool outputs must directly follow the assistant's tool calls; text sent with
    // them (interruptions, follow-up prompts) comes after.
    for (const tr of toolResults) {
      messages.push(tr);
    }
    if (toolResultImageParts.length > 0) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Analyze the image result(s) from the preceding tool call(s) using the current conversation context."
          },
          ...toolResultImageParts
        ]
      });
    }
    if (toolCalls.length === 0) {
      if (hasOpenAIImagePart) {
        messages.push({ role: msg.role, content: contentParts });
      } else if (parts.length > 0) {
        messages.push({ role: msg.role, content: parts.join("\n") });
      }
    }
  }

  const openaiBody = {
    model: anthropicBody.model,
    messages: messages,
    max_tokens: anthropicBody.max_tokens || 4096,
    stream: true
  };

  if (anthropicBody.temperature !== undefined) {
    openaiBody.temperature = anthropicBody.temperature;
  }

  // Convert tools if present
  if (anthropicBody.tools && anthropicBody.tools.length > 0) {
    openaiBody.tools = anthropicBody.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || {}
      }
    }));
  }

  if (anthropicBody.stop_sequences) {
    openaiBody.stop = anthropicBody.stop_sequences;
  }

  if (droppedImages > 0 && requestId) {
    logWarn(requestId, "dropped image blocks; image source could not be converted", {
      images: droppedImages,
      model: anthropicBody.model
    });
  }
  if (forwardedImages > 0 && requestId) {
    logEvent(requestId, "forwarded image blocks to upstream", {
      images: forwardedImages,
      model: anthropicBody.model
    });
  }
  return openaiBody;
}

// Convert OpenAI response to Anthropic format
function convertOpenAIToAnthropic(openaiResp, model) {
  const content = [];
  if (openaiResp.reasoning_content) {
    content.push({ type: "thinking", thinking: openaiResp.reasoning_content, signature: "" });
  }
  if (openaiResp.content) {
    content.push({ type: "text", text: openaiResp.content });
  }
  if (openaiResp.tool_calls) {
    for (const tc of openaiResp.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (e) {
        args = {};
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: args });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  let stopReason = "end_turn";
  if (openaiResp.finish_reason === "tool_calls" || openaiResp.finish_reason === "function_call") {
    stopReason = "tool_use";
  } else if (openaiResp.finish_reason === "length") {
    stopReason = "max_tokens";
  } else if (openaiResp.finish_reason === "stop") {
    stopReason = "end_turn";
  }

  return {
    id: openaiResp.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: toGatewayModelId(model),
    content: content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage ? Math.max(0, openaiResp.usage.prompt_tokens - (openaiResp.usage.cached_tokens || 0)) : 0,
      output_tokens: openaiResp.usage ? openaiResp.usage.completion_tokens : 0,
      ...(openaiResp.usage?.cached_tokens !== undefined ? { cache_read_input_tokens: openaiResp.usage.cached_tokens } : {})
    }
  };
}

function mapOpenAIFinishReason(finishReason) {
  if (finishReason === "tool_calls" || finishReason === "function_call") {
    return "tool_use";
  }
  if (finishReason === "length") {
    return "max_tokens";
  }
  return "end_turn";
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

async function openAnthropicStream(clientRes, model, requestId) {
  if (clientRes.destroyed || clientRes.writableEnded) {
    return false;
  }
  clientRes.writeHead(200, {
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
      model: toGatewayModelId(model),
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  await writeWithBackpressure(clientRes, `: waiting for upstream response\n\n`);
  logEvent(requestId, "Anthropic SSE opened before upstream response", { model: model });
  return true;
}

// Return the length of `text` excluding any trailing substring that could be
// the start of `marker`, so a marker split across SSE chunks isn't emitted as
// literal text before it can be matched. E.g. text "ab</thi", marker
// "</think>" -> 2 (keep "</thi" buffered for the next fragment).
function lengthWithoutTrailingPartial(text, marker) {
  const maxOverlap = Math.min(text.length, marker.length - 1);
  for (let n = maxOverlap; n > 0; n -= 1) {
    if (text.slice(text.length - n) === marker.slice(0, n)) {
      return text.length - n;
    }
  }
  return text.length;
}

// Build a stateful Anthropic stream handler that converts incremental OpenAI SSE
// chunks into Anthropic SSE events, matching the Claude Code wire protocol.
// message_start is sent by openAnthropicStream before this handler runs, so this
// handler only emits content blocks plus the trailing message_delta/message_stop.
function createAnthropicStreamHandler(clientRes, model, requestId, requestBytes = 0, responseHandler = null) {
  const writeEvent = async (name, data) => {
    if (!responseHandler) return writeSseEvent(clientRes, name, data);
    for (const event of responseHandler.event(data)) await writeSseEvent(clientRes, event.type, event);
  };
  const THINK_OPEN = "<think>";
  const THINK_CLOSE = "</think>";
  // GPT reasoning arrives only as Responses summary events, so a literal
  // Keep provider-specific reasoning content separate from visible text.
  const splitThinkTags = !isResponsesModel(model);

  let index = 0;
  let sseChunks = 0;
  let blockKind = null; // "text" | "thinking" | "tool_use" | null
  let openToolOaiIndex = null; // OpenAI tool index of the currently open tool_use block
  const seenToolIndexes = new Set();
  let usage = null;
  let emittedBytes = 0;
  let finished = false;
  let lastFinishReason = null;
  // Inline chain-of-thought (<think>...</think>) splitting on the content stream.
  let insideThink = false;
  let tagBuffer = "";

  const stopBlock = async () => {
    if (blockKind === null) {
      return;
    }
    if (blockKind === "thinking") {
      // Anthropic thinking blocks carry a signature before they close. Upstream
      // models can't produce a real one; emit a placeholder (the proxy strips
      // thinking blocks before sending back upstream, so it's never validated).
      await writeEvent("content_block_delta", {
        type: "content_block_delta",
        index: index,
        delta: { type: "signature_delta", signature: "" }
      });
    }
    await writeEvent("content_block_stop", {
      type: "content_block_stop",
      index: index
    });
    blockKind = null;
    openToolOaiIndex = null;
    index += 1;
  };

  const openTextBlock = async () => {
    await stopBlock();
    await writeEvent("content_block_start", {
      type: "content_block_start",
      index: index,
      content_block: { type: "text", text: "" }
    });
    blockKind = "text";
  };

  const openThinkingBlock = async () => {
    await stopBlock();
    await writeEvent("content_block_start", {
      type: "content_block_start",
      index: index,
      content_block: { type: "thinking", thinking: "" }
    });
    blockKind = "thinking";
  };

  const openToolBlock = async (oaiIndex, id, name) => {
    await stopBlock();
    await writeEvent("content_block_start", {
      type: "content_block_start",
      index: index,
      content_block: { type: "tool_use", id: id || `tool_${index}`, name: name || "", input: {} }
    });
    blockKind = "tool_use";
    openToolOaiIndex = oaiIndex;
  };

  const emitAnswerText = async (text) => {
    if (!text) {
      return;
    }
    if (blockKind !== "text") {
      await openTextBlock();
    }
    await writeEvent("content_block_delta", {
      type: "content_block_delta",
      index: index,
      delta: { type: "text_delta", text: text }
    });
    sseChunks += 1;
    emittedBytes += Buffer.byteLength(text);
  };

  const emitReasoningText = async (text) => {
    if (!text) {
      return;
    }
    if (blockKind !== "thinking") {
      await openThinkingBlock();
    }
    await writeEvent("content_block_delta", {
      type: "content_block_delta",
      index: index,
      delta: { type: "thinking_delta", thinking: text }
    });
    sseChunks += 1;
    emittedBytes += Buffer.byteLength(text);
  };

  // Split a content fragment around <think>/</think>, routing text inside the
  // tags to the thinking block and the rest to the answer block. Tags may
  // straddle SSE chunks, so an incomplete trailing prefix is held in tagBuffer.
  const feedContent = async (fragment) => {
    tagBuffer += fragment;
    while (tagBuffer.length > 0) {
      const marker = insideThink ? THINK_CLOSE : THINK_OPEN;
      const idx = tagBuffer.indexOf(marker);
      if (idx !== -1) {
        const before = tagBuffer.slice(0, idx);
        if (insideThink) {
          await emitReasoningText(before);
        } else {
          await emitAnswerText(before);
        }
        tagBuffer = tagBuffer.slice(idx + marker.length);
        insideThink = !insideThink;
        continue;
      }
      const safeLen = lengthWithoutTrailingPartial(tagBuffer, marker);
      if (safeLen > 0) {
        const ready = tagBuffer.slice(0, safeLen);
        if (insideThink) {
          await emitReasoningText(ready);
        } else {
          await emitAnswerText(ready);
        }
        tagBuffer = tagBuffer.slice(safeLen);
      }
      break;
    }
  };

  const flushContentBuffer = async () => {
    if (tagBuffer.length > 0) {
      if (insideThink) {
        await emitReasoningText(tagBuffer);
      } else {
        await emitAnswerText(tagBuffer);
      }
      tagBuffer = "";
    }
  };

  const applyOpenAiChunk = async (chunk) => {
    const choice = (chunk && chunk.choices && chunk.choices[0]) || {};
    const delta = choice.delta || {};
    const finishReason = choice.finish_reason;
    if (chunk && chunk.usage) {
      usage = chunk.usage;
    }

    // Reasoning models stream chain-of-thought in a separate field; surface it
    // as a thinking block, kept distinct from the answer text.
    const reasoning = typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : (typeof delta.reasoning === "string" ? delta.reasoning : "");
    if (reasoning) {
      await emitReasoningText(reasoning);
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      await (splitThinkTags ? feedContent(delta.content) : emitAnswerText(delta.content));
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        // First chunk of a tool call carries index+id+name; continuation chunks
        // carry only argument fragments (often without index). Resolve the index
        // and only open a new block when it's genuinely a new tool call.
        const oaiIndex = typeof tc.index === "number"
          ? tc.index
          : (openToolOaiIndex !== null ? openToolOaiIndex : 0);
        if (blockKind !== "tool_use" || openToolOaiIndex !== oaiIndex || !seenToolIndexes.has(oaiIndex)) {
          seenToolIndexes.add(oaiIndex);
          await openToolBlock(oaiIndex, tc.id, tc.function && tc.function.name);
        }
        const args = tc.function && tc.function.arguments;
        if (typeof args === "string" && args) {
          await writeEvent("content_block_delta", {
            type: "content_block_delta",
            index: index,
            delta: { type: "input_json_delta", partial_json: args }
          });
          sseChunks += 1;
          emittedBytes += Buffer.byteLength(args);
        }
      }
    }

    // Defer trailing events until usage has arrived.
    if (finishReason) {
      lastFinishReason = finishReason;
    }
  };

  // Close any open block and emit the trailing message_delta/message_stop, then
  // end the client stream. Idempotent: called once after the upstream stream
  // ends (on [DONE] or socket end), by which point usage has been seen.
  const finish = async () => {
    if (finished) {
      return;
    }
    finished = true;
    await flushContentBuffer();
    await stopBlock();
    const reported = usage || { prompt_tokens: 0, completion_tokens: 0 };
    await writeEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapOpenAIFinishReason(lastFinishReason), stop_sequence: null },
      usage: {
        input_tokens: Math.max(0, (reported.prompt_tokens || 0) - (reported.cached_tokens || 0)),
        output_tokens: reported.completion_tokens || 0,
        ...(reported.cached_tokens !== undefined ? { cache_read_input_tokens: reported.cached_tokens } : {})
      }
    });
    await writeEvent("message_stop", { type: "message_stop" });
    await endWithBackpressure(clientRes);
  };

  return { applyOpenAiChunk, finish, sseChunks: () => sseChunks };
}

function requestResponsesStream(openaiBody, model, primaryModel, requestId, clientRes, upstreamControl, responseHandler = null) {
  logEvent(requestId, "OpenAI Responses stream started", { model });
  const handler = createAnthropicStreamHandler(clientRes, model, requestId, 0, responseHandler);
  return requestResponses(openaiBody, {
    onChunk: handler.applyOpenAiChunk, control: upstreamControl,
    onCacheUsage: (usage) => logEvent(requestId, "OpenAI prompt cache usage", usage)
  })
    .then(async (result) => {
      await handler.finish();
      return result;
    });
}

function streamToClient(openaiBody, model, primaryModel, requestId, clientRes, responseHandler = null) {
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

  openAnthropicStream(clientRes, model, requestId)
    .then((opened) => {
      streamOpened = opened;
      if (!opened || clientClosed || clientRes.destroyed || clientRes.writableEnded) {
        return null;
      }
      stopKeepAlive = startSseKeepAlive(clientRes, requestId);
      return requestResponsesStream(openaiBody, model, primaryModel, requestId, clientRes, upstreamControl, responseHandler);
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
        writeSseEvent(clientRes, "error", {
          type: "error",
          error: { type: getErrorType(err.status || 502), message: err.message }
        })
          .then(() => endWithBackpressure(clientRes))
          .catch(() => {});
      } else {
        sendStreamError(clientRes, err.status || 502, err.message);
      }
    });
}

// Claude Code 内置 WebSearch 的独立请求：执行上游原生搜索，按客户端要求以 JSON 或 SSE 返回搜索块。
// 不支持的选项在请求上游前拒绝；SSE 先打开并保持 keepalive，客户端断开时取消上游。
async function answerWebSearch(anthropicBody, search, model, requestId, res) {
  if (search.error) {
    logWarn(requestId, "Web search request rejected", { model });
    sendJsonError(res, 400, search.error);
    return;
  }
  const copilot = isClaudeModel(model);
  if (!copilot && !isResponsesModel(model)) {
    sendJsonError(res, 400, `Built-in web search is not supported for model ${model || "(missing)"}`);
    return;
  }
  const openaiBody = convertAnthropicToOpenAI({ ...anthropicBody, tools: [] }, requestId);
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
    const result = await runWebSearch(openaiBody, search, { copilot, control,
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
const claudeSetup = createClaudeSetup({ store: credentialStore, getAvailableModels });
const authRouter = createAuthRouter({
  port: PORT,
  macosService,
  projectMemory: projectMemoryInstaller,
  codingDiscipline: createCodingDisciplineInstaller({ configRoot: getClaudeConfigRoot() }),
  store: credentialStore,
  setup: claudeSetup,
  summarySettings: createSummarySettings({ getDefaultModel: summaryModel.getDefaultModel, listModels: summaryModel.listModels,
    defaultPrompt: DEFAULT_SUMMARY_PROMPT }),
  onCredentialsChanged: () => getAvailableModels.invalidate()
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

  // Handle /v1/models
  if (new URL(req.url, "http://localhost").pathname === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const waitForRefresh = new URL(req.url, "http://localhost").searchParams.get("wait_for_refresh") === "true";
    res.end(JSON.stringify(toGatewayModels(await getAvailableModels({ waitForRefresh }))));
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

        // count_tokens 等只读子路径保持原有转发，不执行真实搜索。
        const search = readOnly ? null : parseWebSearchRequest(anthropicBody);
        if (search) {
          await answerWebSearch(anthropicBody, search, model, requestId, res);
          return;
        }
        if (isClaudeModel(model)) {
          logEvent(requestId, "Copilot Claude request started", { model, stream: isStream });
          try {
            await forwardClaudeRequest(anthropicBody, req, res, {
              onCacheUsage: (usage) => logEvent(requestId, "Copilot Claude prompt cache usage", usage), responseHandler
            });
          } catch (error) {
            if (!res.destroyed && !res.writableEnded) {
              if (!res.headersSent) sendJsonError(res, error.status || 502, error.message);
              else sendStreamError(res, error.status || 502, error.message);
            }
          }
          return;
        }
        if (!isResponsesModel(model)) { sendJsonError(res, 400, `Unsupported model: ${model || "(missing)"}`); return; }

        if (new URL(req.url, "http://localhost").pathname === "/v1/messages/count_tokens") {
          // This is a read-only local estimate, never a Responses generation request.
          res.writeHead(200, { "Content-Type": "application/json", "X-Token-Count-Method": "conservative-utf8-estimate" });
          res.end(JSON.stringify({ input_tokens: estimateInputTokens(anthropicBody) }));
          return;
        }
        const openaiBody = convertAnthropicToOpenAI(anthropicBody, requestId);
        openaiBody.prompt_cache_key = getPromptCacheKey(anthropicBody);
        openaiBody.reasoning = getResponsesReasoning(anthropicBody);
        if (isStream) {
          // Client wants streaming - bridge OpenAI Responses events to Anthropic SSE.
          streamToClient(openaiBody, model, model, requestId, res, responseHandler);
        } else {
          // Client wants non-streaming; collect a complete Responses result.
          openaiBody.stream = false;
          const assembled = await requestResponses(openaiBody, {
            onCacheUsage: (usage) => logEvent(requestId, "OpenAI prompt cache usage", usage)
          });
          const anthropicResp = convertOpenAIToAnthropic(assembled, model);
          anthropicResp.id = assembled.id || anthropicResp.id;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseHandler ? responseHandler.message(anthropicResp) : anthropicResp));
        }
      } catch (error) {
        if (!res.destroyed && !res.writableEnded) {
          if (!res.headersSent) sendJsonError(res, error.status || 502, error.message);
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
  // 仅在监听成功后异步同步 GPT 子代理默认模型；失败保留原配置，不输出可能包含凭据的错误。
  claudeSetup.syncGptSubagentModel().catch(() => logWarn("claude-setup", "GPT subagent model sync failed; existing settings were kept. Retry on next proxy startup."));
  // 仅在监听成功后、不阻塞启动地检查 zsh 启动器；显式关闭、配置不安全或平台不支持时不安装。
  claudeLauncherInstaller.autoEnable().then((result) => {
    if (result?.ok === false) logWarn("claude-launcher", "Claude launcher automatic setup failed", { reason: result.reason });
    else if (result) logEvent("claude-launcher", "Claude launcher automatic setup", { changed: result.changed, enabled: result.enabled, state: result.state });
  }).catch((error) => logWarn("claude-launcher", "Claude launcher automatic setup failed", { reason: error && error.message }));
});

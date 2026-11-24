"use strict";

const { randomUUID } = require("node:crypto");
const { toGatewayModelId } = require("./model-routing");
const { isReplayCarrier } = require("./responses-replay");

const claudeNativeBlocks = new Set([
  "document", "search_result", "server_tool_use", "web_search_tool_result", "web_fetch_tool_result",
  "code_execution_tool_result", "bash_code_execution_tool_result", "text_editor_code_execution_tool_result",
  "tool_search_tool_result", "container_upload", "tool_addition", "tool_removal", "compaction",
  "mcp_tool_use", "mcp_tool_result"
]);

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const clientCallId = (id) => id.split("|")[0];
function unsupported(kind) {
  throw Object.assign(new Error(`Pi gateway does not support ${kind} in the conversation transcript`), { status: 400 });
}
const textOf = (value) => typeof value === "string" ? value : (value || []).map((part) => {
  if (part.type !== "text") unsupported(`system block ${part.type}`);
  return part.text || "";
}).join("\n");

// The client speaks Anthropic, but does not carry Pi's provider provenance or opaque signatures.
// Only the replay sidecar may restore an authentic Pi assistant message.
function toPiContext(body, restore = () => undefined, nativeBlocks = false) {
  const messages = [];
  const images = new Map();
  const toolsById = new Map();
  const native = new Map();
  const toolCache = new Map();
  const marker = (block) => {
    const text = `pi-gateway-native-${randomUUID()}`;
    native.set(text, block);
    return { type: "text", text };
  };
  // Replay carriers are Codex state, never a Claude signature.
  const needsNative = (block) => nativeBlocks && (block.type === "thinking"
    ? typeof block.signature === "string" && block.signature.trim() && !isReplayCarrier(block.signature)
    : block.type === "redacted_thinking" ? typeof block.data === "string" && block.data
      : block.cache_control || claudeNativeBlocks.has(block.type));
  const image = (block) => {
    const source = block.source || {};
    if (source.type === "base64" && typeof source.data === "string") {
      return { type: "image", data: source.data, mimeType: source.media_type || "image/png" };
    }
    if (source.type === "url" && typeof source.url === "string") {
      // Pi's image type is base64-only. Resolve the marker in the payload, never fetch user URLs here.
      const data = `proxy_url_${images.size}`;
      images.set(`data:image/png;base64,${data}`, source.url);
      return { type: "image", data, mimeType: "image/png" };
    }
    return { type: "text", text: "[Image could not be converted by the proxy.]" };
  };
  for (const [index, message] of (body.messages || []).entries()) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content || [];
    if (message.role === "system") {
      messages.push({ role: "system", content: nativeBlocks && blocks.some(needsNative)
        ? marker(blocks).text : textOf(blocks), timestamp: 0 });
      continue;
    }
    if (message.role === "assistant") {
      for (const block of blocks) if (block.type === "tool_use") toolsById.set(block.id, { name: block.name, id: block.id });
      const cached = restore(index);
      if (cached && !blocks.some(needsNative)) {
        for (const block of cached.message.content) if (block.type === "toolCall") toolsById.set(clientCallId(block.id), { name: block.name, id: block.id });
        messages.push(cached.message); continue;
      }
      const content = blocks.flatMap((block) => {
        if (needsNative(block) && block.type !== "tool_use") return [marker(block)];
        if (block.type === "text") return [{ type: "text", text: block.text }];
        if (block.type === "thinking") return [{ type: "thinking", thinking: block.thinking || "" }];
        if (block.type === "tool_use") {
          if (needsNative(block)) toolCache.set(block.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64), block.cache_control);
          return [{ type: "toolCall", id: block.id, name: block.name, arguments: block.input || {} }];
        }
        if (block.type === "redacted_thinking") return []; // Unverified provenance, like an unmatched thinking signature.
        if (claudeNativeBlocks.has(block.type)) return []; // Claude-only history has no GPT equivalent.
        return unsupported(`assistant block ${block.type}`);
      });
      messages.push({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic-client", model: "unknown",
        usage: emptyUsage(), stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", timestamp: 0 });
      continue;
    }
    const content = [];
    const toolImages = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        // Pi joins text-only tool results into one string, erasing nested block
        // boundaries. Keep a single marker for the whole result when needed.
        const preserveResult = needsNative(block) || (Array.isArray(block.content) && block.content.some(needsNative));
        const output = preserveResult ? [marker(block)] : typeof block.content === "string" ? [{ type: "text", text: block.content }]
          : Array.isArray(block.content) ? block.content.flatMap((part) => {
            if (part.type === "image") { toolImages.push(image(part)); return []; }
            return [{ type: "text", text: part.text || JSON.stringify(part) }];
          }) : [{ type: "text", text: block.content ? JSON.stringify(block.content) : "" }];
        const call = toolsById.get(block.tool_use_id);
        messages.push({ role: "toolResult", toolCallId: call?.id || block.tool_use_id, toolName: call?.name || "tool",
          content: output.length ? output : [{ type: "text", text: "[Image result forwarded in the following user message.]" }],
          isError: Boolean(block.is_error), timestamp: 0 });
      } else if (needsNative(block)) content.push(marker(block));
      else if (block.type === "image") content.push(image(block));
      else if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (!claudeNativeBlocks.has(block.type)) unsupported(`user block ${block.type}`);
    }
    if (toolImages.length) messages.push({ role: "user", content: [{ type: "text",
      text: "Analyze the image result(s) from the preceding tool call(s) using the current conversation context." }, ...toolImages], timestamp: 0 });
    if (content.length) messages.push({ role: "user", content, timestamp: 0 });
  }
  const systemPrompt = nativeBlocks && Array.isArray(body.system) && body.system.some(needsNative)
    ? marker(body.system).text : textOf(body.system);
  return { context: { systemPrompt, messages,
    tools: (body.tools || []).map((tool) => ({ name: tool.name, description: tool.description || "", parameters: tool.input_schema || { type: "object" } })) }, images, native, toolCache };
}

function toAnthropicMessage(message, model = message.model) {
  const native = message.api === "anthropic-messages" && message.provider === "github-copilot";
  const content = message.content.flatMap((block) => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "thinking") {
      if (native && block.redacted) return [{ type: "redacted_thinking", data: block.thinkingSignature }];
      if (native || block.thinking && !block.redacted) return [{ type: "thinking", thinking: block.thinking, signature: native ? block.thinkingSignature || "" : "" }];
    }
    if (block.type === "toolCall") return [{ type: "tool_use", id: native ? block.id : clientCallId(block.id), name: block.name, input: block.arguments }];
    return [];
  });
  return { id: message.responseId || `msg_${Date.now()}`, type: "message", role: "assistant", model: toGatewayModelId(model),
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: message.stopReason === "toolUse" ? "tool_use" : message.stopReason === "length" ? "max_tokens" : "end_turn", stop_sequence: null,
    usage: { input_tokens: message.usage.input, output_tokens: message.usage.output,
      cache_read_input_tokens: message.usage.cacheRead, ...(message.usage.cacheWrite ? { cache_creation_input_tokens: message.usage.cacheWrite } : {}) } };
}

function restoreImageUrls(value, images) {
  if (!value || typeof value !== "object" || !images.size) return;
  if (value.type === "input_image" && images.has(value.image_url)) value.image_url = images.get(value.image_url);
  if (value.type === "image" && value.source?.type === "base64") {
    const url = images.get(`data:${value.source.media_type};base64,${value.source.data}`);
    if (url) value.source = { type: "url", url };
  }
  for (const item of Object.values(value)) if (item && typeof item === "object") restoreImageUrls(item, images);
}

// Resolve only markers created for this request, before any upstream bytes are sent.
function restoreClaudeBlocks(payload, native, toolCache) {
  const restore = (blocks) => Array.isArray(blocks) ? blocks.flatMap((block) => {
    if (block.type === "text" && native.has(block.text)) {
      const original = native.get(block.text);
      native.delete(block.text);
      return Array.isArray(original) ? original : [original];
    }
    if (block.type === "tool_use" && toolCache.has(block.id)) return [{ ...block, cache_control: toolCache.get(block.id) }];
    if (block.type === "tool_result") {
      const key = typeof block.content === "string" ? block.content
        : Array.isArray(block.content) && block.content.length === 1 && block.content[0].type === "text" ? block.content[0].text : undefined;
      if (native.get(key)?.type === "tool_result") {
        const original = native.get(key);
        native.delete(key);
        return [{ ...original, tool_use_id: block.tool_use_id }];
      }
      return [{ ...block, content: restore(block.content) }];
    }
    return [block];
  }) : blocks;
  if (payload.system) payload.system = restore(payload.system);
  for (const message of payload.messages) message.content = restore(message.content);
  if (native.size) unsupported("native blocks that Pi could not place");
}

module.exports = { toPiContext, toAnthropicMessage, clientCallId, restoreImageUrls, restoreClaudeBlocks };

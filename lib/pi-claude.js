"use strict";

const { loadCopilotAuth } = require("./copilot-auth");
const { getCopilotHeaders, prepareClaudePayload, learnDisabledThinkingFallback, claudeResponseHeaders } = require("./github-copilot");
const { reportClaudeCacheUsage } = require("./anthropic-cache");
const { toPiContext, toAnthropicMessage, restoreImageUrls, restoreClaudeBlocks } = require("./anthropic-pi");
const { loadPiModels, getGatewayModel, piModel } = require("./pi-registry");
const { piStreamError } = require("./upstream-error");
const { MODEL_TIMEOUT_MS } = require("./pi-options");
const { createRequestController, streamPi } = require("./pi-stream");

function mergeUsage(usage, update) {
  for (const [key, value] of Object.entries(update || {})) if (value != null) usage[key] = value;
}
const mappedBlocks = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);

async function requestClaude(body, { clientHeaders = {}, url = "/v1/messages", agent = false,
  loadAuth = loadCopilotAuth, fetchImpl = fetch, control, onEvent = async () => {}, route,
  onResponse = async () => {}, onCacheUsage = () => {} } = {}) {
  const controller = createRequestController(control);
  const signal = controller.signal;
  let httpStatus;
  let responseHeaders;
  let initial;
  let stop;
  let safeguardResults;
  const usage = {};
  const blocks = new Map();
  const initialCitations = new Map();
  const initialToolInputs = new Map();
  let piIndex = 0;
  try {
    const auth = await loadAuth({ fetchImpl, signal });
    signal.throwIfAborted();
    const models = await loadPiModels();
    signal.throwIfAborted();
    const original = prepareClaudePayload(body);
    // No replay: native markers already carry signed thinking and other Claude-only blocks.
    const { context, images, native, toolCache } = toPiContext(body, undefined, true);
    const headers = getCopilotHeaders(auth, clientHeaders, original);
    if (agent) headers["X-Initiator"] = "agent";
    const query = new URL(url, "http://localhost").search;
    const model = piModel(models, route || getGatewayModel(body.model) || { id: body.model }, {
      provider: "github-copilot", api: "anthropic-messages", baseUrl: auth.baseUrl, maxTokens: body.max_tokens,
      compat: { supportsMessageThreads: false, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: false, supportsMidConvoEffort: false } });
    let payload;
    const result = await streamPi(models, model, context, {
      signal, label: "Copilot Claude",
      toError: (message) => Object.assign(piStreamError(message, httpStatus), { responseHeaders }),
      apiKey: auth.token, headers, maxRetries: 0, timeoutMs: MODEL_TIMEOUT_MS, cacheRetention: "none", disableContinuation: true,
      maxTokens: body.max_tokens || 4096,
      onPayload(generated) {
        // Pi owns system/transcript/tool serialization. These are the native controls
        // not represented by the portable interface in the pinned SDK.
        restoreImageUrls(generated.messages, images);
        restoreClaudeBlocks(generated, native, toolCache);
        for (const key of ["stop_sequences", "output_config", "tool_choice", "metadata", "temperature", "top_p", "top_k", "cache_control"]) {
          if (original[key] !== undefined) generated[key] = original[key];
        }
        if (original.thinking !== undefined) generated.thinking = original.thinking;
        if (generated.tools) generated.tools = generated.tools.map((tool) => {
          const source = original.tools?.find((item) => item.name === tool.name);
          // Native server tools are not schema-based client tools. The upstream
          // validates their exact definition, including provider-side restrictions.
          if (source?.type && source.type !== "custom") return source;
          for (const key of ["strict", "defer_loading", "eager_input_streaming", "cache_control"]) {
            if (source?.[key] !== undefined) tool[key] = source[key];
          }
          return tool;
        });
        payload = prepareClaudePayload(generated);
        return payload;
      },
      async fetch(_sdkUrl, options) {
        const send = (body) => fetchImpl(auth.baseUrl.replace(/\/$/, "") + "/v1/messages" + query, { ...options,
          body, redirect: "error" });
        let response = await send(options.body);
        if (response.status === 400 && payload.thinking?.type === "disabled" &&
          learnDisabledThinkingFallback(payload, response.status, await response.clone().text().catch(() => ""))) {
          void response.body?.cancel().catch(() => {});
          payload = { ...payload, thinking: prepareClaudePayload(body).thinking };
          response = await send(JSON.stringify(payload));
        }
        responseHeaders = claudeResponseHeaders(response.headers);
        if (!response.ok) httpStatus = response.status;
        return response;
      },
      async onProviderEvent(event) {
        switch (event.type) {
          case "message_start":
            initial = { ...event.message, content: [] };
            mergeUsage(usage, initial.usage);
            await onResponse(initial, responseHeaders);
            break;
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "fallback") break; // Provider control frame, not message content.
            if (mappedBlocks.has(block.type)) {
              if (block.type === "text" && block.citations?.length) initialCitations.set(piIndex, block.citations);
              if (block.type === "tool_use" && Object.keys(block.input || {}).length) initialToolInputs.set(piIndex, block.input);
              blocks.set(event.index, { piIndex: piIndex++, ...(block.type === "text" && block.citations ? { citations: [...block.citations] } : {}) });
            } else {
              const contentIndex = -1 - event.index;
              blocks.set(event.index, { contentIndex, block: structuredClone(block) });
              await onEvent({ type: "native_block_start", contentIndex, block });
            }
            break;
          }
          case "content_block_delta": {
            const entry = blocks.get(event.index);
            if (!entry) break;
            if (event.delta.type === "citations_delta" && entry.piIndex !== undefined) {
              (entry.citations ||= []).push(event.delta.citation);
              await onEvent({ type: "native_block_delta", contentIndex: entry.piIndex, delta: event.delta });
            } else if (entry.block) {
              // Native server-tool input is also streamed as JSON fragments.
              if (event.delta.type === "input_json_delta") entry.json = (entry.json || "") + event.delta.partial_json;
              else if (event.delta.type === "text_delta") entry.block.text = (entry.block.text || "") + event.delta.text;
              else throw new Error(`Unsupported Copilot Claude block delta: ${event.delta.type}`);
              await onEvent({ type: "native_block_delta", contentIndex: entry.contentIndex, delta: event.delta });
            } else if (event.delta.type === "input_json_delta") initialToolInputs.delete(entry.piIndex);
            break;
          }
          case "content_block_stop": {
            const entry = blocks.get(event.index);
            if (entry?.block) {
              if (entry.json) entry.block.input = JSON.parse(entry.json);
              await onEvent({ type: "native_block_stop", contentIndex: entry.contentIndex });
            }
            break;
          }
          case "message_delta":
            // Verdicts can arrive in a separate delta before the stop reason.
            if (event.delta?.safeguard_results !== undefined) safeguardResults = event.delta.safeguard_results;
            if (event.delta?.stop_reason) {
              stop = { ...event.delta };
              // Pi treats these native terminal stops as transport errors. Keep the
              // native stop separately while letting Pi finish its content assembly.
              if (["refusal", "sensitive", "model_context_window_exceeded"].includes(stop.stop_reason)) event.delta.stop_reason = "end_turn";
            }
            mergeUsage(usage, event.usage);
            break;
        }
      },
      async deliver(event) {
        if (event.type === "toolcall_end" && initialToolInputs.has(event.contentIndex)) {
          event.toolCall.arguments = initialToolInputs.get(event.contentIndex);
        }
        await onEvent(event);
        if (event.type === "text_start" || event.type === "thinking_start") {
          const block = event.partial.content[event.contentIndex];
          const delta = block.type === "text" ? block.text : !block.redacted && block.thinking;
          if (delta) await onEvent({ ...event, type: block.type === "text" ? "text_delta" : "thinking_delta", delta });
        }
        if (event.type === "text_start") {
          for (const citation of initialCitations.get(event.contentIndex) || []) await onEvent({ type: "native_block_delta",
            contentIndex: event.contentIndex, delta: { type: "citations_delta", citation } });
        }
      }
    });
    // Pi verifies message_stop; message_start carries the native response envelope.
    if (!initial) throw new Error("Copilot Claude stream ended without message_start");
    const message = toAnthropicMessage(result, initial.model || body.model);
    const content = [...blocks.values()].map((entry) => {
      if (entry.block) return entry.block;
      const block = message.content[entry.piIndex];
      return entry.citations && block?.type === "text" ? { ...block, citations: entry.citations } : block;
    }).filter(Boolean);
    reportClaudeCacheUsage(payload, usage, onCacheUsage);
    const response = { ...initial, ...message, ...stop, content, usage };
    if (safeguardResults !== undefined) response.safeguard_results = safeguardResults;
    return response;
  } finally {
    controller.abort();
  }
}

module.exports = { requestClaude };

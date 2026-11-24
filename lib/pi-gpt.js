"use strict";

const crypto = require("node:crypto");
const { loadPiAuth } = require("./pi-auth");
const { getPromptCacheKey, getResponsesReasoning } = require("./pi-options");
const { createReplayReader, rememberReplay } = require("./responses-replay");
const { toPiContext, toAnthropicMessage, clientCallId, restoreImageUrls } = require("./anthropic-pi");
const { upstreamError } = require("./upstream-error");
const { getGatewayModel, loadPiModels, piModel } = require("./pi-registry");

let decoderImport;
function modelFor(models, body, auth, route) {
  const codex = auth.kind === "codex";
  const provider = codex ? "openai-codex" : auth.kind === "copilot" ? "github-copilot" : "openai";
  return piModel(models, route || getGatewayModel(body.model) || { id: body.model }, {
    provider,
    api: codex ? "openai-codex-responses" : "openai-responses",
    baseUrl: codex ? "https://chatgpt.com/backend-api/codex" : auth.kind === "copilot" ? auth.baseUrl
      : auth.kind === "chatgpt" ? "https://api.openai.com/v1" : process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    reasoning: models.getModel(provider, body.model.replace(/^openai\//i, ""))?.reasoning ?? true,
    // The gateway's live catalog owns context capacity. No static SDK catalog gate.
    maxTokens: body.max_tokens,
    compat: { supportsMidConvoSystemMessages: true, supportsStrictMode: false,
      supportsAdditionalTools: false, supportsMidConvoEffort: false,
      supportsMaxOutputTokens: auth.kind === "api" || auth.kind === "copilot", supportsToolSearch: false } });
}

// Pi normally reserializes parsed arguments. Restore only exact, isolated assistant spans,
// never reconstruct the rest of the provider payload or parse SSE here.
function restoreNativeItems(input, replays) {
  for (const replay of replays) {
    const ids = new Set(replay.native.map((item) => item.id).filter(Boolean));
    const calls = new Set(replay.native.filter((item) => item.type === "function_call").map((item) => item.call_id));
    const matches = input.map((item, index) => ids.has(item.id) || item.type === "function_call" && calls.has(item.call_id) ? index : -1).filter((index) => index >= 0);
    if (matches.length !== replay.native.length || matches.at(-1) - matches[0] + 1 !== matches.length) continue;
    input.splice(matches[0], matches.length, ...structuredClone(replay.native));
  }
}

async function requestGpt(body, { onEvent = async () => {}, onCacheUsage = () => {}, control, fetchImpl = fetch,
  loadAuth = loadPiAuth, remember = true, route, adjustPayload, onProviderEvent = () => {} } = {}) {
  const controller = new AbortController();
  if (control) control.abort = (message, status = 499) => controller.abort(Object.assign(new Error(message), { status }));
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error("OpenAI request timed out"), { status: 504 })), 3600000);
  let idleTimer;
  let reader;
  let failure;
  let payload;
  let terminal;
  let deliveryTail = Promise.resolve();
  let eventStream;
  const items = new Map();
  const delivered = { role: "assistant", content: [] };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(Object.assign(new Error("OpenAI response idle timeout"), { status: 504 })), 90000);
  };
  const checkAbort = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  try {
    const auth = await loadAuth({ fetchImpl });
    checkAbort();
    const [models, { Stream }] = await Promise.all([loadPiModels(), decoderImport ||= import("openai/core/streaming")]);
    checkAbort();
    const request = { ...body, prompt_cache_key: body.prompt_cache_key || getPromptCacheKey(body) };
    const findReplay = createReplayReader(request, auth);
    const replays = [];
    const { context, images } = toPiContext(body, (index) => {
      const entry = findReplay(index);
      if (entry) replays.push(entry);
      return entry;
    });
    const model = modelFor(models, body, auth, route);
    const reasoning = getResponsesReasoning(body, model);
    const guardedFetch = async (url, options) => {
      checkAbort();
      const response = await fetchImpl(url, { ...options, redirect: "error" });
      resetIdle();
      if (!response.ok) {
        let detail = {};
        try { const json = await response.clone().json(); detail = { ...json, ...json.error,
          message: json.error?.message || json.detail?.message || (typeof json.detail === "string" ? json.detail : json.message) }; } catch (_) {}
        failure = upstreamError({ ...detail, message: detail.message || `OpenAI API returned HTTP ${response.status}` }, response.status);
        throw failure;
      }
      if (!response.body) throw new Error("OpenAI response has no body");
      reader = response.body.getReader();
      controller.signal.addEventListener("abort", () => { void reader.cancel(controller.signal.reason).catch(() => {}); }, { once: true });
      // A pull-through stream preserves network backpressure and detects stalls after headers.
      const stream = new ReadableStream({ async pull(target) {
        try {
          const next = await reader.read();
          if (next.done) { target.close(); return; }
          resetIdle(); target.enqueue(next.value);
        } catch (error) { target.error(error); }
      }, cancel(reason) { return reader.cancel(reason); } }, { highWaterMark: 0 });
      const observed = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      // The Codex parser in pinned Pi accepts LF only; OpenAI's default parser also
      // hides error-event codes before Pi's raw hook. Use the public SDK decoder to
      // normalize framing and retain actionable failures, not a local SSE parser.
      const decoder = Stream.fromSSEResponse(observed, new AbortController(), undefined, false, "events")[Symbol.asyncIterator]();
      const encoder = new TextEncoder();
      const finishedItems = new Set();
      const encode = (event) => `data: ${JSON.stringify(event)}\n\n`;
      return new Response(new ReadableStream({ async pull(target) {
        try {
          const next = await decoder.next();
          if (next.done) { target.close(); return; }
          const event = next.value;
          if (event.type === "error") {
            const detail = event.error || event;
            failure = upstreamError(detail, 502, "error");
            target.error(failure); return;
          }
          if (event.type === "response.output_item.done") finishedItems.add(event.output_index);
          let frames = "";
          const terminal = event.response;
          if (["response.completed", "response.incomplete", "response.done"].includes(event.type) && !terminal?.error &&
            (terminal?.status === "completed" || terminal?.status === "incomplete" && terminal.incomplete_details?.reason === "max_output_tokens")) {
            // Some compatible providers supply the final items only in this frame.
            // Feed missing item completions through Pi's normal assembly path.
            for (const [index, item] of (terminal.output || []).entries()) {
              if (!finishedItems.has(index)) frames += encode({ type: "response.output_item.done", output_index: index, item });
            }
          }
          target.enqueue(encoder.encode(frames + encode(event)));
        } catch (error) { target.error(error); }
      }, cancel() { return decoder.return(); } }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
    };
    eventStream = models.stream(model, context, {
      apiKey: auth.token, fetch: guardedFetch, signal: controller.signal, transport: "sse", maxRetries: 0,
      timeoutMs: 3600000, sessionId: request.prompt_cache_key,
      cacheRetention: request.prompt_cache_key ? "short" : "none",
      headers: auth.kind === "copilot" ? auth.headers : {}, maxTokens: body.max_tokens || 4096,
      ...(body.temperature !== undefined && !model.reasoning && auth.kind === "api" ? { temperature: body.temperature } : {}),
      reasoningEffort: reasoning?.effort, reasoningSummary: reasoning?.summary,
      onPayload(value) {
        payload = value;
        restoreNativeItems(payload.input, replays);
        restoreImageUrls(payload.input, images);
        // Pi owns the rest of the Responses payload (system prompt placement, store,
        // stream, include, cache key), with two exceptions below.
        // Reasoning keeps the gateway's own mapping. Without a requested effort, Pi sends
        // effort "none", which Codex rejects for some models (reasoning_effort_not_allowed).
        if (reasoning) payload.reasoning = reasoning; else delete payload.reasoning;
        // Keep the pre-Pi contract: Responses defaults omitted strict to true, which
        // would normalize client schemas and change optional-argument semantics.
        for (const tool of payload.tools || []) if (tool.type === "function") tool.strict = false;
        if (adjustPayload) adjustPayload(payload, auth);
        return payload;
      },
      async onProviderStreamEvent(event) {
        // Pi normalizes this Codex terminal alias after invoking the raw hook.
        if (auth.kind === "codex" && event.type === "response.done") event = { ...event, type: "response.completed" };
        // Pi's producer otherwise runs ahead of its iterable consumer. Fence the previous
        // event's downstream writes before accepting another provider event (no unbounded queue).
        await new Promise((resolve) => setImmediate(resolve));
        await deliveryTail;
        checkAbort();
        await onProviderEvent(event);
        checkAbort();
        if (event.type === "response.output_item.done") items.set(event.output_index, structuredClone(event.item));
        if (event.type === "error" || event.type === "response.failed") {
          const detail = event.error || event.response?.error || {};
          failure = upstreamError({ ...detail, code: detail.code || event.code, message: detail.message || event.message }, 502, event.type);
          throw failure;
        }
        if (event.type === "response.completed" || event.type === "response.incomplete") {
          terminal = { ...event.response, output: event.response.output?.length ? event.response.output : [...items].sort(([a], [b]) => a - b).map(([, item]) => item) };
          if (event.type === "response.incomplete" && event.response.incomplete_details?.reason !== "max_output_tokens") {
            failure = upstreamError({ message: `OpenAI response incomplete: ${event.response.incomplete_details?.reason || "unknown"}` });
            throw failure;
          }
        }
      }
    });
    let result;
    const emitted = new Map();
    const deliver = async (event) => {
      if (event.type === "text_delta" || event.type === "thinking_delta") emitted.set(event.contentIndex, (emitted.get(event.contentIndex) || "") + event.delta);
      if (event.type === "text_delta") {
        const last = delivered.content.at(-1);
        if (last?.type === "text") last.text += event.delta; else delivered.content.push({ type: "text", text: event.delta });
      } else if (event.type === "toolcall_end") {
        if (event.toolCall.argumentsError) throw upstreamError({ message: "OpenAI returned invalid tool arguments" });
        delivered.content.push({ type: "tool_use", id: clientCallId(event.toolCall.id), name: event.toolCall.name, input: structuredClone(event.toolCall.arguments) });
      }
      if (event.type === "done") result = event.message;
      await onEvent(event);
    };
    for await (const event of eventStream) {
      checkAbort();
      if (event.type === "error") throw failure || upstreamError({ message: event.error.errorMessage || "Pi GPT request failed" });
      deliveryTail = (async () => {
        // Providers may send a complete item without deltas. Pi finalizes its content
        // at *_end; emit the missing suffix so JSON and SSE clients see the same text.
        if (event.type === "text_end" || event.type === "thinking_end") {
          const seen = emitted.get(event.contentIndex) || "";
          if (event.content.startsWith(seen) && event.content.length > seen.length) await deliver({ ...event,
            type: event.type === "text_end" ? "text_delta" : "thinking_delta", delta: event.content.slice(seen.length) });
        }
        await deliver(event);
      })();
      await deliveryTail;
    }
    checkAbort();
    if (!terminal || !result) throw Object.assign(new Error("OpenAI Responses stream ended before a terminal response event"), { status: 502 });
    const response = toAnthropicMessage(result, body.model);
    const carrier = remember ? rememberReplay(request, auth, terminal, result, body.stream ? delivered : response) : undefined;
    if (carrier) response.content.push({ type: "thinking", thinking: "", signature: carrier });
    const total = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
    const hash = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
    // Keep prefix_id comparable with pre-Pi logs, which hashed Codex leading system text as instructions.
    const leading = [];
    for (const item of payload.input) {
      if (item.role !== "developer") break;
      leading.push(...(typeof item.content === "string" ? [item.content] : item.content.map((part) => part.text)));
    }
    const instructions = auth.kind === "codex" ? leading.join("\n") || "You are a helpful assistant." : "";
    await onCacheUsage({ model: body.model, auth_kind: auth.kind, replayed_assistant_turns: replays.length,
      cache_key_id: request.prompt_cache_key ? hash(request.prompt_cache_key) : "none",
      prefix_id: hash(JSON.stringify({ instructions, system: body.system || "", tools: payload.tools || [] })),
      total_input_tokens: total, cache_read_input_tokens: result.usage.cacheRead,
      uncached_input_tokens: total - result.usage.cacheRead, cache_hit_percent: total ? Math.round(result.usage.cacheRead / total * 1000) / 10 : 0 });
    return response;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw failure || error;
  } finally {
    clearTimeout(timeout); clearTimeout(idleTimer); controller.abort();
    if (reader) await reader.cancel().catch(() => {});
  }
}

module.exports = { requestGpt };

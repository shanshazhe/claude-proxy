const crypto = require("crypto");
const { upstreamError } = require("./upstream-error");
const { loadPiAuth } = require("./pi-auth");
const { createReplayReader, rememberReplay } = require("./responses-replay");
const REPLAY_COUNT = Symbol("replayedAssistantTurns");

function getPromptCacheKey(anthropicBody) {
  if (process.env.OPENAI_PROMPT_CACHE === "0") return undefined;
  const identity = anthropicBody.metadata?.user_id || anthropicBody.metadata?.session_id;
  const stripMarker = ({ cache_control, ...value }) => value;
  const system = Array.isArray(anthropicBody.system) ? anthropicBody.system.map(stripMarker) : anthropicBody.system || "";
  const seed = identity || JSON.stringify({ system, tools: (anthropicBody.tools || []).map(stripMarker) });
  return "claude-" + crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 48);
}

const isResponsesModel = (model) => /^(?:openai\/)?gpt-(?!oss(?:-|$))/i.test(model || "");

function getResponsesReasoning(body) {
  if (!/^(?:openai\/)?gpt-[56](?:[.-]|$)/i.test(body.model || "") || body.thinking?.type === "disabled") return undefined;
  const requested = body.output_config?.effort;
  const supportedEfforts = /^(?:openai\/)?gpt-6\.1-sol$/i.test(body.model)
    ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"];
  const effort = supportedEfforts.includes(requested) ? requested
    : ["xhigh", "max"].includes(requested) ? "high"
      : body.thinking ? "medium" : undefined;
  // Request the provider's public reasoning summary, not hidden raw reasoning.
  return { summary: "auto", ...(effort ? { effort } : {}) };
}

// Reuse the proxy's normalized messages, but speak Responses on the wire.
function toResponsesBody(body, auth = { kind: "api" }) {
  const input = [];
  let replayCount = 0;
  const findReplay = createReplayReader(body, auth);
  for (const [index, message] of (body.messages || []).entries()) {
    if (message.role === "assistant") {
      const replay = findReplay(index);
      if (replay) { input.push(...replay); replayCount++; continue; }
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (message.content) {
      const parts = typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
      input.push({
        role: message.role === "system" ? "developer" : message.role,
        content: parts.map((part) => part.type === "image_url"
          ? { type: "input_image", image_url: part.image_url.url, detail: "auto" }
          : { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text })
      });
    }
    for (const call of message.tool_calls || []) {
      input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  const model = body.model.replace(/^openai\//i, "");
  const result = {
    model,
    input,
    stream: Boolean(body.stream),
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: Math.max(body.max_tokens || 4096, 16)
  };
  // Reasoning GPT models do not accept arbitrary sampling temperatures.
  if (body.temperature !== undefined && !/^gpt-[56](?:[.-]|$)/i.test(model)) {
    result.temperature = body.temperature;
  }
  if (body.tools?.length) {
    result.tools = body.tools.map((tool) => ({ type: "function", ...tool.function, strict: false }));
  }
  if (body.prompt_cache_key) result.prompt_cache_key = body.prompt_cache_key;
  if (body.reasoning) result.reasoning = body.reasoning;
  if (auth.kind !== "api") {
    delete result.max_output_tokens;
    delete result.temperature;
  }
  if (auth.kind === "codex") {
    result.stream = true;
    // Only the leading system prompt becomes instructions. Claude Code appends system reminders
    // every turn; moving those into instructions would change the cached prefix on every request.
    const leading = input.findIndex((item) => item.role !== "developer");
    const system = leading === -1 ? input : input.slice(0, leading);
    result.instructions = system.flatMap((item) => item.content).map((part) => part.text).join("\n") || "You are a helpful assistant.";
    result.input = input.slice(system.length);
    result.parallel_tool_calls = true;
  }
  Object.defineProperty(result, REPLAY_COUNT, { value: replayCount });
  return result;
}

function fromResponses(response, model) {
  if (response.error || !["completed", "incomplete"].includes(response.status)) {
    throw upstreamError(response.error || { message: `OpenAI response status: ${response.status}` });
  }
  if (response.status === "incomplete" && response.incomplete_details?.reason !== "max_output_tokens") {
    throw Object.assign(new Error(`OpenAI response incomplete: ${response.incomplete_details?.reason || "unknown"}`), { status: 502 });
  }
  const output = response.output || [];
  const toolCalls = output.filter((item) => item.type === "function_call").map((item) => ({
    id: item.call_id,
    type: "function",
    function: { name: item.name, arguments: item.arguments }
  }));
  return {
    id: response.id,
    model,
    content: output.filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .map((part) => part.text || part.refusal || "").join(""),
    tool_calls: toolCalls,
    reasoning_content: output.filter((item) => item.type === "reasoning")
      .flatMap((item) => item.summary || []).map((part) => part.text || "").join("\n\n"),
    finish_reason: response.status === "incomplete" ? "length" : toolCalls.length ? "tool_calls" : "stop",
    usage: {
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
      cached_tokens: response.usage?.input_tokens_details?.cached_tokens || 0
    }
  };
}

// SSE frames, including CRLF, multiline data and UTF-8 split across packets.
async function* readEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") {
        yield JSON.parse(data);
      }
    }
  }
  if (buffer.trim()) {
    throw Object.assign(new Error("OpenAI Responses stream ended with an incomplete SSE frame"), { status: 502 });
  }
}

// adjustPayload / onEvent 只供内置 WebSearch 使用：改写原生请求体，并逐个观察上游 SSE 事件。
async function requestResponses(body, { onChunk = async () => {}, onCacheUsage = () => {}, control, fetchImpl = fetch, loadAuth = loadPiAuth, remember = true,
  adjustPayload, onEvent = () => {} } = {}) {
  const controller = new AbortController();
  if (control) {
    control.abort = (message, status = 499) => controller.abort(Object.assign(new Error(message), { status }));
  }
  const auth = await loadAuth({ fetchImpl });
  if (controller.signal.aborted) throw controller.signal.reason;
  const payload = toResponsesBody(body, auth);
  if (adjustPayload) adjustPayload(payload, auth);
  const baseUrl = auth.kind === "copilot" ? auth.baseUrl
    : auth.kind === "codex" ? "https://chatgpt.com/backend-api/codex"
      : auth.kind === "chatgpt" ? "https://api.openai.com/v1"
        : (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}`, ...(auth.kind === "copilot" ? auth.headers : {}) };
  if (auth.kind === "codex") {
    headers["chatgpt-account-id"] = auth.accountId;
    headers["OpenAI-Beta"] = "responses=experimental";
    headers.originator = "pi";
    headers.Accept = "text/event-stream";
    // Match Pi: one stable identity for the body cache key and SSE affinity.
    if (payload.prompt_cache_key) {
      headers["session-id"] = payload.prompt_cache_key;
      headers["x-client-request-id"] = payload.prompt_cache_key;
    }
  }
  const reportCacheUsage = async (result) => {
    const total = result.usage.prompt_tokens;
    const cached = result.usage.cached_tokens;
    const hashId = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
    const leading = payload.input.findIndex((item) => item.role !== "developer");
    await onCacheUsage({
      model: body.model,
      auth_kind: auth.kind,
      replayed_assistant_turns: payload[REPLAY_COUNT],
      cache_key_id: payload.prompt_cache_key ? hashId(String(payload.prompt_cache_key)) : "none",
      prefix_id: hashId(JSON.stringify({ instructions: payload.instructions || "",
        developer: leading === -1 ? payload.input : payload.input.slice(0, leading), tools: payload.tools || [] })),
      total_input_tokens: total,
      cache_read_input_tokens: cached,
      uncached_input_tokens: Math.max(0, total - cached),
      cache_hit_percent: total > 0 ? Math.round(cached / total * 1000) / 10 : 0
    });
  };
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error("OpenAI request timed out"), { status: 504 })), 3600000);
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(Object.assign(new Error("OpenAI response idle timeout"), { status: 504 })), 90000);
  };
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    // Start idling only after headers: buffering TLS gateways (e.g. Cisco
    // Secure Access) hold them until the whole response is generated.
    resetIdle();
    if (!response.ok) {
      const text = await response.text();
      let failure = { message: `OpenAI API returned HTTP ${response.status}` };
      try {
        const parsed = JSON.parse(text);
        const detail = parsed.error?.message || parsed.detail?.message || parsed.detail || parsed.message;
        failure = { ...parsed, ...parsed.error, ...(typeof detail === "string" ? { message: detail } : {}) };
      } catch (_) { /* Keep a safe status-only error for non-JSON responses. */ }
      throw upstreamError(failure, response.status);
    }
    if (!payload.stream) {
      const native = await response.json();
      const assembled = fromResponses(native, body.model);
      // One-off side requests (e.g. tool-output summaries) must not evict conversation replays.
      if (remember) rememberReplay(body, auth, native, assembled);
      await reportCacheUsage(assembled);
      return assembled;
    }
    let completed = false;
    let terminalResponse;
    const emittedCalls = new Set();
    const streamedCalls = [];
    let streamedText = "";
    let reasoningPart = null;
    const completedItems = new Map();
    for await (const event of readEvents(response.body)) {
      resetIdle();
      onEvent(event);
      if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
        streamedText += event.delta;
        await onChunk({ choices: [{ delta: { content: event.delta } }] });
      } else if (event.type === "response.reasoning_summary_text.delta") {
        // Each summary part is its own paragraph (usually a bold title); bare
        // concatenation would render as "**A****B**".
        const part = `${event.item_id}:${event.summary_index}`;
        const separator = reasoningPart && reasoningPart !== part ? "\n\n" : "";
        reasoningPart = part;
        await onChunk({ choices: [{ delta: { reasoning_content: separator + event.delta } }] });
      } else if (event.type === "response.output_item.added") {
        // Text or a tool call closes the client's thinking block, so later
        // reasoning starts a fresh block without a leading separator.
        if (event.item.type !== "reasoning") reasoningPart = null;
      } else if (event.type === "response.output_item.done") {
        completedItems.set(event.output_index, event.item);
        if (event.item.type === "function_call") {
          // Emit complete calls atomically to avoid interleaving tool arguments.
          emittedCalls.add(event.item.call_id);
          streamedCalls.push({ id: event.item.call_id, function: { name: event.item.name, arguments: event.item.arguments } });
          await onChunk({ choices: [{ delta: { tool_calls: [{ index: event.output_index, id: event.item.call_id,
            function: { name: event.item.name, arguments: event.item.arguments } }] } }] });
        }
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        // Codex can send response.completed with output: []: completed items
        // arrived earlier in the stream and must be retained for text/tool use.
        const output = event.response.output?.length ? event.response.output
          : [...completedItems].sort(([a], [b]) => a - b).map(([, item]) => item);
        const native = { ...event.response, output };
        const assembled = fromResponses(native, body.model);
        terminalResponse = assembled;
        if (assembled.tool_calls.some((call) => !emittedCalls.has(call.id))) {
          throw Object.assign(new Error("OpenAI Responses stream completed with an unfinished tool call"), { status: 502 });
        }
        // SSE tool completions may arrive out of output-index order. Match the
        // view actually delivered to the client, but replay native output order.
        if (remember) rememberReplay(body, auth, native, body.stream
          ? { ...assembled, content: streamedText, tool_calls: streamedCalls } : assembled);
        await reportCacheUsage(assembled);
        await onChunk({ choices: [{ delta: {}, finish_reason: assembled.finish_reason }], usage: assembled.usage });
        completed = true;
        break;
      } else if (event.type === "error" || event.type === "response.failed") {
        // The reason may be nested or code-only; keep it so failures are diagnosable.
        const failure = event.error || event.response?.error || {};
        throw upstreamError({ ...failure, code: failure.code || event.code,
          message: failure.message || event.message }, 502, event.type);
      }
    }
    if (!completed) {
      throw Object.assign(new Error("OpenAI Responses stream ended before a terminal response event"), { status: 502 });
    }
    return body.stream ? { streamed: true } : terminalResponse;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(idleTimer);
    controller.abort();
  }
}

module.exports = { isResponsesModel, getPromptCacheKey, getResponsesReasoning, toResponsesBody, fromResponses, readEvents, requestResponses };

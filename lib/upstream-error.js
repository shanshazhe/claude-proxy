// Preserve client-actionable failures across JSON and SSE provider transports.
function upstreamError(failure = {}, fallbackStatus = 502, event) {
  const code = failure.code;
  const contextExceeded = code === "context_length_exceeded" || code === "max_context_length_exceeded";
  const detail = failure.message || "OpenAI Responses failed";
  const details = [event && `event=${event}`, code && `code=${code}`, failure.type && `type=${failure.type}`].filter(Boolean).join(", ");
  // Claude Code recognizes this provider-neutral phrase for reactive compaction.
  const message = contextExceeded && !/^prompt is too long/i.test(detail) ? `prompt is too long: ${detail}` : detail;
  return Object.assign(new Error(details ? `${message} (${details})` : message), {
    status: contextExceeded ? 400 : fallbackStatus,
    ...(code ? { code } : {})
  });
}

// Pi 1.6 emits formatted error text, without a structured status or code.
function piStreamError(message, status = 502, lostCode) {
  const text = message || "Upstream model request failed";
  let decoded;
  const start = text.indexOf("{");
  if (start !== -1) {
    try { decoded = JSON.parse(text.slice(start)); } catch (_) {}
  }
  const detail = decoded?.error || decoded;
  const code = detail?.code || lostCode;
  const messageText = typeof detail?.message === "string" ? detail.message : text;
  const contextExceeded = code === "context_length_exceeded" || code === "max_context_length_exceeded";
  const error = code ? upstreamError({ code, type: detail?.type, message: messageText }, status)
    : Object.assign(new Error(messageText), { status });
  if (decoded?.type === "error" && decoded.error && !contextExceeded) error.body = decoded;
  return error;
}

module.exports = { upstreamError, piStreamError };

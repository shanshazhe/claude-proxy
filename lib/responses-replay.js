"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");

// Provider metadata cannot round-trip through an Anthropic client. Keep it private,
// bounded, and scoped to the exact account/model/session/history that produced it.
const outputs = new Map();
const MAX_ENTRIES = 512;
const MAX_BYTES = 16 * 1024 * 1024;
let bytes = 0;
// Turns with encrypted reasoning also get a copy in the client transcript, as the
// signature of an empty thinking block, so the reasoning survives a proxy restart.
const CARRIER = "claude-proxy-responses-v1.";
const MAX_CARRIER_BYTES = 1024 * 1024;
const isReplayCarrier = (signature) => typeof signature === "string" && signature.startsWith(CARRIER);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function assistantView(message) {
  const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content || [];
  const view = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      if (view.at(-1)?.type === "text") view.at(-1).text += block.text;
      else view.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") view.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
  }
  return view;
}
function withoutMarkers(blocks) {
  return typeof blocks === "string" ? blocks : (blocks || []).map(({ cache_control, ...block }) =>
    block.type === "tool_result" && Array.isArray(block.content) ? { ...block, content: withoutMarkers(block.content) } : block);
}
function historyView(message) {
  const { role } = message;
  if (role === "assistant") return { role, content: assistantView(message) };
  let content = withoutMarkers(message.content);
  // Claude Code can resend a single plain-text message as a string on resume.
  // Preserve richer blocks and real edits in the replay key.
  if ((role === "system" || role === "user") && Array.isArray(content) && content.length === 1) {
    const { type, text, ...rest } = content[0];
    if (type === "text" && typeof text === "string" && Object.keys(rest).length === 0) content = text;
  }
  return { role, content };
}
function historyHash(messages, prefixes) {
  const hash = crypto.createHash("sha256");
  for (const message of messages) {
    if (prefixes) prefixes.push(hash.copy().digest("hex"));
    hash.update(JSON.stringify(canonical(historyView(message)))).update("\0");
  }
  return hash.digest("hex");
}
function replayKey(body, auth, prefix, assistant) {
  const identity = auth.accountId || crypto.createHash("sha256").update(auth.token || "").digest("hex");
  return crypto.createHash("sha256").update(JSON.stringify(canonical({ provider: auth.kind, identity,
    model: body.model, session: body.prompt_cache_key || "",
    system: withoutMarkers(body.system), tools: withoutMarkers(body.tools), prefix, assistant: assistantView(assistant) }))).digest("hex");
}

// The carrier and the memory cache use the same replay key.
function readCarrier(message, key, diagnostics) {
  let field;
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type !== "thinking" || !isReplayCarrier(block.signature)) continue;
    field ??= "replay_invalid_carrier_turns";
    try {
      const encoded = Buffer.from(block.signature.slice(CARRIER.length), "base64url");
      const payload = JSON.parse(zlib.inflateRawSync(encoded, { maxOutputLength: MAX_BYTES }));
      if (typeof payload?.k !== "string" || !Array.isArray(payload.v?.message?.content) || !Array.isArray(payload.v.native)) continue;
      if (payload.k === key) return payload.v;
      field = "replay_carrier_key_mismatch_turns";
    } catch (_) {}
  }
  if (diagnostics && field) diagnostics[field] = (diagnostics[field] || 0) + 1;
}
function createReplayReader(body, auth, diagnostics) {
  const messages = body.messages || [];
  const prefixes = [];
  historyHash(messages, prefixes);
  return (index) => {
    const key = replayKey(body, auth, prefixes[index], messages[index]);
    const entry = outputs.get(key);
    if (!entry) return readCarrier(messages[index], key, diagnostics);
    outputs.delete(key); outputs.set(key, entry);
    return structuredClone(entry.value);
  };
}
// Returns a carrier signature when the turn contains encrypted reasoning.
function rememberReplay(body, auth, native, message, delivered) {
  if (native && (native.status !== "completed" || !native.output?.length ||
    native.output.some((item) => !["message", "reasoning", "function_call"].includes(item.type)))) return;
  const key = replayKey(body, auth, historyHash(body.messages || []), delivered);
  const value = { message, ...(native ? { native: native.output } : {}) };
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > MAX_BYTES) return;
  const previous = outputs.get(key);
  if (previous) { bytes -= previous.size; outputs.delete(key); }
  outputs.set(key, { value: structuredClone(value), size }); bytes += size;
  while (outputs.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    const oldest = outputs.keys().next().value;
    bytes -= outputs.get(oldest).size; outputs.delete(oldest);
  }
  if (!native?.output.some((item) => item.type === "reasoning" && item.encrypted_content)) return;
  const carrier = CARRIER + zlib.deflateRawSync(JSON.stringify({ k: key, v: value })).toString("base64url");
  return carrier.length <= MAX_CARRIER_BYTES ? carrier : undefined;
}

module.exports = { createReplayReader, rememberReplay, isReplayCarrier };

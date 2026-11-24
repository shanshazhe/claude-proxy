const crypto = require("crypto");

function cacheBlocks(body) {
  const history = [];
  const append = (blocks) => {
    for (const block of blocks) {
      if (block?.type === "tool_result" && Array.isArray(block.content)) append(block.content);
      history.push(block);
    }
  };
  for (const message of body.messages || []) if (Array.isArray(message.content)) append(message.content);
  return [...(body.tools || []), ...(Array.isArray(body.system) ? body.system : []), ...history];
}

function prepareClaudeCache(body) {
  const family = /^claude-(haiku|sonnet|opus)/i.exec(body.model || "")?.[1]?.toUpperCase();
  if (body.cache_control || process.env.CLAUDE_PROMPT_CACHE === "0" || process.env.DISABLE_PROMPT_CACHING === "1" ||
    (family && process.env[`DISABLE_PROMPT_CACHING_${family}`] === "1")) return body;
  const payload = structuredClone(body);
  if (typeof payload.system === "string" && payload.system) payload.system = [{ type: "text", text: payload.system }];
  const last = payload.messages?.at(-1);
  if (last?.role === "user" && typeof last.content === "string" && last.content) last.content = [{ type: "text", text: last.content }];
  const system = Array.isArray(payload.system) ? payload.system.at(-1) : undefined;
  const tool = payload.tools?.at(-1);
  const history = last?.role === "user" && Array.isArray(last.content) ? last.content.at(-1) : undefined;
  const candidates = [tool, system, history && ["text", "image", "tool_result", "tool_addition", "tool_removal"].includes(history.type) ? history : undefined];
  for (const candidate of candidates) {
    if (!candidate || candidate.cache_control || (candidate.type === "text" && !candidate.text)) continue;
    const blocks = cacheBlocks(payload);
    const markers = blocks.filter((block) => block?.cache_control);
    if (markers.length >= 4) break;
    const index = blocks.indexOf(candidate);
    const next = blocks.slice(index + 1).find((block) => block?.cache_control);
    const previous = blocks.slice(0, index).reverse().find((block) => block?.cache_control);
    // Match neighboring TTL to preserve Anthropic's long-before-short ordering.
    const retention = next?.cache_control || previous?.cache_control;
    const long = retention ? retention.ttl === "1h" : process.env.PI_CACHE_RETENTION === "long";
    candidate.cache_control = { type: "ephemeral", ...(long ? { ttl: "1h" } : {}) };
  }
  return payload;
}

function reportClaudeCacheUsage(body, usage, onCacheUsage) {
  const read = usage.cache_read_input_tokens || 0;
  const created = usage.cache_creation_input_tokens || 0;
  const uncached = usage.input_tokens || 0;
  const total = read + created + uncached;
  const stripMarker = ({ cache_control, ...value }) => value;
  const prefix = { system: Array.isArray(body.system) ? body.system.map(stripMarker) : body.system || "",
    tools: (body.tools || []).map(stripMarker) };
  try {
    onCacheUsage({ model: body.model,
      prefix_id: crypto.createHash("sha256").update(JSON.stringify(prefix)).digest("hex").slice(0, 12),
      cache_breakpoints: cacheBlocks(body).filter((block) => block?.cache_control).length + Number(Boolean(body.cache_control)),
      total_input_tokens: total, cache_read_input_tokens: read, cache_creation_input_tokens: created,
      regular_input_tokens: uncached, uncached_input_tokens: Math.max(0, total - read),
      cache_hit_percent: total > 0 ? Math.round(read / total * 1000) / 10 : 0 });
  } catch (_) { /* Diagnostics must not interrupt delivery. */ }
}

module.exports = { prepareClaudeCache, reportClaudeCacheUsage };

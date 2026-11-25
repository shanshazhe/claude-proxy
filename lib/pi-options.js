"use strict";

const crypto = require("node:crypto");

function getPromptCacheKey(body) {
  if (process.env.OPENAI_PROMPT_CACHE === "0") return undefined;
  const identity = body.metadata?.user_id || body.metadata?.session_id;
  const stripMarker = ({ cache_control, ...value }) => value;
  const system = Array.isArray(body.system) ? body.system.map(stripMarker) : body.system || "";
  const seed = identity || JSON.stringify({ system, tools: (body.tools || []).map(stripMarker) });
  return "claude-" + crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 48);
}
function getResponsesReasoning(body, model) {
  if (!model.reasoning || body.thinking?.type === "disabled") return undefined;
  const requested = body.output_config?.effort || (body.thinking ? "medium" : undefined);
  const levels = model.thinkingLevelMap;
  const effort = requested && (levels?.[requested] ?? (["xhigh", "max"].includes(requested) ? "high" : requested));
  return { summary: "auto", ...(effort ? { effort } : {}) };
}

const MODEL_TIMEOUT_MS = 3600000;
module.exports = { getPromptCacheKey, getResponsesReasoning, MODEL_TIMEOUT_MS };

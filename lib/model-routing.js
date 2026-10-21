const { isClaudeModel } = require("./github-copilot");

// Claude Code lists gateway models only when the ID contains "claude" or "anthropic", but applies
// CLAUDE_CODE_MAX_CONTEXT_TOKENS only to IDs that do not start with "claude-". GPT IDs get this prefix.
const GATEWAY_MODEL_PREFIX = "anthropic/";

function selectModel(requestedModel, configuredModel) {
  if (typeof requestedModel !== "string" || !requestedModel.trim()) return configuredModel;
  const requested = requestedModel.trim();
  if (requested.startsWith(GATEWAY_MODEL_PREFIX)) return requested.slice(GATEWAY_MODEL_PREFIX.length);
  if (isClaudeModel(requested)) return requested;
  // Short aliases use the configured default; explicit IDs use their provider.
  if (/^(?:sonnet|opus|haiku|fable|default|opusplan)(?:\[|$)/i.test(requested)) return configuredModel;
  return requested;
}

function toGatewayModelId(model) {
  return typeof model === "string" && !isClaudeModel(model) && !model.startsWith(GATEWAY_MODEL_PREFIX)
    ? GATEWAY_MODEL_PREFIX + model : model;
}

function maximumContextWindow(model) {
  const limits = [model.context_window, model.max_context_window, model.runtime?.max_input_tokens,
    model.capabilities?.limits?.max_context_window_tokens]
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return limits.length ? Math.max(...limits) : undefined;
}

function toGatewayModels(models) {
  return {
    ...models,
    data: models.data.map((model) => {
      const baseId = model.id.replace(/\[1m\]$/i, "");
      const contextWindow = maximumContextWindow(model);
      const hasContextWindow = Number.isSafeInteger(contextWindow) && contextWindow > 0;
      // Capacity is numeric metadata, never inferred from a name or a [1m] threshold.
      const displayId = hasContextWindow ? baseId : model.id;
      return {
        ...model,
        ...(hasContextWindow ? { context_window: contextWindow,
          runtime: { ...model.runtime, max_input_tokens: contextWindow },
          capabilities: { ...model.capabilities, limits: { ...model.capabilities?.limits,
            max_context_window_tokens: contextWindow } } } : {}),
        // Claude Code gives some 1M Claude models (e.g. claude-haiku-5.5) only 200K without [1m]. GPT IDs never
        // get it: on them [1m] overrides CLAUDE_CODE_MAX_CONTEXT_TOKENS.
        id: isClaudeModel(baseId) ? displayId + (hasContextWindow && contextWindow >= 1000000 ? "[1m]" : "")
          : toGatewayModelId(displayId),
        display_name: displayId,
        description: isClaudeModel(baseId) ? "GitHub Copilot" : /^(?:openai\/)?gpt-/i.test(baseId) ? "OpenAI Responses" : "Model"
      };
    })
  };
}

module.exports = { selectModel, toGatewayModelId, toGatewayModels, maximumContextWindow };

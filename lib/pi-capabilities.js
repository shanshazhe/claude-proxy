"use strict";

const { getGatewayModel } = require("./pi-registry");
const { forwardClaudeCount } = require("./github-copilot");
const { estimateInputTokens } = require("./token-count");

// Select operations from the resolved catalog transport and account, not names.
function getModelCapabilities(id, resolve = getGatewayModel) {
  const model = resolve(id);
  const copilot = model?.owned_by === "github-copilot";
  const messages = copilot && model.api === "anthropic-messages";
  const responses = ["openai-responses", "openai-codex-responses"].includes(model?.api) && (copilot || model.owned_by === "openai");
  return {
    count: messages ? "native" : responses || (model?.owned_by === "nvidia" && model.api === "openai-completions") ? "estimate" : null,
    search: messages || responses ? (copilot ? "copilot-responses" : "responses") : null
  };
}

async function countTokens(body, req, res, capabilities = getModelCapabilities(body.model)) {
  if (capabilities.count === "native") return forwardClaudeCount(body, req, res);
  if (capabilities.count !== "estimate") throw Object.assign(new Error(`Unsupported token counting model: ${body.model || "(missing)"}`), { status: 400 });
  res.writeHead(200, { "Content-Type": "application/json", "X-Token-Count-Method": "conservative-utf8-estimate" });
  res.end(JSON.stringify({ input_tokens: estimateInputTokens(body) }));
}

module.exports = { getModelCapabilities, countTokens };

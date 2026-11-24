"use strict";

const { getGatewayModel } = require("./pi-registry");
const { requestGpt } = require("./pi-gpt");
const { requestClaude } = require("./pi-claude");

const transports = new Map([
  ["anthropic-messages", requestClaude], ["openai-responses", requestGpt], ["openai-codex-responses", requestGpt]
]);
async function requestPiModel(body, options = {}) {
  const route = options.route || getGatewayModel(body.model);
  const request = transports.get(route?.api);
  if (!request) throw Object.assign(new Error(`Unsupported model: ${body.model || "(missing)"}`), { status: 400 });
  return request(body, { ...options, route });
}

module.exports = { requestPiModel };

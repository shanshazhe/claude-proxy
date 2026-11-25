"use strict";

const { catalogModelId, maximumContextWindow } = require("./model-routing");

let catalog = new Map();
let registry;
const nativeId = (id) => typeof id === "string" ? id.replace(/^anthropic\//, "").replace(/\[1m\]$/i, "") : id;

function setGatewayModels(rows, { owner } = {}) {
  const next = owner ? new Map([...catalog].filter(([, model]) => model.owned_by !== owner)) : new Map();
  for (const model of rows) {
    next.set(nativeId(model.id), model);
    next.set(nativeId(catalogModelId(model.id, model.owned_by)), model);
  }
  catalog = next;
}

function getGatewayModel(id) {
  return catalog.get(nativeId(id));
}

async function resolveGatewayModel(id, discover) {
  id = nativeId(id);
  const find = (catalog) => catalog?.data?.find((row) => nativeId(row.id) === id ||
    nativeId(catalogModelId(row.id, row.owned_by)) === id);
  const match = find(await discover());
  if (match || !id) return match;
  // Discovery may return a stale snapshot while refreshing. Wait only on a miss.
  return find(await discover({ waitForRefresh: true }));
}

function loadPiModels() {
  return registry ||= Promise.all([
    import("@earendil-works/pi-ai"), import("@earendil-works/pi-ai/providers/openai"),
    import("@earendil-works/pi-ai/providers/openai-codex"), import("@earendil-works/pi-ai/providers/github-copilot"),
    import("@earendil-works/pi-ai/providers/nvidia")
  ]).then(([{ createModels, envApiKeyAuth }, { openaiProvider }, { openaiCodexProvider }, { githubCopilotProvider }, { nvidiaProvider }]) => {
    const models = createModels();
    const codex = openaiCodexProvider();
    // The gateway already resolved OAuth; allow Pi's explicit per-request token override.
    codex.auth = { ...codex.auth, apiKey: envApiKeyAuth("Gateway-resolved Codex token", []) };
    for (const provider of [openaiProvider(), codex, githubCopilotProvider(), nvidiaProvider()]) models.setProvider(provider);
    return models;
  });
}

function piModel(models, route, { provider, api, baseUrl, maxTokens, ...overrides }) {
  const id = route.id;
  const bundled = models.getModel(provider, id);
  const baseline = bundled?.api === api ? bundled : {};
  const capacity = maximumContextWindow(route) ?? baseline.contextWindow;
  const output = route.max_output_tokens ?? route.capabilities?.limits?.max_output_tokens;
  return { reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...baseline, ...overrides, id, name: baseline.name || id, provider, api, baseUrl,
    ...(capacity ? { contextWindow: capacity } : {}), maxTokens: Number.isSafeInteger(output) && output > 0 ? output : baseline.maxTokens || maxTokens || 4096,
    compat: { ...baseline.compat, ...overrides.compat } };
}

module.exports = { getGatewayModel, resolveGatewayModel, setGatewayModels, loadPiModels, piModel };

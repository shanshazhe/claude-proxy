const { loadPiAuth } = require("./pi-auth");
const { isResponsesModel } = require("./openai-responses");
const { isClaudeModel, discoverCopilotModels } = require("./github-copilot");
const { loadCopilotAuth } = require("./copilot-auth");
const { maximumContextWindow } = require("./model-routing");

function createModelDiscovery({ fetchImpl = fetch, loadAuth = loadPiAuth, loadClaudeAuth = loadCopilotAuth, now = Date.now, onWarning = () => {} }) {
  let cached;
  let expires = 0;
  let pending;
  let generation = 0;

  const bounded = async (operation) => {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Model discovery timed out")); }, 12000);
    });
    try { return await Promise.race([operation(controller.signal), deadline]); }
    finally { clearTimeout(timer); controller.abort(); }
  };

  const fetchJson = async (url, headers, signal) => {
    const response = await fetchImpl(url, { headers, signal, redirect: "error" });
    if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`);
    return response.json();
  };

  const discoverOpenAI = (signal) => (async () => {
    const auth = await loadAuth({ fetchImpl });
    if (signal.aborted) throw new Error("Model discovery timed out");
    const headers = { Authorization: `Bearer ${auth.token}` };
    let catalog;
    let models;
    if (auth.kind === "codex") {
      headers["chatgpt-account-id"] = auth.accountId;
      headers.originator = "pi";
      // The backend filters its catalog by client version. An old version can
      // return HTTP 200 with only hidden models; keep this override configurable.
      const version = process.env.CODEX_CLIENT_VERSION || "0.162.1";
      catalog = await fetchJson(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`, headers, signal);
      models = catalog.models?.filter((model) => model.visibility !== "hide" && model.supported_in_api !== false)
        .map((model) => ({ ...model, id: model.slug }));
    } else {
      const base = auth.kind === "chatgpt" ? "https://api.openai.com/v1" : (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");
      catalog = await fetchJson(`${base.replace(/\/+$/, "")}/models`, headers, signal);
      models = catalog.data;
    }
    models = models?.filter((model) => isResponsesModel(model.id) && !/(audio|realtime|transcrib|tts|image|search|deep-research)/i.test(model.id));
    if (!models?.length) throw new Error("OpenAI catalog contains no supported GPT chat models");
    return models.map((model) => {
      const validLimit = (value) => Number.isSafeInteger(value) && value > 0;
      // Prefer the largest capacity declared by the provider, without name-based guesses.
      const contextWindow = maximumContextWindow(model);
      const outputLimit = model.max_output_tokens ?? model.capabilities?.limits?.max_output_tokens;
      const limits = {
        ...(validLimit(contextWindow) ? { max_context_window_tokens: contextWindow } : {}),
        ...(validLimit(outputLimit) ? { max_output_tokens: outputLimit } : {})
      };
      return { id: model.id, object: "model", created: model.created || 0, owned_by: "openai",
        ...(validLimit(contextWindow) ? { context_window: contextWindow, runtime: {
          max_input_tokens: contextWindow, ...(validLimit(outputLimit) ? { max_output_tokens: outputLimit } : {})
        } } : {}),
        ...(validLimit(model.max_context_window) ? { max_context_window: model.max_context_window } : {}),
        ...(Object.keys(limits).length ? { capabilities: { limits } } : {}) };
    });
  })();

  const discoverClaude = (signal) => discoverCopilotModels({ fetchImpl, loadAuth: loadClaudeAuth, signal });

  const providers = ["OpenAI Responses", "GitHub Copilot"];
  const sourceIndex = (model) => isClaudeModel(model.id) ? 1 : 0;

  async function getAvailableModels({ waitForRefresh = false } = {}) {
    if (cached && now() < expires) return cached;
    if (!pending) {
      const startedGeneration = generation;
      const operation = (async () => {
        const results = await Promise.allSettled([bounded(discoverOpenAI), bounded(discoverClaude)]);
        const models = results.flatMap((result, index) => {
          if (result.status === "fulfilled") return result.value;
          onWarning(providers[index], result.reason.message);
          // Retain previously fetched data during an outage; a provider that has
          // never answered stays absent until the next retry.
          return (cached?.data || []).filter((model) => sourceIndex(model) === index);
        });
        const discovered = { object: "list", data: [...new Map(models.map((model) => [model.id, model])).values()] };
        if (startedGeneration === generation) {
          cached = discovered;
          expires = now() + (results.every((result) => result.status === "fulfilled") ? 300000 : 30000);
        }
        return discovered;
      })().finally(() => { if (pending === operation) pending = null; });
      pending = operation;
    }
    // Startup can await the shared refresh, bounded by each upstream's deadline.
    if (waitForRefresh) return pending;
    // Keep ordinary CLI discovery responsive, but let a slower upstream
    // refresh finish in the background for the next discovery request.
    let replyTimer;
    try {
      return await Promise.race([pending, new Promise((resolve) => {
        replyTimer = setTimeout(() => resolve(cached || { object: "list", data: [] }), 2200);
      })]);
    } finally { clearTimeout(replyTimer); }
  }
  getAvailableModels.invalidate = () => {
    generation++;
    expires = 0;
    pending = null;
  };
  return getAvailableModels;
}

module.exports = { createModelDiscovery };

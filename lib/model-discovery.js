const { loadPiAuth, readNvidiaApiKey, NVIDIA_BASE_URL } = require("./pi-auth");
const { discoverCopilotModels } = require("./github-copilot");
const { loadCopilotAuth } = require("./copilot-auth");
const { maximumContextWindow } = require("./model-routing");
const { loadPiModels, setGatewayModels } = require("./pi-registry");
const { nvidiaChatModel } = require("./pi-nvidia");

const modelCatalog = (models) => ({ object: "list", data: [...new Map(models.map((model) => [model.id, model])).values()] });

function createModelDiscovery({ gptOnly = false, fetchImpl = fetch, loadAuth = loadPiAuth, loadClaudeAuth = loadCopilotAuth,
  env = process.env, store, now = Date.now, onWarning = () => {} }) {
  const cachedByProvider = new Map();
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
      const version = process.env.CODEX_CLIENT_VERSION || "0.171.0";
      catalog = await fetchJson(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`, headers, signal);
      models = catalog.models?.filter((model) => model.visibility !== "hide" && model.supported_in_api !== false)
        .map((model) => ({ ...model, id: model.slug }));
    } else {
      const base = auth.kind === "chatgpt" ? "https://api.openai.com/v1" : (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");
      catalog = await fetchJson(`${base.replace(/\/+$/, "")}/models`, headers, signal);
      models = catalog.data;
    }
    const registry = await loadPiModels();
    const provider = auth.kind === "codex" ? "openai-codex" : "openai";
    models = models?.filter((model) => {
      if (typeof model?.id !== "string" || !model.id) return false;
      if (auth.kind === "codex") return true;
      if (Array.isArray(model.supported_endpoints)) return model.supported_endpoints.includes("/responses");
      const known = registry.getModel(provider, model.id);
      if (known) return known.api === "openai-responses";
      // Legacy compatible /models can supply only IDs. This is catalog admission,
      // not request routing; a context window alone doesn't imply chat support.
      return /^(?:openai\/)?gpt-(?!oss(?:-|$))/i.test(model.id) &&
        !/(?:^|[-/])(?:audio|realtime|transcrib\w*|tts|image|search|deep-research)(?:[-/]|$)/i.test(model.id);
    });
    if (!models?.length) throw new Error("OpenAI catalog contains no supported GPT chat models");
    return models.map((model) => {
      const validLimit = (value) => Number.isSafeInteger(value) && value > 0;
      // Prefer the largest capacity declared by the provider, without name-based guesses.
      const bundled = registry.getModel(provider, model.id);
      const contextWindow = maximumContextWindow(model) ?? bundled?.contextWindow;
      const outputLimit = model.max_output_tokens ?? model.capabilities?.limits?.max_output_tokens ?? bundled?.maxTokens;
      const limits = {
        ...(validLimit(contextWindow) ? { max_context_window_tokens: contextWindow } : {}),
        ...(validLimit(outputLimit) ? { max_output_tokens: outputLimit } : {})
      };
      return { id: model.id, object: "model", created: model.created || 0, owned_by: "openai", api: auth.kind === "codex" ? "openai-codex-responses" : "openai-responses",
        ...(validLimit(contextWindow) ? { context_window: contextWindow, runtime: {
          max_input_tokens: contextWindow, ...(validLimit(outputLimit) ? { max_output_tokens: outputLimit } : {})
        } } : {}),
        ...(validLimit(model.max_context_window) ? { max_context_window: model.max_context_window } : {}),
        ...(Object.keys(limits).length ? { capabilities: { limits } } : {}) };
    });
  })();

  const discoverClaude = (signal) => discoverCopilotModels({ fetchImpl, loadAuth: loadClaudeAuth, signal });

  const providers = [["openai", "OpenAI Responses", discoverOpenAI]];
  // Separate instances keep startup capacity discovery independent of the full menu cache.
  if (!gptOnly) {
    providers.push(["github-copilot", "GitHub Copilot", discoverClaude]);
    providers.push(["nvidia", "NVIDIA Build", async (signal) => {
      const key = readNvidiaApiKey({ env, store });
      if (!key) return [];
      const catalog = await fetchJson(`${NVIDIA_BASE_URL}/models`, { Authorization: `Bearer ${key}` }, signal);
      if (!Array.isArray(catalog.data)) throw new Error("Invalid NVIDIA model catalog");
      const registry = await loadPiModels();
      return catalog.data.map((row) => nvidiaChatModel(row, registry)).filter(Boolean);
    }]);
  }

  function replaceCachedProvider(owner, models) {
    if (models.length) cachedByProvider.set(owner, models);
    else if (!cachedByProvider.delete(owner)) return;
    cached = modelCatalog(providers.flatMap(([id]) => cachedByProvider.get(id) || []));
    setGatewayModels(models, { owner });
  }

  async function getAvailableModels({ waitForRefresh = false } = {}) {
    if (cached && now() < expires) return cached;
    if (!pending) {
      const startedGeneration = generation;
      const operation = (async () => {
        const results = await Promise.allSettled(providers.map(async ([owner, , discover]) => {
          const models = await bounded(discover);
          // Publish each source as soon as it settles successfully, not at the slowest source's deadline.
          if (startedGeneration === generation) replaceCachedProvider(owner, models);
        }));
        if (startedGeneration !== generation) return getAvailableModels({ waitForRefresh: true });
        results.forEach((result, index) => {
          // Retain this source's previous rows during an outage.
          if (result.status === "rejected") onWarning(providers[index][1], result.reason.message);
        });
        expires = now() + (results.every((result) => result.status === "fulfilled") ? 300000 : 30000);
        return cached ||= modelCatalog([]);
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
  getAvailableModels.invalidate = (owner) => {
    generation++;
    expires = 0;
    pending = null;
    if (owner) replaceCachedProvider(owner, []);
  };
  return getAvailableModels;
}

module.exports = { createModelDiscovery };

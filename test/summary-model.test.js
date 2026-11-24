const test = require("node:test");
const assert = require("node:assert/strict");
const { createSummaryModel, pickModels, numberedInput, parseSummary, MAX_INPUT_BYTES, DEFAULT_PROMPT } = require("../lib/summary-model");

const catalog = (ids) => async () => ({ object: "list", data: ids.map((id) => ({ id, api: id.startsWith("claude-") ? "anthropic-messages" : id.startsWith("gpt-") ? "openai-responses" : "unsupported" })) });
const reply = JSON.stringify({ summary: "build failed", highlights: [{ start: 2, end: 2, reason: "error" }] });

test("pickModels chooses the newest Luna and Haiku versions", () => {
  assert.deepEqual(pickModels(["gpt-5.6-luna", "gpt-6-luna", "gpt-6.1-sol", "claude-haiku-4.5", "claude-haiku-5.5", "claude-opus-5.5"]),
    { luna: "gpt-6-luna", haiku: "claude-haiku-5.5" });
  assert.deepEqual(pickModels(["claude-opus-5.5"]), { luna: undefined, haiku: undefined });
});

test("numbered input matches Read line numbers and keeps head and tail of oversized output", () => {
  assert.match(numberedInput("a\nb", { name: "Bash", input: { command: "make" } }), /Tool: Bash\nTool input: \{"command":"make"\}\nTotal lines: 2\nKeep the summary under 300 characters.\n\n1: a\n2: b$/);
  const line = "x".repeat(1000);
  const input = numberedInput(Array(3000).fill(line).join("\n"), null);
  assert.ok(Buffer.byteLength(input) <= MAX_INPUT_BYTES + 2048);
  assert.match(input, /\n1: x+\n/);
  assert.match(input, /\n3000: x+$/);
  assert.match(input, /\[lines \d+-\d+ omitted\]/);
});

test("parseSummary validates JSON and clamps highlights to real line ranges", () => {
  const parsed = parseSummary('Here: {"summary":" s ","highlights":[{"start":3,"end":200,"reason":"r"},{"start":0,"end":1},{"start":9,"end":10},{"start":"1","end":2}]}', 50);
  assert.deepEqual(parsed, { summary: "s", highlights: [{ start: 3, end: 42, reason: "r" }, { start: 9, end: 10, reason: "" }] });
  assert.throws(() => parseSummary('{"highlights":[]}', 5));
  assert.throws(() => parseSummary("not json", 5));
});

test("Luna is preferred, called without replay memory, and the model choice is cached until restart", async () => {
  let catalogCalls = 0;
  const requests = [];
  const fetchImpl = async () => { throw new Error("Summary must use the shared dispatcher"); };
  const { summarize } = createSummaryModel({
    getAvailableModels: async () => { catalogCalls++; return catalog(["gpt-6-luna", "claude-haiku-5.5"])(); },
    requestModelImpl: async (body, options) => { requests.push({ body, options }); return { content: [{ type: "thinking", thinking: "not summary JSON" }, { type: "text", text: reply }] }; },
    fetchImpl
  });
  const first = await summarize("ok\nerror: failed", { name: "Bash", input: {} });
  assert.deepEqual(first, { model: "gpt-6-luna", summary: "build failed", highlights: [{ start: 2, end: 2, reason: "error" }] });
  await summarize("again", null);
  assert.equal(catalogCalls, 1);
  assert.equal(requests[0].body.model, "gpt-6-luna");
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[0].body.system, DEFAULT_PROMPT);
  assert.deepEqual(requests[0].body.messages.map((message) => message.role), ["user"]);
  assert.equal(requests[0].options.remember, false);
  assert.equal(requests[0].options.agent, true);
  assert.equal(requests[0].options.fetchImpl, fetchImpl);
  assert.equal(typeof requests[0].options.control, "object");
  assert.match(requests[0].body.messages[0].content, /2: error: failed/);
});

test("Luna and Haiku use the same dispatcher with agent mode and no replay, and all failures return null", async () => {
  const requests = [];
  const fetchImpl = async () => { throw new Error("Summary must use the shared dispatcher"); };
  const warnings = [];
  const events = [];
  const { summarize: failingLuna } = createSummaryModel({ getAvailableModels: catalog(["gpt-6-luna", "claude-haiku-5.5"]),
    requestModelImpl: async (body, options) => {
      requests.push({ body, options });
      if (body.model === "gpt-6-luna") throw Object.assign(new Error("private upstream text"), { status: 429 });
      return { content: [{ type: "thinking", thinking: "not summary JSON" }, { type: "text", text: reply.slice(0, 15) },
        { type: "text", text: reply.slice(15) }] };
    },
    fetchImpl, onWarning: (event) => warnings.push(event), onEvent: (event) => events.push(event) });
  assert.equal((await failingLuna("a\nb", null)).model, "claude-haiku-5.5");
  assert.deepEqual(Object.keys(warnings[0]).sort(), ["model", "ms", "status"]);
  assert.equal(warnings[0].status, 429);
  assert.equal(events[0].model, "claude-haiku-5.5");
  assert.deepEqual(requests.map(({ body }) => body.model), ["gpt-6-luna", "claude-haiku-5.5"]);
  for (const { body, options } of requests) {
    assert.equal(body.stream, false);
    assert.equal(body.system, DEFAULT_PROMPT);
    assert.equal(body.max_tokens, 2048);
    assert.deepEqual(body.messages.map((message) => message.role), ["user"]);
    assert.equal(options.agent, true);
    assert.equal(options.remember, false);
    assert.equal(options.fetchImpl, fetchImpl);
  }
  assert.notEqual(requests[0].options.control, requests[1].options.control);

  const { summarize: failing } = createSummaryModel({ getAvailableModels: catalog(["claude-haiku-5.5"]),
    requestModelImpl: async () => { throw Object.assign(new Error("failed"), { status: 500 }); } });
  assert.equal(await failing("a", null), null);
  assert.equal(await createSummaryModel({ getAvailableModels: catalog([]) }).summarize("a", null), null);
});

for (const model of ["gpt-6-luna", "claude-haiku-5.5"]) {
  test(`a slow ${model} summary is aborted at the timeout`, async () => {
    const warnings = [];
    let aborted = false;
    const { summarize } = createSummaryModel({ getAvailableModels: catalog([model]), timeoutMs: 20,
      onWarning: (event) => warnings.push(event),
      requestModelImpl: (body, { control }) => new Promise((_, reject) => {
        control.abort = (message, status) => {
          aborted = true;
          assert.equal(message, "Summary model timed out");
          reject(Object.assign(new Error(message), { status }));
        };
      }) });
    assert.equal(await summarize("a", null), null);
    assert.equal(aborted, true);
    assert.equal(warnings[0].status, 504);
  });
}

test("an empty catalog is not cached so a later request can find the models", async () => {
  let ids = [];
  const { summarize } = createSummaryModel({ getAvailableModels: async () => catalog(ids)(),
    requestModelImpl: async () => ({ content: [{ type: "thinking", thinking: "not summary JSON" }, { type: "text", text: reply }] }) });
  assert.equal(await summarize("a\nb", null), null);
  ids = ["gpt-6-luna"];
  assert.equal((await summarize("a\nb", null)).model, "gpt-6-luna");
});

test("the user-selected model is tried first and falls back to the detected cheap models", async () => {
  const tried = [];
  let preferred = "claude-sonnet-5.5";
  const requestModelImpl = async ({ model }) => {
    tried.push(model);
    if (model === "claude-sonnet-5.5") throw Object.assign(new Error("unavailable"), { status: 503 });
    return { content: [{ type: "text", text: reply }] };
  };
  const { summarize } = createSummaryModel({ getAvailableModels: catalog(["claude-haiku-5.5", "claude-sonnet-5.5"]),
    getPreferredModel: () => preferred, requestModelImpl });
  assert.equal((await summarize("a\nb", null)).model, "claude-haiku-5.5");
  assert.deepEqual(tried, ["claude-sonnet-5.5", "claude-haiku-5.5"]);
  preferred = "z-ai/glm5";
  tried.length = 0;
  assert.equal((await summarize("a\nb", null)).model, "claude-haiku-5.5");
  assert.deepEqual(tried, ["claude-haiku-5.5"]);
});

test("default model and selectable list come from the catalog without failing the page", async () => {
  const model = createSummaryModel({ getAvailableModels: catalog(["z-ai/glm5", "gpt-6-luna", "claude-haiku-5.5", "gpt-6.1-sol", "gpt-6-luna"]) });
  assert.equal(await model.getDefaultModel(), "gpt-6-luna");
  assert.deepEqual(await model.listModels(), ["claude-haiku-5.5", "gpt-6-luna", "gpt-6.1-sol"]);
  const broken = createSummaryModel({ getAvailableModels: async () => { throw new Error("offline"); } });
  assert.equal(await broken.getDefaultModel(), null);
  assert.deepEqual(await broken.listModels(), []);
});

test("complete tries Luna then Haiku with the given system prompt, ignores the preferred model and returns null when all fail", async () => {
  const requests = [];
  const fetchImpl = async () => { throw new Error("Completion must use the shared dispatcher"); };
  const { complete } = createSummaryModel({ getAvailableModels: catalog(["gpt-6-luna", "claude-haiku-5.5", "gpt-6.1-sol"]),
    getPreferredModel: () => "gpt-6.1-sol", fetchImpl,
    requestModelImpl: async (body, options) => {
      requests.push({ body, options });
      if (body.model === "gpt-6-luna") throw Object.assign(new Error("busy"), { status: 429 });
      return { content: [{ type: "thinking", thinking: "not completion text" }, { type: "text", text: "{\"save\":[]}" }] };
    } });
  assert.deepEqual(await complete({ system: "maintain", input: "files", maxTokens: 8192 }), { model: "claude-haiku-5.5", text: "{\"save\":[]}" });
  assert.deepEqual(requests.map((request) => request.body.model), ["gpt-6-luna", "claude-haiku-5.5"]);
  for (const { body, options } of requests) {
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.system, "maintain");
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: "user", content: "files" }]);
    assert.equal(options.remember, false);
    assert.equal(options.agent, true);
    assert.equal(options.fetchImpl, fetchImpl);
  }
  const { complete: failing } = createSummaryModel({ getAvailableModels: catalog(["gpt-6-luna"]), timeoutMs: 1000,
    requestModelImpl: (body, { control }) => new Promise((_, reject) => { control.abort = (message, status) => reject(Object.assign(new Error(message), { status })); }) });
  assert.equal(await failing({ system: "s", input: "i", timeoutMs: 20 }), null);
  assert.equal(await createSummaryModel({ getAvailableModels: catalog([]) }).complete({ system: "s", input: "i" }), null);
});

test("a saved custom prompt replaces the built-in system prompt for GPT and Claude, and null restores it", async () => {
  let prompt = "Custom summary prompt.";
  const systems = [];
  const { summarize } = createSummaryModel({ getAvailableModels: catalog(["gpt-6-luna", "claude-haiku-5.5"]), getPrompt: () => prompt,
    requestModelImpl: async (body) => {
      systems.push(body.system);
      if (body.model === "gpt-6-luna") throw Object.assign(new Error("busy"), { status: 429 });
      return { content: [{ type: "text", text: reply }] };
    } });
  assert.equal((await summarize("a\nb", null)).model, "claude-haiku-5.5");
  assert.deepEqual(systems, [prompt, prompt]);
  prompt = null;
  systems.length = 0;
  await summarize("a\nb", null);
  assert.deepEqual(systems, [DEFAULT_PROMPT, DEFAULT_PROMPT]);
  assert.match(DEFAULT_PROMPT, /Reply with JSON only/);
});

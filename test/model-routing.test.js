const test = require("node:test");
const assert = require("node:assert/strict");
const { selectModel, catalogModelId, toGatewayModels } = require("../lib/model-routing");

test("CLI explicit model and discovery aliases override settings", () => {
  const fallback = "gpt-5.4";
  for (const model of ["gpt-5.4", "openai/gpt-5", "claude-sonnet-4"]) {
    assert.equal(selectModel(model, fallback), model);
    assert.equal(selectModel("anthropic/" + model, fallback), model);
    assert.equal(selectModel("claude-gateway/" + model, fallback), "claude-gateway/" + model);
  }
  assert.equal(selectModel("anthropic/" + fallback, "gpt-5"), fallback);
  assert.equal(selectModel("claude-sonnet-5.5", fallback), "claude-sonnet-5.5");
  assert.equal(selectModel("claude-gateway/claude-opus-5.5", fallback), "claude-gateway/claude-opus-5.5");
  for (const alias of [undefined, "", "sonnet", "opus", "haiku"]) assert.equal(selectModel(alias, fallback), fallback);
});

test("gateway identity adds one namespace and keeps provider prefixes", () => {
  for (const [id, owner, expected] of [["gpt-6.1-sol", "openai", "anthropic/openai/gpt-6.1-sol"],
    ["openai/gpt-test", "openai", "anthropic/openai/gpt-test"], ["claude-sonnet-5.5", "github-copilot", "anthropic/claude-sonnet-5.5"],
    ["z-ai/glm-5.3-flash", "nvidia", "anthropic/z-ai/glm-5.3-flash"]]) {
    assert.equal(catalogModelId(id, owner), expected);
    assert.equal(catalogModelId(expected, owner), expected);
    assert.equal(selectModel(expected, "unused"), expected.slice("anthropic/".length));
  }
});

test("unknown capacity is not upgraded to 1M from a model-family name", () => {
  for (const id of ["gpt-6.1-sol", "gpt-6-luna", "openai/gpt-6-terra", "claude-sonnet-5.5", "claude-haiku-4.5", "unsupported-model"]) {
    const original = { data: [{ id }] };
    const entry = toGatewayModels(original).data[0];
    assert.equal(entry.id, "anthropic/" + id);
    assert.equal(entry.display_name, id.startsWith("claude-") ? "anthropic/" + id : id);
    assert.equal(selectModel(entry.id, "unused"), id);
    assert.equal(original.data[0].id, id);
  }
});

test("largest declared capacity wins across every metadata field without mutating the catalog", () => {
  const fields = [
    (tokens) => ({ context_window: tokens }),
    (tokens) => ({ max_context_window: tokens }),
    (tokens) => ({ runtime: { max_input_tokens: tokens, max_output_tokens: 64000 } }),
    (tokens) => ({ capabilities: { limits: { max_context_window_tokens: tokens, max_output_tokens: 32000 } } })
  ];
  for (const field of fields) {
    const original = { data: [{ id: "gpt-test[1m]", context_window: 500000, ...field(872000) }] };
    const snapshot = structuredClone(original);
    const entry = toGatewayModels(original).data[0];
    assert.equal(entry.context_window, 872000);
    assert.equal(entry.runtime.max_input_tokens, 872000);
    assert.equal(entry.capabilities.limits.max_context_window_tokens, 872000);
    assert.equal(entry.runtime.max_output_tokens, original.data[0].runtime?.max_output_tokens);
    assert.equal(entry.capabilities.limits.max_output_tokens, original.data[0].capabilities?.limits?.max_output_tokens);
    assert.equal(selectModel(entry.id, "unused"), "gpt-test");
    assert.deepEqual(original, snapshot);
  }
  for (const invalid of [null, 0, -1, NaN, Infinity, "2000000", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const entry = toGatewayModels({ data: [{ id: "gpt-test", context_window: invalid, max_context_window: 872000 }] }).data[0];
    assert.equal(entry.context_window, 872000);
  }
  assert.equal(toGatewayModels({ data: [{ id: "gpt-test", context_window: 872000, max_context_window: 500000 }] }).data[0].context_window, 872000);
});

test("an explicit upstream 1M ID stays intact when limits are unavailable", () => {
  const entry = toGatewayModels({ data: [{ id: "gpt-6-luna[1m]" }] }).data[0];
  assert.equal(entry.id, "anthropic/gpt-6-luna[1m]");
});

test("discovery list passes Claude filter with provider-qualified labels", () => {
  const original = { object: "list", data: [{ id: "gpt-5.4", owned_by: "openai" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot" }] };
  const result = toGatewayModels(original);
  assert.ok(result.data.every((model) => /claude|anthropic/i.test(model.id)));
  assert.equal(result.data[0].id, "anthropic/openai/gpt-5.4");
  assert.equal(result.data[0].display_name, "openai/gpt-5.4");
  assert.equal(result.data[1].id, "anthropic/claude-sonnet-5.5");
  assert.equal(result.data[1].display_name, "anthropic/claude-sonnet-5.5");
  assert.equal(result.data[0].description, "OpenAI Responses");
  assert.equal(result.data[1].description, "GitHub Copilot");
  assert.equal(original.data[0].id, "gpt-5.4");
});

test("catalog does not duplicate existing provider namespaces", () => {
  const { data } = toGatewayModels({ data: [
    { id: "openai/gpt-test", owned_by: "openai" },
    { id: "anthropic/claude-opus-5.5", owned_by: "github-copilot", context_window: 1000000 },
    { id: "openai/gpt-oss-120b", owned_by: "nvidia" }
  ] });
  assert.deepEqual(data.map(({ id, display_name }) => [id, display_name]), [
    ["anthropic/openai/gpt-test", "openai/gpt-test"],
    ["anthropic/claude-opus-5.5[1m]", "anthropic/claude-opus-5.5"],
    ["anthropic/openai/gpt-oss-120b", "openai/gpt-oss-120b"]
  ]);
});

test("catalog limits override family names and stale 1M suffixes without mutation", () => {
  const model = (id, tokens) => ({ id, capabilities: { limits: { max_context_window_tokens: tokens } } });
  const original = { data: [model("gpt-6.1-sol[1m]", 500000), model("claude-haiku-4.5", 200000), model("gpt-6-luna", 1000000),
    model("claude-haiku-5.5", 1000000)] };
  const entries = toGatewayModels(original).data;
  assert.deepEqual(entries.map((entry) => entry.display_name), ["gpt-6.1-sol", "anthropic/claude-haiku-4.5", "gpt-6-luna", "anthropic/claude-haiku-5.5"]);
  // Only a declared 1M Claude limit gets [1m]; GPT keeps its plain ID so CLAUDE_CODE_MAX_CONTEXT_TOKENS applies.
  assert.deepEqual(entries.map((entry) => entry.id),
    ["anthropic/gpt-6.1-sol", "anthropic/claude-haiku-4.5", "anthropic/gpt-6-luna", "anthropic/claude-haiku-5.5[1m]"]);
  assert.equal(entries[0].capabilities.limits.max_context_window_tokens, 500000);
  assert.equal(entries[0].context_window, 500000);
  assert.equal(entries[0].runtime.max_input_tokens, 500000);
  assert.equal(entries[2].runtime.max_input_tokens, 1000000);
  assert.equal(original.data[0].id, "gpt-6.1-sol[1m]");
  for (const value of [undefined, null, 0, -1, NaN, Infinity, "200000", 1.5]) {
    assert.equal(toGatewayModels({ data: [model("gpt-6-sol", value)] }).data[0].display_name, "gpt-6-sol");
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPiModels, piModel, resolveGatewayModel } = require("../lib/pi-registry");
const { requestPiModel } = require("../lib/pi-model");
const { claudeSse } = require("./helpers/claude-fixture");
const { eventsFor, jwt, payloadOf, sse } = require("./helpers/pi-fixture");

const route = { id: "arbitrary-name", owned_by: "github-copilot", api: "anthropic-messages", context_window: 352001 };

test("routing follows catalog metadata, not names", async () => {
  const resolve = async () => ({ data: [route] });
  assert.deepEqual(await resolveGatewayModel("anthropic/arbitrary-name", resolve), route);
  assert.equal(await resolveGatewayModel("claude-name-not-in-catalog", resolve), undefined);
  await assert.rejects(requestPiModel({ model: "gpt-unknown" }, { fetchImpl: () => assert.fail("must not connect") }), { status: 400 });
  const result = await requestPiModel({ model: route.id, messages: [{ role: "user", content: "hello" }] }, {
    route, loadAuth: async () => ({ token: "fixture", baseUrl: "https://copilot.example" }),
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://copilot.example/v1/messages");
      assert.deepEqual(JSON.parse(options.body).messages, [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }]);
      return claudeSse();
    }
  });
  assert.equal(result.content[0].text, "native reply");
});

test("Codex and Claude send the provider's full catalog ID, not the gateway display ID", async () => {
  for (const [id, api, owned_by, auth] of [
    ["openai/gpt-fixture", "openai-codex-responses", "openai", { kind: "codex", token: jwt("fixture"), accountId: "fixture" }],
    ["anthropic/claude-fixture", "anthropic-messages", "github-copilot", { token: "fixture", baseUrl: "https://copilot.example" }]
  ]) {
    const route = { id, api, owned_by };
    const model = await resolveGatewayModel(id.replace(/^anthropic\//, ""), async () => ({ data: [route] }));
    assert.strictEqual(model, route);
    await requestPiModel({ model: id.replace(/^anthropic\//, ""), messages: [{ role: "user", content: "hi" }] }, {
      route: model, loadAuth: async () => auth, remember: false,
      fetchImpl: async (_, options) => {
        assert.equal(payloadOf(options).model, id);
        return owned_by === "openai" ? sse(eventsFor()) : claudeSse();
      }
    });
  }
});

test("live context metadata overrides Pi's bundled capacity", async () => {
  const registry = await loadPiModels();
  const opts = { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
  const bundled = registry.getModel("openai", "gpt-5");
  assert.equal(piModel(registry, { id: "gpt-5" }, opts).contextWindow, bundled.contextWindow);
  assert.equal(piModel(registry, { id: "gpt-5", context_window: 352001 }, opts).contextWindow, 352001);
});

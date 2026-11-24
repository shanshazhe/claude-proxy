const test = require("node:test");
const assert = require("node:assert/strict");
const { getPromptCacheKey, getResponsesReasoning } = require("../lib/pi-options");

// Provider wire/conversion coverage now exercises the actual Pi runtime in pi-gpt.test.js.
test("prompt cache identity stays stable across turns and separates sessions", () => {
  const first = { metadata: { user_id: "session-a" }, messages: [{ role: "user", content: "hello" }] };
  const key = getPromptCacheKey(first);
  assert.equal(key, getPromptCacheKey({ ...first, messages: [...first.messages, { role: "assistant", content: "reply" }] }));
  assert.notEqual(key, getPromptCacheKey({ ...first, metadata: { user_id: "session-b" } }));
  assert.ok(!key.includes("session-a"));
  const previous = process.env.OPENAI_PROMPT_CACHE;
  process.env.OPENAI_PROMPT_CACHE = "0";
  try { assert.equal(getPromptCacheKey(first), undefined); }
  finally { if (previous === undefined) delete process.env.OPENAI_PROMPT_CACHE; else process.env.OPENAI_PROMPT_CACHE = previous; }
});

test("moving native cache annotations does not change fallback GPT cache identity", () => {
  const first = { system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }] };
  const next = { system: [{ type: "text", text: "instructions" }], tools: [{ name: "read", input_schema: { type: "object" } }] };
  assert.equal(getPromptCacheKey(first), getPromptCacheKey(next));
});

test("reasoning effort follows Pi model metadata, not its name", () => {
  const reasoning = { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(getResponsesReasoning({ model: "any-id", output_config: { effort } }, reasoning), { summary: "auto", effort });
  }
  assert.deepEqual(getResponsesReasoning({ output_config: { effort: "max" } }, { reasoning: true }), { summary: "auto", effort: "high" });
  assert.equal(getResponsesReasoning({ thinking: { type: "disabled" } }, reasoning), undefined);
  assert.equal(getResponsesReasoning({ output_config: { effort: "max" } }, { reasoning: false }), undefined);
});

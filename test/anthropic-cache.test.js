const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareClaudeCache, reportClaudeCacheUsage } = require("../lib/anthropic-cache");

const body = () => ({ model: "claude-sonnet-5.5", system: "private-system", tools: [{ name: "read", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "private-user" }] });

test("Claude fills Pi-style tool, system and last-user breakpoints without mutating input", () => {
  const original = body();
  const payload = prepareClaudeCache(original);
  for (const block of [payload.tools[0], payload.system[0], payload.messages[0].content[0]]) assert.deepEqual(block.cache_control, { type: "ephemeral" });
  assert.equal(original.system, "private-system");
  assert.equal(original.tools[0].cache_control, undefined);
  assert.deepEqual(prepareClaudeCache(payload), payload);
});

test("Claude preserves existing TTLs and nested markers without exceeding four points", () => {
  const original = body();
  original.system = [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }];
  original.messages = [{ role: "user", content: [{ type: "tool_result", content: [
    { type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "5m" } },
    { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "5m" } },
    { type: "text", text: "c", cache_control: { type: "ephemeral", ttl: "5m" } }
  ] }] }];
  const payload = prepareClaudeCache(original);
  assert.equal(payload.tools[0].cache_control, undefined);
  assert.equal(payload.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(payload, original);
  original.messages[0].content[0].content.pop();
  const filled = prepareClaudeCache(original);
  assert.deepEqual(filled.tools[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(filled.messages[0].content[0].cache_control, undefined);
});

test("Claude breakpoint TTL follows native tools-system-history ordering", () => {
  const original = body();
  original.system = [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }];
  original.messages[0].content = [{ type: "text", text: "earlier", cache_control: { type: "ephemeral", ttl: "5m" } }, { type: "text", text: "later" }];
  const payload = prepareClaudeCache(original);
  assert.equal(payload.tools[0].cache_control.ttl, "1h");
  assert.equal(payload.messages[0].content.at(-1).cache_control.ttl, undefined);
});

test("Claude automatic request caching and explicit disables are respected", () => {
  const original = { ...body(), cache_control: { type: "ephemeral" } };
  assert.equal(prepareClaudeCache(original), original);
  const old = process.env.CLAUDE_PROMPT_CACHE;
  process.env.CLAUDE_PROMPT_CACHE = "0";
  try { assert.equal(prepareClaudeCache(original), original); assert.equal(prepareClaudeCache(body()).system, "private-system"); }
  finally { if (old === undefined) delete process.env.CLAUDE_PROMPT_CACHE; else process.env.CLAUDE_PROMPT_CACHE = old; }
});

test("Claude reports merged native cache counters without logging content", () => {
  const stats = [];
  reportClaudeCacheUsage(prepareClaudeCache(body()), { input_tokens: 100, cache_read_input_tokens: 600,
    cache_creation_input_tokens: 300, output_tokens: 5 }, (usage) => stats.push(usage));
  assert.equal(stats.length, 1);
  assert.equal(stats[0].total_input_tokens, 1000);
  assert.equal(stats[0].cache_read_input_tokens, 600);
  assert.equal(stats[0].cache_creation_input_tokens, 300);
  assert.equal(stats[0].cache_hit_percent, 60);
  assert.equal(stats[0].uncached_input_tokens, 400);
  assert.equal(stats[0].regular_input_tokens, 100);
  assert.equal(stats[0].cache_breakpoints, 3);
  assert.ok(!JSON.stringify(stats).includes("private-"));
});

test("Claude cache diagnostics tolerate zero usage and failing callbacks", () => {
  reportClaudeCacheUsage(body(), {}, (stats) => { assert.equal(stats.cache_hit_percent, 0); });
  assert.doesNotThrow(() => reportClaudeCacheUsage(body(), {}, () => { throw Error("diagnostic failure"); }));
});

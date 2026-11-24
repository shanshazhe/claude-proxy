"use strict";

const { requestGpt } = require("./pi-gpt");
const { listCopilotResponsesModels, loadCopilotResponsesAuth } = require("./github-copilot");
const { pickModels } = require("./summary-model");
const { getModelCapabilities } = require("./pi-capabilities");

// Claude Code 内置 WebSearch 的独立请求：唯一的工具是 web_search_20250305。
// 上游执行 OpenAI Responses 原生搜索，再把真实的调用和来源转换成 Claude Code 读取的
// server_tool_use / web_search_tool_result；不伪造 encrypted_content，也不从正文里提取 URL。
const TOOL_TYPE = "web_search_20250305";
const TOOL_NAME = "web_search";
const SUPPORTED_OPTIONS = new Set(["type", "name", "allowed_domains", "blocked_domains", "max_uses", "search_profile", "cache_control"]);
// 只接受双方都能等价表示的裸域名；带协议、路径、端口或通配符的写法会被拒绝，而不是悄悄放宽。
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

// 返回 null（不是搜索请求）、{ error }（必须在请求上游前拒绝）或 { tool, maxUses }（上游原生搜索工具与调用上限）。
function parseWebSearchRequest(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const search = tools.filter((tool) => typeof tool?.type === "string" && /^web_search_/.test(tool.type));
  if (!search.length) return null;
  if (tools.length !== 1) return { error: "Built-in web search must be the only tool in its request; mixing it with other tools is not supported" };
  const [tool] = search;
  if (tool.type !== TOOL_TYPE || tool.name !== TOOL_NAME) return { error: `Unsupported web search tool ${tool.type}; only ${TOOL_TYPE} named ${TOOL_NAME} is supported` };
  // CLI 内部要求强制调用，但经网关发出时是 auto；这个请求只为搜索而发，上游始终强制搜索。
  const choice = body.tool_choice;
  if (choice && !["auto", "any"].includes(choice.type) && !(choice.type === "tool" && choice.name === TOOL_NAME)) {
    return { error: `tool_choice ${choice.type} is not supported for built-in web search` };
  }
  const unknown = Object.keys(tool).filter((key) => !SUPPORTED_OPTIONS.has(key));
  if (unknown.length) return { error: `Unsupported web search options: ${unknown.join(", ")}` };
  if (tool.max_uses !== undefined && !(Number.isInteger(tool.max_uses) && tool.max_uses > 0)) return { error: "web_search max_uses must be a positive integer" };
  if (tool.blocked_domains != null && (!Array.isArray(tool.blocked_domains) || tool.blocked_domains.length)) {
    return { error: "blocked_domains cannot be enforced by the upstream web search; use allowed_domains instead" };
  }
  const allowed = tool.allowed_domains ?? [];
  if (!Array.isArray(allowed) || allowed.some((domain) => typeof domain !== "string" || !DOMAIN.test(domain))) {
    return { error: "allowed_domains must be plain domain names such as example.com (no scheme, path, port or wildcard)" };
  }
  return {
    // search_profile "fast" 只是延迟提示，映射为实测可用的低搜索上下文；其他取值不映射。
    tool: { type: "web_search", ...(allowed.length ? { filters: { allowed_domains: allowed } } : {}), ...(tool.search_profile === "fast" ? { search_context_size: "low" } : {}) },
    maxUses: tool.max_uses
  };
}

// Copilot 的 Claude 端点会拒绝服务端搜索（"The use of the web search tool is not supported"），
// Claude 会话的搜索因此由同一 Copilot 登录下目录里最新的 Luna 在 /responses 上执行；GPT 会话沿用自己的模型和登录。
// 上游始终流式：Codex 端点不接受 max_tool_calls，max_uses 只能在第 max_uses + 1 次搜索出现时中止上游来执行。
async function runWebSearch(anthropicBody, search, { control = {}, onCacheUsage, requestGptImpl = requestGpt,
  listCopilotModels = listCopilotResponsesModels, capabilities = getModelCapabilities(anthropicBody.model) } = {}) {
  if (!capabilities.search) throw Object.assign(new Error(`Built-in web search is not supported for model ${anthropicBody.model || "(missing)"}`), { status: 400 });
  const copilot = capabilities.search === "copilot-responses";
  let model = anthropicBody.model;
  if (copilot) {
    model = pickModels(await listCopilotModels()).luna;
    if (!model) throw Object.assign(new Error("No Copilot GPT model on /responses is available for built-in web search"), { status: 502 });
  }
  const items = new Map();
  let started = 0;
  let capped = null;
  let terminal = null;
  let authKind = null;
  const adjustPayload = (payload, auth) => {
    authKind = auth.kind;
    payload.tools = [search.tool];
    payload.tool_choice = "required";
    payload.include = [...new Set([...(payload.include || []), "web_search_call.action.sources"])];
    payload.stream = true;
    // 只在实测接受的端点上发送原生上限。
    if (search.maxUses && auth.kind === "copilot") payload.max_tool_calls = search.maxUses;
  };
  const onProviderEvent = (event) => {
    if (event.type === "response.output_item.added" && event.item?.type === "web_search_call") {
      started++;
      if (search.maxUses && started > search.maxUses && !capped) {
        capped = event.item;
        control.abort?.("Web search max_uses exceeded", 502);
      }
    } else if (event.type === "response.output_item.done") {
      items.set(event.output_index, event.item);
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      terminal = event.response;
    }
  };
  let assembled = null;
  try {
    // The native search tool is installed by adjustPayload, not converted into
    // a user function by the Anthropic/Pi transcript adapter.
    const { tools, tool_choice, ...body } = anthropicBody;
    assembled = await requestGptImpl({ ...body, model, stream: false }, {
      control, remember: false, adjustPayload, onProviderEvent, onCacheUsage, ...(copilot ? { loadAuth: loadCopilotResponsesAuth } : {})
    });
  } catch (error) {
    if (!capped) throw error;
  }
  // Codex 的 response.completed 可能带空 output，已完成的条目要从流里恢复。
  const output = !capped && terminal?.output?.length ? terminal.output : [...items].sort(([a], [b]) => a - b).map(([, item]) => item);
  return { ...toAnthropicContent(output, capped), model, authKind, capped: Boolean(capped), usage: assembled?.usage || null };
}

function httpUrl(value) {
  try { return typeof value === "string" && /^https?:$/.test(new URL(value).protocol); } catch (_) { return false; }
}
// 引用里的 URL 常带 utm_source=openai，按去掉它和锚点后的地址与来源匹配标题。
function urlKey(value) {
  const url = new URL(value);
  url.searchParams.delete("utm_source");
  url.hash = "";
  return url.href;
}

// 每个真实的 web_search_call 变成配对的 server_tool_use 与 web_search_tool_result；命中只来自上游 action.sources
// 中的 URL 来源，标题取自上游 url_citation，没有时直接显示 URL。没有任何搜索调用时视为失败，而不是空结果。
function toAnthropicContent(output, capped = null) {
  const titles = new Map();
  for (const item of output) {
    if (item?.type !== "message") continue;
    for (const note of (item.content || []).flatMap((part) => part?.annotations || [])) {
      if (note?.type === "url_citation" && httpUrl(note.url) && typeof note.title === "string" && note.title.trim()) {
        if (!titles.has(urlKey(note.url))) titles.set(urlKey(note.url), note.title.trim());
      }
    }
  }
  const content = [];
  const ids = new Set();
  let searches = 0;
  let hits = 0;
  const addCall = (item) => {
    let id = "srvtoolu_" + String(item?.id || "").replace(/[^A-Za-z0-9_]/g, "");
    if (id === "srvtoolu_" || ids.has(id)) id = `srvtoolu_proxy_${ids.size}`;
    ids.add(id);
    const action = item?.action || {};
    // 只使用上游实际给出的查询；没有时输入留空，CLI 仍用它自己的原始查询作标签。
    const query = typeof action.query === "string" && action.query ? action.query
      : Array.isArray(action.queries) && typeof action.queries[0] === "string" && action.queries[0] ? action.queries[0] : null;
    content.push({ type: "server_tool_use", id, name: TOOL_NAME, input: query ? { query } : {} });
    searches++;
    return id;
  };
  const error = (id, code) => content.push({ type: "web_search_tool_result", tool_use_id: id, content: { type: "web_search_tool_result_error", error_code: code } });
  for (const item of output) {
    if (item?.type === "web_search_call") {
      // open_page / find_in_page 是对已有结果的后续浏览，没有对应的 Anthropic 块；它们的内容体现在总结里。
      if (item.action?.type && item.action.type !== "search") continue;
      const id = addCall(item);
      const sources = item.action?.sources;
      if (item.status !== "completed" || !Array.isArray(sources)) { error(id, "unavailable"); continue; }
      const results = [];
      const seen = new Set();
      for (const source of sources) {
        if (source?.type !== "url" || !httpUrl(source.url) || seen.has(urlKey(source.url))) continue;
        seen.add(urlKey(source.url));
        results.push({ type: "web_search_result", url: source.url, title: titles.get(urlKey(source.url)) || source.url });
      }
      hits += results.length;
      content.push({ type: "web_search_tool_result", tool_use_id: id, content: results });
    } else if (item?.type === "message") {
      const text = (item.content || []).map((part) => part?.type === "output_text" && typeof part.text === "string" ? part.text : "").join("");
      if (text.trim()) content.push({ type: "text", text });
    }
  }
  if (capped) error(addCall(capped), "max_uses_exceeded");
  if (!searches) throw Object.assign(new Error("The upstream model answered without performing a web search"), { status: 502 });
  return { content, searches, hits };
}

function toAnthropicMessage(result, model) {
  const usage = result.usage || {};
  return {
    id: "msg_" + Date.now(), type: "message", role: "assistant", model, content: result.content, stop_reason: "end_turn", stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      ...(usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
      server_tool_use: { web_search_requests: result.searches }
    }
  };
}

// message_start 之后的事件：调用块的输入经 input_json_delta 送出，结果块在 start 中携带完整内容。
function toAnthropicEvents(message) {
  const events = [];
  message.content.forEach((block, index) => {
    if (block.type === "server_tool_use") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    } else if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage }],
    ["message_stop", { type: "message_stop" }]);
  return events;
}

module.exports = { parseWebSearchRequest, runWebSearch, toAnthropicContent, toAnthropicMessage, toAnthropicEvents };

const { requestPiModel } = require("./pi-model");
const { getGatewayModel } = require("./pi-registry");

const SUMMARY_TIMEOUT_MS = 30000;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_HIGHLIGHTS = 20;
const MAX_HIGHLIGHT_LINES = 40;
// 主模型依赖这份结果而不是自己翻原文，所以要求尽量完整地给出可直接使用的信息和行号。
const PROMPT = [
  "You compress a large tool output for an expensive coding model. It relies on your answer instead of reading the original,",
  "so include everything it would otherwise have to search for. Lines are prefixed with their 1-based line number and a colon.",
  "summary (at most 1500 characters): what ran and its outcome (exit status, pass/fail totals, final result); every distinct",
  "error, failure or warning with its message, file:line location and the input line number; key values the task likely needs",
  "(versions, counts, IDs, paths, timings). Group repeated identical errors and give their count and line range.",
  "If nothing notable happened, say so and state the final result.",
  "highlights: line ranges the coding model should see verbatim: each distinct error with its stack trace and a few lines of",
  "context before it, failing test names and assertions, and the final result or summary lines.",
  `Most important first; at most ${MAX_HIGHLIGHTS} ranges of at most ${MAX_HIGHLIGHT_LINES} lines each.`,
  'Reply with JSON only: {"summary": "...", "highlights": [{"start": <line>, "end": <line>, "reason": "<short reason>"}]}',
  "Line numbers must refer to the numbered input. Do not invent content."
].join("\n");

const versionOf = (id) => (id.match(/\d+/g) || []).map(Number);
function newest(ids) {
  return ids.sort((a, b) => {
    const left = versionOf(a);
    const right = versionOf(b);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      if ((right[index] || 0) !== (left[index] || 0)) return (right[index] || 0) - (left[index] || 0);
    }
    return 0;
  })[0];
}

function pickModels(ids) {
  return {
    luna: newest(ids.filter((id) => /luna/i.test(id))),
    haiku: newest(ids.filter((id) => /^claude-haiku-/i.test(id)))
  };
}

// 行号与 Read 工具一致；超长输出保留头尾，并注明省略的行号范围。
function numberedInput(text, call) {
  const lines = text.split("\n").map((line, index) => `${index + 1}: ${line}`);
  let body = lines.join("\n");
  if (Buffer.byteLength(body) > MAX_INPUT_BYTES) {
    const half = MAX_INPUT_BYTES / 2;
    let head = 0;
    for (let bytes = 0; head < lines.length && bytes + Buffer.byteLength(lines[head]) < half; head++) bytes += Buffer.byteLength(lines[head]) + 1;
    let tail = lines.length;
    for (let bytes = 0; tail > head && bytes + Buffer.byteLength(lines[tail - 1]) < half; tail--) bytes += Buffer.byteLength(lines[tail - 1]) + 1;
    body = [...lines.slice(0, head), `[lines ${head + 1}-${tail} omitted]`, ...lines.slice(tail)].join("\n");
  }
  const input = JSON.stringify(call?.input || {}).slice(0, 1000);
  // 小输出要求更短的总结，否则替换后省不下多少。
  const limit = Math.min(1500, Math.max(300, Math.floor(Buffer.byteLength(text) / 8)));
  return `Tool: ${call?.name || "unknown"}\nTool input: ${input}\nTotal lines: ${lines.length}\nKeep the summary under ${limit} characters.\n\n${body}`;
}

function parseSummary(content, lineCount) {
  const start = content.indexOf("{");
  const parsed = JSON.parse(content.slice(start, content.lastIndexOf("}") + 1));
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) throw new Error("Summary is missing");
  const highlights = (Array.isArray(parsed.highlights) ? parsed.highlights : [])
    .filter((item) => Number.isInteger(item?.start) && Number.isInteger(item?.end) &&
      item.start >= 1 && item.start <= item.end && item.start <= lineCount)
    .slice(0, MAX_HIGHLIGHTS)
    .map((item) => ({ start: item.start, end: Math.min(item.end, lineCount, item.start + MAX_HIGHLIGHT_LINES - 1),
      reason: typeof item.reason === "string" ? item.reason.slice(0, 200) : "" }));
  return { summary: parsed.summary.trim().slice(0, 2000), highlights };
}

const isSummaryModel = (model) => ["openai-responses", "openai-codex-responses", "anthropic-messages"].includes(model?.api);

function createSummaryModel({ getAvailableModels, getPreferredModel = () => null, getPrompt = () => null, requestModelImpl = requestPiModel, fetchImpl = fetch,
  timeoutMs = SUMMARY_TIMEOUT_MS, onEvent = () => {}, onWarning = () => {} }) {
  let models;

  // 首次成功选出 Luna/Haiku 后缓存到进程重启；目录暂不可用时下次再查。
  async function resolveModels() {
    if (models) return models;
    const catalog = await getAvailableModels();
    const rows = (catalog?.data || []).filter(isSummaryModel);
    const picked = { ...pickModels(rows.map((model) => model.id)), rows };
    if (picked.luna || picked.haiku) models = picked;
    return picked;
  }

  async function callModel(model, input, signal, prompt, maxTokens = 2048) {
    const control = {};
    signal.addEventListener("abort", () => control.abort?.("Summary model timed out", 504), { once: true });
    const route = getGatewayModel(model) || (await resolveModels()).rows.find((row) => row.id === model);
    const result = await requestModelImpl({ model, stream: false, max_tokens: maxTokens,
      system: prompt, messages: [{ role: "user", content: input }] }, { control, remember: false, agent: true, fetchImpl, route });
    return (result.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
  }

  // 返回 { model, summary, highlights }；用户选择的模型优先，失败再依次尝试 Luna、Haiku；全部失败时返回 null，由调用方保留原文。
  async function summarize(text, call) {
    let picked;
    try { picked = await resolveModels(); } catch (_) { picked = {}; }
    const preferred = getPreferredModel();
    const candidates = [...new Set([preferred, picked.luna, picked.haiku])].filter((id) => id &&
      isSummaryModel(getGatewayModel(id) || picked.rows?.find((row) => row.id === id)));
    // 页面保存的提示词每次重新读取；未设置时使用内置默认值。
    const prompt = getPrompt() || PROMPT;
    const input = numberedInput(text, call);
    const lineCount = text.split("\n").length;
    for (const model of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      try {
        const result = parseSummary(await callModel(model, input, controller.signal, prompt), lineCount);
        onEvent({ model, input_bytes: Buffer.byteLength(text), highlights: result.highlights.length, ms: Date.now() - started });
        return { model, ...result };
      } catch (error) {
        onWarning({ model, status: error.status || (controller.signal.aborted ? 504 : 502), ms: Date.now() - started });
      } finally { clearTimeout(timer); }
    }
    return null;
  }

  // 后台任务（项目记忆维护）用：只按 Luna、Haiku 顺序尝试，返回第一个非空回复 { model, text }；全部失败返回 null。
  async function complete({ system, input, maxTokens = 2048, timeoutMs: limit = timeoutMs }) {
    let picked;
    try { picked = await resolveModels(); } catch (_) { picked = {}; }
    for (const model of [picked.luna, picked.haiku].filter(Boolean)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limit);
      try {
        const text = await callModel(model, input, controller.signal, system, maxTokens);
        if (typeof text === "string" && text.trim()) return { model, text };
      } catch (_) { /* 换下一个模型。 */ } finally { clearTimeout(timer); }
    }
    return null;
  }

  // 页面下拉框：默认选中探测到的便宜模型，可选项为当前目录中能调用的模型。
  async function getDefaultModel() {
    try {
      const picked = await resolveModels();
      return picked.luna || picked.haiku || null;
    } catch (_) { return null; }
  }
  async function listModels() {
    try {
      const catalog = await getAvailableModels();
      return [...new Set((catalog?.data || []).filter(isSummaryModel).map((model) => model.id))].sort();
    } catch (_) { return []; }
  }

  return { summarize, complete, getDefaultModel, listModels };
}

module.exports = { createSummaryModel, pickModels, numberedInput, parseSummary, MAX_INPUT_BYTES, DEFAULT_PROMPT: PROMPT };

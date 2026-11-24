"use strict";

const zlib = require("node:zlib");
const jwt = (id) => `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`;
const text = (value = "你好🙂") => ({ type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: value, annotations: [] }] });
function eventsFor(output = [text()], terminal = {}) {
  return [...output.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "message" ? { content: [] } : item.type === "function_call" ? { arguments: "" } : {}) } },
    ...(item.type === "message" ? [{ type: "response.output_text.delta", output_index, delta: item.content.map((part) => part.text || part.refusal).join("") }]
      : item.type === "reasoning" ? (item.summary || []).flatMap((part, summary_index) => [
        { type: "response.reasoning_summary_text.delta", output_index, summary_index, delta: part.text },
        { type: "response.reasoning_summary_part.done", output_index, summary_index }]) : []),
    { type: "response.output_item.done", output_index, item }
  ]), { type: "response.completed", response: { id: "resp_test", status: "completed", output: [],
    usage: { input_tokens: 2000, output_tokens: 12, input_tokens_details: { cached_tokens: 1536 } }, ...terminal } }];
}
function sse(events, fragmented = false) {
  const bytes = Buffer.from(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    const end = fragmented ? offset + 1 : bytes.length;
    controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
function payloadOf(options) {
  return JSON.parse(new Headers(options.headers).get("content-encoding") === "zstd" ? zlib.zstdDecompressSync(options.body).toString() : options.body);
}
module.exports = { eventsFor, sse, payloadOf, jwt, text };

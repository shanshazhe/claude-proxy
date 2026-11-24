"use strict";

function claudeEvents({ model = "claude-sonnet-5.5", blocks = [{ type: "text", text: "native reply" }],
  usage = { input_tokens: 36, cache_read_input_tokens: 64, output_tokens: 1 },
  delta = { stop_reason: "end_turn", stop_sequence: null }, finalUsage = { output_tokens: 3 } } = {}) {
  return [{ type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model,
    content: [], stop_reason: null, stop_sequence: null, usage } },
  ...blocks.flatMap((block, index) => {
    const start = { ...block };
    const changes = [];
    if (block.type === "text") {
      start.text = "";
      changes.push({ type: "text_delta", text: block.text });
    } else if (block.type === "thinking") {
      start.thinking = ""; start.signature = "";
      if (block.thinking) changes.push({ type: "thinking_delta", thinking: block.thinking });
      if (block.signature) changes.push({ type: "signature_delta", signature: block.signature });
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      start.input = {};
      changes.push({ type: "input_json_delta", partial_json: JSON.stringify(block.input) });
    }
    return [{ type: "content_block_start", index, content_block: start },
      ...changes.map((delta) => ({ type: "content_block_delta", index, delta })), { type: "content_block_stop", index }];
  }), { type: "message_delta", delta, usage: finalUsage }, { type: "message_stop" }];
}
function claudeSse(events = claudeEvents(), headers = {}) {
  return new Response(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""),
    { headers: { "content-type": "text/event-stream", ...headers } });
}

module.exports = { claudeEvents, claudeSse };

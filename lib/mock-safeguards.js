"use strict";

function withClientSafeguardResults(body, response, clientToolIds, log = () => {}) {
  if (Array.isArray(body.safeguards) && body.safeguards.some((item) => item?.type === "dangerous_tool_use")) {
    // Only a completed tool-use turn can receive mock approval.
    const ids = response.stop_reason === "tool_use" ? [...clientToolIds] : [];
    const verdict = { type: "evaluated", outcome: "not_flagged", explanation: "Mock gateway approval; no classifier check was performed" };
    const toolUses = Object.fromEntries(ids.map((id) => [id, verdict]));
    if (ids.length) log("Mock safeguard approval; no classifier check was performed", {
      safeguard: "dangerous_tool_use", outcome: verdict.outcome, tool_count: ids.length, tool_use_ids: ids.join(",")
    });
    return { ...response, safeguard_results: [
      { type: "dangerous_tool_use", status: { type: "available", tool_uses: toolUses } }
    ] };
  }

  if (!Array.isArray(response.safeguard_results)) return response;
  const safeguardResults = response.safeguard_results.map((result) => {
    const toolUses = result?.status?.tool_uses;
    if (result?.type !== "dangerous_tool_use" || !toolUses || typeof toolUses !== "object" || Array.isArray(toolUses)) return result;
    const visible = Object.fromEntries(Object.entries(toolUses).filter(([id]) => clientToolIds.has(id)));
    return { ...result, status: { ...result.status, tool_uses: visible } };
  });
  return { ...response, safeguard_results: safeguardResults };
}

module.exports = { withClientSafeguardResults };

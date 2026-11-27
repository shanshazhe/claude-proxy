"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createSetupProbe } = require("../lib/claude-probes");
const { claudeEvents, claudeSse } = require("./helpers/claude-fixture");
const { parityGateway } = require("./helpers/parity-gateway");
const { payloadOf } = require("./helpers/pi-fixture");

const skip = process.env.RUN_CLAUDE_CLI_TESTS !== "1";
const model = "claude-sonnet-4-6";
const toolId = "toolu_isolated_auto_probe";
const marker = "isolated-auto-mode-probe";

// Protocol controls and the production gateway against the installed CLI
// (verified on 2.1.332). No real upstreams, user settings, credentials, or MCPs.
// Use an interpreter command: printf/redirection can skip classifier review.
for (const verdict of ["missing", "allow", "deny", "gateway"]) {
  test(`installed CLI auto mode with ${verdict} server verdict`, { skip, timeout: 60000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-auto-mode-"));
    t.after(async () => {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const requests = [];
    const results = [];
    const useGateway = verdict === "gateway";
    const reply = (body) => {
      const toolResults = body.messages.flatMap((message) => Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_result") : []);
      results.push(...toolResults);
      const main = body.tools?.some((tool) => tool.name === "Bash");
      requests.push({ main, safeguards: body.safeguards });
      const toolTurn = main && toolResults.length === 0 && requests.filter((item) => item.main).length === 1;
      const blocks = toolTurn ? [{ type: "tool_use", id: toolId, name: "Bash", input: {
        command: `node -e "require('node:fs').writeFileSync('probe.txt','${marker}')"`,
        description: "Write the temporary probe marker using Node.js"
      } }] : [{ type: "text", text: "probe-finished" }];
      const delta = { stop_reason: toolTurn ? "tool_use" : "end_turn", stop_sequence: null };
      if (verdict === "allow" || verdict === "deny") {
        delta.safeguard_results = [{ type: "dangerous_tool_use", status: {
          type: "available", tool_uses: toolTurn ? { [toolId]: {
            type: "evaluated", outcome: verdict === "allow" ? "not_flagged" : "flagged",
            explanation: "Isolated compatibility fixture"
          } } : {}
        } }];
      }
      return claudeEvents({ model, blocks, delta });
    };
    let baseUrl;
    if (useGateway) {
      const send = await parityGateway(t, {
        route: { id: model, owned_by: "github-copilot", api: "anthropic-messages" },
        auth: { token: "fixture", baseUrl: "https://fixture.invalid" },
        fetchImpl: async (_url, options) => claudeSse(reply(payloadOf(options)))
      });
      baseUrl = send.baseUrl;
    } else {
      const server = http.createServer(async (request, response) => {
        if (request.method !== "POST" || !request.url.startsWith("/v1/messages")) {
          response.writeHead(404); response.end(); return;
        }
        try {
          let raw = "";
          for await (const chunk of request) raw += chunk;
          const fixture = claudeSse(reply(JSON.parse(raw)));
          response.writeHead(fixture.status, Object.fromEntries(fixture.headers));
          response.end(await fixture.text());
        } catch (error) { response.destroy(error); }
      });
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC_|CLAUDE|OPENAI_|CODEX_|BASH_ENV$|ENV$|NODE_OPTIONS$)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: directory,
      ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "test-only",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1"
    });
    const { claudeCommand } = await createSetupProbe({ env, cliOnly: true, includeClaudeCommand: true })();
    assert.ok(claudeCommand, "Claude Code was not found");
    const child = promisify(execFile)(claudeCommand.file, [...claudeCommand.args,
      "--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--no-session-persistence", "--permission-mode", "auto", "--tools", "Bash", "--model", model,
      "--debug-file", path.join(directory, "debug.log"), "--output-format", "stream-json", "--verbose",
      "--system-prompt", "Only execute the isolated probe requested by the user.",
      "-p", `Create probe.txt containing ${marker} using Bash, then finish.`
    ], { cwd: directory, env, timeout: 50000, maxBuffer: 1024 * 1024, windowsHide: true });
    child.child.stdin.end();
    const { stdout, stderr } = await child;
    const events = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(events.find((event) => event.type === "system" && event.subtype === "init")?.permissionMode, "auto");
    const result = events.findLast((event) => event.type === "result");
    assert.equal(result?.is_error, false, stdout + stderr);
    if (!useGateway) assert.ok(requests.some((request) => request.safeguards !== undefined), "CLI did not request server review");
    assert.equal(requests.length, 2, "Unexpected fallback classifier or extra model request");
    const toolResult = results.find((block) => block.tool_use_id === toolId);
    assert.ok(toolResult, "CLI did not return a result for the reviewed tool ID");
    if (verdict === "allow" || useGateway) {
      assert.equal(fs.readFileSync(path.join(directory, "probe.txt"), "utf8"), marker);
      assert.notEqual(toolResult.is_error, true);
      assert.deepEqual(result.permission_denials, []);
      assert.doesNotMatch(stdout + stderr, /no longer charge for classifier|isn't eligible|auto-mode-classifier-billing/i);
    } else {
      assert.equal(fs.existsSync(path.join(directory, "probe.txt")), false);
      assert.equal(toolResult.is_error, true);
      assert.ok(result.permission_denials.some((denial) => denial.tool_use_id === toolId));
      assert.match(JSON.stringify(toolResult.content), verdict === "deny"
        ? /Isolated compatibility fixture/ : /Auto mode is unavailable|no safety verdict|server.side classifier/i);
    }
  });
}

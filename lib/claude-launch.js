// GPT capacity is set at startup, not updated by /model. No CLI settings are injected.
const { spawn } = require("child_process");
const { createSetupProbe } = require("./claude-probes");
const { selectModel, toGatewayModelId } = require("./model-routing");
const { isClaudeModel } = require("./github-copilot");
const { defaultStore } = require("./credential-store");
const { readCredentialAvailability } = require("./pi-auth");

const baseId = (id) => typeof id === "string" ? selectModel(id, "").replace(/\[1m\]$/i, "") : "";
const optionsOf = (args) => args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
// Skip required option values, even when their text looks like --model. No values are parsed.
const valueOptions = new Set((
  "--add-dir --agent --agents --allowedTools --allowed-tools --append-system-prompt --autocompact " +
  "--betas --debug-file --disallowedTools --disallowed-tools --effort --environment --fallback-model " +
  "--file --input-format --json-schema --max-budget-usd --mcp-config -n --name --output-format " +
  "--permission-mode --permission-prompts --plugin-dir --plugin-url --remote-control-session-name-prefix " +
  "--session-id --setting-sources --settings --system-prompt --system-prompt-snapshot --tools"
).split(" "));

const nonSessionCommands = new Set((
  "agents attach auth auto-mode doctor gateway import install logs mcp plugin plugins purge respawn rm " +
  "setup-token stop kill ultrareview update upgrade help"
).split(" "));

function isNonSession(args) {
  const options = optionsOf(args);
  for (let index = 0; index < options.length; index++) {
    const arg = options[index];
    if (["--version", "-v", "--help", "-h"].includes(arg)) return true;
    if (valueOptions.has(arg) || arg === "--model") index++;
    else if (valueOptions.has(arg.split("=")[0]) || arg.startsWith("--model=")) continue;
    // Unknown/optional flags may consume a prompt. Leave their interpretation to the CLI.
    else return nonSessionCommands.has(arg);
  }
  return false;
}

function buildLaunch(catalog, args, env) {
  if (isNonSession(args)) return { args, env, warnings: [] };
  if (!Array.isArray(catalog?.data) || !catalog.data.length || catalog.data.some((model) =>
    !model || typeof model.id !== "string" || !model.id.trim())) throw new Error("Invalid model catalog");
  const rows = catalog.data.map((model) => {
    const id = baseId(model.id);
    return { gpt: !isClaudeModel(id), tokens: Number.isSafeInteger(model.context_window) && model.context_window > 0 ? model.context_window : undefined, id,
      model: isClaudeModel(id) ? model.id.replace(/\[1m\]$/i, "") + (model.context_window >= 1000000 ? "[1m]" : "") : toGatewayModelId(id) };
  });
  const options = optionsOf(args);
  let flag = -1;
  for (let index = 0; index < options.length; index++) {
    const arg = options[index];
    if (arg === "--model") { flag = index; index++; }
    else if (arg.startsWith("--model=")) flag = index;
    else if (valueOptions.has(arg)) index++;
  }
  const requested = flag < 0 ? env.ANTHROPIC_MODEL
    : args[flag] === "--model" ? args[flag + 1] : args[flag].slice("--model=".length);
  const selected = rows.find((row) => row.id === baseId(requested));
  const nextArgs = [...args];
  if (selected && flag < 0) nextArgs.splice(options.length, 0, "--model", selected.model);
  else if (selected) nextArgs.splice(flag, args[flag] === "--model" ? 2 : 1, "--model", selected.model);
  const gptTokens = rows.filter((row) => row.gpt && row.tokens).map((row) => row.tokens);
  const sharedTokens = gptTokens.length ? Math.min(...gptTokens) : undefined;
  const tokens = selected?.gpt ? selected.tokens
    : (selected?.tokens || (flag < 0 && !requested)) ? sharedTokens : undefined;
  return { args: nextArgs, env: { ...env,
    ...(!env.CLAUDE_CODE_MAX_CONTEXT_TOKENS && tokens ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(tokens) } : {}) },
    warnings: new Set(gptTokens).size > 1 ? ["GPT context limits differ. This process uses one limit; /model does not update it."] : [] };
}

async function main({ args = process.argv.slice(2), env = process.env, fetchImpl = fetch, spawnImpl = spawn,
  probe, store = defaultStore } = {}) {
  const ignoreInterrupt = () => {};
  const hasGptCredentials = () => {
    try { return readCredentialAvailability({ env, store }).openai; }
    catch (_) { return false; }
  };
  try {
    let launch = { args, env };
    let catalogUnavailable = false;
    const eligible = !isNonSession(args) && hasGptCredentials();
    if (eligible) {
      try {
        const base = env.ANTHROPIC_BASE_URL || "http://localhost:8082";
        const response = await fetchImpl(base.replace(/\/+$/, "") + "/v1/models", { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error("Catalog HTTP error");
        launch = buildLaunch(await response.json(), args, env);
      } catch (_) { catalogUnavailable = true; }
    }
    const { claudeCommand } = await (probe || createSetupProbe({ env, includeClaudeCommand: true }))();
    if (!claudeCommand) throw new Error("Claude CLI not found");
    // Discovery and CLI probing can yield to logout; only adopt catalog results after both finish.
    if (eligible && hasGptCredentials()) {
      if (catalogUnavailable) console.error("claude-launch: model catalog unavailable; keeping the original CLI arguments and context behavior.");
      for (const warning of launch.warnings || []) console.error(`claude-launch: ${warning}`);
    } else launch = { args, env };
    process.on("SIGINT", ignoreInterrupt);
    return await new Promise((resolve, reject) => {
      const child = spawnImpl(claudeCommand.file, [...claudeCommand.args, ...launch.args], { stdio: "inherit", env: launch.env, shell: false });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } catch (_) {
    console.error("claude-launch: could not start Claude; check the CLI installation and PATH.");
    return 1;
  } finally {
    process.removeListener("SIGINT", ignoreInterrupt);
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { buildLaunch, main };

# claude-proxy

A local gateway for Claude Code. Access GPT through ChatGPT / Codex device authorization or an OpenAI API key, and access Claude through GitHub Copilot device authorization. Includes dynamic model discovery, a local login page, protected Claude CLI routing and Statusline setup, optional current-user macOS service registration, gateway-maintained Project Code Memory, tool and image conversion, streaming responses, Online Summary of large tool outputs, and comprehensive cache compatibility.

## Contents

- [Overview and architecture](#overview-and-architecture)
- [Prerequisites](#prerequisites)
- [Starting the proxy](#starting-the-proxy)
- [Login and credentials](#login-and-credentials)
- [Configuring Claude CLI](#configuring-claude-cli)
- [Configuring Statusline](#configuring-statusline)
- [Registering a macOS service](#registering-a-macos-service)
- [Gateway-maintained Project Code Memory](#gateway-maintained-project-code-memory)
- [Installing Coding Discipline](#installing-coding-discipline)
- [Model selection and API](#model-selection-and-api)
- [Streaming, tools, images, and reasoning](#streaming-tools-images-and-reasoning)
- [Built-in WebSearch](#built-in-websearch)
- [Cache behavior](#cache-behavior)
- [Online Summary](#online-summary)
- [Environment variables](#environment-variables)
- [Security and troubleshooting](#security-and-troubleshooting)
- [Offline tests](#offline-tests)
- [License](#license)

## Overview and architecture

```text
Claude Code / Anthropic Messages client
                    │
             127.0.0.1:8082
                    │
          POST /v1/messages
           ┌────────┴─────────────┐
           │                      │
       GPT models             Claude models
   OpenAI Responses      Native Anthropic Messages
           │                      │
 OpenAI API or Codex        GitHub Copilot
```

- GPT requests are converted to the Responses API, and responses are converted back to Anthropic Messages / SSE.
- Claude requests use Copilot's native Messages endpoint, preserving thinking, signatures, tool events, and cache usage.
- `/v1/models` merges the two dynamic catalogs available to the current credentials. There is no bundled static account model list.
- `/login` manages local device authorization, CLI routing, Statusline setup, Online Summary settings, optional macOS service registration, and the gateway-maintained Project Code Memory switch. It does not collect account passwords.
- The proxy uses CommonJS and Node.js built-in modules; there is no build step or npm runtime dependency.

Source layout: `lib/` contains provider, login, secure storage, setup, and cache modules; `web/login.html` is the local page; `mac/` and `windows/` contain platform proxies and launchers; `scripts/` contains feature-toggle utilities; and `test/` contains offline tests. The two `proxy.js` files are identical.

## Prerequisites

1. **Node.js 18.17 or newer.** A currently supported Node.js LTS release is recommended. The implementation requires built-in `fetch`, Web Streams, `structuredClone`, and related APIs.
2. To use the CLI configuration button, install **Claude Code** first and ensure the CLI can be found by the version probe. The gateway does not install it automatically.
3. At least one type of upstream access:
   - A ChatGPT account that supports Codex device authorization and the requested models, or an OpenAI API key with API quota.
   - A GitHub account with Copilot access and permission to use the selected Claude model.
4. Network access to the relevant official authorization and API services, and an available local port **8082**.

Successful login does not grant access to every model. Subscriptions, organization policies, model availability, regions, and quotas are controlled by the upstream service; the gateway does not bypass these restrictions. ChatGPT subscriptions and OpenAI API billing are separate access methods.

## Starting the proxy

Run the following commands from the project root.

### macOS / Linux

```bash
node --version
bash mac/start-proxy.sh
```

Or run the proxy directly:

```bash
node mac/proxy.js
```

The launcher runs the proxy in the foreground. Keep the terminal open and press `Ctrl+C` to stop it. Then open:

```text
http://127.0.0.1:8082/login
```

### Windows

From Command Prompt:

```bat
node --version
windows\start-proxy.bat
```

The batch launcher uses `start /min node` to start a separate process. To view logs and stop the proxy explicitly, run it in the foreground instead:

```bat
node windows\proxy.js
```

Open `http://127.0.0.1:8082/login`. The launchers do not install services or modify CLI settings; configuration is performed explicitly through the page button.

The proxy listens only on `127.0.0.1:8082`. There is no environment variable for changing the port or enabling a remote listener. Do not start both platform proxies at once.

After listening succeeds on **macOS + zsh or Windows PowerShell**, the proxy automatically checks/installs the [capacity launcher function](#automatic-gpt-capacity-on-session-start) in `~/.zshrc` or Windows PowerShell's `$PROFILE.CurrentUserAllHosts`. An identical existing block is adopted without rewriting the file or creating a backup. Linux skips this installation without reading shell or feature configuration files. Installation conflicts only warn; they do not stop the proxy. A failed port bind never triggers shell installation.

## Login and credentials

### ChatGPT / Codex device authorization

1. Click **Login ChatGPT** on `/login`.
2. Copy the device code and open the official OpenAI authorization link shown on the page.
3. Complete authorization at `https://auth.openai.com/codex/device`. Enter your account password only on the official website.
4. Return to the local page and wait for polling to report completion. Start again if the code expires or authorization fails.

Device login stores an `openai-codex` credential. Expired credentials are refreshed automatically at runtime, and Codex requests use the ChatGPT account ID from the token.

### GitHub Copilot device authorization

1. Click **Login Copilot** and copy the device code.
2. Complete GitHub authorization at `https://github.com/login/device`.
3. The local page polls the flow. After authorization, the proxy validates Copilot access and saves the credentials.

The proxy exchanges the GitHub login token for a short-lived Copilot API token. Copilot Claude models remain subject to account and organization policies, and the catalog may be empty.

### OpenAI API key environment override

Set `OPENAI_API_KEY` in the process environment before starting the proxy. It takes precedence over stored ChatGPT credentials, is not saved through the web page, and is not written to Claude settings.

```bash
# This is a placeholder. Use your own secure environment-injection method.
OPENAI_API_KEY='<your-api-key>' node mac/proxy.js
```

Do not put real keys in the repository, screenshots, or shared command history. On Windows, set the variable in the current terminal or through the system environment-variable settings before starting the proxy. Restart the proxy after changing its environment variables.

### Credential storage and import

The default store is:

```text
~/.claude/claude-proxy/auth.json
```

It stores authentication data for `openai`, `openai-codex`, and `github-copilot`. Refresh-token updates preserve the existing format and check both the refresh token and `loginVersion` to prevent an older refresh from overwriting a newer login. A new login replaces that provider's previous login fields while preserving other providers.

On platforms with Unix permissions, the directory uses `0700` and the file uses `0600`. Updates use temporary files in the same directory and atomic publication. On Windows, also rely on account isolation and file ACLs; Unix mode values are not a complete access-control mechanism.

To import an existing Pi authentication file, explicitly provide `PI_AUTH_FILE`:

```bash
PI_AUTH_FILE='/path/to/pi/auth.json' node mac/proxy.js
```

At startup, supported credentials are imported only if the destination `auth.json` does not exist. The source is read-only: it is neither modified nor deleted. Existing or damaged destinations are never overwritten, and conflicts produce a warning. Invalid sources and unsupported entries are not treated as valid credentials. Without `PI_AUTH_FILE`, the proxy does not search for authentication files in the repository.

Importing a module does not create credential directories or migrate files. `CLAUDE_CONFIG_DIR` does not change the credential root; it selects the actual CLI root for settings, backups, Statusline deployments, and macOS service state/logs.

## Configuring Claude CLI

1. Keep the proxy running and configure at least one upstream authentication method first.
2. On `/login`, wait until **Configure Claude CLI** is enabled, then click it.
3. The proxy validates the CLI installation, credentials, settings structure, and authentication conflicts, then selects an available model from the dynamic catalog that matches the current credentials.
4. **Open a new terminal** and run `claude`. Use `/model` in an interactive session to switch models. On macOS + zsh and Windows PowerShell, proxy startup separately installs the [capacity entry point](#automatic-gpt-capacity-on-session-start); the web configuration button does not manage it.

The default settings file is `~/.claude/settings.json`. When `CLAUDE_CONFIG_DIR` is set, the proxy uses the actual `settings.json` in that directory, with support for `~` expansion. Model settings are cached by mtime and reread on later requests when the file changes.

The configuration button merges these fields:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8082",
    "ANTHROPIC_API_KEY": "sk-placeholder",
    "CLAUDE_CODE_USE_GATEWAY": "1",
    "CLAUDE_GATEWAY_ALLOW_LOOPBACK": "1",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_MODEL": "<gateway model ID selected from the current dynamic catalog>"
  }
}
```

`sk-placeholder` is a local routing placeholder, not an upstream API key. The operation removes the superseded `env.ANTHROPIC_AUTH_TOKEN` while preserving unrelated environment variables, hooks, permissions, plugins, `model`, and an existing `statusLine`. An existing explicit model is retained when available; otherwise, the first catalog entry matching the credentials is selected. No fixed model version is installed. The separate startup-only GPT subagent sync below does not change the main session model or gateway routing fields.

Before writing, the original settings bytes, including any BOM and formatting, are backed up to:

```text
<actual CLI config directory>/claude-proxy/settings-backups/settings-<SHA-256>.json
```

The backup directory and regular backup files are private. Configuration operations run serially, reread the latest settings before committing, recheck conflicts, merge changes, and update atomically through a temporary file. Damaged settings, symbolic links, directory targets, oversized files, unsafe backup paths, and unwritable targets are rejected.

Conflicts such as `apiKeyHelper`, `proxyAuthHelper`, forced login settings, other cloud authentication modes, or gateway helpers must be resolved manually; the button does not silently delete them. Shell, project, local, and managed settings may still override user settings. The proxy does not read or write Claude's `.credentials.json`.

**Importing modules, opening the page, and querying status do not write CLI settings.** Main-session gateway configuration runs only through a local nonce-protected, same-origin JSON `POST /api/auth/claude/configure` with a body of `{}`. Proxy startup has one narrow settings exception: the automatic GPT subagent defaults described below. To restore settings, first stop using the gateway, inspect the relevant private backup, and restore the required fields manually. Do not overwrite personal settings added since the backup.

### Automatic GPT subagent defaults on proxy startup

After successfully binding the port, both platform proxies start one nonblocking sync using the current GPT credentials and dynamic model catalog. This does not wait before serving requests, run on a failed bind, or poll in the background. It writes only these two environment settings in the actual CLI settings file:

```json
{
  "env": {
    "CLAUDE_CODE_SUBAGENT_MODEL": "<canonical anthropic/GPT ID selected from the current catalog>",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"
  }
}
```

Selection prefers an existing available GPT subagent model, then an available GPT `env.ANTHROPIC_MODEL`, then an available GPT top-level `model`, then the first available GPT catalog entry. It never hardcodes a GPT version or adds `[1m]` to GPT IDs. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` requires **Claude Code v2.1.257+**: ordinary subagents use the selected GPT even when their definitions request another model. Official forked-agent inheritance and skills using `model: inherit` remain exceptions and follow Claude Code's own inheritance rules.

GPT credentials may be saved OAuth credentials, a saved API key, or `OPENAI_API_KEY`. An expired saved OAuth access token is not treated as logout; startup does not initiate a login request. Without valid GPT credentials (including credentials removed while discovery is pending), the sync skips without changing or deleting existing defaults; with no available GPT model, it also keeps settings unchanged. Unsafe settings or discovery/save failures leave the existing settings intact and produce a fixed, credential-safe warning. Retry happens on the next proxy startup, not a timer.

Writes use the private exact-byte backups and serialized, conflict-checked atomic settings merge described above. Repeated startups with identical values do not rewrite settings or create another backup. Unrelated settings, the main session's `model` / `ANTHROPIC_MODEL`, and gateway routing fields are preserved: configuring the main session still requires the website button. Existing Claude processes do not reload their environment; start a new CLI session to use the defaults.

### Automatic GPT capacity on session start

Claude Code 2.1.303's gateway discovery keeps model IDs, names, and descriptions, but does not use catalog capacity metadata to set GPT's session window. With local GPT credentials available, `lib/claude-launch.js` fetches `/v1/models` on **each session start** (3-second timeout, using the proxy's existing catalog cache) and passes `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the official CLI. It does not patch the official executable, require a pinned CLI version, or save a fixed capacity in global settings.

All three automatic GPT behaviors—subagent defaults sync, capacity launcher installation, and CLI context injection—require the same local GPT credentials: structurally valid saved OAuth, a saved API key, or a nonblank `OPENAI_API_KEY`. Copilot-only credentials do not qualify. An expired OAuth access token still counts as logged in; this check never refreshes tokens or verifies them online. Missing or unreadable credentials skip automatic changes without deleting existing settings or an installed launcher. The launcher then starts the official CLI with the original arguments and environment, including any caller-provided `CLAUDE_CODE_MAX_CONTEXT_TOKENS`; a cached GPT catalog cannot bypass the check.

There are three separate steps:

1. **Proxy startup:** after successfully binding the port, check local GPT credentials before checking/installing the function in the user's shell profile. Write only when it is missing or an exact project template has stale Node/repository paths. An identical manually installed block is adopted without touching the profile or making a backup. Startup does not request or freeze capacity.
2. **New terminal:** zsh or Windows PowerShell loads the function. The proxy never sources user configuration, changes an existing terminal's environment, or updates an already-running Claude session.
3. **Plain `claude` launch:** with local GPT credentials, the existing launcher fetches the current catalog and injects capacity only into that new CLI child process. Credentials are checked again after catalog parsing and CLI discovery; logout during either step restores the original arguments/environment and suppresses catalog-derived warnings. Node is resolved from PATH each time, with the installer's verified Node executable as fallback.

The managed block looks like this (the installer fills in safely quoted absolute paths; no manual paste is required):

```zsh
# >>> claude-proxy capacity launcher >>>
claude() {
  local node_command
  node_command="$(whence -p node)" || node_command='/absolute/path/to/node'
  "$node_command" '/absolute/path/to/claude-proxy/lib/claude-launch.js' "$@"
}
# <<< claude-proxy capacity launcher <<<
```

Open a new terminal: `whence -w claude` should report a function, and `claude --version` should still print the official version. Continue running plain `claude` normally. The launcher uses `createSetupProbe` to locate real CLI files and starts them without a shell, so the function cannot recurse through PATH. It preserves the arguments, working directory, standard streams, exit status, and existing interrupt handling. Standalone help/version and recognized maintenance subcommands (including `auth` and `update`/`upgrade`) pass through without reading GPT credentials, requesting a catalog, or adding model arguments.

**Safety and conflicts:** before any shell-file change, the installer saves the exact original bytes to `<actual CLI config directory>/claude-proxy/zsh-backups/zshrc-<SHA-256>` (directory `0700`, file `0600`; identical verified backups are reused). A missing `.zshrc` is created with mode `0600`, without inventing an original backup. Other bytes, existing line endings, and original file permissions are preserved; newly appended shell code uses LF for zsh compatibility. A same-directory exclusive temporary file is checked with `/bin/zsh -f -n`, then the target's identity and bytes are rechecked before atomic publication. Concurrent edits abort the change.

Unknown `claude` aliases/functions outside the block, edited/duplicate/broken markers, symlinks, non-regular files, unsafe ownership/permissions, unsafe backup paths, and syntax errors leave the original shell file unchanged and warn. Checks are static and limited to the target file: definitions loaded dynamically from other sourced files cannot be reliably detected. Inspect `whence -w claude` in a new terminal if another shell manager also configures it. Explicit non-zsh `SHELL` values are skipped; macOS service environments without `SHELL` use the default zsh behavior. A custom `ZDOTDIR` outside home warns and skips rather than modifying a file zsh will not load.

Capacity rules and boundaries:

- Without an explicit `--model` or process-environment `ANTHROPIC_MODEL`, use the **smallest valid declared GPT window** in the catalog. This also covers a model chosen only by official user/project/`--settings` settings. No model argument or model environment variable is injected in this branch, and the launcher does not read or rewrite those settings: Claude Code still chooses the model.
- An explicitly selected, known GPT uses its own valid capacity; a known Claude selection retains the shared GPT fallback for later switches. Explicit unknown models or selections without a valid capacity do not borrow another model's limit. A caller-provided `CLAUDE_CODE_MAX_CONTEXT_TOKENS` takes priority.
- Normal recognized Claude models continue using Claude Code's own context logic. No `DISABLE_COMPACT` or global forced `[1m]` marker is added.
- Automatic refresh happens at **process startup**, not inside an existing session. If GPT capacities differ, ordinary launches use the shared minimum; explicitly starting a GPT can use its individual capacity. The existing difference warning remains: `/model` does not promise arbitrary, exact per-model window updates within one process.
- A catalog declaration is **not a guarantee of the account's actual allowance**. If the proxy is unavailable or returns invalid catalog data, the launcher warns and starts the official CLI with the original arguments and context behavior; it does not invent a capacity.
- This entry point covers this user's zsh or Windows PowerShell terminal only. IDE/desktop launches and direct execution of the official binary bypass it. Linux entry points are unchanged. No background polling, PATH modification/shim, or replacement of the official CLI is installed. After moving the repository or changing Node, start the proxy from the new installation (or run `--enable` below) to update only its recognized block.

**Persistent disable / re-enable** (run from the repository root, with the same home and `CLAUDE_CONFIG_DIR` as the proxy):

```bash
node lib/claude-launcher-install.js --disable
node lib/claude-launcher-install.js --enable
```

`--disable` works even without GPT credentials: it first saves `claudeLauncher: false` to `~/.claude/gateway-features.json`, then backs up and removes only an exact recognized block, preserving later user configuration. Subsequent proxy startups will not reinstall it. A modified block is left intact with a warning, but the opt-out remains saved. `--enable` safely installs/adopts the block and records `true` only after success; it never overwrites an unknown definition or modified block. With GPT credentials available, missing `claudeLauncher` means automatically attempt installation and `true` maintains the recognized block; explicit `false` always prevents automatic installation, while damaged/unsafe feature configuration also disables it. Other feature settings are retained.

After disabling, open a new terminal (or `unfunction claude` in the current one). Keep private backups for inspection; do not restore the whole file over shell configuration added later. The official CLI and its settings remain unchanged. Removing the block manually without saving the opt-out is not a persistent uninstall.

## Configuring Statusline

**Configure Statusline** on `/login` is independent of ChatGPT / Copilot login and CLI routing. It requires a discoverable Claude CLI, **Bash 3+**, and **jq 1.6+**; Node.js is not needed by the statusline. On Windows, install Git Bash and jq manually. Missing dependencies are never downloaded automatically.

Clicking the button explicitly **replaces the existing `statusLine` command**, even if you already have one. The original settings bytes are backed up to the same private `settings-backups/` directory described above. Gateway environment variables, authentication, hooks, permissions, and unrelated plugins remain unchanged. The operation accepts only an empty JSON object at `POST /api/auth/statusline/configure` under the local page's security guards.

The statusline is a single Bash/jq line: directory, git branch with a dirty marker, model name, current context usage (`ctx: used/total (pct%)`), whole-session `in/out/cache` tokens with the prompt-cache hit rate, and the cache state (`warm`, `cold`, or `dropped: <cause>`). `in` counts all input, including the cached system prompt. It is deployed into:

```text
<actual CLI config directory>/claude-proxy/statusline/<generation SHA-256>/
```

Each immutable generation contains the script and a launcher that quotes the probed Bash/jq paths. Dependency paths participate in the generation identity. Repeated installs verify the deployed script bytes before reuse; changed or unsafe generations are not silently overwritten, and older Claude HUD generations show as not configured until you click the button again. Settings are committed only after successful deployment. If saving fails, cleanup removes only a newly created deployment that is not referenced by the latest settings.

The deployed Statusline works after moving this repository, provided Bash and jq remain available. Refresh the Statusline or open a new Claude session after configuring. See [Statusline provenance](statusline/SOURCE.md).

## Registering a macOS service

On macOS, `/login` shows an independent **Register macOS Service** button. It requires a normal current-user GUI login session, safe writable directories, and available Node/repository paths. It creates a **LaunchAgent**, never a system LaunchDaemon and never using `sudo`. Windows and other platforms report this feature as unsupported; the card follows the backend platform, not the browser's platform.

```text
Label: com.shanshazhe.claude-proxy
Plist: $HOME/Library/LaunchAgents/com.shanshazhe.claude-proxy.plist
State/log root: <actual CLI config directory>/claude-proxy/macos-service/
Logs: stdout.log, stderr.log
```

Registration is explicit through a protected `{}` `POST /api/auth/macos/service/configure`. Importing modules, starting the proxy, opening the page, or querying status never registers a service or writes service files; status may run bounded, read-only service checks. A matching running job is a no-op. A matching stopped plist is reused byte-for-byte. Conflicting installations, disabled jobs, unsafe files, or incompatible settings require manual repair and are never overwritten. This identity is separate from the source toolkit's service.

**Immediate handoff can interrupt active requests and login flows.** The detached helper must be ready before HTTP 202, and activation waits until the response finishes; a client disconnect during preparation cancels handoff without stopping the original proxy. The original proxy drains for at most 10 seconds. The helper checks the old PID/birth identity and port release before bootstrap, then verifies launchd ownership, the listening socket, the page nonce, the operation ID, and installation identity. `/health` alone is not proof of successful registration.

The page polls the operation and reconnects with a fresh same-origin nonce. **An interrupted/lost POST is never automatically repeated.** If the result cannot be confirmed, inspect status before retrying. Failed registration reports whether the original proxy was `recovered` or `recovery_failed`; the latter requires manually starting `bash mac/start-proxy.sh` and inspecting the service. Recovery secrets stay in IPC/memory, not the plist, operation records, or logs.

New plists transfer only validated cache switches (`OPENAI_PROMPT_CACHE`, `CLAUDE_PROMPT_CACHE`, `DISABLE_PROMPT_CACHING`, and the HAIKU/SONNET/OPUS variants), `PI_CACHE_RETENTION`, `CODEX_CLIENT_VERSION`, the selected CLI root, and supported safe TLS/certificate options. They do not copy arbitrary shell environment variables. **Environment-only `OPENAI_API_KEY`, `PI_AUTH_FILE`, custom `OPENAI_BASE_URL`, insecure TLS, arbitrary `NODE_OPTIONS`/Node arguments, and verbose prompt logging prevent handoff.** Save supported credentials to the local store and remove unsupported overrides before restarting the proxy manually. A running-service no-op does not modify its environment.

The service depends on absolute Node and repository paths. Moving either requires manual repair; do not overwrite another installation's plist or blindly delete service state. Service logs may contain operational or model-request information: keep them private and inspect them before sharing.

## Gateway-maintained Project Code Memory

The **Gateway-maintained Project Code Memory** switch on `/login` is independent of proxy login, CLI routing, Statusline, and macOS service registration. The main model only **queries** records; the gateway refreshes, adds, and deletes them in the background with a cheaper model. It requires **Claude CLI** and **CPython 3.9+** with its standard library. Windows Python and `py -3` are supported using fixed, shell-free `-I -B` probes and a sanitized environment; automatic interpreter installation is disabled. Missing dependencies must be installed manually.

**First startup and explicit choice.** When `projectMemory` has never been set, startup attempts to install the query-only skill and enable maintenance. An unchanged known older deployment is backed up and upgraded automatically, but only when its complete file/directory set and every SHA-256 match a `previousDeployments` entry in the manifest. This includes the historical install-button layout and whole-bundle copies from this project's `f3fab02` through the version before `530542c`, as well as the recorded source layouts. When the switch is already on, startup also backs up and upgrades an installed skill that exactly matches a `previousDeployments` entry, logging `Project Code Memory upgraded automatically`; a current, missing, or unknown skill is left alone. Modified, unknown, symlinked, or extra-content skills are never moved automatically. Missing dependencies or unknown conflicts leave it off without writing files. An explicit `false` stays off on future startups; malformed or unsafe feature configuration also prevents automatic enablement. Status and page loads do not install anything. Manual changes use the local, nonce-protected `POST /api/auth/project-memory/configure` with exactly `{"enabled":true}` or `{"enabled":false}`; successful responses include a boolean `replaced`. The choice lives in `~/.claude/gateway-features.json`, independently of `CLAUDE_CONFIG_DIR`.

**Enable and install.** After checking dependencies, the installer validates the manifest pinned to upstream commit `7dc7b0dad137fa8e1e65af31143f4ead8109ca03` and deploys only:

```text
<actual CLI config directory>/skills/project-code-memory/
  SKILL.md
  scripts/pcm.py
  scripts/query.py
  LICENSE
  SOURCE.md
```

The actual CLI root defaults to `~/.claude` (`%USERPROFILE%\.claude` on Windows) and follows `CLAUDE_CONFIG_DIR`. Operations are serialized in the proxy process. Installation writes all files to a private `.project-code-memory-stage-*` directory under `<actual CLI config directory>/claude-proxy/`, then publishes by directory rename. It sets `projectMemory: true` only after installation succeeds. An identical, exact five-file deployment is a read-only installation no-op. The upstream Python implementation is unchanged; the toolkit's `scripts/query.py` wraps its `query` command so a query keeps stale records for the gateway instead of deleting them; `references/record-format.md` remains in the bundle as maintenance-prompt reference, not an installed file.

**Explicit enable and backup replacement.** With dependencies ready, a conflicting skill remains selectable on `/login`. Turning it on explicitly first writes the complete new stage, then renames the entire old skill to `<actual CLI config directory>/claude-proxy/skill-backups/project-code-memory-<timestamp>-<random>/` before publishing the query-only skill. Extra files and `.git/` are preserved; a symlink is moved as a link without touching its destination. The old skill is outside `skills/`, so Claude no longer loads it. Automatic upgrades use the same backup path but only for exact known older deployments. Unsafe symlink/non-directory backup parents are rejected. Target identity and contents are rechecked after dependency probing and staging, and automatic upgrades are checked again around the backup move; newly appearing targets are not intentionally replaced. On publication failure, restoration is attempted only if the original location is still absent; otherwise the old skill is retained in the backup for manual recovery. The page reports replacement using the relative backup location, never a private absolute backup path. Startup logs include `previous_skill_backed_up` without a backup path.

**Disable and conflict protection.** Disabling writes `false` first, immediately stopping new injection, then removes only the exact current deployed file set: every hash must match, with no extra files, directories, or symlinks. Removal first renames and rechecks the directory; changes detected then are restored rather than deleted (or kept privately if the original location is occupied). Different, modified, partial, or extra-content skills remain in place with a fixed warning. Direct `install()` calls never replace conflicts; replacement is reserved for explicit enablement or a verified automatic upgrade. Backups and project `projectCodeMemory/` caches are always kept, including after disabling; inspect them before manually restoring an old skill, and open a new Claude session afterward. The installer does not edit CLI settings, hooks, CLAUDE.md, or `.gitignore`, download code, or invoke the Python memory CLI.

**Request behavior.** While enabled, requests with `Edit`/`Write` tools receive a fixed `ProjectMemoryUpdate` tool definition and system instruction appended to the existing content. This keeps the injected bytes stable for prompt caching; toggling can cause one cache rewrite. After changing source/test files, discovering new, stable, reusable, non-obvious code knowledge verified against current source during read-only analysis, or finding records wrong or useless, the main model writes its final answer and calls this tool once at the end of the same response, passing the repository root, changed source/test paths, at most three verified knowledge items with evidence paths, and obsolete record IDs. Read-only analysis passes an empty `changed_paths` array and supplies its new findings through `learned`; unchanged files must never be reported as changed. Simple lookups, repeated findings already covered by existing records, speculation, and task narration do not trigger maintenance. The gateway consumes this virtual tool at the response boundary in both JSON and SSE, queues its complete input, and replaces the call with a plain-text `Queued.` notice before Claude Code sees it; no MCP server or local tool handler is needed. Rejected queue submissions or invalid/truncated calls receive a not-queued notice instead. If no real client tool remains, the response ends the turn; other tool calls, answer text, and usage accounting are preserved. Call IDs are deduplicated within the proxy process. For compatibility with older transcripts, historical results are still rewritten to `Queued.`, and calls in the last assistant message answered by subsequent user messages (including queued reports or task notifications) are still recognized. When only that legacy bare result remains, the gateway repeats the final answer locally without another upstream request; mixed results or additional user text continue through the existing routes. Read-only `/v1/messages` subpaths never enqueue maintenance or end a turn locally.

**Background maintenance and privacy.** Only repositories with an existing, owned, real `projectCodeMemory/` directory are eligible. The gateway does not initialize caches or edit `.gitignore`. It sends up to 12 affected records (reported obsolete, citing changed or learned paths, or stale) and numbered evidence files (at most 96 KiB each, enough for a roughly 73 KiB proxy entrypoint, and 256 KiB total, excluding symlink-redirected files) to **Luna, then Haiku** through the existing authentication paths, with a 120-second timeout per model attempt. **Code and record content are sent to that background model/provider while enabled.** New/updated records may cite only supplied files, and each symbol must occur verbatim in a cited file; provenance explicitly says they are not test-verified. Fingerprints are rechecked before saving, and Python applies changes under the existing memory lock. Work is serialized per repository, with at most two jobs running and 16 outstanding globally; it does not block the main request.

Success logs use `[project-memory] Project memory updated project=… model=… saved=N deleted=N rejected=N ms=…`; failures use fixed codes such as `root_rejected`, `model_failed`, `invalid_output`, `python_failed`, or `queue_full`, without logging file contents. Model failures or invalid output leave records untouched. A stale record the model neither refreshes nor deletes is deleted, but one whose refresh draft is rejected or fails to save is kept for the next run. These are machine-generated leads, not authority: fingerprints detect changed files, not claims that were wrong from the start. Queued work is not durable across proxy restarts, and Python remains a runtime dependency while maintenance is enabled.

**Open a new Claude session after toggling.** Use `/project-code-memory` explicitly or let the model select the skill; this is model-driven guidance, not a hook. A query intentionally creates the selected project's ignored `projectCodeMemory/` cache, adds its ignore rule, and may prune malformed records; stale records are reported and kept for the gateway to refresh. That cache differs from this repository's bundled `project-code-memory/` directory. The [bundled README](project-code-memory/README.md) retains upstream background/workflow material; the installed [query-only skill](project-code-memory/SKILL.md) defines this mode. See [provenance](project-code-memory/SOURCE.md), [manifest](project-code-memory/manifest.json), and [MIT license](project-code-memory/LICENSE).

## Installing Coding Discipline

**Install Coding Discipline** on `/login` is an independent macOS/Windows button. It needs an installed **Claude CLI**, but not Python or proxy login. Missing CLI dependencies must be installed manually. Installation uses the existing loopback, Host, nonce, same-origin JSON, and bounded empty-object guards at `POST /api/auth/coding-discipline/install`.

The `coding-discipline/` bundle is adapted from [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) (formerly `forrestchang/andrej-karpathy-skills`), pinned to commit `2c606141936f1eeef17fa3043a72095b4765b9c2`. Upstream declares MIT in its README and skill frontmatter but has no LICENSE file; the bundle includes MIT license text. See [provenance](coding-discipline/SOURCE.md), [manifest](coding-discipline/manifest.json), and [license](coding-discipline/LICENSE) for adaptations and original/deployed SHA-256 hashes.

The installer verifies the manifest and copies only `SKILL.md`, `LICENSE`, and `SOURCE.md` into `<actual CLI config directory>/skills/coding-discipline/`. The root defaults to `~/.claude` (`%USERPROFILE%\.claude` on Windows) and respects `CLAUDE_CONFIG_DIR`. Installs are serialized: files are written into a private `.coding-discipline-stage-*` directory under `skills/`, then published by a directory rename. New POSIX directories/files use `0700/0600`. Every click replaces the whole existing `skills/coding-discipline/` target (directory, file, or symlink — a symlink is removed, not followed) with the bundle; no conflict check is made. The previous target is moved aside and restored if publishing fails.

Status reports installed when the target `SKILL.md` matches the bundle; the button stays enabled so it can reinstall. Import, status, and page load do not install anything. The button performs no downloads or model calls and does not modify settings, CLAUDE.md, hooks, credentials, or services.

**Open a new Claude session after installation.** The skill asks the model to load it before any code change; you can also invoke `/coding-discipline` explicitly. Skill use remains model-driven guidance, not hook enforcement.

## Model selection and API

```bash
curl http://127.0.0.1:8082/health
curl http://127.0.0.1:8082/v1/models
curl http://127.0.0.1:8082/features
```

The catalog returns GPT models as `anthropic/<model ID>` and Claude models under their plain ID. Claude Code's `/model` picker lists only gateway IDs that contain `claude` or `anthropic`, and it applies `CLAUDE_CODE_MAX_CONTEXT_TOKENS` only to IDs that do not start with `claude-`; the `anthropic/` prefix satisfies both. The shared macOS/Windows launcher and GPT JSON/SSE responses use the same `anthropic/<model ID>` identity as the catalog, so Claude Code saves a discoverable model ID for session restoration. Only upstream requests strip `anthropic/`; the old `claude-gateway/` spelling is no longer supported. When `capabilities.limits.max_context_window_tokens` is a valid positive integer, it decides the `[1m]` extended-context marker on Claude IDs: only limits of at least 1,000,000 tokens get the suffix, so Copilot's `claude-haiku-4.5` at 200K does not. GPT IDs never get it, because on them `[1m]` would override `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. Without a valid catalog limit, the existing GPT Sol/Luna/Terra and Claude family rules remain in effect. The suffix is never duplicated and is removed before forwarding. This marker is not an upstream expansion or a guarantee of the account's actual context allowance; upstream capabilities depend on the account catalog and request results.

Requests may use the full gateway ID from the catalog or an explicit raw GPT / Claude model ID. CLI aliases such as `sonnet`, `opus`, `haiku`, and `default` use the model configured in settings. Send an explicit model ID if no default is configured. Other model types return HTTP 400 instead of being routed to the wrong provider.

Copy a GPT model ID available to your account from `/v1/models` and replace `gpt-<available-id>` below:

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "anthropic/gpt-<available-id>",
    "max_tokens": 256,
    "stream": false,
    "messages": [{"role":"user","content":"Explain the purpose of this gateway in one sentence."}]
  }'
```

For Claude, replace `model` with a `claude-...` entry from the catalog. To stream, use the same body with `stream` set to `true` and add `-N` to curl. In Windows PowerShell, use `curl.exe` and save the body to a JSON file you create yourself to avoid shell quoting differences.

Main endpoints:

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Process liveness; does not validate upstream access |
| `GET /v1/models` | Dynamic gateway catalog from both providers; accepts requests with query parameters |
| `POST /v1/messages` | Anthropic Messages input with JSON or SSE output |
| `GET /features` | Read-only Online Summary status (`onlineSummary`, `summaryModel`) |
| `GET /login` | Local account and CLI configuration page |
| `GET /api/auth/status` | Nonce-protected credential / CLI / Statusline / Online Summary / service / Project Code Memory status; never returns tokens |
| `POST /api/auth/chatgpt/start` | Starts ChatGPT device authorization; the page sends `{}` |
| `POST /api/auth/copilot/start` | Starts Copilot device authorization; the page sends `{}` |
| `GET /api/auth/flow/<id>` | Device-flow status snapshot |
| `POST /api/auth/claude/configure` | Protected CLI configuration with an empty JSON object |
| `POST /api/auth/statusline/configure` | Protected independent Statusline deployment with an empty JSON object |
| `POST /api/auth/macos/service/configure` | Protected macOS registration; 200 for a running no-op, 202 for a prepared asynchronous operation |
| `POST /api/auth/project-memory/configure` | Protected independent maintenance switch; accepts only `{"enabled":true}` or `{"enabled":false}` |
| `POST /api/auth/online-summary/configure` | Protected Online Summary settings; accepts only `enabled` (boolean), `model` (an ID from the list), and/or `threshold` (4096, 8192, 16384, or 32768) |

Use `/login` for login and configuration operations; these endpoints do not support ordinary cross-origin API calls. The Messages endpoint is not a complete implementation of the Anthropic API. Do not assume other Anthropic endpoints are available.

## Streaming, tools, images, and reasoning

- **Non-streaming GPT:** Converts the request, collects the Responses result, and maps text, tool calls, stop reasons, and usage. A local non-streaming client still receives complete JSON even when the Codex upstream requires SSE.
- **Streaming GPT:** Sends Anthropic `message_start`, converts Responses text, reasoning summaries, and complete tool-call events as they arrive, then sends usage, `message_delta`, and `message_stop`. SSE keepalives are sent while waiting. Writes honor backpressure, and a genuine client disconnect cancels the upstream request.
- **Copilot Claude:** Forwards native Messages JSON or SSE, preserving response bytes, signatures, tool-argument fragments, and error events, with backpressure and client cancellation.
- **Tools:** Maps `tool_use` / `tool_result`. Results immediately follow their corresponding tool calls, before any user text supplied alongside them. The client remains responsible for executing tools requested by the upstream model.
- **Images:** Ordinary GPT image blocks become Responses `input_image` items. Images in tool results are attached to a following multimodal user message. Copilot receives native image structures and a vision request header. Image support depends on the selected model and account; unsupported or invalid sources are replaced with explanatory text.
- **Reasoning:** GPT supports public reasoning summaries, not native Claude's full thinking / signature protocol. Literal `<think>` text in an answer is not misclassified as a GPT reasoning block. Copilot adapts adaptive thinking using catalog capabilities while preserving native signatures and compatibility fallbacks.

The request-body limit is 32 MiB. OpenAI requests have a one-hour total timeout and are canceled after 90 seconds without data once upstream response headers have arrived. GPT SSE attempts a keepalive every 10 seconds. Copilot requests also have a one-hour total timeout, but do not use the same idle-timer behavior as OpenAI.

## Built-in WebSearch

Claude Code's built-in **WebSearch** tool sends its own request whose only tool is `web_search_20250305` (on the wire `tool_choice` is `auto`). The proxy recognizes that request, runs OpenAI's native Responses `web_search` upstream with the search required, and returns the real calls and sources as `server_tool_use` / `web_search_tool_result` blocks (JSON or SSE) with `end_turn`. Claude Code then hands the titles and URLs to the main conversation. `count_tokens` subpaths are never searched.

| Session model | Where the search runs |
| --- | --- |
| GPT (`anthropic/gpt-…`) | The same model and ChatGPT/Codex login (or `OPENAI_API_KEY`) |
| Copilot Claude (`claude-…`) | The newest Luna in the Copilot catalog, on Copilot `/responses` with the same Copilot login. Copilot's Claude `/v1/messages` endpoint rejects server-side web search (`The use of the web search tool is not supported`), so only this one search step uses a GPT model; the conversation stays on Claude |

- **Results:** Hits come only from the upstream `web_search_call` sources (http/https, de-duplicated); titles come from the upstream URL citations, otherwise the URL is shown. Nothing is extracted from answer text, and Anthropic `encrypted_content` is never fabricated. The upstream's short summary is passed through as text.
- **Zero hits vs. failure:** A completed search with an empty source list returns an empty result ("No links found."). A failed call or a call without a source list returns a `web_search_tool_result_error`. An upstream answer with no search call at all, authentication, rate-limit and network errors return an error instead of an empty result.
- **Limits:** `allowed_domains` is enforced natively and accepts only plain domain names such as `example.com`. Non-empty `blocked_domains`, `user_location` or any other unknown option is rejected before calling upstream, because it cannot be enforced equivalently. `max_uses` is sent as `max_tool_calls` to Copilot; the ChatGPT/Codex endpoint rejects that parameter, so there the proxy aborts the upstream stream as soon as a search beyond `max_uses` starts and reports it as `max_uses_exceeded`. `search_profile: "fast"` is a latency hint and maps to `search_context_size: "low"`.
- **Logs:** `Web search completed` records the model, auth kind, search and result counts, and whether the limit was hit; queries and source content are never logged.
- **Tested endpoints:** the ChatGPT/Codex login and Copilot `/responses` were checked against the live services. `OPENAI_API_KEY` uses the public Responses API, which documents the same tool, but it has not been tested here.
- A running proxy must be restarted to pick up this behavior.

## Cache behavior

### GPT prompt caching and statistics

A stable `prompt_cache_key` is generated by default. It aims to preserve cache identity as a session grows while separating different sessions. Moving native cache annotations in system / tools does not change the fallback key. Logs contain only hashed key / prefix identifiers and token statistics, never prompts or full request bodies.

Responses `input_tokens_details.cached_tokens` maps to Anthropic `usage.cache_read_input_tokens` in both JSON and SSE output. `input_tokens` reports regular input after subtracting cache reads, and `output_tokens` retains the upstream output count. Logs show total input, cache reads, uncached input, and the hit percentage; an upstream cache miss may report 0. A stable key does not guarantee a hit. Cache policy and billing are controlled by the upstream service.

### Claude prompt caching and statistics

Unless an explicit top-level `cache_control` or a disable switch is present, the proxy adds `ephemeral` annotations to eligible tools, system content, and the last user content, respecting existing markers and TTL ordering. It allows at most four block markers and does not overwrite existing annotations. Long-before-short ordering and neighboring TTLs remain compatible.

Copilot's native usage fields, including `cache_read_input_tokens` and `cache_creation_input_tokens`, are returned unchanged. A separate observer inspects JSON / SSE usage while immediately forwarding the original bytes. Unknown or oversized events skip diagnostics without changing the response, and a failing statistics callback does not interrupt native output.

### Responses replay and other local caches

- Anthropic clients cannot directly carry Responses item IDs or encrypted reasoning. The proxy keeps matching native output in **process memory**, scoped to the account, model, session, and history, for replay on later turns. These data are not written to logs or disk.
- Replay is limited to 512 entries / 16 MiB with least-recently-used eviction. Restarting clears it, and unrelated clients are not arbitrarily mixed.
- Model discovery coalesces pending requests, limits each source to 12 seconds, and gives clients a response budget of approximately 2.2 seconds. The TTL is five minutes when every source succeeds and 30 seconds when a source fails. A failed source retains previously discovered entries; a source that has never succeeded remains absent.
- Successful login invalidates the catalog generation. An older pending discovery cannot repopulate the current cache.
- CLI model settings are cached by mtime. This is separate from upstream prompt caching, Responses replay, and Online Summary.

## Online Summary

Online Summary keeps large tool outputs from filling your main model's context. When a new tool output (other than `Read`) reaches the threshold (8 KiB by default), the proxy archives the original locally and asks a cheap model to extract what matters: the outcome (exit status, pass/fail totals), every distinct error or warning with its message and `file:line`, and the line numbers of the key lines. Your main model receives the summary plus those key lines **quoted verbatim by the proxy** with their original line numbers, and the archive path. The cheap model only selects lines; it never rewrites the quoted text. Line numbers match `Read`, so the main model can read more with `Read(file_path, offset, limit)` when needed.

**Threshold.** The default is 8 KiB. Choose 4, 8, 16, or 32 KiB on `/login` (saved as `summaryThreshold`). Lower thresholds summarize more outputs and save more tokens, but each summary adds a few seconds. Summary length scales with the output size, and if a summary would not shrink the output below 70% of its original size, the original is kept.

Up to 20 excerpts of up to 40 lines are included, without repeating overlapping lines, within half of the original size (4,000 to 12,000 characters). Excerpts that do not fit are listed by line range and reason so the main model can jump straight to them.

**Summary model.** By default the proxy picks the newest Luna model (for example `gpt-6-luna`, which needs ChatGPT login or `OPENAI_API_KEY`) and falls back to the newest Haiku model (Copilot). The detection is cached until the proxy restarts. You can choose another GPT or Copilot Claude model on `/login`; a chosen model is tried first and falls back to Luna, then Haiku, if it fails. Each summary has a 30-second timeout. Outputs over 1 MiB are sent to the model as their first and last ~512 KiB with the omitted line range noted. If every model fails, the original output is kept.

**Summary prompt.** The `/login` card displays the current system prompt sent to the summary model. Edit it and click **Save prompt** to persist `summaryPrompt` without restarting the proxy. It must be non-empty and fit within 8 KiB after JSON encoding. Keep the JSON reply contract with `summary` and `highlights`; malformed model replies fail safely to the original output. **Reset to default** removes the override, as does saving text equivalent to the built-in prompt, so later built-in updates still apply. Status refreshes preserve unsaved edits.

**Not summarized:** `Read` output (edits need exact text), error results, images or mixed content, archive readbacks, outputs below the threshold, history that existed before the first observed request, and requests without a session identity or a native `Read` tool.

**Tool outputs are sent to the summary model's provider** (OpenAI or GitHub Copilot), which may differ from your main model's provider. Turn Online Summary off when outputs may contain sensitive data.

### Turning it on or off and choosing the model

The easiest way is the **Online Summary** card on `/login`: the checkbox turns the feature on or off; the model, threshold, and prompt controls are disabled while it is off. The model defaults to the detected cheap model and the threshold to 8 KiB. Archive retention defaults to 30 days and remains editable while summaries are off. Select changes are saved immediately; prompt changes use **Save prompt**. Summary changes apply to new tool outputs without restarting; retention changes take effect at the next cleanup. Settings live under the actual HOME:

```text
~/.claude/gateway-features.json
{"version": 1, "onlineSummary": true, "summaryModel": "claude-haiku-5.5", "summaryThreshold": 8192}
```

`onlineSummary` defaults to on when the file or field is absent; damaged or unsafe configuration disables new summaries. Remove `summaryModel` to return to automatic detection and `summaryPrompt` to restore the built-in prompt. The older `observationPack` field is no longer used, and the old beginning/ending excerpt mode has been removed. From the project root:

```bash
node scripts/toggle-online-summary.js status
node scripts/toggle-online-summary.js off
node scripts/toggle-online-summary.js on
curl http://127.0.0.1:8082/features
```

The script changes only `onlineSummary` and keeps other fields. `status` and `GET /features` are read-only.

### Cache and safety

Each result is decided once, the first time it appears in the newest turn: summary or original. The decision is stored in a local ledger and never changes, so retries, proxy restarts, model switches, and toggle changes do not rewrite history already sent, and prompt caching is not broken. Turning the feature off affects only new results; excerpts produced by the older Observation Pack also stay as they were. Token-count requests read existing views only and never call the summary model.

Archives always live at:

```text
~/.claude/gateway-observations/<session identity SHA-256>/
  state.json
  <content SHA-256>.txt
```

The limits are 8 MiB per result, 128 MiB of archives per session, and 4 MiB / 20,000 entries for state. Archives and state use private files. An interrupted write freezes new summaries for that session. Unreadable existing state returns 503 rather than rewriting untrusted history.

**Archives contain the original tool output and may include sensitive code or data.** Do not share the archive directory. At proxy startup and hourly afterward, archives unused for more than **30 days** are deleted, even while Online Summary is off. Choose **7 / 14 / 30 / 60 / 90 days** or **Never** on `/login` (`archiveRetentionDays: 0` means never). Non-read-only requests refresh session usage time. Cleanup recognizes only this module's hashed session directories and archive filenames, removes the ledger before originals, never follows symlinks, and preserves a whole session if it contains unexpected files. Foreign-owned directories and archive roots writable by other users are skipped. Damaged/unsafe configuration or an invalid retention value disables deletion. Resuming a cleaned session sends its earlier tool outputs in full again, costing more tokens and invalidating that cached prefix once. `CLAUDE_CONFIG_DIR` does not relocate the settings or archive paths.

Logs include `Online summary configuration` (toggle or chosen model changed; `summary_model` is the model ID or `auto`, plus `summary_threshold`), `Gateway online summary` (replaced results, avoided bytes, new summaries, archive readbacks, and the models that generated all summaries carried in this request, including reused pinned summaries, as `summary_models`), `Tool output summarized` (model, input bytes, duration), `Summary model failed` (model, status, duration), and `Online summary archive cleanup` (removed session count). Configuration events also report default/custom prompt selection and archive retention days, never the prompt text. They never contain tool output, raw session IDs, or credentials.

## Environment variables

Pass these variables to the **proxy process**, not just to another terminal running Claude. Runtime switches are read in different ways; restart the proxy after changing accounts, URLs, or the CLI configuration root.

| Variable | Behavior |
| --- | --- |
| `OPENAI_API_KEY` | Uses an OpenAI API key instead of stored ChatGPT credentials; never persisted |
| `OPENAI_BASE_URL` | Base URL for `/models` and `/responses` in API-key mode; defaults to `https://api.openai.com/v1` and does not replace official Codex / ChatGPT OAuth endpoints |
| `PI_AUTH_FILE` | Explicit read-only import source at startup; an existing destination is never overwritten |
| `CLAUDE_CONFIG_DIR` | Actual CLI settings root; private backups, Statusline generations, and service state/logs live under its `claude-proxy/` directory; defaults to `~/.claude` |
| `CODEX_CLIENT_VERSION` | Client-version query value for the Codex model catalog; defaults to `0.162.1` |
| `OPENAI_PROMPT_CACHE=0` | Disables generation of the GPT fallback prompt-cache key; does not guarantee disabling every upstream cache mechanism |
| `CLAUDE_PROMPT_CACHE=0` | Disables automatic Claude cache annotations; existing client annotations are retained |
| `DISABLE_PROMPT_CACHING=1` | Disables automatic Claude cache annotations |
| `DISABLE_PROMPT_CACHING_HAIKU=1` / `..._SONNET=1` / `..._OPUS=1` | Disables automatic annotations for the corresponding Claude model family |
| `PI_CACHE_RETENTION=long` | Uses `ttl: "1h"` for automatic Claude annotations when neighboring markers do not constrain the TTL; other values use the short-lived default |
| `HOME` | Determines default credential, feature-toggle, and archive locations; automated tests use a temporary HOME |
| `PATH`, Windows `APPDATA` / `ProgramFiles` / `LOCALAPPDATA` / `SystemRoot` | Installation locations searched by CLI/dependency probes; no automatic installation |
| `RUN_CLAUDE_CLI_TESTS=1` | Test-only opt-in for isolated cases requiring an installed Claude Code CLI; skipped by default |

The `ANTHROPIC_*` and gateway environment fields written by CLI setup are for the **Claude Code client**, as described in the configuration section. They do not replace the proxy's upstream authentication.

A custom `OPENAI_BASE_URL` receives the API key, model requests, and conversation content. Point it only at a trusted compatible service. Do not disable TLS verification; if an enterprise network requires an additional CA, configure trusted certificates through Node.js.

## Security and troubleshooting

### Security boundaries

- The listener is local-only. Messages API CORS compatibility is not authentication, and the API does not validate the placeholder key. Do not expose it through port forwarding, a reverse proxy, or a public tunnel, and do not publish the local page externally.
- Login and configuration routes run before wildcard API CORS. They validate the loopback address, exact Host / port, and a random page nonce. POST requests also require a same-origin Origin and `application/json`. Protections include nonce-based CSP, `no-store`, framing restrictions, and redirect restrictions.
- Authentication bodies are limited to 16 KiB with a 10-second read timeout. Configuration bodies must be `{}`, except Online Summary settings, which accept only `enabled`, `model`, and `threshold`. The page does not persist tokens in browser storage or receive actual access tokens.
- Enter passwords only on official websites and keep device codes private. Do not share authentication files, private settings backups, or Online Summary archives.
- Claude tools can still access local files or execute commands. Continue using client-side permission prompts and project isolation; the gateway does not replace permission controls.

### Common issues

| Symptom | What to check |
| --- | --- |
| Proxy cannot listen / port already in use | Ensure only one proxy is running, inspect port 8082, and manually stop any unwanted process |
| Login page does not open | Use `127.0.0.1:8082/login`; the proxy binds only IPv4 loopback, and localhost / IPv6 resolution may differ by environment |
| Login status returns 403 | Reload the local page to refresh its nonce; do not use another Host, a proxy, a cross-origin page, or a POST without Origin |
| Device code expires / login fails | Complete authorization on the official website, check account permissions and network / device-authorization availability, then start again |
| OpenAI 401 / refresh failure | Check environment overrides, storage permissions, and token validity; log in again through the page, and do not paste tokens into logs |
| Copilot 403 / no Claude models | Check the Copilot subscription, organization authorization, model picker, and policies; confirm the account can access the model |
| `/v1/models` is temporarily empty | Initial discovery may exceed the response budget; retry later. Missing credentials, upstream outages, or unavailable permissions do not produce a fabricated default model |
| CLI configuration button is unavailable | Ensure Claude CLI is discoverable, matching credentials exist, settings are valid and writable, and authentication conflicts have been resolved manually |
| Statusline button is unavailable / deployment fails | Check CLI, Bash 3+, jq 1.6+, the bundled script, settings permissions, and private deployment integrity; login is not required. A proxy started before an upgrade must be restarted |
| Project Code Memory switch is unavailable / conflict | Check Claude CLI, CPython 3.9+, bundle integrity, and safe writable CLI directories. With dependencies ready, explicitly turning it on backs up and replaces an existing skill under `claude-proxy/skill-backups/`; only exact known older deployments upgrade automatically, including at startup while the switch is on. If installation fails, inspect both the skill and retained backups before retrying. Explicit off stays off after restart |
| Service registration is unavailable | Confirm macOS GUI login, safe writable paths, matching label/installation, and supported environment/TLS options; no system service is created |
| Service request disconnects / result is unknown | Let the page reconnect and verify its operation; do not repeat a lost POST blindly. Inspect private logs and status |
| Service reports recovery_failed / fails after paths move | Start `bash mac/start-proxy.sh` manually, inspect the matching LaunchAgent and private logs, and repair paths without overwriting another installation |
| Setup succeeds but Claude bypasses the gateway | Open a new terminal, check shell / project / local / managed overrides, and ensure the proxy and CLI use the same `CLAUDE_CONFIG_DIR` |
| Unknown model returns 400 | Copy an available ID from the current `/v1/models`; explicit unsupported model types do not automatically fall back |
| 429 / quota error | Wait according to upstream limits or adjust the account / model, and inspect upstream usage and quota |
| Streaming fails midway / empty content | Inspect status and SSE errors; check the network, upstream terminal events, model permissions, and timeouts |
| Cache hit is 0 | Caching is controlled upstream; check key / session identity, system / tools stability, and switches. Replay hits are not the same as billable prompt-cache hits |
| Online Summary state is unreadable | Check archive integrity and permissions, restore trusted state, or start a new session. Do not delete the ledger during an active session |
| Online Summary does not summarize | Check `Summary model failed` in the proxy's stderr log, the selected model on `/login`, and ChatGPT / Copilot login. `recalled_results` in `Gateway online summary` shows how often the main model re-read archives |

## Offline tests

From the project root:

```bash
node --test test/*.test.js
node --check mac/proxy.js
node --check windows/proxy.js
bash -n mac/start-proxy.sh
bash -n statusline/statusline-command.sh
cmp mac/proxy.js windows/proxy.js
git diff --check
```

To keep feature-toggle, archive, and configuration tests away from personal directories, use an isolated HOME on macOS / Linux:

```bash
TEST_HOME="$(mktemp -d)"
HOME="$TEST_HOME" CLAUDE_CONFIG_DIR="$TEST_HOME/config" \
  node --test test/*.test.js
# After checking the results, remove the TEST_HOME you just created if desired.
```

In Windows PowerShell, create a separate temporary directory and set `HOME`, `USERPROFILE`, and `CLAUDE_CONFIG_DIR` for that test run, restoring the original environment afterward. `node --check` also works on Windows; `bash -n` / `cmp` require Git Bash or equivalent tools.

The default suite uses mocked upstreams and temporary directories. It covers device authorization, token-refresh races, catalog invalidation, JSON / SSE, tools / images, cache usage, Responses replay, genuine client disconnects, login-route security, and private settings backups. HTTP end-to-end tests exercise both GPT and Copilot paths and reject unknown models. Statusline tests deploy/run only in temporary roots with synthetic input. Service tests mock system-management commands and run fake proxies on random non-8082 ports; VM/e2e tests inject a fake service. Project Code Memory tests use temporary CLI roots, fake dependency/model calls, and isolated Python `pcm.py` runs in temporary repositories, covering exact-file recognition, explicit backup replacement, known-older automatic upgrades, symlink/path safety, first-start enablement, explicit off, serialized installation/removal, empty-target races, publication-failure recovery, backup/cache retention, local JSON/SSE replies, record validation, and failed-write cleanup. Online Summary tests use temporary settings/archive roots and fake summary models. No real Statusline configuration, global skill installation, or launchd registration/restart is performed.

Capacity-launcher tests use temporary homes/config roots for adoption, path refresh, persistent opt-out, private digest backups, shell conflicts, permissions/symlinks, syntax failures, concurrent edits, fresh-zsh argument forwarding, and Node PATH/fallback behavior. Full-startup VM tests cover the branch after the inert legacy settings-sync boundary: launcher installation and GPT subagent sync run only after listening succeeds, never block startup, and only warn on failure. GPT sync tests inject a temporary config root, empty environment, mock credential store, and fake dynamic catalog into the real setup factory, covering absent/disappearing credentials, unavailable models, exact backups, idempotent restarts, unrelated-settings preservation, and credential-safe failure logging. They do not restart the current proxy or modify real user settings or `.zshrc`.

Historical installer upgrade tests read original Git blobs at `f3fab02` and `530542c^`; the checkout must include those objects (a history-free archive or overly shallow clone is insufficient).

`claude-cli.test.js` is skipped by default. Set `RUN_CLAUDE_CLI_TESTS=1` only when explicitly choosing to run isolated checks with the locally installed CLI. It still uses mocked gateways and does not validate real account authorization or real upstream access.

Windows PowerShell installation and wrapper execution are covered with temporary profiles: real PowerShell parsing, argument/standard-stream/exit-code preservation, Node fallback, backup/opt-out and isolated proxy-startup regressions. Optional installed-CLI tests use local mock upstreams. Real provider accounts and interactive terminal/profile-policy combinations are not covered by these tests; macOS execution tests still require zsh.

## License

The project retains the root [MIT LICENSE](LICENSE). `lib/device-login.js` preserves its Pi source attribution; the corresponding third-party MIT license is in [third-party/pi/LICENSE](third-party/pi/LICENSE). The statusline script's source and its single adaptation are documented in [statusline/SOURCE.md](statusline/SOURCE.md). Project Code Memory retains its [MIT LICENSE](project-code-memory/LICENSE); source-owner authorization and pinned bundle provenance are recorded in [project-code-memory/SOURCE.md](project-code-memory/SOURCE.md).

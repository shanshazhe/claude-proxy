# Bundled statusline provenance

- Source: the maintainer's local `~/.claude/statusline-command.sh`. Original SHA-256: `59c7e57d62f09a09a4b9bfad7d7cbabc4fcfa33f0d4996b08d81d817369b0702`.
- Display: one line with `git:(branch)` and a trailing `*` for uncommitted changes, model name, session effort when available, current context usage (`ctx: used/total (pct%)`), and main-conversation whole-session `in/out/cache` tokens plus prompt cache hit %, deduplicated from the transcript. `in` is total input (uncached + cache read + cache creation, so the cached system prompt counts); `hit` is cache read / `in`. Cache state comes from Claude Code's `prompt_cache` stdin field when caching is observed: `warm` (prefix inside TTL), `cold` (`warm=false`), or `dropped: <cause>` (still warm, but `last_miss_at` matches the last request at `expires_at - ttl`).
- Requires only Bash 3+ and jq 1.6+ (plus `git`/`awk` normally present; Git Bash on Windows). No Node.js runtime, plugins, caches, network, keychain or credential access.

## Local adaptation

`statusline-command.sh` adapts the original by selecting the probed jq binary, replacing the working-directory display with the Git segment, and appending `effort: <level>` to the model name when Claude Code supplies a recognized `.effort.level` on stdin. This is the CLI's session effort, not an upstream-provider measurement.

```bash
# Toolkit adapter: use the probed jq binary.
jq() { "${TOOLKIT_JQ:-jq}" "$@"; }
```

Deployments live in `<actual CLI config directory>/claude-proxy/statusline/<generation SHA-256>/` and keep working after this repository moves. The generated private launcher sets only `TOOLKIT_JQ` and `TOOLKIT_STATUSLINE_DIR`, quotes dependency paths, converts Windows drive paths for Git Bash and invokes the probed Bash directly. It does not rewrite Claude settings env or set `CLAUDE_CONFIG_DIR`.

Earlier versions bundled Claude HUD 0.1.0; that runtime was removed. Old HUD generations no longer match the bundled script, so status reports them as not configured until Configure Statusline is clicked again; their directories are left in place.

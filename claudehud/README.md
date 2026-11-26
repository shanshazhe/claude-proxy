# Windows statusline (Claude HUD)

On Windows, **Enable Statusline** on `/login` installs [Claude HUD](https://github.com/jarrodwatts/claude-hud) from its plugin marketplace, runs Claude HUD's own `install --replace` to point the statusline at it, and copies `config.json` here to `<actual CLI config directory>/plugins/claude-hud/config.json`.

`config.json` shows the Git branch with the uncommitted-change marker, model and effort, context, session tokens, and prompt-cache hit rate. It hides the project path.

```text
git:(main*) | [openai/gpt-6.2-sol ◑ high] 40% (345k/872k) | tok: 85.3M (in: 45.7M, out: 132k, cache: 39.4M) | Cache hit 86%
```

Run `/hud` in Claude Code to adjust it further. macOS and Linux use the bundled Bash script in [`../statusline`](../statusline/SOURCE.md) instead.

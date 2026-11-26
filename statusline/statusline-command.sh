#!/bin/bash
# Claude Code status line
# Shows: git branch + dirty marker, model name, session effort, context usage (tokens used/total + %),
#        whole-session cumulative in/out/cache tokens + prompt cache hit % + cache state (warm/cold/dropped)

# Toolkit adapter: use the probed jq binary.
jq() { "${TOOLKIT_JQ:-jq}" "$@"; }
input=$(cat)

# --- Git branch + dirty marker ---
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
git_info=""
if [ -n "$cwd" ] && git -C "$cwd" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)
  if [ -z "$branch" ]; then
    branch=$(git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  fi
  if [ -n "$branch" ]; then
    if [ -n "$(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null)" ]; then
      dirty="*"
    else
      dirty=""
    fi
    git_info="git:(${branch})${dirty}"
  fi
fi

# --- Model name and session effort ---
model=$(echo "$input" | jq -r '
  (try .effort.level catch null) as $effort
  | (.model.display_name // "") as $model
  | if $effort == "low" or $effort == "medium" or $effort == "high" or $effort == "xhigh" or $effort == "max"
    then ($model | if . == "" then "" else . + " · " end) + "effort: " + $effort
    else $model end')

# --- Context usage: actual token counts + percentage ---
# Format a token count compactly: 1234 -> 1.2k, 200000 -> 200k, 1000000 -> 1M
fmt_tokens() {
  awk -v n="$1" 'BEGIN {
    if (n >= 1000000) { v = n / 1000000; s = sprintf("%.1f", v); sub(/\.0$/, "", s); print s "M" }
    else if (n >= 1000) { v = n / 1000; s = sprintf("%.1f", v); sub(/\.0$/, "", s); print s "k" }
    else { printf "%d\n", n }
  }'
}

# Usage tokens: one decimal, at least k; promote rounded 1000.0k to m.
fmt_request_tokens() {
  if [ "$1" = "na" ]; then printf '%s\n' 'n/a'; return; fi
  awk -v n="$1" 'BEGIN {
    t = int((n + 50) / 100); unit = "k"
    if (t >= 10000) { t = int((n + 50000) / 100000); unit = "m" }
    printf "%d.%d%s\n", int(t / 10), t % 10, unit
  }'
}

used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
# Tokens currently in the context window: sum of the last API call's input-side usage.
# This describes the current context, not the cumulative transcript usage below.
used_tokens=$(echo "$input" | jq -r '
  if .context_window.current_usage then
    (.context_window.current_usage
      | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0))
  else empty end')

if [ -n "$used_tokens" ] && [ -n "$ctx_size" ]; then
  ctx_text="ctx: $(fmt_tokens "$used_tokens")/$(fmt_tokens "$ctx_size")"
  [ -n "$used_pct" ] && ctx_text="$ctx_text ($(printf '%.0f' "$used_pct")%)"
  ctx_info=" \033[2m|\033[0m \033[2m${ctx_text}\033[0m"
elif [ -n "$ctx_size" ]; then
  ctx_info=" \033[2m|\033[0m \033[2mctx: 0/$(fmt_tokens "$ctx_size")\033[0m"
elif [ -n "$used_pct" ]; then
  ctx_info=" \033[2m|\033[0m \033[2mctx: $(printf '%.0f' "$used_pct")%\033[0m"
else
  ctx_info=""
fi

# --- Whole-session token usage and cache hit rate (main conversation only) ---
# Deduplicate response blocks; keep the largest reported count for each request.
# in is total input (uncached + cache read + cache creation, so the cached system prompt counts);
# cache is cache_read; hit is cache / in.
cache_info=""
in_tok=na; out_tok=na; cache_tok=na; hit_pct=na
transcript=$(echo "$input" | jq -r '.transcript_path // empty')
if [ -n "$transcript" ] && [ -r "$transcript" ]; then
  if totals=$(jq -Rnr '
    reduce (inputs | fromjson? | select(type == "object")
      | select(.type == "assistant"
          and .isSidechain != true and .isUnmetered != true and .isApiErrorMessage != true
          and (.message.usage | type) == "object")) as $e
      ({};
       (if ($e.message.id // "") != ""
          then $e.message.id + "|" + ($e.requestId // "")
          else ($e.uuid // "") end) as $key
       | if $key == "" then . else
           .[$key] = {
             i: ([(.[$key].i // 0), ($e.message.usage.input_tokens // 0)] | max),
             o: ([(.[$key].o // 0), ($e.message.usage.output_tokens // 0)] | max),
             c: ([(.[$key].c // 0), ($e.message.usage.cache_read_input_tokens // 0)] | max),
             w: ([(.[$key].w // 0), ($e.message.usage.cache_creation_input_tokens // 0)] | max)
           }
         end)
    | reduce .[] as $u ({i: 0, o: 0, c: 0, w: 0};
        .i += $u.i | .o += $u.o | .c += $u.c | .w += $u.w)
    | (.i + .c + .w) as $denominator
    | [$denominator, .o, .c, (if $denominator > 0 then (.c * 100 / $denominator | round) else "na" end)]
    | @tsv
  ' "$transcript" 2>/dev/null) && [ -n "$totals" ]; then
    read -r in_tok out_tok cache_tok hit_pct <<< "$totals"
  fi
fi

parts="in: $(fmt_request_tokens "$in_tok") out: $(fmt_request_tokens "$out_tok") cache: $(fmt_request_tokens "$cache_tok")"
if [ "$hit_pct" = "na" ]; then
  parts="${parts:+$parts }hit: n/a"
elif [ -n "$hit_pct" ]; then
  parts="${parts:+$parts }hit: ${hit_pct}%"
fi
[ -n "$parts" ] && cache_info=" \033[2m|\033[0m \033[2m${parts}\033[0m"

# --- Prompt cache state from Claude Code's prompt_cache field (only when caching is observed) ---
# warm: prefix inside its TTL; cold: TTL expired or last response had no cache;
# dropped: still warm but the last request (at expires_at - ttl) was a miss, plus its likely cause.
cache_state=$(echo "$input" | jq -r '
  .prompt_cache // empty
  | select(.caching_observed == true)
  | if .warm != true then "cold"
    elif .last_miss_at != null and .expires_at != null
         and .last_miss_at >= .expires_at - (if .ttl == "1h" then 3600 else 300 end) - 1
      then "dropped" + ((.last_miss_cause.causes[0] // "") | if . != "" then ": " + . else "" end)
    else "warm" end' 2>/dev/null)
case "$cache_state" in
  warm) cache_info="${cache_info} \033[32m(warm)\033[0m" ;;
  cold) cache_info="${cache_info} \033[33m(cold)\033[0m" ;;
  dropped*) cache_info="${cache_info} \033[31m(${cache_state})\033[0m" ;;
esac

if [ -n "$git_info" ]; then
  printf '\033[36m%s\033[0m \033[2m|\033[0m ' "$git_info"
fi
printf "\033[2m%s\033[0m%b%b\n" "$model" "$ctx_info" "$cache_info"

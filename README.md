# hubert

Live side dashboard for Hyprland: which coding agents (jcode, Claude Code) are working, what tool they're running, and which files changed in their repos.

Voice-led orchestration is the longer-term goal. See the Obsidian vault `hubert/` for the plan.

## Run

```sh
bun install
./hubert.sh        # starts server on 127.0.0.1:7777 (if needed) and opens/focuses a Brave app window
bun dev            # hot-reload dev server
bun test
```

## How it works

No agent config needed. `state.ts` reads:

- `~/.jcode/sessions/*.json` + `*.journal.jsonl`: session meta, live mtime, last tool intent
- `~/.claude/projects/*/*.jsonl`: Claude Code transcripts (last 30 min)
- `git status` / `git diff --numstat HEAD` for each repo that has a live agent

`working` = transcript written in the last 15s. `idle` = alive but quiet.

## Hyprland

Bind + dock on the right (add to your hypr config):

```ini
bind = SUPER, H, exec, ~/Documents/GitHub/hubert/hubert.sh
windowrulev2 = float, class:^(brave-127.0.0.1__-Default)$
windowrulev2 = size 480 95%, class:^(brave-127.0.0.1__-Default)$
windowrulev2 = move 100%-490 45, class:^(brave-127.0.0.1__-Default)$
windowrulev2 = pin, class:^(brave-127.0.0.1__-Default)$
```

Validated on Hyprland 0.51.1, 1920x1080 with a 37px top bar: lands at 1430,45, 480x1026, floating + pinned on all workspaces. Tune `45`/`95%` for your bar height. `monitor_w`/`monitor_h` expressions did not work on 0.51.

Brave on Wayland ignores `--class`, so the window class is `brave-<host>__-Default`.

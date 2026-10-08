# hubert

A live side dashboard for your coding agents. It shows which [jcode](https://github.com/1jehuang/jcode) and [Claude Code](https://claude.com/claude-code) sessions are working, what tool each one is running, and which files changed in their repos.

Voice-led orchestration is the longer-term goal.

![hubert](docs/screenshot.png)

## Requirements

- [Bun](https://bun.sh) 1.3+
- git
- Linux or macOS. Optional: a Chromium-family browser for a chromeless app window, [lazygit](https://github.com/jesseduffield/lazygit) for the per-repo button, Hyprland for focus-on-relaunch.

## Install

```sh
git clone https://github.com/red0-x/hubert && cd hubert
bun install
./hubert.sh
```

`hubert.sh` starts the server on `127.0.0.1:7777` (if needed) and opens the dashboard as an app window, or focuses it if it is already open.

Dev: `bun dev` (hot reload), `bun test`.

## Configuration

All optional, set as environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HUBERT_PORT` | `7777` | Server port |
| `HUBERT_BROWSER` | first of chromium, chrome, brave, edge, vivaldi | Browser for `--app` window |
| `HUBERT_TERMINAL` | first of kitty, ghostty, foot, alacritty, wezterm, gnome-terminal, konsole, xterm | Command prefix that runs lazygit in a new window, e.g. `foot` or `alacritty -e` |
| `JCODE_HOME` | `~/.jcode` | jcode data dir |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code data dir |

## How it works

No agent configuration needed. The server reads, read-only:

- jcode: `$JCODE_HOME/sessions/*.json` + `*.journal.jsonl` (session meta, last activity, last tool intent)
- Claude Code: `$CLAUDE_CONFIG_DIR/projects/*/*.jsonl` (sessions touched in the last 30 min)
- `git status` / `git diff --numstat HEAD` for each repo that has a live agent

`working` means the transcript was written in the last 15s. `idle` means the session is alive but quiet.

The server binds to `127.0.0.1` only and rejects requests with a foreign `Host` or `Origin`, so other websites can't read your agent activity. The lazygit endpoint only opens repos that are currently listed.

## Hyprland: dock on the right

```ini
bind = SUPER, H, exec, /path/to/hubert/hubert.sh
windowrulev2 = float, class:^(.*-127\.0\.0\.1__-Default)$
windowrulev2 = size 480 95%, class:^(.*-127\.0\.0\.1__-Default)$
windowrulev2 = move 100%-490 45, class:^(.*-127\.0\.0\.1__-Default)$
windowrulev2 = pin, class:^(.*-127\.0\.0\.1__-Default)$
```

Chromium-family browsers on Wayland ignore `--class` and name app windows `<browser>-<host>__-Default`. Tune `45` / `95%` to your bar height. Tested on Hyprland 0.51.1.

## Stack

Bun (server + bundler via HTML imports), React, [shadcn/ui](https://ui.shadcn.com) (Radix, Tailwind v4).

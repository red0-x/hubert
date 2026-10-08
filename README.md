# hubert

A live side dashboard for your coding agents. It shows which [jcode](https://github.com/1jehuang/jcode) and [Claude Code](https://claude.com/claude-code) sessions are working, what tool each one is running, and which files changed in their repos.

Voice-led orchestration is the longer-term goal.

![hubert](docs/screenshot.png)

## Requirements

- [Bun](https://bun.sh) 1.3+
- git
- Linux or macOS. Optional: a Chromium-family browser for a chromeless app window, [lazygit](https://github.com/jesseduffield/lazygit) for the per-repo button, [ffmpeg](https://ffmpeg.org) for voice, Hyprland for focus-on-relaunch.

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

## Voice

Hold the mic button in the dashboard and speak. hubert transcribes it with the speech-to-text connector you pick, parses it, and shows what it understood:

| You say | hubert understands |
| --- | --- |
| "switch to snake" | focus snake |
| "tell llama to review the nav changes" | send to llama |
| "stop horse" / "what's llama doing" | stop / status |
| "show diff for ecily" | open diff |
| "open a new agent in ecily and fix the nav" | open agent |

Agent and repo names are fuzzy-matched against what is running (speech-to-text mangles names), and hubert refuses to guess when two names are equally close. Repeated phrases, "please", and "the" are tolerated.

> **Status:** transcription and intent parsing work end to end. Executing the actions (focus, open, send) is the next milestone, see the [roadmap](#roadmap). Today the result is shown as a toast.

### Speech-to-text connectors

Set `HUBERT_STT` to pick one. If unset, hubert uses the first **local** connector that is configured. It never uses a cloud API unless you choose it, so audio does not leave your machine by accident.

| `HUBERT_STT` | Kind | Needs |
| --- | --- | --- |
| `whisper-socket` | local | `HUBERT_STT_SOCKET`: unix socket of a warm faster-whisper server (write `F:<wav path>\n`, read text) |
| `command` | local | `HUBERT_STT_COMMAND`, e.g. `whisper-cli -m ggml-small.en.bin -nt -f {wav}`. `{wav}` is replaced with the audio path. No shell is involved. |
| `openai-compatible` | local | `HUBERT_STT_URL` (e.g. `http://127.0.0.1:8080/v1`), optional `HUBERT_STT_KEY`, `HUBERT_STT_MODEL`. Works with whisper.cpp server, faster-whisper-server, LocalAI, vLLM. |
| `groq` | API | `GROQ_API_KEY`. Default model `whisper-large-v3-turbo`. |
| `openai` | API | `OPENAI_API_KEY`. Default model `gpt-4o-mini-transcribe`. |
| `deepgram` | API | `DEEPGRAM_API_KEY`. Default model `nova-3`. |

`HUBERT_STT_MODEL` overrides the model for any of them. Browser audio is converted to 16 kHz WAV with [ffmpeg](https://ffmpeg.org), which must be installed. Adding a connector is one object in [`voice/stt.ts`](voice/stt.ts).

```sh
# example: local whisper.cpp
HUBERT_STT=command HUBERT_STT_COMMAND="whisper-cli -m ~/models/ggml-small.en.bin -nt -f {wav}" ./hubert.sh
# example: Groq
HUBERT_STT=groq GROQ_API_KEY=... ./hubert.sh
```

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

## Roadmap

- [x] Live agents + changed files (jcode, Claude Code)
- [x] Voice: pluggable speech-to-text (local + cloud) and intent parsing
- [ ] Voice actions: focus, open, move and message agents
- [ ] Live diff window
- [ ] Command stats: most failed, most sent, longest
- [ ] Change graph and change frequency (Obsidian-style)
- [ ] Orchestrator brain: free-form voice to a plan of actions
- [ ] More agents: Codex CLI, opencode

## License

[MIT](LICENSE)

<div align="center">
  <img src="docs/mascot.png" alt="Hubert, a pink blubber fish with round glasses" width="220">

  # Hubert

  **A local workspace for watching your coding agents work.**

  Follow live [jcode](https://github.com/1jehuang/jcode) and [Claude Code](https://claude.com/claude-code) sessions, changed files, commands, and diffs without leaving your desktop.
</div>

![Hubert dashboard showing agents and changed files](docs/screenshot.png)

## Get started

Requires [Bun](https://bun.sh) 1.3+, git, and Linux or macOS. A Chromium-family browser is optional for the app window; otherwise use the local URL. Install [ffmpeg](https://ffmpeg.org) only if you want voice input.

```sh
git clone https://github.com/red0-x/hubert.git
cd hubert
bun install
./hubert.sh
```

`hubert.sh` serves the dashboard on `127.0.0.1:7777` and opens or focuses its app window when supported. For development, run `bun dev`; run tests with `bun test`.

## Explore

- **Agents:** active sessions, their latest tool activity, and changed files. Select a jcode agent's tmux window or open a file diff.
- **Change map:** a live visual connection between repositories and changed files. It does not yet attribute each edit to an individual agent.
- **Commands:** recent completed Bash calls from jcode and Claude Code journals, with failures and duration where available.
- **Live diff:** changes against `HEAD`, including readable untracked files. Views refresh roughly every 1.5 seconds.

Hubert reads jcode sessions from `~/.jcode`, Claude Code journals from `~/.claude`, and git state for repositories with live agents. A session is marked **working** after recent transcript activity and **idle** when quiet.

## Voice, optionally

Hold the mic button to transcribe a request. Configure a local speech-to-text connector, or explicitly choose a cloud provider. Simple requests such as focusing an agent or asking its status use a grammar; other requests can use a tool-less jcode model to propose a plan. The plan is checked against live agents and windows. Consequential actions require confirmation. Hubert does **not** open or close windows or agents through voice; supported Hyprland arrangement is limited to validated move and resize actions.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HUBERT_STT` | first configured local connector | `whisper-socket`, `command`, `openai-compatible`, `groq`, `openai`, or `deepgram` |
| `HUBERT_STT_SOCKET` | unset | Warm local Whisper Unix socket |
| `HUBERT_STT_COMMAND` | unset | Local command with `{wav}` placeholder, for example `whisper-cli -m model.bin -f {wav}` |
| `HUBERT_STT_URL` | unset | OpenAI-compatible transcription endpoint |
| `HUBERT_STT_KEY`, `HUBERT_STT_MODEL` | unset | Optional endpoint key and model override |
| `HUBERT_BRAIN` | on if jcode is installed | Set `off` to disable model planning |
| `HUBERT_BRAIN_MODEL`, `HUBERT_BRAIN_PROVIDER` | jcode selection | Override planning model/provider |

Cloud STT requires the corresponding `GROQ_API_KEY`, `OPENAI_API_KEY`, or `DEEPGRAM_API_KEY`. The browser recording is converted to 16 kHz WAV with ffmpeg. Add a speech connector in [`voice/stt.ts`](voice/stt.ts).

**Privacy and safety:** the server binds to loopback and rejects foreign `Host` and `Origin` headers. Local connectors keep audio on your machine; cloud connectors send it to the chosen provider. If grammar cannot handle a request and the brain is enabled, its transcript, live agent names, and recent tool activity go to the selected model through jcode. Set `HUBERT_BRAIN=off` to avoid model calls. Hubert validates proposed actions against current state and asks before mutations.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HUBERT_PORT` | `7777` | Local server port |
| `HUBERT_BROWSER` | first available Chromium-family browser | App-window browser |
| `HUBERT_TERMINAL` | first supported terminal | Command prefix for the lazygit button |
| `JCODE_HOME` | `~/.jcode` | jcode data directory |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code data directory |

[lazygit](https://github.com/jesseduffield/lazygit) is optional. Hyprland enables window focus and arrangement, but the dashboard's read-only views do not require it.

## Contribute

Try the dashboard with a live session, report a reproducible issue, or improve a connector, journal parser, or accessible view. Start with `bun test` and `bunx tsc --noEmit`; keep the server local-only and do not add window creation or termination to voice actions. Current gaps include per-agent edit attribution, richer command history, and agent-to-agent plans.

## License

[MIT](LICENSE)

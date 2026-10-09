# Contributing to Hubert

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup

```sh
bun install
bun dev          # server with hot reload on 127.0.0.1:7777
python3 hubert-window.py   # native window pointing at it
bun test         # unit tests
bunx tsc --noEmit
```

Run both checks before opening a PR. CI is not set up yet, so please paste the results in the PR.

## Layout

| Path | What |
| --- | --- |
| `server.ts` | Local HTTP API, Host/Origin guard |
| `state.ts`, `live.ts` | Agent discovery, git state, commands, edits, diffs |
| `voice/` | Speech connectors, grammar, model planner, action executor |
| `src/` | React UI (shadcn components in `src/components/ui`) |
| `hubert-window.py`, `hubert.sh` | Native window and launcher |

## Ground rules

- **Local only.** Keep the loopback bind and the Host/Origin checks on every endpoint.
- **No voice open/close.** Voice must never create or terminate windows or agents. Mutating actions need explicit confirmation and are revalidated against live state on the server.
- **No surprise dependencies.** Open an issue before adding a package, service or font and say why the existing stack cannot do it.
- **Tests for logic.** Parsers, planners and anything touching paths or commands get a test next to them.
- **Honest docs.** If you could not test something, say so in the PR and the README's known limits.

## Good first contributions

- A journal adapter for another agent (Codex, opencode).
- A speech connector in `voice/stt.ts`.
- A window-manager backend beyond Hyprland (sway, tmux-only, macOS).
- Accessibility and keyboard-navigation fixes in the UI.

## Reporting bugs

Include your OS, window manager, which agent (jcode or Claude Code), and what Hubert showed versus what you expected. Attach `~/.local/state/hubert.log` if the server failed.
